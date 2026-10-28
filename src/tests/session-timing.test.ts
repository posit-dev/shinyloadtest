import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { readRecordingFromString } from "../recording.js"
import { createLogger, LogLevel } from "../logger.js"
import { runSession, Stats } from "../replay/session.js"
import type { Recording, RecordingEvent } from "../types.js"

const server = vi.hoisted(() => ({
  schedule: [] as Array<{ at: number; message?: string; error?: boolean }>,
  sent: 0,
  sendTimes: [] as number[],
  delivered: 0,
  closed: 0,
  closedAt: 0,
  timers: [] as Array<ReturnType<typeof setTimeout>>,
}))

// Replace only the socket transport. Session logic and its actual AsyncQueue,
// including timed polling and abort handling, run unchanged.
vi.mock("../replay/websocket.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../replay/websocket.js")>()
  const { canIgnore } = await import("../sockjs.js")
  class FakeSocket {
    receiveQueue = new actual.AsyncQueue<
      import("../replay/websocket.js").WSMessage
    >(100)
    private failure: ((error: Error) => void) | undefined
    private closed = false
    onFailure(callback: (error: Error) => void): void {
      this.failure = callback
    }
    send(): void {
      server.sent++
      server.sendTimes.push(Date.now())
      for (const item of server.schedule) {
        server.timers.push(
          setTimeout(() => {
            if (this.closed) return
            if (item.error) {
              const error = new Error("server disconnected")
              this.failure?.(error)
              this.receiveQueue.offer({ kind: "error", error })
            } else if (item.message && !canIgnore(item.message)) {
              server.delivered++
              this.receiveQueue.offer({ kind: "text", text: item.message })
            }
          }, item.at),
        )
      }
    }
    async receive(
      _warn: (elapsed: number) => void,
      signal?: AbortSignal,
    ): Promise<string> {
      const message = await this.receiveQueue.poll(30_000, signal)
      if (signal?.aborted) throw signal.reason
      if (!message) throw new Error("fake receive timed out")
      if (message.kind === "error") throw message.error
      return message.text
    }
    close(): void {
      if (this.closed) return
      this.closed = true
      server.closed++
      server.closedAt = Date.now()
      for (const timer of server.timers) clearTimeout(timer)
    }
  }
  return { ...actual, ShinyWebSocket: FakeSocket }
})

const update = JSON.stringify({
  errors: {},
  values: { synthetic: 1 },
  inputMessages: [],
})
const other = JSON.stringify({ custom: { synthetic: 1 } })
const ignored = JSON.stringify({ errors: {}, values: {}, inputMessages: [] })
const epoch = Date.UTC(2020, 0, 1)
let tmp: string

function recording(
  receives: Array<{ at: number; message: string }>,
  closeAt: number,
) {
  const event = (type: string, at: number, extra: object = {}) =>
    JSON.stringify({
      type,
      begin: new Date(epoch + at).toISOString(),
      ...extra,
    })
  return readRecordingFromString(
    [
      "# version: 1",
      "# target_url: http://localhost",
      "# target_type: R/Shiny",
      event("WS_OPEN", 0, { url: "/websocket" }),
      event("WS_SEND", 0, { message: '{"method":"init"}' }),
      ...receives.map(({ at, message }) => event("WS_RECV", at, { message })),
      event("WS_CLOSE", closeAt),
    ].join("\n"),
  )
}

function insertBeforeClose(rec: Recording, event: RecordingEvent): Recording {
  return {
    ...rec,
    events: [...rec.events.slice(0, -1), event, rec.events.at(-1)!],
  }
}

function withBegins(rec: Recording, begins: Record<number, number>): Recording {
  return {
    ...rec,
    events: rec.events.map((event, index) =>
      index in begins ? { ...event, begin: begins[index]! } : event,
    ),
  }
}

