import type { ReportData } from "./load.js"
import { computeReportStats } from "./stats.js"

export function generateReportJSON(data: ReportData): string {
  const stats = computeReportStats(data)

  const output = {
    recording: {
      events: data.recording.events.map((e) => ({
        line_number: e.lineNumber,
        type: e.type,
        label: e.label,
      })),
      duration_s: data.recording.duration / 1000,
    },
    stats: {
      event_duration: stats.aggregate.eventDurations.map((e) => ({
        label: e.label,
        event: e.event_base,
        count: e.count,
        min: round4(e.min_time),
        max: round4(e.max_time),
        mean: round4(e.mean_time),
        median: round4(e.median_time),
        mean_diff: round4(e.mean_diff),
      })),
      event_concurrency: stats.aggregate.eventConcurrency.map((e) => ({
        label: e.label,
        event: e.event_base,
        slope: round4(e.slope),
        intercept: round4(e.intercept),
        max_error: round4(e.maxError),
      })),
    },
    runs: stats.runs.map((run, i) => ({
      name: run.name,
      events: data.runs[i]!.rows.length,
      sessions: {
        total: run.sessionDurations.sessions.length,
        maintenance: run.sessionDurations.sessions.filter((s) => s.maintenance)
          .length,
        duration_median_s: round4(run.sessionDurations.median),
        duration_max_s: round4(run.sessionDurations.max),
        recording_duration_s: round4(run.sessionDurations.recordingDuration),
      },
      latency: {
        http_median_s: round4(run.latency.httpMedian),
        http_p95_s: round4(run.latency.httpP95),
        ws_median_s: round4(run.latency.wsMedian),
        ws_p95_s: round4(run.latency.wsP95),
      },
      event_duration: run.eventDurations.map((e) => ({
        label: e.label,
        event: e.event_base,
        count: e.count,
        min: round4(e.min_time),
        max: round4(e.max_time),
        mean: round4(e.mean_time),
        median: round4(e.median_time),
      })),
      event_concurrency: run.eventConcurrency.map((e) => ({
        label: e.label,
        event: e.event_base,
        slope: round4(e.slope),
        intercept: round4(e.intercept),
        max_error: round4(e.maxError),
      })),
    })),
  }

  return JSON.stringify(output, null, 2)
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
