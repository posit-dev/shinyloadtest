import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { once } from "node:events"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { CookieJar } from "tough-cookie"
import { HttpClient } from "../http.js"
import { detectServerType } from "../detect.js"
import { ServerType } from "../types.js"
import type { Logger } from "../logger.js"
import { readRecordingFromString } from "../recording.js"
import { ReplayDiagnostics } from "../replay/diagnostics.js"
import { createOutputDir } from "../replay/output.js"
import { runSession, Stats } from "../replay/session.js"
import { MockShinyServer } from "./helpers/mock-shiny-server.js"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

function setup(recordingText: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-diagnostics-"))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const recordingPath = path.join(tmpDir, "recording.log")
  fs.writeFileSync(recordingPath, recordingText)
  const outputDir = path.join(tmpDir, "output")
  createOutputDir({
    outputDir,
    recordingPath,
    overwrite: false,
    version: "test",
  })
  const messages: string[] = []
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error(message) {
      messages.push(message)
    },
    child() {
      return this
    },
  }
  return {
    outputDir,
    recordingPath,
    recording: readRecordingFromString(recordingText),
    sessionId: 7,
    workerId: 2,
    iterationId: 3,
    headers: { Authorization: "Key header-secret-sentinel" },
    creds: { user: null, pass: null, connectApiKey: "header-secret-sentinel" },
    logger,
    argsString: "metadata-secret-sentinel",
    argsJson: "{}",
    messages,
  }
}

