/**
 * Worker orchestration module. Implements the EnduranceTest: multiple
 * concurrent workers, each looping through recording sessions, with
 * staggered start, loaded duration control, per-worker failure backoff,
 * and progress reporting.
 */

import type { Logger } from "../logger.js"
import { Stats, WS_RECV_MAX_GAP_MS, runSession } from "./session.js"
import type { RequiredReceiveWait, SessionConfig } from "./session.js"
import type { Recording, Creds } from "../types.js"
import type { ReplayTerminalUI } from "./ui.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnduranceTestConfig {
  httpUrl: string
  recording: Recording
  recordingPath: string
  headers: Record<string, string>
  creds: Creds
  numWorkers: number
  warmupInterval: number
  loadedDurationMinutes: number
  maxErrors: number
  outputDir: string
  logger: Logger
  argsString: string
  argsJson: string
  ui?: ReplayTerminalUI
  /** No-throw sink for allowlisted, credential-free event objects. */
  diagnostics?: import("./diagnostics.js").ReplayDiagnostics
  /**
   * Warmup liveness ceiling in milliseconds. Defaults to `WARMUP_CEILING_MS`;
   * injected by tests so they need not wait 15 minutes.
   */
  warmupCeilingMs?: number
}

/**
 * Error thrown when the cumulative session failure count exceeds --max-errors.
 */
export class MaxErrorsExceededError extends Error {
  readonly maxErrors: number
  readonly totalFailures: number

  constructor(maxErrors: number, totalFailures: number) {
    super(
      `Max errors exceeded (${totalFailures} failures, limit ${maxErrors}). ` +
        `Use --max-errors to adjust or set to 0 to disable.`,
    )
    this.name = "MaxErrorsExceededError"
    this.maxErrors = maxErrors
    this.totalFailures = totalFailures
  }
}

/** A worker and the required receive it was waiting on when warmup timed out. */
export interface WarmupStall {
  workerId: number
  wait: RequiredReceiveWait
}

/**
 * Error thrown when warmup goes `WARMUP_CEILING_MS` without any session
 * finishing. On its own that is a stall, not a slow start: a session that is
 * still progressing keeps resetting the ceiling, so reaching it means nothing
 * is finishing any more. `stalled` names the workers that were parked on a
 * required protocol message at that moment, which is where the run is stuck.
 */
export class WarmupTimeoutError extends Error {
  readonly ceilingMs: number
  readonly numWorkers: number
  readonly stalled: WarmupStall[]

