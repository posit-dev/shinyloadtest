import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { MockShinyServer } from "./helpers/mock-shiny-server.js"
import {
  WARMUP_CEILING_MS,
  WarmupTimeoutError,
  runEnduranceTest,
} from "../replay/worker.js"
import type { EnduranceTestConfig } from "../replay/worker.js"
import {
  WS_RECV_MAX_GAP_MS,
  requiredReceiveWaitLine,
} from "../replay/session.js"
import { readRecordingFromString } from "../recording.js"
import type { Logger } from "../logger.js"
import { createOutputDir } from "../replay/output.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCapturingLogger(): { logger: Logger; messages: string[] } {
  const messages: string[] = []

  function makeLogger(prefix: string): Logger {
    return {
      debug(msg: string) {
        messages.push(`DEBUG${prefix}: ${msg}`)
      },
      info(msg: string) {
        messages.push(`INFO${prefix}: ${msg}`)
      },
      warn(msg: string) {
        messages.push(`WARN${prefix}: ${msg}`)
      },
      error(msg: string, _err?: Error) {
        messages.push(`ERROR${prefix}: ${msg}`)
      },
      child(name: string): Logger {
        return makeLogger(`${prefix} [${name}]`)
      },
    } as Logger
  }

  return { logger: makeLogger(""), messages }
}

interface RunResult {
  tmpDir: string
  outputDir: string
  csvFiles: string[]
  error: unknown
}

/** Run the endurance test, capturing the thrown error instead of failing. */
async function runTest(
  mock: MockShinyServer,
  overrides: Partial<Omit<EnduranceTestConfig, "logger">> = {},
): Promise<RunResult> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "shinyloadtest-warmup-ceiling-"),
  )
  const recordingPath = path.join(tmpDir, "recording.log")
  const recordingContent = mock.makeRecording()
  fs.writeFileSync(recordingPath, recordingContent)
  const outputDir = path.join(tmpDir, "output")
  createOutputDir({
    outputDir,
    overwrite: false,
    version: "0.0.0-test",
    recordingPath,
  })

  const { logger } = createCapturingLogger()
  const config: EnduranceTestConfig = {
    httpUrl: mock.url,
    recording: readRecordingFromString(recordingContent),
    recordingPath,
    headers: {},
    creds: { user: null, pass: null, connectApiKey: null },
    numWorkers: 1,
    warmupInterval: 10,
    loadedDurationMinutes: 0.002,
    maxErrors: 0,
    outputDir,
    logger,
    argsString: "test",
    argsJson: "{}",
    ...overrides,
  }

  let error: unknown = null
  try {
    await runEnduranceTest(config)
  } catch (err: unknown) {
    error = err
  }

  const sessionsDir = path.join(outputDir, "sessions")
  return {
    tmpDir,
    outputDir,
    csvFiles: fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".csv")),
    error,
  }
}

/** Recording line the session must be waiting on when init never arrives. */
function wsRecvInitLine(recordingContent: string): number {
  const event = readRecordingFromString(recordingContent).events.find(
    (e) => e.type === "WS_RECV_INIT",
  )
  expect(event).toBeDefined()
  return event!.lineNumber
}