async function failingServer(status: number, stall = false) {
  let requests = 0
  let upgrades = 0
  let resolveRequest!: () => void
  const requestArrived = new Promise<void>((resolve) => {
    resolveRequest = resolve
  })
  const server = http.createServer((_, res) => {
    requests++
    if (requests === 1) {
      res.writeHead(200)
      res.end('<script src="/shared/shiny.min.js"></script>')
    } else if (stall) {
      resolveRequest()
    } else {
      res.writeHead(status)
      res.end("body-secret-sentinel")
    }
  })
  server.on("upgrade", (_, socket) => {
    upgrades++
    socket.destroy()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const port = (server.address() as import("node:net").AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  const recording = [
    "# version: 1",
    `# target_url: ${url}`,
    "# target_type: R/Shiny",
    JSON.stringify({
      type: "REQ_HOME",
      begin: "2020-01-01T00:00:00.000Z",
      url: "/",
      status: 200,
    }),
    JSON.stringify({
      type: "WS_OPEN",
      begin: "2020-01-01T00:00:00.100Z",
      url: "/websocket",
    }),
    JSON.stringify({ type: "WS_CLOSE", begin: "2020-01-01T00:00:00.200Z" }),
  ].join("\n")
  return {
    url,
    recording,
    requestArrived,
    counts: () => ({ requests, upgrades }),
  }
}

function events(outputDir: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(outputDir, "diagnostics.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

async function successfulPreflight(url: string) {
  const client = new HttpClient({
    cookieJar: new CookieJar(),
    headers: {},
    userAgent: "test",
  })
  expect(await detectServerType(url, client)).toBe(ServerType.SHN)
}

describe("Connect bootstrap hardening", () => {
  it.each([401, 403, 503])(
    "reports bootstrap HTTP %i without replaying home or opening a socket",
    async (status) => {
      const server = await failingServer(status)
      const config = setup(server.recording)
      await successfulPreflight(server.url)
      const stats = new Stats()

      const outcome = await runSession(
        { ...config, httpUrl: server.url },
        stats,
      )

      expect(outcome).toBe("failed")
      expect(stats.getCounts()).toMatchObject({
        running: 0,
        failed: 1,
        done: 0,
      })
      expect(server.counts()).toEqual({ requests: 2, upgrades: 0 })
      expect(config.messages).toEqual([
        expect.stringContaining(`HTTP ${status}`),
      ])
      const csv = fs.readFileSync(
        path.join(config.outputDir, "sessions", "7_2_3.csv"),
        "utf8",
      )
      expect(csv).toContain("PLAYBACK_FAIL")
      expect(csv).not.toContain("REQ_HOME_START")
      expect(
        fs.existsSync(path.join(config.outputDir, "diagnostics.jsonl")),
      ).toBe(false)
    },
  )

  it("cancels an in-flight bootstrap request without counting it as failure", async () => {
    const server = await failingServer(503, true)
    const config = setup(server.recording)
    await successfulPreflight(server.url)
    const controller = new AbortController()
    const stats = new Stats()
    const diagnostics = new ReplayDiagnostics({
      outputDir: config.outputDir,
      numWorkers: 1,
      maxErrors: 0,
    })
    cleanups.push(() => diagnostics.finish())

    const pending = runSession(
      {
        ...config,
        httpUrl: server.url,
        signal: controller.signal,
        diagnostics,
      },
      stats,
    )
    await server.requestArrived
    controller.abort()
    const outcome = await pending
    await diagnostics.finish()

    expect(outcome).toBe("canceled")
    expect(stats.getCounts()).toMatchObject({ running: 0, failed: 0 })
    expect(server.counts()).toEqual({ requests: 2, upgrades: 0 })
    const csv = fs.readFileSync(
      path.join(config.outputDir, "sessions", "7_2_3.csv"),
      "utf8",
    )
    expect(csv).toContain("PLAYBACK_CANCEL")
    expect(csv).not.toContain("PLAYBACK_FAIL")
    expect(events(config.outputDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "http_error",
          phase: "bootstrap",
          aborted: true,
        }),
        expect.objectContaining({ type: "session_end", outcome: "canceled" }),
      ]),
    )
  })
})

describe("Replay diagnostics integration", () => {
  it("flushes diagnostics before the built CLI exits, without exporting explicit headers", async () => {
    const mock = new MockShinyServer()
    await mock.start()
    cleanups.push(() => mock.stop())
    const config = setup(mock.makeRecording())
    const env = { ...process.env }
    delete env.SHINYLOADTEST_CONNECT_API_KEY
    delete env.SHINYCANNON_CONNECT_API_KEY
    delete env.SHINYLOADTEST_USER
    delete env.SHINYLOADTEST_PASS
    delete env.SHINYCANNON_USER
    delete env.SHINYCANNON_PASS

    await promisify(execFile)(
      process.execPath,
      [
        path.resolve("dist/main.mjs"),
        "replay",
        config.recordingPath,
        mock.url,
        "--output-dir",
        config.outputDir,
        "--overwrite-output",
        "--diagnostics",
        "--loaded-duration-minutes",
        "0.001",
        "--max-errors",
        "0",
        "-H",
        "Authorization: Key cli-header-secret-sentinel",
      ],
      { env, timeout: 10000 },
    )

    const recorded = events(config.outputDir)
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session_end", outcome: "done" }),
        expect.objectContaining({ type: "ws_closed", origin: "client" }),
      ]),
    )
    expect(recorded.at(-1)).toMatchObject({
      type: "run_end",
      activeSockets: 0,
      complete: true,
    })
    const diagnostics = fs.readFileSync(
      path.join(config.outputDir, "diagnostics.jsonl"),
      "utf8",
    )
    expect(diagnostics).not.toContain("cli-header-secret-sentinel")
    expect(diagnostics).not.toContain(mock.url)
  }, 15000)

  it("records the setup 503 as a failed session without storing request or response secrets", async () => {
    const server = await failingServer(503)
    const config = setup(server.recording)
    await successfulPreflight(server.url)
    const diagnostics = new ReplayDiagnostics({
      outputDir: config.outputDir,
      numWorkers: 1,
      maxErrors: 0,
    })
    cleanups.push(() => diagnostics.finish())

    const outcome = await runSession(
      { ...config, httpUrl: server.url, diagnostics },
      new Stats(),
    )
    await diagnostics.finish()

    expect(outcome).toBe("failed")
    expect(events(config.outputDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session_start",
          sessionId: 7,
          workerId: 2,
          iterationId: 3,
        }),
        expect.objectContaining({
          type: "http_complete",
          phase: "bootstrap",
          method: "GET",
          statusCode: 503,
        }),
        expect.objectContaining({ type: "session_end", outcome: "failed" }),
      ]),
    )
    const text = fs.readFileSync(
      path.join(config.outputDir, "diagnostics.jsonl"),
      "utf8",
    )
    expect(text).not.toContain("secret-sentinel")
    expect(text).not.toContain(server.url)
    expect(
      events(config.outputDir).some((event) => event.type === "ws_created"),
    ).toBe(false)
  })

  it("records server-initiated closure and the resulting playback failure", async () => {
    const mock = new MockShinyServer({ wsDropAfterInit: true })
    await mock.start()
    cleanups.push(() => mock.stop())
    const config = setup(mock.makeRecording())
    const diagnostics = new ReplayDiagnostics({
      outputDir: config.outputDir,
      numWorkers: 1,
      maxErrors: 0,
    })
    cleanups.push(() => diagnostics.finish())
    const stats = new Stats()

    const outcome = await runSession(
      { ...config, httpUrl: mock.url, diagnostics },
      stats,
    )
    await diagnostics.finish()

    expect(outcome).toBe("failed")
    expect(stats.getCounts()).toMatchObject({ running: 0, failed: 1 })
    expect(events(config.outputDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ws_closed", origin: "other" }),
        expect.objectContaining({ type: "session_end", outcome: "failed" }),
      ]),
    )
    expect(events(config.outputDir).at(-1)).toMatchObject({
      type: "run_end",
      activeSockets: 0,
      complete: true,
    })
  })

  it("keeps observing physical socket closure after successful playback finishes", async () => {
    const mock = new MockShinyServer()
    await mock.start()
    cleanups.push(() => mock.stop())
    const config = setup(mock.makeRecording())
    const diagnostics = new ReplayDiagnostics({
      outputDir: config.outputDir,
      numWorkers: 1,
      maxErrors: 0,
    })
    cleanups.push(() => diagnostics.finish())

    const outcome = await runSession(
      { ...config, httpUrl: mock.url, diagnostics },
      new Stats(),
    )
    await diagnostics.finish()

    expect(outcome).toBe("done")
    const recorded = events(config.outputDir)
    expect(
      recorded.filter((event) => event.type === "http_complete"),
    ).toHaveLength(4)
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "http_complete",
          phase: "playback",
          statusCode: 200,
        }),
        expect.objectContaining({ type: "ws_open" }),
        expect.objectContaining({ type: "ws_close_requested" }),
        expect.objectContaining({
          type: "ws_closed",
          closeCode: 1005,
          origin: "client",
        }),
        expect.objectContaining({ type: "session_end", outcome: "done" }),
      ]),
    )
    expect(recorded.at(-1)).toMatchObject({
      type: "run_end",
      activeSockets: 0,
      complete: true,
    })
    expect(recorded.filter((event) => event.type === "ws_closed")).toHaveLength(
      1,
    )
    const text = fs.readFileSync(
      path.join(config.outputDir, "diagnostics.jsonl"),
      "utf8",
    )
    expect(text).not.toContain("secret-sentinel")
    expect(text).not.toContain(mock.url)
  })
})
