/**
 * Deterministic, controlled-time tests for worker orchestration: jittered
 * exponential failure backoff (growth, cap, reset), no delay after success,
 * prompt cancellation while backing off, max-errors accounting, warmup
 * gates for workers aborted before launch, per-worker independence, and
 * unexpected worker errors. Session outcomes are driven by mocking
 * runSession; stats are only asserted where they are the production signal
 * (max-errors threshold, final counts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { runEnduranceTest, MaxErrorsExceededError } from "../replay/worker.js"
import type { EnduranceTestConfig } from "../replay/worker.js"
import type { ReplayDiagnostics } from "../replay/diagnostics.js"
import type { ReplayTerminalUI } from "../replay/ui.js"
import type { SessionConfig, SessionOutcome, Stats } from "../replay/session.js"
import type { Logger } from "../logger.js"
import type { Recording } from "../types.js"
import { ServerType } from "../types.js"

const { runSessionMock } = vi.hoisted(() => ({ runSessionMock: vi.fn() }))

vi.mock("../replay/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../replay/session.js")>()
  return { ...actual, runSession: runSessionMock }
})

// ---------------------------------------------------------------------------
// Outcome control
// ---------------------------------------------------------------------------

/** Decides each session's outcome from its config; overridden per test. */
let outcomeFor: (config: SessionConfig) => SessionOutcome = () => "done"

beforeEach(() => {
  vi.useFakeTimers()
  outcomeFor = () => "done"
  runSessionMock.mockImplementation(
    async (config: SessionConfig, stats: Stats): Promise<SessionOutcome> => {
      const outcome = outcomeFor(config)
      stats.transition("running")
      // Bound instant-success loops so a failed assertion cannot starve the
      // test runner's real timeout. The blocked mock session ends on shutdown.
      if (outcome === "done" && config.iterationId >= 1000) {
        await new Promise<void>((resolve) => {
          if (config.signal?.aborted) resolve()
          else
            config.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            })
        })
        stats.transition("canceled")
        return "canceled"
      }
      stats.transition(outcome)
      return outcome
    },
  )
})

afterEach(async () => {
  // Let active runs reach their loaded-duration shutdown even when the test
  // failed before advancing its clock. A second pass covers delayed warmup.
  advance(120 * 60_000)
  await flush()
  advance(120 * 60_000)
  await flush()
  // Reach the mock's safety bound if a regression prevents shutdown.
  await flush(3000)
  vi.clearAllTimers()
  runSessionMock.mockReset()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const recording: Recording = {
  props: {
    version: 1,
    targetUrl: "http://example.com/",
    targetType: ServerType.SSP,
    rscApiKeyRequired: false,
  },
  events: [],
}

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
    }
  }
  return { logger: makeLogger(""), messages }
}

function createDiagnostics(): {
  diagnostics: ReplayDiagnostics
  events: Array<Record<string, unknown>>
} {
  const events: Array<Record<string, unknown>> = []
  const sink = {
    emit(event: Record<string, unknown>): void {
      events.push(event)
    },
  }
  return { diagnostics: sink as unknown as ReplayDiagnostics, events }
}

function createUi(): {
  ui: ReplayTerminalUI
  calls: {
    finish: ReturnType<typeof vi.fn>
    finishMaxErrors: ReturnType<typeof vi.fn>
  }
} {
  const finish = vi.fn()
  const finishMaxErrors = vi.fn()
  const ui = {
    startWarmup: vi.fn(),
    workerProgress: vi.fn(),
    workerReady: vi.fn(),
    startLoaded: vi.fn(),
    startShutdown: vi.fn(),
    finish,
    finishMaxErrors,
  }
  return {
    ui: ui as unknown as ReplayTerminalUI,
    calls: { finish, finishMaxErrors },
  }
}

function makeConfig(overrides: Partial<EnduranceTestConfig> = {}): {
  config: EnduranceTestConfig
  events: Array<Record<string, unknown>>
  messages: string[]
  uiCalls: ReturnType<typeof createUi>["calls"]
} {
  const { logger, messages } = createCapturingLogger()
  const { diagnostics, events } = createDiagnostics()
  const { ui, calls } = createUi()
  const config: EnduranceTestConfig = {
    httpUrl: "http://example.com/",
    recording,
    recordingPath: "/tmp/recording.log",
    headers: {},
    creds: {
      user: "secret-user",
      pass: "secret-pass",
      connectApiKey: "secret-key",
    },
    numWorkers: 1,
    warmupInterval: 0,
    loadedDurationMinutes: 60,
    maxErrors: 0,
    outputDir: "/tmp/shinyloadtest-worker-backoff",
    logger,
    argsString: "replay test",
    argsJson: "{}",
    ui,
    diagnostics,
    ...overrides,
  }
  return { config, events, messages, uiCalls: calls }
}

