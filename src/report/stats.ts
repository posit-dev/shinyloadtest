import type { ReportData, RunData } from "./load.js"

// =========================================================================
// Helper utilities
// =========================================================================

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFn(item)
    const group = map.get(key)
    if (group) {
      group.push(item)
    } else {
      map.set(key, [item])
    }
  }
  return map
}

function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0)
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return sum(values) / values.length
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mid = Math.floor(n / 2)
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]!
}

function linearRegression(points: { x: number; y: number }[]): {
  slope: number
  intercept: number
  maxError: number
} {
  const n = points.length
  if (n < 2) return { slope: 0, intercept: 0, maxError: 0 }
  const sumX = sum(points.map((p) => p.x))
  const sumY = sum(points.map((p) => p.y))
  const sumXY = sum(points.map((p) => p.x * p.y))
  const sumX2 = sum(points.map((p) => p.x * p.x))
  const denom = n * sumX2 - sumX * sumX
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0
  const intercept = (sumY - slope * sumX) / n
  const maxError = points.reduce((max, p) => {
    const err = Math.abs(p.y - (slope * p.x + intercept))
    return err > max ? err : max
  }, 0)
  return { slope, intercept, maxError }
}

// =========================================================================
// Exported interfaces
// =========================================================================

export interface PairedEvent {
  session_id: number
  worker_id: number
  iteration: number
  input_line_number: number
  event_base: string
  start: number
  end: number
  time: number
  concurrency: number
  maintenance: boolean
}

export interface ProcessedRun {
  name: string
  paired: PairedEvent[]
}

export interface SessionDurationStats {
  sessions: { session_id: number; duration: number; maintenance: boolean }[]
  median: number
  max: number
  recordingDuration: number
}

export interface EventDurationStat {
  label: string
  input_line_number: number
  event_base: string
  count: number
  min_time: number
  max_time: number
  mean_time: number
  median_time: number
  mean_diff: number
}

export interface EventConcurrencyStat {
  label: string
  input_line_number: number
  event_base: string
  slope: number
  intercept: number
  maxError: number
}

export interface LatencyStats {
  http: { session_id: number; total: number; maintenance: boolean }[]
  ws: { session_id: number; max: number; maintenance: boolean }[]
  httpMedian: number
  httpP95: number
  wsMedian: number
  wsP95: number
}

export interface RunStats {
  name: string
  sessionDurations: SessionDurationStats
  eventDurations: EventDurationStat[]
  eventConcurrency: EventConcurrencyStat[]
  latency: LatencyStats
}

export interface ReportStats {
  runs: RunStats[]
  aggregate: {
    eventDurations: EventDurationStat[]
    eventConcurrency: EventConcurrencyStat[]
  }
}

// =========================================================================
// Label helper
// =========================================================================

export function getRecordingLabel(
  recording: ReportData["recording"],
  lineNum: number,
): string {
  const event = recording.events.find((e) => e.lineNumber === lineNum)
  return event ? event.label : "Event " + lineNum
}

// =========================================================================
// Event classification
// =========================================================================

const EVENT_TYPE_MAP: Record<string, string> = {
  REQ_HOME: "Homepage",
  REQ_GET: "JS/CSS",
  WS_OPEN: "Start Session",
  WS_RECV: "Calculate",
}

export function classifyEvent(eventBase: string): string | undefined {
  return EVENT_TYPE_MAP[eventBase]
}

// =========================================================================
// Data processing
// =========================================================================

function identifyMaintenance(events: PairedEvent[]): Set<number> {
  const byWorker = groupBy(events, (e) => String(e.worker_id))

  if (byWorker.size <= 1) {
    return new Set(events.map((e) => e.session_id))
  }

  let latestStart = -Infinity
  let earliestEnd = Infinity
  for (const [, workerEvents] of byWorker) {
    const starts = workerEvents.map((e) => e.start)
    const ends = workerEvents.map((e) => e.end)
    latestStart = Math.max(latestStart, Math.min(...starts))
    earliestEnd = Math.min(earliestEnd, Math.max(...ends))
  }

  const bySess = new Map<number, { min: number; max: number }>()
  for (const e of events) {
    const s = bySess.get(e.session_id)
    if (s) {
      s.min = Math.min(s.min, e.start)
      s.max = Math.max(s.max, e.end)
    } else {
      bySess.set(e.session_id, { min: e.start, max: e.end })
    }
  }

  const maintenanceSessions = new Set<number>()
  for (const [sid, range] of bySess) {
    if (range.min >= latestStart && range.max <= earliestEnd) {
      maintenanceSessions.add(sid)
    }
  }

  if (maintenanceSessions.size === 0) {
    return new Set(events.map((e) => e.session_id))
  }

  return maintenanceSessions
}

