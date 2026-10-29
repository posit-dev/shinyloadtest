import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  DIAGNOSTICS_FILE_NAME,
  DIAGNOSTICS_SCHEMA_VERSION,
  ReplayDiagnostics,
  type DiagnosticEvent,
} from "../replay/diagnostics.js"
import { VERSION } from "../version.js"

// ---------------------------------------------------------------------------
// Helpers: temp directories with explicit cleanup
// ---------------------------------------------------------------------------

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shinyloadtest-diagnostics-"))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Fresh output directory per test so files never leak between tests. */
function newOutputDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, "output-"))
  return dir
}

function readLines(outputDir: string): Array<Record<string, unknown>> {
  const text = fs.readFileSync(
    path.join(outputDir, DIAGNOSTICS_FILE_NAME),
    "utf8",
  )
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

function readRaw(outputDir: string): string {
  return fs.readFileSync(path.join(outputDir, DIAGNOSTICS_FILE_NAME), "utf8")
}

const CONTEXT = { sessionId: 7, workerId: 2, iterationId: 3 }

// ---------------------------------------------------------------------------
// run_start
// ---------------------------------------------------------------------------

describe("ReplayDiagnostics run_start", () => {
  it("constructor emits run_start with tool/runtime metadata", async () => {
    const outputDir = newOutputDir()
    const diagnostics = new ReplayDiagnostics({
      outputDir,
      numWorkers: 45,
      maxErrors: 0,
    })

    const lines = readLines(outputDir)
    expect(lines).toHaveLength(1)
    const start = lines[0] as Record<string, unknown>
    expect(start.type).toBe("run_start")
    expect(start.schemaVersion).toBe(DIAGNOSTICS_SCHEMA_VERSION)
    expect(start.toolVersion).toBe(VERSION)
    expect(start.nodeVersion).toBe(process.version)
    expect(start.numWorkers).toBe(45)
    expect(start.maxErrors).toBe(0)
    expect(typeof start.timestamp).toBe("number")
    // run_start takes no caller-supplied fields
    expect(Object.keys(start).sort()).toEqual(
      [
        "maxErrors",
        "nodeVersion",
        "numWorkers",
        "schemaVersion",
        "timestamp",
        "toolVersion",
        "type",
      ].sort(),
    )

    await diagnostics.finish()
  })

  it("every line records schemaVersion and a timestamp", async () => {
    const outputDir = newOutputDir()
    const before = Date.now()
    const diagnostics = new ReplayDiagnostics({
      outputDir,
      numWorkers: 1,
      maxErrors: 5,
    })
    diagnostics.emit({ type: "session_start", ...CONTEXT })
    await diagnostics.finish()

    for (const line of readLines(outputDir)) {
      expect(line.schemaVersion).toBe(1)
      expect(line.timestamp).toBeGreaterThanOrEqual(before)
    }
  })
})

// ---------------------------------------------------------------------------
// Event schema: allowlisted fields only
// ---------------------------------------------------------------------------

describe("diagnostics event schema", () => {
  it("serializes each event type with exactly its allowlisted fields", async () => {
    const outputDir = newOutputDir()
    const diagnostics = new ReplayDiagnostics({
      outputDir,
      numWorkers: 1,
      maxErrors: 5,
    })

    const events: DiagnosticEvent[] = [
      { type: "session_start", ...CONTEXT },
      {
        type: "session_end",
        ...CONTEXT,
        outcome: "done",
        wsRecvMatched: 5,
        wsRecvIgnored: 1,
        wsRecvTimeout: 2,
        wsRecvMismatch: 3,
      },
      ...(["ignored", "timeout", "mismatch"] as const).map((reason, i) => ({
        type: "ws_recv_skipped" as const,
        ...CONTEXT,
        inputLineNumber: 10 + i,
        reason,
      })),
      {
        type: "http_complete",
        ...CONTEXT,
        phase: "bootstrap",
        method: "GET",
        statusCode: 503,
        durationMs: 12.5,
      },
      {
        type: "http_error",
        ...CONTEXT,
        phase: "playback",
        method: "POST",
        durationMs: 2000,
        aborted: true,
      },
      { type: "ws_created", ...CONTEXT, socketId: 0 },
      { type: "ws_open", ...CONTEXT, socketId: 0 },
      { type: "ws_close_requested", ...CONTEXT, socketId: 0 },
      { type: "ws_error", ...CONTEXT, socketId: 0 },
      {
        type: "ws_closed",
        ...CONTEXT,
        socketId: 0,
        closeCode: 1005,
        origin: "client",
      },
      {
        type: "ws_closed",
        ...CONTEXT,
        socketId: 1,
        closeCode: 1006,
        origin: "other",
      },
      {
        type: "retry_wait",
        workerId: 2,
        iterationId: 3,
        delayMs: 1000,
        consecutiveFailures: 2,
        sessionId: 7,
      },
      {
        type: "retry_wait",
        workerId: 2,
        iterationId: 4,
        delayMs: 2000,
        consecutiveFailures: 3,
      },
    ]
    for (const event of events) {
      diagnostics.emit(event)
    }
    await diagnostics.finish()

    const lines = readLines(outputDir)
    expect(lines).toHaveLength(events.length + 2) // + run_start, run_end

    const base = ["schemaVersion", "timestamp", "type"]
    const expected: Record<string, string[]> = {
      session_start: [...base, "sessionId", "workerId", "iterationId"],
      session_end: [
        ...base,
        "sessionId",
        "workerId",
        "iterationId",
        "outcome",
        "wsRecvMatched",
        "wsRecvIgnored",
        "wsRecvTimeout",
        "wsRecvMismatch",
      ],
      ws_recv_skipped: [
        ...base,
        "sessionId",
        "workerId",
        "iterationId",
        "inputLineNumber",
        "reason",
      ],
      http_complete: [
        ...base,
        "sessionId",
        "workerId",
        "iterationId",
        "phase",
        "method",
        "statusCode",
        "durationMs",
      ],
      http_error: [
        ...base,
        "sessionId",
        "workerId",
        "iterationId",
        "phase",
        "method",
        "durationMs",
        "aborted",
      ],
      ws_created: [...base, "sessionId", "workerId", "iterationId", "socketId"],
      ws_open: [...base, "sessionId", "workerId", "iterationId", "socketId"],
      ws_close_requested: [
        ...base,
        "sessionId",
        "workerId",
        "iterationId",
        "socketId",
      ],
      ws_error: [...base, "sessionId", "workerId", "iterationId", "socketId"],
      ws_closed: [
        ...base,
        "sessionId",
        "workerId",
        "iterationId",
        "socketId",
        "closeCode",
        "origin",
      ],
      retry_wait: [
        ...base,
        "workerId",
        "iterationId",
        "delayMs",
        "consecutiveFailures",
      ],
    }
    // retry_wait with sessionId adds exactly that one optional field
    const retryWithSession = [...expected.retry_wait!, "sessionId"]

    const outcomeEvents = lines.filter(
      (line) => line.type !== "run_start" && line.type !== "run_end",
    )
    expect(outcomeEvents).toHaveLength(events.length)
    expect(outcomeEvents).toEqual(
      events.map((event) => ({
        ...event,
        schemaVersion: 1,
        timestamp: expect.any(Number),
      })),
    )

    let seenRetryWithSession = false
    let seenRetryWithoutSession = false
    for (const line of outcomeEvents) {
      const type = line.type as string
      if (type !== "retry_wait") {
        expect(Object.keys(line).sort()).toEqual(expected[type]!.sort())
      } else if ("sessionId" in line) {
        expect(Object.keys(line).sort()).toEqual(retryWithSession.sort())
        seenRetryWithSession = true
      } else {
        expect(Object.keys(line).sort()).toEqual(expected.retry_wait!.sort())
        seenRetryWithoutSession = true
      }
    }
    expect(seenRetryWithSession).toBe(true)
    expect(seenRetryWithoutSession).toBe(true)

    const runStart = lines[0] as Record<string, unknown>
    expect(runStart.type).toBe("run_start")
    const runEnd = lines.at(-1) as Record<string, unknown>
    expect(Object.keys(runEnd).sort()).toEqual(
      [...base, "activeSockets", "complete"].sort(),
    )
  })

  it("filters extra injected properties so URLs, credentials, and error strings never leak", async () => {
    const outputDir = newOutputDir()
    const diagnostics = new ReplayDiagnostics({
      outputDir,
      numWorkers: 1,
      maxErrors: 5,
    })

    // Simulate a caller that spreads extra material onto an event object.
    // The whitelist must keep it out of the file.
    const tainted = {
      type: "http_error",
      ...CONTEXT,
      phase: "bootstrap",
      method: "GET",
      durationMs: 42,
      aborted: false,
      url: "http://app.example.com/secret-path?api-key=secret-sentinel",
      error: "connect ECONNREFUSED secret-sentinel",
      headers: { Authorization: "Key secret-sentinel" },
      request: { body: "secret-sentinel" },
    }
    diagnostics.emit(tainted as unknown as DiagnosticEvent)
    const extras = {
      url: "http://app.example.com/secret-path",
      payload: { secretKey: "secret-sentinel" },
      error: "ECONNREFUSED secret-sentinel",
    }
    diagnostics.emit({
      type: "session_end",
      ...CONTEXT,
      outcome: "done",
      wsRecvMatched: 5,
      wsRecvIgnored: 1,
      wsRecvTimeout: 2,
      wsRecvMismatch: 3,
      ...extras,
    } as DiagnosticEvent)
    diagnostics.emit({
      type: "ws_recv_skipped",
      ...CONTEXT,
      inputLineNumber: 42,
      reason: "mismatch",
      ...extras,
    } as DiagnosticEvent)
    await diagnostics.finish()

    const lines = readLines(outputDir)
    const event = lines.find((line) => line.type === "http_error")
    expect(event).toBeDefined()
    expect(Object.keys(event!).sort()).toEqual(
      [
        "aborted",
        "durationMs",
        "iterationId",
        "method",
        "phase",
        "schemaVersion",
        "sessionId",
        "timestamp",
        "type",
        "workerId",
      ].sort(),
    )

    const raw = readRaw(outputDir)
    expect(raw).not.toContain("secret-sentinel")
    expect(raw).not.toContain("app.example.com")
    expect(raw).not.toContain("api-key")
    expect(raw).not.toContain("ECONNREFUSED")
    expect(raw).not.toContain("Authorization")
    expect(raw).not.toContain("secretKey")
    expect(lines.find((line) => line.type === "session_end")).toEqual({
      schemaVersion: 1,
      timestamp: expect.any(Number),
      type: "session_end",
      ...CONTEXT,
      outcome: "done",
      wsRecvMatched: 5,
      wsRecvIgnored: 1,
      wsRecvTimeout: 2,
      wsRecvMismatch: 3,
    })
    expect(lines.find((line) => line.type === "ws_recv_skipped")).toEqual({
      schemaVersion: 1,
      timestamp: expect.any(Number),
      type: "ws_recv_skipped",
      ...CONTEXT,
      inputLineNumber: 42,
      reason: "mismatch",
    })
  })
})

// ---------------------------------------------------------------------------
// Socket tracking and finish()
// ---------------------------------------------------------------------------

describe("ReplayDiagnostics finish", () => {
  it("empty finish emits run_end with no active sockets and complete=true", async () => {
    const outputDir = newOutputDir()
    const diagnostics = new ReplayDiagnostics({
      outputDir,
      numWorkers: 1,
      maxErrors: 5,
    })

    await diagnostics.finish()

    const lines = readLines(outputDir)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ type: "run_start" })
    expect(lines.at(-1)).toMatchObject({
      type: "run_end",
      activeSockets: 0,
      complete: true,
    })
  })

  it("second finish() is a no-op and does not write another run_end", async () => {
    const outputDir = newOutputDir()
    const diagnostics = new ReplayDiagnostics({
      outputDir,
      numWorkers: 1,
      maxErrors: 5,
    })

    await diagnostics.finish()
    await diagnostics.finish()

    const lines = readLines(outputDir)
    expect(lines.filter((line) => line.type === "run_end")).toHaveLength(1)
  })

  it("waits for delayed socket closure before emitting run_end", async () => {
    const outputDir = newOutputDir()
    const diagnostics = new ReplayDiagnostics({
      outputDir,
      numWorkers: 1,
      maxErrors: 5,
    })

    const socket = diagnostics.registerSocket()
    expect(socket.socketId).toBe(0)
    const second = diagnostics.registerSocket()
    expect(second.socketId).toBe(1)

    const finishing = diagnostics.finish()

    // finish() cannot resolve until the sockets report closure (no timer has
    // elapsed within a microtask)
    let resolved = false
    finishing.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    second.closed()
    socket.closed()
    socket.closed() // idempotent

    await finishing

    const lines = readLines(outputDir)
    const runEnd = lines.at(-1) as Record<string, unknown>
    expect(runEnd.type).toBe("run_end")
    expect(runEnd.activeSockets).toBe(0)
    expect(runEnd.complete).toBe(true)
  })

  it("stops waiting after 31s and reports an incomplete run_end", async () => {
    vi.useFakeTimers()
    try {
      const outputDir = newOutputDir()
      const diagnostics = new ReplayDiagnostics({
        outputDir,
        numWorkers: 1,
        maxErrors: 5,
      })
      const socket = diagnostics.registerSocket()

      const finishing = diagnostics.finish()
      let resolved = false
      finishing.then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(30_999)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(resolved).toBe(true)
      await finishing

      const lines = readLines(outputDir)
      expect(lines.at(-1)).toMatchObject({
        type: "run_end",
        activeSockets: 1,
        complete: false,
      })

      // The socket can still report closure, but nothing new is recorded.
      const lineCount = lines.length
      expect(() => socket.closed()).not.toThrow()
      expect(readLines(outputDir)).toHaveLength(lineCount)
    } finally {
      vi.useRealTimers()
    }
  })

  it("late events after finish() are ignored and never throw", async () => {
    const outputDir = newOutputDir()
    const diagnostics = new ReplayDiagnostics({
      outputDir,
      numWorkers: 1,
      maxErrors: 5,
    })
    await diagnostics.finish()
    const lineCountBefore = readLines(outputDir).length

    expect(() =>
      diagnostics.emit({ type: "session_start", ...CONTEXT }),
    ).not.toThrow()
    const socket = diagnostics.registerSocket()
    expect(() => socket.closed()).not.toThrow()

    expect(readLines(outputDir)).toHaveLength(lineCountBefore)
  })

  it("propagates writer errors from finish(), not from emit()", async () => {
    // A path whose parent is a regular file: openSync fails (ENOTDIR).
    const notADir = path.join(tmpDir, `blocked-${Date.now()}`)
    fs.writeFileSync(notADir, "not a directory")

    const diagnostics = new ReplayDiagnostics({
      outputDir: notADir,
      numWorkers: 1,
      maxErrors: 5,
    })

    expect(() =>
      diagnostics.emit({ type: "session_start", ...CONTEXT }),
    ).not.toThrow()

    await expect(diagnostics.finish()).rejects.toThrow()
  })
})