// ---------------------------------------------------------------------------
// Controlled-time driving
// ---------------------------------------------------------------------------

/** Fire all timers due within `ms`, synchronously (microtasks are not drained). */
function advance(ms: number): void {
  vi.advanceTimersByTime(ms)
}

/** Run queued microtasks for a bounded number of rounds. */
async function flush(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

/**
 * Start a run, fire the zero-length stagger timers, and settle once.
 * The run's completion promise is stored in an object so `await` doesn't
 * assimilate it, with a rejection handler attached immediately so an early
 * failure during the startup flush can't surface as a test-owned unhandled
 * rejection. Tests observe the outcome via `completion`.
 */
async function startRun(
  config: EnduranceTestConfig,
): Promise<{ completion: Promise<void> }> {
  const completion = runEnduranceTest(config)
  completion.catch(() => {})
  advance(0)
  await flush()
  return { completion }
}

function sessionConfigs(): SessionConfig[] {
  return runSessionMock.mock.calls.map((c) => c[0] as SessionConfig)
}

function callsForWorker(workerId: number): SessionConfig[] {
  return sessionConfigs().filter((c) => c.workerId === workerId)
}

function retryWaits(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return events.filter((e) => e["type"] === "retry_wait")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runEnduranceTest failure backoff", () => {
  it("grows the delay exponentially per failure, caps at 30s, resets after success", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5) // jitter factor exactly 1
    const outcomes: SessionOutcome[] = [
      "done", // warmup
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed", // six consecutive failures
      "done", // resets the backoff
      "failed", // starts over at ~1s
    ]
    outcomeFor = (c) => outcomes[c.iterationId] ?? "done"
    const { config, events, messages, uiCalls } = makeConfig()
    const { completion: promise } = await startRun(config)

    // Warmup succeeded, then the first loop session failed: backing off 1000ms.
    expect(sessionConfigs()).toHaveLength(2)
    expect(retryWaits(events)).toHaveLength(1)

    advance(999)
    expect(sessionConfigs()).toHaveLength(2) // still backing off

    advance(1)
    await flush()
    expect(sessionConfigs()).toHaveLength(3) // second attempt ran

    // Drive each retry so its wait actually elapses on the fake clock.
    advance(2_000)
    await flush() // 3rd session failed (cf 2): wait 2000ms
    advance(4_000)
    await flush() // 4th session failed (cf 3): wait 4000ms
    advance(8_000)
    await flush() // 5th session failed (cf 4): wait 8000ms
    advance(16_000)
    await flush() // 6th session failed (cf 5): wait 16000ms
    advance(30_000)
    await flush() // 7th session succeeded; 8th failed (cf 1): wait 1000ms

    const waits = retryWaits(events)
    expect(waits.map((e) => e["delayMs"])).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 1000,
    ])
    expect(waits.map((e) => e["consecutiveFailures"])).toEqual([
      1, 2, 3, 4, 5, 6, 1,
    ])

    // The first wait describes the session about to be retried.
    expect(waits[0]).toEqual({
      type: "retry_wait",
      sessionId: 2,
      workerId: 0,
      iterationId: 2,
      delayMs: 1000,
      consecutiveFailures: 1,
    })

    // The retry delay is explained in the logs, without credential data.
    const warnLines = messages.filter((m) => m.startsWith("WARN"))
    expect(
      warnLines.some((m) =>
        m.includes("1 consecutive failure; retrying in 1000ms"),
      ),
    ).toBe(true)
    expect(
      warnLines.some((m) =>
        m.includes("6 consecutive failures; retrying in 30000ms"),
      ),
    ).toBe(true)
    expect(
      messages.some(
        (m) =>
          m.includes("secret-user") ||
          m.includes("secret-pass") ||
          m.includes("secret-key"),
      ),
    ).toBe(false)

    // End the loaded phase and settle.
    advance(3_600_000 - 61_000)
    await flush()
    await promise

    const counts = uiCalls.finish.mock.calls[0]?.[0]
    expect(counts.failed).toBe(7)
    expect(counts.done).toBeGreaterThanOrEqual(2)
    expect(counts.canceled).toBe(0)
  })

  it("does not delay between successful sessions", async () => {
    outcomeFor = () => "done"
    const { config, events, messages } = makeConfig({
      loadedDurationMinutes: 1,
    })
    const { completion: promise } = await startRun(config)

    expect(sessionConfigs().length).toBeGreaterThanOrEqual(3)
    // No delay timers beyond the loaded-duration wait.
    expect(vi.getTimerCount()).toBe(1)
    expect(retryWaits(events)).toEqual([])
    expect(messages.filter((m) => m.startsWith("WARN"))).toEqual([])

    advance(60_000)
    await flush()
    await promise
  })

  it("stops promptly when the loaded duration ends mid-backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    outcomeFor = (c) => (c.iterationId === 0 ? "failed" : "done")
    const { config, events, uiCalls } = makeConfig({
      loadedDurationMinutes: 0.01, // 600ms, shorter than the 1000ms backoff
    })
    const { completion: promise } = await startRun(config)

    // The worker failed its warmup and is backing off for 1000ms.
    expect(sessionConfigs()).toHaveLength(1)
    expect(retryWaits(events)).toHaveLength(1)

    advance(600)
    await flush()
    await promise

    // Shutdown aborted the backoff wait: the retry never ran.
    expect(sessionConfigs()).toHaveLength(1)
    const counts = uiCalls.finish.mock.calls[0]?.[0]
    expect(counts.failed).toBe(1)
    expect(counts.done).toBe(0)
    expect(counts.canceled).toBe(0)
  })

  it("aborts in-flight backoffs and throws once max errors is reached", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    // Worker 1 fails its warmup and is mid-backoff (retry pending) when
    // worker 2's sixth session trips the threshold and aborts the wait.
    outcomeFor = (c) =>
      c.workerId === 1 ? (c.iterationId === 5 ? "failed" : "done") : "failed"
    const { config, events, uiCalls } = makeConfig({
      numWorkers: 2,
      maxErrors: 2,
    })
    const { completion: promise } = await startRun(config)

    const error = await promise.then(
      () => {
        throw new Error("expected MaxErrorsExceededError")
      },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(MaxErrorsExceededError)
    expect(error).toHaveProperty("totalFailures", 2)

    // Worker 1's retry never ran: the threshold aborted its backoff wait.
    expect(callsForWorker(0).map((c) => c.iterationId)).toEqual([0])
    expect(callsForWorker(1)).toHaveLength(6)
    expect(retryWaits(events).map((e) => e["delayMs"])).toEqual([1000])
    expect(uiCalls.finishMaxErrors).toHaveBeenCalledTimes(1)
    expect(uiCalls.finishMaxErrors.mock.calls[0]?.[0].failed).toBe(2)
  })

  it("settles warmup gates for workers aborted before launch (no hang)", async () => {
    outcomeFor = () => "failed"
    const { config } = makeConfig({
      numWorkers: 3,
      warmupInterval: 1000,
      maxErrors: 1,
    })
    const { completion: promise } = await startRun(config)

    // Worker 1 fails its warmup immediately, tripping max errors; workers 2
    // and 3 are aborted mid-stagger but still settle their gates, so the
    // warmup phase completes instead of hanging forever.
    const error = await promise.then(
      () => {
        throw new Error("expected MaxErrorsExceededError")
      },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(MaxErrorsExceededError)
    expect(error).toHaveProperty("totalFailures", 1)
    expect(sessionConfigs()).toHaveLength(1)
  })

  it("rethrows an unexpected worker error and aborts sibling workers without an unhandled rejection", async () => {
    const csvError = new Error("EACCES: cannot open session CSV")
    runSessionMock.mockImplementation(
      async (config: SessionConfig, stats: Stats): Promise<SessionOutcome> => {
        if (config.workerId === 0 && config.iterationId === 1) {
          throw csvError
        }
        const outcome = outcomeFor(config)
        stats.transition("running")
        stats.transition(outcome)
        return outcome
      },
    )
    const unhandled: Array<{ reason: unknown }> = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push({ reason })
    }
    process.on("unhandledRejection", onUnhandledRejection)
    try {
      const { config, uiCalls } = makeConfig({
        numWorkers: 2,
        warmupInterval: 1000,
      })
      const { completion: promise } = await startRun(config)

      const error = await promise.then(
        () => {
          throw new Error("expected the worker error to propagate")
        },
        (e: unknown) => e,
      )
      expect(error).toBe(csvError) // the original error is rethrown

      // Worker 1's warmup session ran, its next session rejected, and
      // worker 2 was aborted mid-stagger without ever launching a session.
      expect(sessionConfigs().every((c) => c.workerId === 0)).toBe(true)
      expect(sessionConfigs().map((c) => c.iterationId)).toEqual([0, 1])
      expect(uiCalls.finish).not.toHaveBeenCalled()
      expect(uiCalls.finishMaxErrors).not.toHaveBeenCalled()
      await flush(50) // let any stray continuations surface
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
    }
    expect(unhandled).toEqual([])
  })

  it("applies backoff per worker, independently", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    outcomeFor = (c) => (c.workerId === 0 ? "failed" : "done")
    const { config, events } = makeConfig({
      numWorkers: 2,
      loadedDurationMinutes: 1,
    })
    const { completion: promise } = await startRun(config)

    // Worker 1 failed its warmup and is backing off; worker 2 keeps
    // succeeding with no delay.
    expect(callsForWorker(0)).toHaveLength(1)
    expect(callsForWorker(1).length).toBeGreaterThan(5)
    expect(retryWaits(events).map((e) => e["workerId"])).toEqual([0])

    advance(1_000) // worker 1's ~1s backoff elapses
    await flush(20)
    expect(callsForWorker(0)).toHaveLength(2)

    // End the loaded phase mid-backoff (worker 1 is waiting 2000ms). The
    // exact tail count depends on microtask interleaving; the invariant is
    // that only worker 1 ever waits, its delays grow from its own failures,
    // and worker 2 runs freely throughout.
    advance(59_000)
    await flush(100)
    await promise

    expect(callsForWorker(0).length).toBeGreaterThanOrEqual(2)
    const waits = retryWaits(events)
    expect(waits.every((e) => e["workerId"] === 0)).toBe(true)
    expect(waits.map((e) => e["delayMs"]).slice(0, 2)).toEqual([1000, 2000])
    expect(waits.map((e) => e["consecutiveFailures"]).slice(0, 2)).toEqual([
      1, 2,
    ])
    expect(callsForWorker(1).length).toBeGreaterThan(
      callsForWorker(0).length + 5,
    )
  })

  it("treats a canceled session as neither a failure nor a success", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const outcomes: SessionOutcome[] = [
      "failed", // warmup: cf 1, wait 1000ms
      "failed", // cf 2, wait 2000ms
      "canceled", // no increment, no reset: still cf 2, wait 2000ms
      "failed", // cf 3, wait 4000ms
    ]
    outcomeFor = (c) => outcomes[c.iterationId] ?? "done"
    const { config, events } = makeConfig()
    const { completion: promise } = await startRun(config)

    advance(1_000)
    await flush(10)
    advance(2_000)
    await flush(10)
    advance(2_000)
    await flush(10)
    advance(4_000)
    await flush(10)

    const waits = retryWaits(events)
    expect(waits.map((e) => e["consecutiveFailures"])).toEqual([1, 2, 2, 3])
    expect(waits.map((e) => e["delayMs"])).toEqual([1000, 2000, 2000, 4000])

    advance(3_600_000 - 9_000)
    await flush()
    await promise
  })

  it("aborts staggered starts and settles gates at a 45-worker fan-out", async () => {
    outcomeFor = () => "failed"
    const warnings: string[] = []
    const onWarning = (w: Error): void => {
      warnings.push(w.message)
    }
    process.on("warning", onWarning)
    try {
      const { config } = makeConfig({
        numWorkers: 45,
        warmupInterval: 100,
        maxErrors: 1,
      })
      const { completion: promise } = await startRun(config)

      // The first worker trips max errors during the ramp; the other 44
      // workers are aborted mid-stagger, settle their gates, and never
      // launch a session.
      const error = await promise.then(
        () => {
          throw new Error("expected MaxErrorsExceededError")
        },
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(MaxErrorsExceededError)
      expect(sessionConfigs().map((c) => c.workerId)).toEqual([0])
    } finally {
      process.off("warning", onWarning)
    }
    expect(warnings.filter((m) => m.includes("MaxListenersExceeded"))).toEqual(
      [],
    )
  })
})