export function processRun(run: RunData): ProcessedRun {
  const rows = [...run.rows].sort((a, b) => a.timestamp - b.timestamp)
  if (rows.length === 0) return { name: run.name, paired: [] }

  const minTs = rows[0]!.timestamp

  let cumConc = 0
  const normalized = rows.map((row) => {
    if (row.event === "WS_OPEN_START") cumConc++
    else if (row.event === "WS_CLOSE_END") cumConc--
    return {
      ...row,
      ts: (row.timestamp - minTs) / 1000,
      concurrency: Math.max(cumConc, 0),
    }
  })

  const relevant = normalized.filter(
    (d) =>
      !d.event.startsWith("PLAYBACK") &&
      d.event !== "PLAYER_SESSION_CREATE" &&
      d.event !== "PLAYBACK_DONE" &&
      d.input_line_number > 0,
  )

  const groups = groupBy(
    relevant,
    (row) =>
      row.session_id +
      "," +
      row.worker_id +
      "," +
      row.iteration +
      "," +
      row.input_line_number,
  )

  const paired: PairedEvent[] = []
  for (const [, groupRows] of groups) {
    const start = Math.min(...groupRows.map((r) => r.ts))
    const end = Math.max(...groupRows.map((r) => r.ts))
    const concSum = sum(groupRows.map((r) => r.concurrency))
    const baseEvent = groupRows[0]!.event.replace(/_(START|END)$/, "")

    paired.push({
      session_id: groupRows[0]!.session_id,
      worker_id: groupRows[0]!.worker_id,
      iteration: groupRows[0]!.iteration,
      input_line_number: groupRows[0]!.input_line_number,
      event_base: baseEvent,
      start,
      end,
      time: end - start,
      concurrency: concSum / groupRows.length,
      maintenance: false,
    })
  }

  const maintenance = identifyMaintenance(paired)

  return {
    name: run.name,
    paired: paired.map((r) => ({
      ...r,
      maintenance: maintenance.has(r.session_id),
    })),
  }
}

// =========================================================================
// Stat computation functions
// =========================================================================

export function computeSessionDurations(
  paired: PairedEvent[],
  recordingDurationMs: number,
): SessionDurationStats {
  const bySess = groupBy(paired, (e) => String(e.session_id))
  const sessions: {
    session_id: number
    duration: number
    maintenance: boolean
  }[] = []

  for (const [, events] of bySess) {
    const start = Math.min(...events.map((e) => e.start))
    const end = Math.max(...events.map((e) => e.end))
    sessions.push({
      session_id: events[0]!.session_id,
      duration: end - start,
      maintenance: events[0]!.maintenance,
    })
  }

  const durations = sessions.map((s) => s.duration)
  return {
    sessions,
    median: median(durations),
    max: durations.length > 0 ? Math.max(...durations) : 0,
    recordingDuration: recordingDurationMs / 1000,
  }
}

export function computeEventDurations(
  runs: ProcessedRun[],
  recording: ReportData["recording"],
): EventDurationStat[] {
  const allData = runs.flatMap((run, ri) =>
    run.paired.filter((d) => d.maintenance).map((d) => ({ ...d, run_idx: ri })),
  )

  if (allData.length === 0) return []

  const byEventRun = groupBy(
    allData,
    (d) => d.input_line_number + "|" + d.run_idx,
  )

  const perRunStats = [...byEventRun.values()].map((g) => {
    const times = [...g.map((d) => d.time)].sort((a, b) => a - b)
    const n = times.length
    const mid = Math.floor(n / 2)
    return {
      label: getRecordingLabel(recording, g[0]!.input_line_number),
      input_line_number: g[0]!.input_line_number,
      event_base: g[0]!.event_base,
      run_idx: g[0]!.run_idx,
      min_time: times[0]!,
      max_time: times[n - 1]!,
      mean_time: sum(times) / n,
      median_time:
        n % 2 === 1 ? times[mid]! : (times[mid - 1]! + times[mid]!) / 2,
      count: n,
    }
  })

  const byEvent = groupBy(perRunStats, (s) => String(s.input_line_number))

  const stats: EventDurationStat[] = [...byEvent.entries()].map(
    ([, runStats]) => {
      const means = runStats.map((s) => s.mean_time)
      return {
        label: runStats[0]!.label,
        input_line_number: runStats[0]!.input_line_number,
        event_base: runStats[0]!.event_base,
        min_time: Math.min(...runStats.map((s) => s.min_time)),
        max_time: Math.max(...runStats.map((s) => s.max_time)),
        mean_time: mean(means),
        median_time: median(runStats.map((s) => s.median_time)),
        count: sum(runStats.map((s) => s.count)),
        mean_diff:
          means.length > 1 ? Math.max(...means) - Math.min(...means) : 0,
      }
    },
  )

  return stats.sort((a, b) => b.max_time - a.max_time)
}