function startSession(rec: ReturnType<typeof recording>, signal?: AbortSignal) {
  const stats = new Stats()
  const logger = createLogger({ name: "timing", consoleLevel: LogLevel.SILENT })
  const warnings = vi.spyOn(logger, "warn")
  const result = runSession(
    {
      sessionId: 0,
      workerId: 0,
      iterationId: 0,
      httpUrl: "http://localhost",
      recording: rec,
      recordingPath: "synthetic",
      headers: {},
      creds: { user: null, pass: null, connectApiKey: null },
      logger,
      outputDir: tmp,
      argsString: "test",
      argsJson: "{}",
      signal,
    },
    stats,
  )
  return { result, stats, warnings }
}

function csvEvents() {
  return fs
    .readFileSync(path.join(tmp, "sessions", "0_0_0.csv"), "utf8")
    .split("\n")
    .slice(3)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",")
      return { event: parts[3], time: Number(parts[4]), line: Number(parts[5]) }
    })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(epoch)
  server.schedule = []
  server.sent = 0
  server.sendTimes = []
  server.delivered = 0
  server.closed = 0
  server.closedAt = 0
  server.timers = []
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shinyloadtest-timing-"))
  fs.mkdirSync(path.join(tmp, "sessions"))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("recording-aware receive timing", () => {
  it("consumes the initial message and all four delayed updates before closing", async () => {
    // Different recorded gaps include one shorter than the nominal server poll.
    const receives = [0, 67_107, 101_991, 151_467, 199_406].map((at) => ({
      at,
      message: update,
    }))
    server.schedule = Array.from({ length: 5 }, (_, i) => ({
      at: i * 50_000,
      message: update,
    }))
    const session = startSession(recording(receives, 210_000))
    await vi.advanceTimersByTimeAsync(220_000)
    expect(await session.result).toBe("done")
    const events = csvEvents()
    expect(events.filter((e) => e.event === "WS_RECV_END")).toHaveLength(5)
    expect(server.sent).toBe(1)
    expect(server.delivered).toBe(5)
    expect(server.closed).toBe(1)
    expect(server.closedAt - epoch).toBeGreaterThanOrEqual(200_000)
    expect(session.warnings).not.toHaveBeenCalled()
    expect(session.stats.getCounts()).toMatchObject({
      done: 1,
      failed: 0,
      canceled: 0,
    })
  })

  it("finishes with a finite wait for a missing message", async () => {
    server.schedule = [{ at: 0, message: update }]
    const session = startSession(
      recording(
        [
          { at: 0, message: update },
          { at: 1_000, message: other },
        ],
        2_000,
      ),
    )
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await session.result).toBe("done")
    expect(server.delivered).toBe(1)
    expect(server.closed).toBe(1)
    expect(session.warnings).toHaveBeenCalled()
  })

  it("finishes after multiple missing events instead of waiting indefinitely", async () => {
    const session = startSession(
      recording(
        [
          { at: 0, message: update },
          { at: 0, message: other },
          { at: 0, message: update },
        ],
        0,
      ),
    )
    await vi.advanceTimersByTimeAsync(90_000)
    expect(await session.result).toBe("done")
    expect(server.closedAt - epoch).toBe(90_000)
    expect(session.warnings).toHaveBeenCalledTimes(3)
  })

  it("does not extend the deadline when the wall clock moves backward", async () => {
    server.schedule = [{ at: 10_000, message: other }]
    const session = startSession(
      recording([{ at: 50_000, message: update }], 50_000),
    )
    let outcome: string | undefined
    void session.result.then((result) => {
      outcome = result
    })
    await vi.advanceTimersByTimeAsync(5_000)
    vi.setSystemTime(epoch - 3_600_000)
    await vi.advanceTimersByTimeAsync(80_000)
    expect(outcome).toBe("done")
    expect(server.closed).toBe(1)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("ignores old filtered expectations and matches reordered messages from the buffer", async () => {
    server.schedule = [
      { at: 0, message: other },
      { at: 0, message: update },
    ]
    const session = startSession(
      recording(
        [
          { at: 0, message: ignored },
          { at: 0, message: update },
          { at: 0, message: other },
        ],
        0,
      ),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await session.result).toBe("done")
    expect(server.delivered).toBe(2)
    expect(csvEvents().filter((e) => e.event === "WS_RECV_END")).toHaveLength(3)
    expect(session.warnings).not.toHaveBeenCalled()
  })

  it("preserves bounded mismatch tolerance and completes with a warning", async () => {
    server.schedule = [{ at: 0, message: other }]
    const session = startSession(recording([{ at: 0, message: update }], 0))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await session.result).toBe("done")
    expect(server.delivered).toBe(1)
    expect(server.closed).toBe(1)
    expect(session.warnings).toHaveBeenCalledTimes(1)
    expect(session.warnings.mock.calls[0]![0]).toContain("no match")
    expect(session.stats.getCounts()).toMatchObject({ done: 1, failed: 0 })
    expect(csvEvents().map((event) => event.event)).toContain("PLAYBACK_DONE")
  })

  it("allows fourteen mismatches before a matching message", async () => {
    server.schedule = [
      ...Array.from({ length: 14 }, () => ({ at: 0, message: other })),
      { at: 1_000, message: update },
    ]
    const session = startSession(
      recording([{ at: 50_000, message: update }], 50_000),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await session.result).toBe("done")
    expect(server.delivered).toBe(15)
    expect(session.warnings).not.toHaveBeenCalled()
  })

  it("stops after fifteen mismatches and preserves residual close pacing", async () => {
    server.schedule = Array.from({ length: 16 }, () => ({
      at: 0,
      message: other,
    }))
    const session = startSession(
      recording([{ at: 50_000, message: update }], 100_000),
    )
    await vi.advanceTimersByTimeAsync(100_000)
    expect(await session.result).toBe("done")
    const receiveEnd = csvEvents().find(
      (event) => event.event === "WS_RECV_END",
    )!
    expect(receiveEnd.time - epoch).toBe(0)
    expect(server.delivered).toBe(16)
    expect(server.closedAt - epoch).toBe(100_000)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("waits through an early mismatch for the delayed expected message", async () => {
    server.schedule = [
      { at: 0, message: other },
      { at: 50_000, message: update },
    ]
    const session = startSession(
      recording(
        [
          { at: 50_000, message: update },
          { at: 50_000, message: other },
        ],
        50_000,
      ),
    )
    await vi.advanceTimersByTimeAsync(100_000)
    expect(await session.result).toBe("done")
    expect(server.delivered).toBe(2)
    expect(server.closed).toBe(1)
    expect(session.warnings).not.toHaveBeenCalled()
    expect(
      csvEvents().filter((e) => e.event === "WS_RECV_END")[0]!.time - epoch,
    ).toBeGreaterThanOrEqual(50_000)
  })

  it("uses one bounded deadline even when mismatches keep arriving", async () => {
    server.schedule = [10_000, 20_000, 30_000, 40_000, 50_000].map((at) => ({
      at,
      message: other,
    }))
    const session = startSession(
      recording([{ at: 50_000, message: update }], 50_000),
    )
    await vi.advanceTimersByTimeAsync(100_000)
    expect(await session.result).toBe("done")
    const receiveEnd = csvEvents().find((e) => e.event === "WS_RECV_END")!
    expect(receiveEnd.time - epoch).toBeGreaterThanOrEqual(50_000)
    expect(receiveEnd.time - epoch).toBeLessThanOrEqual(90_000)
    expect(server.delivered).toBe(5)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("does not advance the anchor for an ignored expectation", async () => {
    server.schedule = [{ at: 55_000, message: update }]
    const session = startSession(
      recording(
        [
          { at: 30_000, message: ignored },
          { at: 50_000, message: update },
        ],
        50_000,
      ),
    )
    await vi.advanceTimersByTimeAsync(90_000)
    expect(await session.result).toBe("done")
    expect(server.delivered).toBe(1)
    expect(server.closedAt - epoch).toBe(55_000)
    expect(session.warnings).not.toHaveBeenCalled()
  })

  it("preserves quiet time before close after an ignored expectation", async () => {
    const session = startSession(
      recording([{ at: 50_000, message: ignored }], 100_000),
    )
    await vi.advanceTimersByTimeAsync(100_000)
    expect(await session.result).toBe("done")
    expect(server.closedAt - epoch).toBe(100_000)
    expect(session.warnings).not.toHaveBeenCalled()
  })

  it("consumes a buffered match immediately and anchors the next receive", async () => {
    server.schedule = [
      { at: 0, message: other },
      { at: 0, message: update },
      { at: 50_000, message: update },
    ]
    const session = startSession(
      recording(
        [
          { at: 50_000, message: update },
          { at: 100_000, message: other },
          { at: 150_000, message: update },
        ],
        150_000,
      ),
    )
    await vi.advanceTimersByTimeAsync(90_000)
    expect(await session.result).toBe("done")
    const received = csvEvents().filter(
      (event) => event.event === "WS_RECV_END",
    )
    expect(received.map((event) => event.time - epoch)).toEqual([0, 0, 50_000])
    expect(server.delivered).toBe(3)
    expect(session.warnings).not.toHaveBeenCalled()
  })

  it("paces a send after a skip using only the unspent recorded gap", async () => {
    const rec = insertBeforeClose(
      recording([{ at: 50_000, message: update }], 100_000),
      {
        type: "WS_SEND",
        begin: epoch + 100_000,
        lineNumber: 20,
        message: '{"method":"update"}',
      },
    )
    const session = startSession(rec)
    await vi.advanceTimersByTimeAsync(100_000)
    expect(await session.result).toBe("done")
    expect(server.sendTimes.map((time) => time - epoch)).toEqual([0, 100_000])
    expect(server.closedAt - epoch).toBe(100_000)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("paces a GET after a skip while the socket is open", async () => {
    let requestedAt = 0
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        requestedAt = Date.now()
        return new Response("ok", { status: 200 })
      })
    const rec = insertBeforeClose(
      recording([{ at: 50_000, message: update }], 100_000),
      {
        type: "REQ_GET",
        begin: epoch + 100_000,
        lineNumber: 20,
        url: "/synthetic",
        status: 200,
      },
    )
    const session = startSession(rec)
    await vi.advanceTimersByTimeAsync(100_000)
    expect(await session.result).toBe("done")
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(requestedAt - epoch).toBe(100_000)
    expect(server.closedAt - epoch).toBe(100_000)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("waits for a delayed message after an earlier missing event", async () => {
    server.schedule = [{ at: 65_000, message: update }]
    const session = startSession(
      recording(
        [
          { at: 10_000, message: other },
          { at: 60_000, message: update },
        ],
        70_000,
      ),
    )
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await session.result).toBe("done")
    const receives = csvEvents().filter((e) => e.event === "WS_RECV_END")
    expect(receives).toHaveLength(2)
    expect(receives[1]!.time - epoch).toBeGreaterThanOrEqual(65_000)
    expect(server.delivered).toBe(1)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("does not add the full recorded gap again after a skipped receive", async () => {
    const session = startSession(
      recording([{ at: 50_000, message: update }], 100_000),
    )
    await vi.advanceTimersByTimeAsync(150_000)
    expect(await session.result).toBe("done")
    expect(server.closedAt - epoch).toBe(100_000)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("bounds an extreme recorded receive gap", async () => {
    const session = startSession(
      recording([{ at: 86_400_000, message: update }], 86_400_000),
    )
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(await session.result).toBe("done")
    expect(server.closedAt - epoch).toBe(900_000)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("uses the finite minimum for backwards timestamps", async () => {
    server.schedule = [{ at: 0, message: update }]
    const session = startSession(
      recording(
        [
          { at: 1_000, message: update },
          { at: -1_000, message: other },
        ],
        -1_000,
      ),
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await session.result).toBe("done")
    expect(server.closedAt - epoch).toBe(30_000)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("uses the finite minimum for invalid programmatic event timestamps", async () => {
    const rec = withBegins(recording([{ at: 0, message: update }], 0), {
      2: Number.NaN,
    })
    const session = startSession(rec)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await session.result).toBe("done")
    expect(server.closedAt - epoch).toBe(30_000)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("handles overflowing programmatic timestamp differences", async () => {
    const rec = withBegins(recording([{ at: 0, message: update }], 0), {
      1: -1e308,
      2: 1e308,
      3: 1e308,
    })
    const session = startSession(rec)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await session.result).toBe("done")
    expect(server.closedAt - epoch).toBe(30_000)
    expect(session.warnings).toHaveBeenCalledTimes(1)
  })

  it("rejects malformed timestamps at recording parse time", () => {
    expect(() =>
      readRecordingFromString(
        [
          "# version: 1",
          "# target_url: http://localhost",
          "# target_type: R/Shiny",
          JSON.stringify({ type: "WS_CLOSE", begin: "invalid" }),
        ].join("\n"),
      ),
    ).toThrow("Invalid begin timestamp")
  })

  it("still requires an exact string-frame match", async () => {
    server.schedule = [{ at: 0, message: "o" }]
    const session = startSession(recording([{ at: 0, message: "o" }], 0))
    await vi.advanceTimersByTimeAsync(0)
    expect(await session.result).toBe("done")
    expect(server.delivered).toBe(1)
    expect(session.warnings).not.toHaveBeenCalled()
  })

  it("fails on a different string frame", async () => {
    server.schedule = [{ at: 0, message: update }]
    const session = startSession(recording([{ at: 0, message: "o" }], 0))
    await vi.advanceTimersByTimeAsync(0)
    expect(await session.result).toBe("failed")
    expect(server.delivered).toBe(1)
    expect(server.closed).toBe(1)
  })

  it("fails promptly on server error during a receive", async () => {
    server.schedule = [{ at: 5_000, error: true }]
    const session = startSession(
      recording([{ at: 50_000, message: update }], 50_000),
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await session.result).toBe("failed")
    expect(server.closed).toBe(1)
    expect(session.stats.getCounts()).toMatchObject({ failed: 1, done: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("propagates server errors after an early mismatch", async () => {
    server.schedule = [
      { at: 0, message: other },
      { at: 5_000, error: true },
    ]
    const session = startSession(
      recording([{ at: 50_000, message: update }], 50_000),
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await session.result).toBe("failed")
    expect(server.delivered).toBe(1)
    expect(server.closed).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("interrupts residual pacing when the server fails", async () => {
    server.schedule = [
      ...Array.from({ length: 15 }, () => ({ at: 0, message: other })),
      { at: 5_000, error: true },
    ]
    const session = startSession(
      recording([{ at: 50_000, message: update }], 100_000),
    )
    let outcome: string | undefined
    void session.result.then((result) => {
      outcome = result
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(outcome).toBe("failed")
    expect(server.closed).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cancels residual pacing and closes promptly", async () => {
    server.schedule = Array.from({ length: 15 }, () => ({
      at: 0,
      message: other,
    }))
    const controller = new AbortController()
    const session = startSession(
      recording([{ at: 50_000, message: update }], 100_000),
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(5_000)
    controller.abort(new Error("test shutdown"))
    await vi.advanceTimersByTimeAsync(0)
    expect(await session.result).toBe("canceled")
    expect(server.closedAt - epoch).toBe(5_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cancels a pending receive and closes immediately", async () => {
    const controller = new AbortController()
    const session = startSession(
      recording([{ at: 50_000, message: update }], 50_000),
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(5_000)
    controller.abort(new Error("test shutdown"))
    await vi.advanceTimersByTimeAsync(0)
    expect(await session.result).toBe("canceled")
    expect(server.closed).toBe(1)
    expect(server.closedAt - epoch).toBe(5_000)
    expect(vi.getTimerCount()).toBe(0)
  })
})
