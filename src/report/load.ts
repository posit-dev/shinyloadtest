import * as fs from "node:fs"
import * as path from "node:path"

export interface SessionRow {
  session_id: number
  worker_id: number
  iteration: number
  event: string
  timestamp: number
  input_line_number: number
}

export interface RecordingEventInfo {
  lineNumber: number
  type: string
  begin: number
  end: number | null
  url?: string
  message?: string
  label: string
}

export interface RunData {
  name: string
  rows: SessionRow[]
}

export interface ReportData {
  runs: RunData[]
  recording: {
    events: RecordingEventInfo[]
    duration: number
  }
}

function readSessionCSV(filePath: string): SessionRow[] {
  const content = fs.readFileSync(filePath, "utf-8")
  const lines = content.split("\n").filter((l) => l.length > 0)

  const rows: SessionRow[] = []
  for (const line of lines) {
    if (line.startsWith("#")) continue
    if (line.startsWith("session_id")) continue

    const parts = line.split(",")
    if (parts.length < 6) continue

    rows.push({
      session_id: Number(parts[0]),
      worker_id: Number(parts[1]),
      iteration: Number(parts[2]),
      event: parts[3]!,
      timestamp: Number(parts[4]),
      input_line_number: Number(parts[5]),
    })
  }

  return rows
}

// ---------------------------------------------------------------------------
// Recording event label generation
// ---------------------------------------------------------------------------

// SockJS frame pattern: ["N#N|m|{payload}"] or ["N|m|{payload}"]
const sockjsMessagePattern = /^(a?\[")([0-9A-F*]+#)?(\d+)(\|[mc]\|)(.*)("\])$/