  constructor(options: {
    ceilingMs: number
    numWorkers: number
    stalled: WarmupStall[]
  }) {
    const { ceilingMs, numWorkers, stalled } = options
    const named = stalled.slice(0, WARMUP_TIMEOUT_LISTED_WORKERS)
    const remaining = stalled.length - named.length
    const status =
      stalled.length === 0
        ? "No worker was waiting on a required message."
        : `Stalled: ${named
            .map(
              ({ workerId, wait }) =>
                `worker ${workerId + 1} was waiting for ${wait.type} at recording line ${wait.lineNumber}`,
            )
            .join("; ")}${remaining > 0 ? `; and ${remaining} more` : ""}.`

    super(
      `Warmup timed out after ${formatDuration(ceilingMs)}: no session finished, ` +
        `so the test never started maintaining load (${stalled.length} of ` +
        `${numWorkers} workers waiting). ${status} The application may still ` +
        `be starting; if it is not, the recording no longer matches what the ` +
        `application sends over the WebSocket.`,
    )
    this.name = "WarmupTimeoutError"
    this.ceilingMs = ceilingMs
    this.numWorkers = numWorkers
    this.stalled = stalled
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait `ms`, resolving early if `signal` aborts; removes its abort listener once settled. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Human-readable duration for messages: `300ms`, `45s`, `15 minutes`. */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.round(ms / 60_000)
  return `${minutes} minute${minutes === 1 ? "" : "s"}`
}

// ---------------------------------------------------------------------------
// Failure backoff
// ---------------------------------------------------------------------------

/** Base delay before retrying a failed session, doubled per consecutive failure. */
const RETRY_BASE_DELAY_MS = 1_000

/** Upper bound on the retry delay, applied after jitter. */
const RETRY_MAX_DELAY_MS = 30_000

/** Jitter range as a fraction of the exponential delay (±25%). */
const RETRY_JITTER_FRACTION = 0.25

/**
 * How long warmup may go without a session finishing before the run is
 * declared stuck.
 *
 * A required-protocol receive (`WS_RECV_INIT`, `WS_RECV_BEGIN_UPLOAD`, the
 * SockJS open frame) waits indefinitely by design: a recording says nothing
 * about how long the server may take, and failing a session that would have
 * recovered only adds retry load. That is safe while something bounds the run
 * — the loaded-duration timer does, but only after warmup: it starts once
 * every worker's first session has finished, and `--max-errors` only counts
 * sessions that end. Without a ceiling, a run in which every worker is waiting
 * on a required message never finishes, never trips `--max-errors`, and can
 * only be stopped by Ctrl+C, which exits without closing anything.
 *
 * This bounds *liveness*, not the individual receive: a session that is slow
 * but still finishing keeps resetting it. 15 minutes is the same cap the
 * receive policy puts on a quiet interval (`WS_RECV_MAX_GAP_MS`), so the tool
 * has one ceiling rather than two.
 */
export const WARMUP_CEILING_MS = WS_RECV_MAX_GAP_MS

/** Workers named in the warmup-timeout message before it is summarized. */
const WARMUP_TIMEOUT_LISTED_WORKERS = 5

/**
 * Jittered exponential backoff: ~1s after the first failure, doubling per
 * consecutive failure, capped at 30s. Jitter keeps workers that fail
 * together from retrying in lockstep.
 */
function computeRetryDelayMs(consecutiveFailures: number): number {
  const exponential = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** (consecutiveFailures - 1),
    RETRY_MAX_DELAY_MS,
  )
  const jitterFactor = 1 + (Math.random() * 2 - 1) * RETRY_JITTER_FRACTION
  return Math.min(Math.round(exponential * jitterFactor), RETRY_MAX_DELAY_MS)
}

// ---------------------------------------------------------------------------
// runEnduranceTest
// ---------------------------------------------------------------------------

