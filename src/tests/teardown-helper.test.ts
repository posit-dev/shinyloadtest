import { describe, it, expect } from "vitest"
import {
  DEFAULT_TEARDOWN_TIMEOUT_MS,
  withTeardown,
  withTimeout,
} from "./helpers/teardown.js"

const neverSettles = <T>() => new Promise<T>(() => {})

describe("withTeardown", () => {
  it("returns the body value and runs teardown afterwards", async () => {
    const order: string[] = []
    const result = await withTeardown(
      async () => {
        order.push("body")
        return 42
      },
      () => {
        order.push("teardown")
      },
    )
    expect(result).toBe(42)
    expect(order).toEqual(["body", "teardown"])
  })

  it("rethrows the body error unchanged when teardown succeeds", async () => {
    const bodyError = new Error("body failed")
    let teardownRan = false
    const thrown = await withTeardown(
      async () => {
        throw bodyError
      },
      () => {
        teardownRan = true
      },
    ).catch((error: unknown) => error)
    expect(thrown).toBe(bodyError)
    expect(bodyError.cause).toBeUndefined()
    expect(teardownRan).toBe(true)
  })

  it("throws the teardown error when only teardown fails", async () => {
    const teardownError = new Error("teardown failed")
    const thrown = await withTeardown(
      async () => "ok",
      () => {
        throw teardownError
      },
    ).catch((error: unknown) => error)
    expect(thrown).toBe(teardownError)
  })

  it("keeps the body error as the thrown error with teardown as its cause", async () => {
    const bodyError = new Error("body failed")
    const teardownError = new Error("teardown failed")
    const thrown = await withTeardown(
      async () => {
        throw bodyError
      },
      () => {
        throw teardownError
      },
    ).catch((error: unknown) => error)
    expect(thrown).toBe(bodyError)
    expect((thrown as Error).cause).toBe(teardownError)
  })

  it("captures a synchronous teardown throw", async () => {
    const teardownError = new Error("sync teardown failed")
    const thrown = await withTeardown(
      async () => "ok",
      () => {
        throw teardownError
      },
    ).catch((error: unknown) => error)
    expect(thrown).toBe(teardownError)
  })

  it("reports a hanging teardown as a teardown failure instead of hanging", async () => {
    const thrown = await withTeardown(
      async () => "ok",
      () => neverSettles(),
      {
        timeoutMs: 20,
        operation: "Hanging teardown",
      },
    ).catch((error: unknown) => error)
    expect((thrown as Error).message).toBe(
      "Hanging teardown timed out after 20ms",
    )
  })

  it("attaches a hung teardown to the body error as its cause", async () => {
    const bodyError = new Error("body failed")
    const thrown = await withTeardown(
      async () => {
        throw bodyError
      },
      () => neverSettles(),
      { timeoutMs: 20, operation: "Hanging teardown" },
    ).catch((error: unknown) => error)
    expect(thrown).toBe(bodyError)
    expect(((thrown as Error).cause as Error).message).toBe(
      "Hanging teardown timed out after 20ms",
    )
  })

  it("aggregates both messages when the body throws a non-Error value", async () => {
    const teardownError = new Error("teardown failed")
    const thrown = await withTeardown(
      async () => {
        throw "body failed as a string"
      },
      () => {
        throw teardownError
      },
    ).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AggregateError)
    const aggregate = thrown as AggregateError
    expect(aggregate.message).toContain("body failed as a string")
    expect(aggregate.message).toContain("teardown failed")
    expect(aggregate.errors).toEqual([expect.any(Error), teardownError])
  })

  it("does not overwrite a body error that already has a cause", async () => {
    const originalCause = new Error("original cause")
    const bodyError = new Error("body failed", { cause: originalCause })
    const teardownError = new Error("teardown failed")
    const thrown = await withTeardown(
      async () => {
        throw bodyError
      },
      () => {
        throw teardownError
      },
    ).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).message).toContain("teardown failed")
    expect((thrown as AggregateError).errors).toEqual([
      bodyError,
      teardownError,
    ])
    expect(bodyError.cause).toBe(originalCause)
  })

  it("does not leak an unhandled rejection when a timed-out teardown fails later", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      const thrown = await withTeardown(
        async () => "ok",
        () =>
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error("late teardown failure")), 60)
          }),
        { timeoutMs: 20, operation: "Late teardown" },
      ).catch((error: unknown) => error)
      expect((thrown as Error).message).toBe(
        "Late teardown timed out after 20ms",
      )
      // Let the abandoned teardown settle; its rejection must already be handled.
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("defaults the teardown deadline to the exported constant", () => {
    expect(DEFAULT_TEARDOWN_TIMEOUT_MS).toBe(10_000)
  })
})

describe("withTimeout", () => {
  it("resolves with the promise value before the deadline", async () => {
    expect(await withTimeout(Promise.resolve("value"), 50, "Fast")).toBe(
      "value",
    )
  })

  it("rejects with a labeled timeout error", async () => {
    const thrown = await withTimeout(
      neverSettles<string>(),
      20,
      "Slow operation",
    ).catch((error: unknown) => error)
    expect((thrown as Error).message).toBe(
      "Slow operation timed out after 20ms",
    )
  })

  it("propagates the original rejection", async () => {
    const original = new Error("original")
    const thrown = await withTimeout(
      Promise.reject(original),
      50,
      "Rejecting",
    ).catch((error: unknown) => error)
    expect(thrown).toBe(original)
  })
})
