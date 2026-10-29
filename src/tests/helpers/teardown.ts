/**
 * Test teardown that cannot hide the failure it is cleaning up after.
 *
 * A `finally` block that awaits anything replaces the error thrown by the
 * `try` body when the teardown itself fails. The assertion that actually
 * failed disappears, and it disappears in the one situation where the
 * diagnosis matters most: a failure that left sockets, servers, or queue
 * polls in a state where teardown also fails. A teardown that never settles
 * is worse, because vitest reports only "Test timed out".
 *
 * `withTeardown` runs the body, always runs the teardown, and reports both
 * failures. The body error stays the thrown error, with the teardown error
 * attached as `cause`, which vitest prints under "Caused by:" after the
 * original stack and assertion diff. Teardown is bounded by `timeoutMs`, so a
 * hang is reported as a teardown failure instead of a bare test timeout.
 */

/** Deadline for a whole teardown function, not for one step inside it. */
export const DEFAULT_TEARDOWN_TIMEOUT_MS = 10_000

/** Rejects with a labeled error when `promise` has not settled in time. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${operation} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export interface TeardownOptions {
  /** Deadline for the whole teardown function. */
  timeoutMs?: number
  /** Named in the timeout error, e.g. "WebSocket server shutdown". */
  operation?: string
}

/**
 * Runs `body`, then `teardown`, and reports whichever of them failed.
 *
 * Both failures together throw the body error with the teardown error as
 * `cause`, so the assertion diff survives.
 */
export async function withTeardown<T>(
  body: () => Promise<T>,
  teardown: () => Promise<void> | void,
  {
    timeoutMs = DEFAULT_TEARDOWN_TIMEOUT_MS,
    operation = "Test teardown",
  }: TeardownOptions = {},
): Promise<T> {
  let bodyFailure: { error: unknown } | undefined
  let result: T | undefined

  try {
    result = await body()
  } catch (error) {
    bodyFailure = { error }
  }

  try {
    await withTimeout(Promise.resolve(teardown()), timeoutMs, operation)
  } catch (teardownError) {
    if (!bodyFailure) throw teardownError
    throw preserveBodyFailure(bodyFailure.error, teardownError, operation)
  }

  // Nothing was lost to teardown, so the body's own outcome stands.
  if (bodyFailure) throw bodyFailure.error
  return result as T
}

/**
 * Attaches `teardownError` to `bodyError` as `cause`.
 *
 * Falls back to an `AggregateError` whose message carries both messages when
 * the body error already has a cause or refuses the assignment, since
 * overwriting either would hide the original.
 */
function preserveBodyFailure(
  bodyError: unknown,
  teardownError: unknown,
  operation: string,
): unknown {
  const teardownFailure = toError(teardownError)

  if (bodyError instanceof Error && bodyError.cause === undefined) {
    try {
      bodyError.cause = teardownFailure
      return bodyError
    } catch {
      // Non-writable in some environments; the AggregateError below keeps both.
    }
  }

  const bodyFailure = toError(bodyError)
  return new AggregateError(
    [bodyFailure, teardownFailure],
    `${bodyFailure.message}\n${operation} also failed: ${teardownFailure.message}`,
  )
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
