/**
 * Worker orchestration module. Implements the EnduranceTest: multiple
 * concurrent workers, each looping through recording sessions, with
 * staggered start, loaded duration control, and progress reporting.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  // Max-errors: a promise that resolves when the threshold is exceeded.
  // Used to interrupt the loaded-duration sleep.
  let maxErrorsTriggered = false
  let resolveMaxErrors: (() => void) | null = null
  const maxErrorsPromise = new Promise<void>((resolve) => {
    resolveMaxErrors = resolve
  })

  /** Check if cumulative failures have exceeded --max-errors. */
  function checkMaxErrors(): void {
    if (maxErrors > 0 && stats.getCounts().failed >= maxErrors) {
      if (!maxErrorsTriggered) {
        maxErrorsTriggered = true
        logger.error(`Max errors (${maxErrors}) exceeded — stopping test`)
        keepWorking = false
        abortController.abort()
        resolveMaxErrors?.()
      }
    }
  }

  // Per-worker warmup resolve functions
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

    // Stagger delay
    await sleep(workerId * warmupInterval)

    if (maxErrorsTriggered) return

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
        signal: abortController.signal,
      }
    }

    // First session (warmup)
    try {
      const warmupConfig = buildSessionConfig()
      warmupConfig.onProgress = (eventIndex, totalEvents) => {
        ui?.workerProgress(workerId, eventIndex, totalEvents)
      }
      await runSession(warmupConfig, stats)
    } finally {
      warmupResolvers[workerId]!()
      ui?.workerReady()
    }

    checkMaxErrors()

    // Subsequent sessions
    while (keepWorking) {
      workerLogger.info("Running again")
      await runSession(buildSessionConfig(), stats)
      checkMaxErrors()
    }

    workerLogger.info("Stopped")
  }

  // Launch all workers concurrently
  const workerPromises: Promise<void>[] = []
  for (let i = 0; i < numWorkers; i++) {
    workerPromises.push(workerFn(i))
  }

  try {
    // Wait for all workers to complete their first session (warmup phase)
    logger.info("Waiting for warmup to complete")
    await Promise.all(warmupPromises)

    if (maxErrorsTriggered) {
      // Already exceeded during warmup — skip loaded phase
      await Promise.all(workerPromises)
      const counts = stats.getCounts()
      ui?.finishMaxErrors(counts, maxErrors)
      throw new MaxErrorsExceededError(maxErrors, counts.failed)
    }

    // Maintain loaded duration
    logger.info(`Maintaining for ${loadedDurationMinutes} minutes`)
    ui?.startLoaded(() => stats.getCounts())
    await Promise.race([sleep(loadedDurationMinutes * 60000), maxErrorsPromise])

    if (maxErrorsTriggered) {
      // Exceeded during loaded phase
      await Promise.all(workerPromises)
      const counts = stats.getCounts()
      ui?.finishMaxErrors(counts, maxErrors)
      throw new MaxErrorsExceededError(maxErrors, counts.failed)
    }

    // Signal workers to stop
    logger.info("Stopped maintaining, waiting for workers to stop")
    ui?.startShutdown()
    keepWorking = false
    abortController.abort()

    // Wait for all workers to finish their current sessions
    await Promise.all(workerPromises)

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
