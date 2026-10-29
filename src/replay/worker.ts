/**
 * Worker orchestration module. Implements the EnduranceTest: multiple
 * concurrent workers, each looping through recording sessions, with
 * staggered start, loaded duration control, per-worker failure backoff,
 * and progress reporting.
 */

import type { Logger } from "../logger.js"
import { Stats, runSession } from "./session.js"
import type { SessionConfig } from "./session.js"
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
      }
    }

    /** Run one session and fold its outcome into the backoff state. */
    async function runOneSession(sessionConfig: SessionConfig): Promise<void> {
      const outcome = await runSession(sessionConfig, stats)
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
    await Promise.all(warmupPromises)

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
    if (progressInterval !== null) {
      clearInterval(progressInterval)
    }
  }
}