export function computeEventConcurrency(
  runs: ProcessedRun[],
  recording: ReportData["recording"],
): EventConcurrencyStat[] {
  const allData = runs.flatMap((run, ri) =>
    run.paired.filter((d) => d.maintenance).map((d) => ({ ...d, run_idx: ri })),
  )

  if (allData.length === 0) return []

  const byEventRun = groupBy(
    allData,
    (d) => d.input_line_number + "|" + d.run_idx,
  )

  const perRunStats = []
  for (const [, events] of byEventRun) {
    const n = events.length
    const lineNum = events[0]!.input_line_number
    const label = getRecordingLabel(recording, lineNum)
    const eventBase = events[0]!.event_base
    const runIdx = events[0]!.run_idx

    if (n < 2) {
      perRunStats.push({
        label,
        input_line_number: lineNum,
        event_base: eventBase,
        run_idx: runIdx,
        slope: 0,
        intercept: 0,
        maxError: 0,
      })
      continue
    }

    const reg = linearRegression(
      events.map((d) => ({ x: d.concurrency, y: d.time })),
    )
    perRunStats.push({
      label,
      input_line_number: lineNum,
      event_base: eventBase,
      run_idx: runIdx,
      ...reg,
    })
  }

  const byEvent = groupBy(perRunStats, (s) => String(s.input_line_number))

  const stats: EventConcurrencyStat[] = [...byEvent.entries()].map(
    ([, runStats]) => {
      const worstSlope = runStats.reduce((a, b) =>
        Math.abs(a.slope) >= Math.abs(b.slope) ? a : b,
      )
      const worstIntercept = runStats.reduce((a, b) =>
        Math.abs(a.intercept) >= Math.abs(b.intercept) ? a : b,
      )
      const worstError = runStats.reduce((a, b) =>
        a.maxError >= b.maxError ? a : b,
      )
      return {
        label: runStats[0]!.label,
        input_line_number: runStats[0]!.input_line_number,
        event_base: runStats[0]!.event_base,
        slope: worstSlope.slope,
        intercept: worstIntercept.intercept,
        maxError: worstError.maxError,
      }
    },
  )

  return stats.sort((a, b) => Math.abs(b.slope) - Math.abs(a.slope))
}

export function computeLatency(runs: ProcessedRun[]): LatencyStats {
  const httpCategories = new Set(["Homepage", "JS/CSS"])
  const wsCategories = new Set(["Calculate"])

  const httpBySess = new Map<
    string,
    { session_id: number; total: number; maintenance: boolean }
  >()
  const wsBySess = new Map<
    string,
    { session_id: number; max: number; maintenance: boolean }
  >()

  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri]!
    for (const d of run.paired) {
      if (!d.maintenance) continue
      const category = classifyEvent(d.event_base)
      if (!category) continue

      const key = ri + ":" + d.session_id

      if (httpCategories.has(category)) {
        const existing = httpBySess.get(key)
        if (existing) {
          existing.total += d.time
        } else {
          httpBySess.set(key, {
            session_id: d.session_id,
            total: d.time,
            maintenance: d.maintenance,
          })
        }
      } else if (wsCategories.has(category)) {
        const existing = wsBySess.get(key)
        if (existing) {
          existing.max = Math.max(existing.max, d.time)
        } else {
          wsBySess.set(key, {
            session_id: d.session_id,
            max: d.time,
            maintenance: d.maintenance,
          })
        }
      }
    }
  }

  const http = [...httpBySess.values()]
  const ws = [...wsBySess.values()]
  const httpTotals = http.map((s) => s.total)
  const wsMaxes = ws.map((s) => s.max)

  return {
    http,
    ws,
    httpMedian: median(httpTotals),
    httpP95: percentile(httpTotals, 95),
    wsMedian: median(wsMaxes),
    wsP95: percentile(wsMaxes, 95),
  }
}

export function computeRunStats(
  run: ProcessedRun,
  recording: ReportData["recording"],
): RunStats {
  return {
    name: run.name,
    sessionDurations: computeSessionDurations(run.paired, recording.duration),
    eventDurations: computeEventDurations([run], recording),
    eventConcurrency: computeEventConcurrency([run], recording),
    latency: computeLatency([run]),
  }
}

export function computeReportStats(data: ReportData): ReportStats {
  const processedRuns = data.runs.map(processRun)
  const runs = processedRuns.map((run) => computeRunStats(run, data.recording))
  return {
    runs,
    aggregate: {
      eventDurations: computeEventDurations(processedRuns, data.recording),
      eventConcurrency: computeEventConcurrency(processedRuns, data.recording),
    },
  }
}
