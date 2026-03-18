/**
 * Event construction helpers for recording.
 * Creates event objects that serialize to the recording log format.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordingHttpEvent {
  readonly type: "REQ_HOME" | "REQ_TOK" | "REQ_SINF" | "REQ_GET" | "REQ_POST"
  readonly begin: string
  readonly end: string
  readonly status: number
  readonly url: string
  readonly datafile?: string
}

export interface RecordingWsEvent {
  readonly type:
    | "WS_OPEN"
    | "WS_RECV"
    | "WS_RECV_INIT"
    | "WS_RECV_BEGIN_UPLOAD"
    | "WS_SEND"
    | "WS_CLOSE"
  readonly begin: string
  readonly url?: string
  readonly message?: string
}

export type RecordingEvent = RecordingHttpEvent | RecordingWsEvent

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

export function toISOTimestamp(date: Date): string {
  return date.toISOString()
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function makeHttpEvent(
  type: RecordingHttpEvent["type"],
  begin: Date,
  end: Date,
  status: number,
  url: string,
  datafile?: string,
): RecordingHttpEvent {
  const event: RecordingHttpEvent = {
    type,
    begin: toISOTimestamp(begin),
    end: toISOTimestamp(end),
    status,
    url,
  }
  if (datafile !== undefined) {
    return { ...event, datafile }
  }
  return event
}

export function makeWsEvent(
  type: RecordingWsEvent["type"],
  begin: Date,
  extras?: { url?: string; message?: string },
): RecordingWsEvent {
  const event: RecordingWsEvent = {
    type,
    begin: toISOTimestamp(begin),
  }
  if (extras?.url !== undefined && extras?.message !== undefined) {
    return { ...event, url: extras.url, message: extras.message }
  }
  if (extras?.url !== undefined) {
    return { ...event, url: extras.url }
  }
  if (extras?.message !== undefined) {
    return { ...event, message: extras.message }
  }
  return event
}

// ---------------------------------------------------------------------------
// GET request classification
// ---------------------------------------------------------------------------

/**
 * Classify a GET request by its path and return the appropriate event type.
 * Also extracts token values from the path for SINF requests.
 *
 * Classification rules (from the R reference implementation):
 * - Path ends with `/` or `.rmd` (case-insensitive) → REQ_HOME
 * - Path contains `__token__` → REQ_TOK
 * - Path matches `/__sockjs__/...n=<id>` → REQ_SINF (extracts ROBUST_ID)
 * - Everything else → REQ_GET
 */
export function classifyGetRequest(pathWithQuery: string): {
  type: RecordingHttpEvent["type"]
  robustId?: string
} {
  // Extract just the path (before query string)
  const path = pathWithQuery.split("?")[0] ?? pathWithQuery

  // REQ_HOME: ends with / or .rmd (case-insensitive)
  if (/(\/|\.rmd)$/i.test(path)) {
    return { type: "REQ_HOME" }
  }

  // REQ_TOK: contains __token__
  if (path.includes("__token__")) {
    return { type: "REQ_TOK" }
  }

  // REQ_SINF: /__sockjs__/ with n=<id> in path segment or query param
  if (path.includes("/__sockjs__/")) {
    // Check path segments for n=<id>
    const pathNMatch = /\/n=([^/?&]+)/.exec(path)
    if (pathNMatch?.[1]) {
      return { type: "REQ_SINF", robustId: pathNMatch[1] }
    }
    // Check query params for n=<id>
    try {
      const parsed = new URL(pathWithQuery, "http://localhost")
      const n = parsed.searchParams.get("n")
      if (n) {
        return { type: "REQ_SINF", robustId: n }
      }
    } catch {
      // Malformed URL, fall through
    }
  }

  return { type: "REQ_GET" }
}