export async function runEnduranceTest(
  config: EnduranceTestConfig,
): Promise<void> {
  const {
    httpUrl,
    recording,
    recordingPath,
    headers,
    creds,
    numWorkers,
    warmupInterval,
    loadedDurationMinutes,
    maxErrors,
    outputDir,
    logger,
    argsString,
    argsJson,
    ui,
    diagnostics,
    warmupCeilingMs = WARMUP_CEILING_MS,
  } = config

  const stats = new Stats()

  // Session counter (safe in single-threaded Node.js)
  let sessionCounter = 0
  function nextSessionId(): number {
    return sessionCounter++
  }

  // Progress reporting: log stats every 5 seconds (only when no UI)
  const progressInterval = ui
    ? null
    : setInterval(() => {
        logger.info(stats.toString())
      }, 5000)

  ui?.startWarmup()

  // Shared flag to signal workers to stop after loaded duration
  let keepWorking = true
  const abortController = new AbortController()
  const signal = abortController.signal

  let maxErrorsTriggered = false
  // First unexpected worker exception (runSession normally never throws,
  // e.g. a session CSV that can't be opened). Rethrown after all workers
  // settle, never surfaced as an unhandled rejection. `workerFailed` is the
  // guard — the error itself may be null or undefined.
  let workerFailed = false
  let workerError: unknown = null

  function stopAll(): void {
    keepWorking = false
    abortController.abort()
  }

  /** Check if cumulative failures have exceeded --max-errors. */
  function checkMaxErrors(): void {
    if (maxErrors > 0 && stats.getCounts().failed >= maxErrors) {
      if (!maxErrorsTriggered) {
        maxErrorsTriggered = true
        logger.error(`Max errors (${maxErrors}) exceeded — stopping test`)
        stopAll()
      }
    }
  }

  // Warmup liveness watchdog. A session that is slow but still finishing resets
  // it; reaching the ceiling means nothing is finishing, and only an abort can
  // unblock a session parked on a required protocol receive.
  let inWarmup = true
  let warmupTimedOut = false
  let warmupTimer: ReturnType<typeof setTimeout> | null = null
  /** The required receive each worker is currently waiting on, by worker id. */
  const waitingReceives = new Map<number, RequiredReceiveWait>()
  /** What `waitingReceives` held when the ceiling fired. */
  const stalledAtTimeout: WarmupStall[] = []

  function clearWarmupWatchdog(): void {
    if (warmupTimer !== null) {
      clearTimeout(warmupTimer)
      warmupTimer = null
    }
  }

  function armWarmupWatchdog(): void {
    clearWarmupWatchdog()
    if (!inWarmup || warmupCeilingMs <= 0) return
    warmupTimer = setTimeout(() => {
      warmupTimer = null
      if (!inWarmup || warmupTimedOut) return
      warmupTimedOut = true
      // Snapshot before aborting: each session clears its entry as it unwinds.
      for (const [workerId, wait] of waitingReceives) {
        stalledAtTimeout.push({ workerId, wait })
      }
      // stopAll() aborts every waiting receive, so the sessions parked on a
      // required message end as canceled and close their sockets by handshake.
      logger.error(
        `Warmup timed out after ${formatDuration(warmupCeilingMs)} with no session finished — stopping test`,
      )
      stopAll()
    }, warmupCeilingMs)
    // Never keep the process alive just for the watchdog.
    warmupTimer.unref?.()
  }

  // Per-worker warmup gates. Every worker settles its own gate on every
  // exit path — including when aborted before its first session — so the
  // warmup phase can never hang.
  const warmupPromises: Promise<void>[] = []
  const warmupResolvers: Array<() => void> = []

  for (let i = 0; i < numWorkers; i++) {
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    warmupPromises.push(promise)
    warmupResolvers.push(resolve)
  }

  // Worker function
  async function workerFn(workerId: number): Promise<void> {
    const workerLogger = logger.child(
      `thread${String(workerId + 1).padStart(2, "0")}`,
    )

    // Worker-local backoff state, driven only by this worker's own session
    // outcomes — never by the shared Stats, which counts every worker.
    let consecutiveFailures = 0

    await sleep(workerId * warmupInterval, signal)

    if (maxErrorsTriggered || signal.aborted) {
      // Aborted before launch: settle the gate without warming up.
      warmupResolvers[workerId]!()
      return
    }

    workerLogger.info("Warming up")

    let iteration = 0

    // Build session config (shared fields)
    function buildSessionConfig(): SessionConfig {
      return {
        sessionId: nextSessionId(),
        workerId,
        iterationId: iteration++,
        httpUrl,
        recording,
        recordingPath,
        headers,
        creds,
        logger: workerLogger,
        outputDir,
        argsString,
        argsJson,
        signal,
        diagnostics,
        onRequiredReceiveWait: (wait) => {
          if (wait === null) {
            waitingReceives.delete(workerId)
          } else {
            waitingReceives.set(workerId, wait)
          }
        },
      }
    }

    /** Run one session and fold its outcome into the backoff state. */
    async function runOneSession(sessionConfig: SessionConfig): Promise<void> {
      const outcome = await runSession(sessionConfig, stats)
      waitingReceives.delete(workerId)
      // A session finished, so warmup is still making progress: restart the
      // ceiling rather than measuring from the start of the run.
      armWarmupWatchdog()
      if (outcome === "failed") {
        consecutiveFailures++
      } else if (outcome === "done") {
        // Only a successful session resets the backoff; "canceled" is
        // shutdown, not a failure.
        consecutiveFailures = 0
      }
    }

    // First session (warmup)
    try {
      const warmupConfig = buildSessionConfig()
      warmupConfig.onProgress = (eventIndex, totalEvents) => {
        ui?.workerProgress(workerId, eventIndex, totalEvents)
      }
      await runOneSession(warmupConfig)
    } finally {
      warmupResolvers[workerId]!()
      ui?.workerReady()
    }

    checkMaxErrors()

    // Subsequent sessions
    while (keepWorking) {
      const sessionConfig = buildSessionConfig()

      if (consecutiveFailures > 0) {
        // Back off before the next attempt; the wait aborts promptly on
        // max-errors or shutdown so a failing worker never hammers the
        // server or outlives the test.
        const delayMs = computeRetryDelayMs(consecutiveFailures)
        const failureWord = consecutiveFailures === 1 ? "failure" : "failures"
        workerLogger.warn(
          `${consecutiveFailures} consecutive ${failureWord}; retrying in ${delayMs}ms`,
        )
        diagnostics?.emit({
          type: "retry_wait",
          sessionId: sessionConfig.sessionId,
          workerId,
          iterationId: sessionConfig.iterationId,
          delayMs,
          consecutiveFailures,
        })
        await sleep(delayMs, signal)
        if (!keepWorking) {
          break
        }
      } else {
        workerLogger.info("Running again")
      }

      await runOneSession(sessionConfig)
      checkMaxErrors()
    }

    workerLogger.info("Stopped")
  }

  // Launch all workers concurrently. A worker that exits through an
  // unexpected exception is captured here: stopAll() cancels sibling workers
  // and every pending wait, the warmup gate is settled, and the original
  // error is rethrown after every worker settles (nothing is logged here:
  // the logger can itself fail, and main rethrows the original error).
  const workerPromises: Promise<void>[] = []
  for (let i = 0; i < numWorkers; i++) {
    const settleGate = warmupResolvers[i]!
    workerPromises.push(
      workerFn(i).catch((err: unknown) => {
        settleGate()
        if (!workerFailed) {
          workerFailed = true
          workerError = err
        }
        stopAll()
      }),
    )
  }

  try {
    // Wait for all workers to complete their first session (warmup phase)
    logger.info("Waiting for warmup to complete")
    armWarmupWatchdog()
    await Promise.all(warmupPromises)
    inWarmup = false
    clearWarmupWatchdog()

    if (warmupTimedOut) {
      // Abort already happened when the ceiling fired; let the parked sessions
      // finish their cancellation, then report the stall.
      await Promise.all(workerPromises)
      const reason = `Warmup timed out after ${formatDuration(warmupCeilingMs)}`
      ui?.finishStartupFailure(reason)
      throw new WarmupTimeoutError({
        ceilingMs: warmupCeilingMs,
        numWorkers,
        stalled: stalledAtTimeout,
      })
    }

    if (workerFailed || maxErrorsTriggered) {
      // Already stopping — skip loaded phase
      await Promise.all(workerPromises)
      if (workerFailed) throw workerError
      const counts = stats.getCounts()
      ui?.finishMaxErrors(counts, maxErrors)
      throw new MaxErrorsExceededError(maxErrors, counts.failed)
    }

    // Maintain loaded duration; abortable so a max-errors abort ends it early.
    logger.info(`Maintaining for ${loadedDurationMinutes} minutes`)
    ui?.startLoaded(() => stats.getCounts())
    await sleep(loadedDurationMinutes * 60000, signal)

    if (workerFailed || maxErrorsTriggered) {
      await Promise.all(workerPromises)
      if (workerFailed) throw workerError
      const counts = stats.getCounts()
      ui?.finishMaxErrors(counts, maxErrors)
      throw new MaxErrorsExceededError(maxErrors, counts.failed)
    }

    // Signal workers to stop
    logger.info("Stopped maintaining, waiting for workers to stop")
    ui?.startShutdown()
    stopAll()

    // Wait for all workers to finish their current sessions
    await Promise.all(workerPromises)
    if (workerFailed) throw workerError

    // Final summary
    const counts = stats.getCounts()
    logger.info(
      `Complete. Done: ${counts.done}, Failed: ${counts.failed}, Canceled: ${counts.canceled}`,
    )
    ui?.finish(counts)
  } finally {
    clearWarmupWatchdog()
    if (progressInterval !== null) {
      clearInterval(progressInterval)
    }
  }
}
