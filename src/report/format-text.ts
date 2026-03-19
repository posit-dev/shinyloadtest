import type { ReportData } from "./load.js"
import { computeLatency, computeReportStats, computeSessionDurations, processRun } from "./stats.js"

function fmtTime(n: number): string {
  return n.toFixed(2) + "s"
}

function fmtNum(n: number, decimals: number): string {
  return n.toFixed(decimals)
}

function fmtCount(n: number): string {
  return n.toLocaleString("en-US")
}

function padLeft(s: string, width: number): string {
  return s.padStart(width)
}

function padRight(s: string, width: number): string {
  return s.padEnd(width)
}

type Row = string[]

function renderTable(headers: string[], alignRight: boolean[], rows: Row[]): string {
  const cols = headers.length
  const widths = headers.map((h, i) => {
    let w = h.length
    for (const row of rows) {
      w = Math.max(w, (row[i] ?? "").length)
    }
    return w
  })

  const headerRow = headers
    .map((h, i) => (alignRight[i] ? padLeft(h, widths[i]!) : padRight(h, widths[i]!)))
    .join(" | ")

  const sepRow = widths
    .map((w, i) => (alignRight[i] ? "-".repeat(w - 1) + ":" : "-".repeat(w)))
    .join("-|-")

  const dataRows = rows.map((row) =>
    row
      .map((cell, i) => (alignRight[i] ? padLeft(cell, widths[i]!) : padRight(cell, widths[i]!)))
      .join(" | "),
  )

  return ["| " + headerRow + " |", "|-" + sepRow + "-|", ...dataRows.map((r) => "| " + r + " |")].join(
    "\n",
  )
}

export function generateReportText(data: ReportData): string {
  const stats = computeReportStats(data)
  const processedRuns = data.runs.map(processRun)

  const sections: string[] = []

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------

  const runNames = data.runs.map((r) => r.name).join(", ")
  const recordingEvents = data.recording.events.length
  const recordingDuration = fmtTime(data.recording.duration / 1000)

  let totalSessions = 0
  let maintenanceSessions = 0
  let totalDataPoints = 0

  const workerIds = new Set<string>()
  for (let i = 0; i < processedRuns.length; i++) {
    const pr = processedRuns[i]!
    const run = data.runs[i]!
    const sessIds = new Set<number>()
    for (const e of pr.paired) {
      workerIds.add(pr.name + ":" + e.worker_id)
      sessIds.add(e.session_id)
      if (e.maintenance) maintenanceSessions++
    }
    totalSessions += sessIds.size
    totalDataPoints += run.rows.length
  }

  // maintenanceSessions counted per paired event; recount by session
  let maintenanceSessionCount = 0
  for (const pr of processedRuns) {
    const seen = new Set<number>()
    for (const e of pr.paired) {
      if (e.maintenance && !seen.has(e.session_id)) {
        seen.add(e.session_id)
        maintenanceSessionCount++
      }
    }
  }

  const workers = workerIds.size

  sections.push(
    [
      "# shinyloadtest Report",
      "",
      "## Overview",
      "",
      `- **Runs**: ${data.runs.length} (${runNames})`,
      `- **Workers**: ${workers}`,
      `- **Recording**: ${recordingEvents} events, ${recordingDuration} duration`,
      `- **Sessions**: ${totalSessions} total, ${maintenanceSessionCount} in maintenance window`,
      `- **Data points**: ${fmtCount(totalDataPoints)}`,
    ].join("\n"),
  )

  // -------------------------------------------------------------------------
  // Session Duration
  // -------------------------------------------------------------------------

  const perRunDurations = processedRuns.map((r) =>
    computeSessionDurations(r.paired, data.recording.duration),
  )
  const allDurations = perRunDurations.flatMap((sd) => sd.sessions.map((s) => s.duration))
  if (allDurations.length > 0) {
    const recordingDuration = data.recording.duration / 1000
    const sorted = [...allDurations].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const medianDur = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
    const maxDur = sorted[sorted.length - 1]!
    const sd = { median: medianDur, max: maxDur, recordingDuration }
    const maxVsBaseline = sd.max - sd.recordingDuration
    const pct = sd.recordingDuration > 0 ? ((sd.max / sd.recordingDuration) - 1) * 100 : 0
    const sign = maxVsBaseline >= 0 ? "+" : ""
    const maxVsBaselineStr = `${sign}${fmtTime(maxVsBaseline)} (${sign}${fmtNum(pct, 1)}%)`

    const sdRows: Row[] = [
      ["Median", fmtTime(sd.median)],
      ["Max", fmtTime(sd.max)],
      ["Recording baseline", fmtTime(sd.recordingDuration)],
      ["Max vs baseline", maxVsBaselineStr],
    ]

    sections.push(
      [
        "## Session Duration",
        "",
        renderTable(["Metric", "Value"], [false, true], sdRows),
      ].join("\n"),
    )
  }

  // -------------------------------------------------------------------------
  // Event Duration (top 5 by max)
  // -------------------------------------------------------------------------

  const topDurations = stats.aggregate.eventDurations.slice(0, 5)
  if (topDurations.length > 0) {
    const edRows: Row[] = topDurations.map((e) => [
      e.label,
      String(e.count),
      fmtTime(e.min_time),
      fmtTime(e.mean_time),
      fmtTime(e.median_time),
      fmtTime(e.max_time),
    ])

    sections.push(
      [
        "## Event Duration (Top 5)",
        "",
        renderTable(
          ["Event", "Count", "Min", "Mean", "Median", "Max"],
          [false, true, true, true, true, true],
          edRows,
        ),
      ].join("\n"),
    )
  }

  // -------------------------------------------------------------------------
  // Concurrency Impact (top 3 by |slope|)
  // -------------------------------------------------------------------------

  const topConcurrency = stats.aggregate.eventConcurrency.slice(0, 3)
  if (topConcurrency.length > 0) {
    const ecRows: Row[] = topConcurrency.map((e) => [
      e.label,
      fmtNum(e.slope, 4),
      fmtNum(e.intercept, 4),
      fmtNum(e.maxError, 4),
    ])

    sections.push(
      [
        "## Concurrency Impact (Top 3)",
        "",
        renderTable(
          ["Event", "Slope", "Intercept", "Max Error"],
          [false, true, true, true],
          ecRows,
        ),
      ].join("\n"),
    )
  }

  // -------------------------------------------------------------------------
  // Latency
  // -------------------------------------------------------------------------

  const latency = processedRuns.length > 0 ? computeLatency(processedRuns) : null
  if (latency) {
    const latRows: Row[] = [
      ["HTTP (Homepage + JS/CSS)", fmtTime(latency.httpMedian), fmtTime(latency.httpP95)],
      ["WebSocket (Calculate)", fmtTime(latency.wsMedian), fmtTime(latency.wsP95)],
    ]

    sections.push(
      [
        "## Latency",
        "",
        renderTable(["Metric", "Median", "P95"], [false, true, true], latRows),
      ].join("\n"),
    )
  }

  return sections.join("\n\n") + "\n"
}