// SockJS init frame: ["0#0|o|"] or ["0|o|"]
const sockjsInitPattern = /^\["0(#\d+)?\|o\|/

function parseSockjsPayload(message: string): unknown {
  const match = sockjsMessagePattern.exec(message)
  if (match) {
    try {
      const encoded = match[5]!
      return JSON.parse(JSON.parse('"' + encoded + '"') as string) as unknown
    } catch {
      return null
    }
  }
  return null
}

function parseJsonSafe(message: string): unknown {
  try {
    return JSON.parse(message) as unknown
  } catch {
    return null
  }
}

function commaCollapse(items: string[]): string {
  return items.join(", ")
}

function lastPathSegment(url: string): string {
  const cleaned = url.split("?")[0]!
  const parts = cleaned.split("/").filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? url
}

type RecordingObj = Record<string, unknown>

function wsRecvLabel(parsed: RecordingObj): string {
  // File upload complete
  const response = parsed["response"] as RecordingObj | undefined
  if (response?.["tag"] != null) {
    return "Completed File Upload"
  }

  // Update outputs / errors / input messages
  if (parsed["values"] !== undefined) {
    const values = parsed["values"] as Record<string, unknown>
    const errors = parsed["errors"] as Record<string, RecordingObj> | undefined
    const inputMessages = parsed["inputMessages"] as
      | Array<{ id: string }>
      | undefined

    const hasValues = Object.keys(values).length > 0
    const hasInputMsgs = inputMessages !== undefined && inputMessages.length > 0

    // Filter out silent errors
    let errorNames: string[] = []
    if (errors) {
      errorNames = Object.entries(errors)
        .filter(([, err]) => {
          const errType = err?.["type"]
          if (Array.isArray(errType))
            return !errType.includes("shiny.silent.error")
          return errType !== "shiny.silent.error"
        })
        .map(([name]) => name)
    }
    const hasErrors = errorNames.length > 0

    if (!hasErrors && !hasValues && !hasInputMsgs) {
      return "(Empty values)"
    }

    const parts: string[] = []
    if (hasInputMsgs) {
      parts.push(
        "Input message: " + commaCollapse(inputMessages!.map((m) => m.id)),
      )
    }
    if (hasValues) {
      parts.push("Updated: " + commaCollapse(Object.keys(values)))
    }
    if (hasErrors) {
      parts.push("Errors: " + commaCollapse(errorNames))
    }
    return parts.join("; ")
  }

  // Custom message handler
  if (parsed["custom"] !== undefined) {
    const custom = parsed["custom"] as Record<string, RecordingObj>
    const names = Object.entries(custom).map(([name, value]) => {
      if (value && typeof value === "object" && "id" in value) {
        return name + "[" + value["id"] + "]"
      }
      return name
    })
    return "Custom: " + commaCollapse(names)
  }

  // Frozen
  if (parsed["frozen"] !== undefined) {
    const frozen = parsed["frozen"] as { ids?: string[] }
    return "Freeze: " + commaCollapse(frozen.ids ?? [])
  }

  // Generic response (non-upload)
  if (response !== undefined) {
    return "Request: " + String(response["tag"] ?? "")
  }

  // Notification
  const notification = parsed["notification"] as RecordingObj | undefined
  if (notification !== undefined) {
    const nType = notification["type"] as string
    if (nType === "show") {
      const msg = notification["message"] as RecordingObj | undefined
      return "Show notification: " + (msg?.["id"] ?? "")
    }
    if (nType === "remove") {
      return "Remove notification: " + String(notification["message"] ?? "")
    }
    return "Notification: (Unknown)"
  }

  // Modal
  const modal = parsed["modal"] as RecordingObj | undefined
  if (modal !== undefined) {
    if (modal["type"] === "show") return "Show modal"
    if (modal["type"] === "remove") return "Hide modal"
    return "Modal: (Unknown)"
  }

  // Reload
  if (parsed["reload"] !== undefined) return "Reload app"

  // UI insert/remove
  const insertUI = parsed["shiny-insert-ui"] as RecordingObj | undefined
  if (insertUI !== undefined)
    return "Insert UI: " + String(insertUI["selector"] ?? "")

  const removeUI = parsed["shiny-remove-ui"] as RecordingObj | undefined
  if (removeUI !== undefined)
    return "Remove UI: " + String(removeUI["selector"] ?? "")

  // Tab insert/remove/visibility
  const insertTab = parsed["shiny-insert-tab"] as RecordingObj | undefined
  if (insertTab !== undefined)
    return "Insert tab: " + String(insertTab["inputId"] ?? "")

  const removeTab = parsed["shiny-remove-tab"] as RecordingObj | undefined
  if (removeTab !== undefined)
    return "Remove tab: " + String(removeTab["inputId"] ?? "")

  const tabVis = parsed["shiny-change-tab-visibility"] as
    | RecordingObj
    | undefined
  if (tabVis !== undefined) {
    const prefix = tabVis["type"] === "show" ? "Show" : "Hide"
    return prefix + " tab: " + String(tabVis["inputId"] ?? "")
  }

  // Query string
  if (parsed["updateQueryString"] !== undefined) return "Update query string"

  // Reset brush
  const resetBrush = parsed["resetBrush"] as RecordingObj | undefined
  if (resetBrush !== undefined)
    return "Reset brush: " + String(resetBrush["brushId"] ?? "")

  return "(Unknown message)"
}

function labelRecordingEvent(
  obj: Record<string, unknown>,
  lineNumber: number,
  previousType: string | null,
): string {
  const type = obj["type"] as string
  const prefix = `Event ${lineNumber}) `

  try {
    let label: string

    switch (type) {
      case "REQ_HOME":
        label = "Get: Homepage"
        break
      case "REQ_GET":
        label = "Get: " + lastPathSegment((obj["url"] as string) ?? "")
        break
      case "REQ_TOK":
        label = "Get: Shiny Token"
        break
      case "REQ_SINF":
        label = "Get: Connection Information"
        break
      case "REQ_POST":
        label = "Post Request"
        break
      case "WS_OPEN":
        label = "Start Session"
        break
      case "WS_CLOSE":
        label = "Stop Session"
        break
      case "WS_RECV_INIT":
        label = "Initialize Session"
        break
      case "WS_RECV_BEGIN_UPLOAD":
        label = "File Upload"
        break
      case "WS_SEND": {
        const message = obj["message"] as string | undefined
        if (!message) {
          label = type
          break
        }
        if (previousType === "WS_RECV_INIT") {
          label = "Initialize Inputs"
          break
        }
        if (sockjsInitPattern.test(message)) {
          label = "SockJS Initialize Connection"
          break
        }
        // Try SockJS frame first (Connect), then plain JSON (local Shiny)
        const parsed =
          (parseSockjsPayload(message) as RecordingObj | null) ??
          (parseJsonSafe(message) as RecordingObj | null)
        if (!parsed) {
          label = type
          break
        }
        if (parsed["method"] === "uploadInit") {
          label = "Start File Upload"
          break
        }
        if (parsed["method"] === "uploadEnd") {
          label = "Stop File Upload"
          break
        }
        const data = parsed["data"] as Record<string, unknown> | undefined
        if (data) {
          const visibleKeys = Object.keys(data).filter(
            (k) => !k.startsWith("."),
          )
          if (visibleKeys.length === 0) {
            label = "(Empty update)"
          } else {
            label = "Set: " + commaCollapse(visibleKeys)
          }
        } else {
          label = type
        }
        break
      }
      case "WS_RECV": {
        const message = obj["message"] as string | undefined
        if (!message) {
          label = type
          break
        }
        if (message === "o") {
          label = "Start Connection"
          break
        }
        // Try SockJS frame first (Connect-hosted apps), then plain JSON
        const parsed =
          (parseSockjsPayload(message) as RecordingObj | null) ??
          (parseJsonSafe(message) as RecordingObj | null)
        if (!parsed) {
          label = type
          break
        }
        label = wsRecvLabel(parsed)
        break
      }
      default:
        label = type
    }

    return prefix + label
  } catch {
    return prefix + type
  }
}

// ---------------------------------------------------------------------------
// Recording file reader
// ---------------------------------------------------------------------------

function readRecordingForReport(filePath: string): {
  events: RecordingEventInfo[]
  duration: number
} {
  const content = fs.readFileSync(filePath, "utf-8")
  const lines = content.split("\n").filter((l) => l.length > 0)

  const events: RecordingEventInfo[] = []
  let lineNumber = 0
  let previousType: string | null = null

  for (const line of lines) {
    lineNumber++
    if (line.startsWith("#") || line.length === 0) continue

    const obj = JSON.parse(line) as Record<string, unknown>
    const type = obj["type"] as string
    const begin = new Date(obj["begin"] as string).getTime()
    const end = obj["end"] ? new Date(obj["end"] as string).getTime() : null

    const event: RecordingEventInfo = {
      lineNumber,
      type,
      begin,
      end,
      label: labelRecordingEvent(obj, lineNumber, previousType),
    }

    if (obj["url"]) event.url = obj["url"] as string
    if (obj["message"]) event.message = obj["message"] as string

    events.push(event)
    previousType = type
  }

  const duration =
    events.length > 0 ? events[events.length - 1]!.begin - events[0]!.begin : 0

  return { events, duration }
}

export function findOutputDirs(searchDir: string): string[] {
  if (!fs.existsSync(searchDir)) return []

  const entries = fs.readdirSync(searchDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith("test-logs-"))
    .map((e) => path.join(searchDir, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, "sessions")))
    .sort()
}

export function loadReportData(outputDirs: string[]): ReportData {
  if (outputDirs.length === 0) {
    throw new Error("No output directories provided")
  }

  const runs = outputDirs.map((dir) => {
    const sessionsDir = path.join(dir, "sessions")
    if (!fs.existsSync(sessionsDir)) {
      throw new Error(`Sessions directory not found: ${sessionsDir}`)
    }

    const csvFiles = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".csv"))
      .map((f) => path.join(sessionsDir, f))

    if (csvFiles.length === 0) {
      throw new Error(`No CSV files found in: ${sessionsDir}`)
    }

    const allRows: SessionRow[] = []
    for (const file of csvFiles) {
      allRows.push(...readSessionCSV(file))
    }
    allRows.sort((a, b) => a.timestamp - b.timestamp)

    return {
      name: path.basename(dir),
      rows: allRows,
    }
  })

  // Load recording from first directory (all runs should use same recording)
  const recordingPath = path.join(outputDirs[0]!, "recording.log")
  if (!fs.existsSync(recordingPath)) {
    throw new Error(`Recording file not found: ${recordingPath}`)
  }
  const recording = readRecordingForReport(recordingPath)

  return { runs, recording }
}
