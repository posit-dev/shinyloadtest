/**
 * Opt-in replay diagnostics.
 *
 * When replay runs with `--diagnostics`, a `ReplayDiagnostics` instance
 * writes a strict, credential-free JSONL event log to
 * `<outputDir>/diagnostics.jsonl`. The log captures the client-side session
 * lifecycle: session start/end, per-request HTTP timing split into
 * `bootstrap` and `playback` phases, WebSocket creation/open/close, and
 * retry delays. It tracks what the client transport actually did — it does
 * not know anything about server-side (e.g. Posit Connect) logical session
 * counts.
 *
 * Privacy design:
 * - Every event must be a member of the `DiagnosticEvent` union, and each
 *   serialized line is constructed from a per-event field whitelist, so
 *   properties that were never allowlisted (URLs, headers, cookies, bodies,
 *   credentials, free-form error messages) cannot reach the file even if a
 *   caller attaches them.
 * - Writes are synchronous (`fs.writeSync`) with no per-event fsync. The
 *   events are small, and sync writes reach the OS immediately, so nothing
 *   is lost when the process exits via `process.exit()` right after
 *   `finish()`.
 * - Writer failures never throw out of `emit()`: the first error is retained
 *   and rethrown by `finish()`, so instrumentation failures surface instead
 *   of silently producing incomplete diagnostics.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { VERSION } from "../version.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Identifies the replay session an event belongs to. */
export interface DiagnosticContext {
  sessionId: number
  workerId: number
  iterationId: number
}

export type SessionOutcome = "done" | "failed" | "canceled"
export type HttpPhase = "bootstrap" | "playback"
export type HttpMethod = "GET" | "POST"
/**
 * Who initiated a WebSocket close. "client" means shinyloadtest sent the
 * close request; "other" covers every non-client close — server-initiated
 * closes, network failures, and failed handshakes. Deliberately not named
 * "server": a non-client close is not proof that the server closed the
 * connection.
 */
export type WsCloseOrigin = "client" | "other"

/**
 * Allowlisted diagnostic events. Every payload field is an ID, count, status
 * code, duration, or enum-like outcome — never a URL, header, body,
 * credential, or free-form error string.
 */
export type DiagnosticEvent =
  | { type: "run_start" }
  | ({ type: "session_start" } & DiagnosticContext)
  | ({ type: "session_end"; outcome: SessionOutcome } & DiagnosticContext)
  | ({
      type: "http_complete"
      phase: HttpPhase
      method: HttpMethod
      statusCode: number
      durationMs: number
    } & DiagnosticContext)
  | ({
      type: "http_error"
      phase: HttpPhase
      method: HttpMethod
      durationMs: number
      aborted: boolean
    } & DiagnosticContext)
  | ({ type: "ws_created"; socketId: number } & DiagnosticContext)
  | ({ type: "ws_open"; socketId: number } & DiagnosticContext)
  | ({ type: "ws_close_requested"; socketId: number } & DiagnosticContext)
  | ({ type: "ws_error"; socketId: number } & DiagnosticContext)
  | ({
      type: "ws_closed"
      socketId: number
      closeCode: number
      origin: WsCloseOrigin
    } & DiagnosticContext)
  | {
      type: "retry_wait"
      workerId: number
      iterationId: number
      delayMs: number
      consecutiveFailures: number
      sessionId?: number
    }
  | { type: "run_end" }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DIAGNOSTICS_SCHEMA_VERSION = 1
export const DIAGNOSTICS_FILE_NAME = "diagnostics.jsonl"

/**
 * `finish()` waits at most this long for registered sockets to report
 * closure: the `ws` library's close handshake times out after 30 seconds, so
 * 31 seconds covers that timeout plus a small allowance.
 */
const MAX_SOCKET_DRAIN_MS = 31_000

export interface ReplayDiagnosticsOptions {
  outputDir: string
  numWorkers: number
  maxErrors: number
}

// ---------------------------------------------------------------------------
// Field whitelist
// ---------------------------------------------------------------------------

const CONTEXT_FIELDS = ["sessionId", "workerId", "iterationId"] as const
const SOCKET_FIELDS = [...CONTEXT_FIELDS, "socketId"] as const

/**
 * The only event payload fields that may be serialized. `run_start` and
 * `run_end` fields are derived from constructor/finish state instead.
 */
const EVENT_FIELDS: Record<DiagnosticEvent["type"], readonly string[]> = {
  run_start: [],
  run_end: [],
  session_start: CONTEXT_FIELDS,
  session_end: [...CONTEXT_FIELDS, "outcome"],
  http_complete: [
    ...CONTEXT_FIELDS,
    "phase",
    "method",
    "statusCode",
    "durationMs",
  ],
  http_error: [...CONTEXT_FIELDS, "phase", "method", "durationMs", "aborted"],
  ws_created: SOCKET_FIELDS,
  ws_open: SOCKET_FIELDS,
  ws_close_requested: SOCKET_FIELDS,
  ws_error: SOCKET_FIELDS,
  ws_closed: [...SOCKET_FIELDS, "closeCode", "origin"],
  retry_wait: [
    "workerId",
    "iterationId",
    "delayMs",
    "consecutiveFailures",
    "sessionId",
  ],
}