/** Wait for a condition the peer reports asynchronously (close frames). */
async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Warmup liveness ceiling", { timeout: 20000 }, () => {
  let mock: MockShinyServer | null = null
  const tempDirs: string[] = []

  afterEach(async () => {
    if (mock !== null) {
      await mock.stop()
      mock = null
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reuses the receive quiet-interval cap instead of adding a second ceiling", () => {
    expect(WARMUP_CEILING_MS).toBe(WS_RECV_MAX_GAP_MS)
    expect(WARMUP_CEILING_MS).toBe(15 * 60_000)
  })

  it("aborts a stalled warmup instead of hanging, closing the socket it holds", async () => {
    // The server accepts the WebSocket but never sends the init message, so
    // the session is parked on WS_RECV_INIT: the case with no other escape,
    // because the loaded-duration timer has not started and no session can
    // fail. One worker keeps this test about the close the session performs
    // itself, not about socket-handshake races under a loaded test runner.
    mock = new MockShinyServer({ wsNoInit: true })
    await mock.start()

    const started = Date.now()
    const result = await runTest(mock, { warmupCeilingMs: 1_000 })
    const elapsed = Date.now() - started
    tempDirs.push(result.tmpDir)
    const initLine = wsRecvInitLine(mock.makeRecording())

    expect(result.error).toBeInstanceOf(WarmupTimeoutError)
    const error = result.error as WarmupTimeoutError
    expect(error.ceilingMs).toBe(1_000)
    expect(error.numWorkers).toBe(1)
    expect(error.stalled).toEqual([
      { workerId: 0, wait: { type: "WS_RECV_INIT", lineNumber: initLine } },
    ])

    const message = error.message
    expect(message).toContain("Warmup timed out after 1s")
    expect(message).toContain("1 of 1 workers waiting")
    expect(message).toContain(
      `worker 1 was waiting for WS_RECV_INIT at recording line ${initLine}`,
    )

    // The run stops on its own, on the ceiling rather than when a human
    // notices — the whole point of the watchdog.
    expect(elapsed).toBeLessThan(10_000)

    // The waiting session ends cancelled — not failed — and closes its socket
    // by handshake (1005) instead of leaving it open.
    const csv = result.csvFiles
      .map((f) =>
        fs.readFileSync(path.join(result.outputDir, "sessions", f), "utf-8"),
      )
      .join("\n")
    expect(csv).toContain("PLAYBACK_CANCEL")
    expect(csv).not.toContain("PLAYBACK_FAIL")

    await until(() => mock!.wsCloseCodes.length === 1)
    expect(mock.wsCloseCodes).toEqual([1005])
  })

  it("names every worker that is parked, and only those", async () => {
    // Under a loaded test runner a short ceiling can fire before a staggered
    // worker has even opened its socket, so this asserts the contract rather
    // than a fixed worker set: whoever was waiting is named, with the frame
    // and recording line, and the count matches the message.
    mock = new MockShinyServer({ wsNoInit: true })
    await mock.start()

    const result = await runTest(mock, {
      numWorkers: 3,
      warmupInterval: 0,
      warmupCeilingMs: 500,
    })
    tempDirs.push(result.tmpDir)
    const initLine = wsRecvInitLine(mock.makeRecording())

    const error = result.error as WarmupTimeoutError
    expect(error).toBeInstanceOf(WarmupTimeoutError)
    expect(error.numWorkers).toBe(3)
    expect(error.stalled.length).toBeGreaterThanOrEqual(1)
    expect(error.stalled.length).toBeLessThanOrEqual(3)
    expect(error.message).toContain(
      `${error.stalled.length} of 3 workers waiting`,
    )

    for (const stalled of error.stalled) {
      expect(stalled.wait).toEqual({
        type: "WS_RECV_INIT",
        lineNumber: initLine,
      })
      expect(error.message).toContain(
        `worker ${stalled.workerId + 1} was waiting for WS_RECV_INIT at recording line ${initLine}`,
      )
    }
  })

  it("does not interfere with a warmup that finishes", async () => {
    mock = new MockShinyServer()
    await mock.start()

    const result = await runTest(mock, { warmupCeilingMs: 10_000 })
    tempDirs.push(result.tmpDir)

    expect(result.error).toBeNull()
    expect(result.csvFiles.length).toBeGreaterThan(0)
    expect(
      result.csvFiles.some((f) =>
        fs
          .readFileSync(path.join(result.outputDir, "sessions", f), "utf-8")
          .includes("PLAYBACK_DONE"),
      ),
    ).toBe(true)
    expect(mock.wsCloseCodes).not.toContain(1006)
  })

  it("is disabled by a ceiling of 0 or less", async () => {
    mock = new MockShinyServer()
    await mock.start()

    const result = await runTest(mock, { warmupCeilingMs: 0 })
    tempDirs.push(result.tmpDir)

    expect(result.error).toBeNull()
  })

  it("warns while a required receive waits, then errors with an operator hint", () => {
    expect(requiredReceiveWaitLine("WS_RECV_INIT", 8, 30)).toEqual({
      level: "warn",
      message: "WS_RECV_INIT line 8: Haven't received message after 30 seconds",
    })

    const escalated = requiredReceiveWaitLine("WS_RECV_INIT", 8, 600)
    expect(escalated.level).toBe("error")
    expect(escalated.message).toContain(
      "WS_RECV_INIT line 8: Haven't received message after 600 seconds",
    )
    expect(escalated.message).toContain(
      "the session cannot continue without it",
    )
    expect(escalated.message).toContain("Ctrl+C stops the test")

    // Just under the escalation threshold stays a warning.
    expect(requiredReceiveWaitLine("WS_RECV_INIT", 8, 570).level).toBe("warn")
  })
})