// ---------------------------------------------------------------------------
// ReplayDiagnostics
// ---------------------------------------------------------------------------

export class ReplayDiagnostics {
  private readonly options: ReplayDiagnosticsOptions
  private readonly filePath: string
  private fd: number
  private closed: boolean
  private savedError: unknown
  private activeSockets: Set<number>
  private socketCounter: number
  private socketWaiter: (() => void) | null
  private finishPromise: Promise<void> | null

  constructor(options: ReplayDiagnosticsOptions) {
    this.options = options
    this.filePath = path.join(options.outputDir, DIAGNOSTICS_FILE_NAME)
    this.fd = -1
    this.closed = false
    this.savedError = undefined
    this.activeSockets = new Set()
    this.socketCounter = 0
    this.socketWaiter = null
    this.finishPromise = null

    try {
      this.fd = fs.openSync(this.filePath, "w")
    } catch (err) {
      this.savedError = err
    }

    // run_start is derived entirely from constructor state: it carries no
    // caller-supplied fields.
    this.emit({ type: "run_start" })
  }

  /**
   * Append one diagnostics event. Never throws: if the writer has been
   * closed by `finish()`, or a write fails, the event is dropped and (for
   * write failures) the first error is retained to be rethrown by
   * `finish()`. This makes `emit()` safe to call from late asynchronous
   * callbacks such as WebSocket close handlers.
   */
  emit(event: DiagnosticEvent): void {
    if (this.closed || this.fd < 0) {
      return
    }
    const record = this.buildRecord(event)
    try {
      const buffer = Buffer.from(JSON.stringify(record) + "\n")
      let offset = 0
      while (offset < buffer.length) {
        const written = fs.writeSync(
          this.fd,
          buffer,
          offset,
          buffer.length - offset,
        )
        if (written <= 0) throw new Error("Could not write replay diagnostics")
        offset += written
      }
    } catch (err) {
      if (this.savedError === undefined) {
        this.savedError = err
      }
    }
  }

  /**
   * Register an outstanding socket (e.g. a WebSocket being created). The
   * returned `closed()` callback marks the socket closed and is idempotent;
   * `finish()` waits (bounded) for all registered sockets to close before
   * writing `run_end`.
   */
  registerSocket(): { socketId: number; closed: () => void } {
    const socketId = this.socketCounter++
    this.activeSockets.add(socketId)
    let alreadyClosed = false
    return {
      socketId,
      closed: () => {
        if (alreadyClosed) {
          return
        }
        alreadyClosed = true
        this.activeSockets.delete(socketId)
        if (this.activeSockets.size === 0) {
          this.socketWaiter?.()
        }
      },
    }
  }

  /**
   * Close the writer. Waits up to 31 seconds for registered sockets to
   * report closure (event-driven — no polling; the timer is cleared as soon
   * as the last socket closes), then emits `run_end` with the number of
   * sockets still open and a `complete` flag, closes the file descriptor,
   * and rethrows the first retained writer error, if any. Subsequent calls
   * return the same promise.
   */
  finish(): Promise<void> {
    if (this.finishPromise === null) {
      this.finishPromise = this.closeWriter()
    }
    return this.finishPromise
  }

  // -- Internals -----------------------------------------------------------

  private async closeWriter(): Promise<void> {
    if (this.activeSockets.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, MAX_SOCKET_DRAIN_MS)
        this.socketWaiter = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.socketWaiter = null
    }

    this.emit({ type: "run_end" })
    this.closed = true

    const fd = this.fd
    this.fd = -1
    if (fd >= 0) {
      try {
        fs.closeSync(fd)
      } catch (err) {
        if (this.savedError === undefined) {
          this.savedError = err
        }
      }
    }

    if (this.savedError !== undefined) {
      throw this.savedError
    }
  }

  /**
   * Build the serialized JSONL record for an event, copying only the
   * allowlisted fields for that event type. Extra properties on the event
   * object can never reach the file.
   */
  private buildRecord(event: DiagnosticEvent): Record<string, unknown> {
    const record: Record<string, unknown> = {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      timestamp: Date.now(),
      type: event.type,
    }

    if (event.type === "run_start") {
      record.toolVersion = VERSION
      record.nodeVersion = process.version
      record.numWorkers = this.options.numWorkers
      record.maxErrors = this.options.maxErrors
    } else if (event.type === "run_end") {
      record.activeSockets = this.activeSockets.size
      record.complete =
        this.activeSockets.size === 0 && this.savedError === undefined
    } else {
      for (const field of EVENT_FIELDS[event.type]) {
        const value = (event as Record<string, unknown>)[field]
        if (value !== undefined) {
          record[field] = value
        }
      }
    }
    return record
  }
}
