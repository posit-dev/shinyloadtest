import { describe, it, expect } from "vitest"
import type { SessionRow, RecordingEventInfo, ReportData } from "../report/load.js"
import {
  processRun,
  classifyEvent,
  getRecordingLabel,
  computeSessionDurations,
  computeEventDurations,
  computeEventConcurrency,
  computeLatency,
  computeReportStats,
} from "../report/stats.js"

function makeRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    session_id: 1,
    worker_id: 0,
    iteration: 0,
    event: "REQ_HOME_START",
    timestamp: 1000,
    input_line_number: 1,
    ...overrides,
  }
}

function makeRecording(events?: Partial<RecordingEventInfo>[]): ReportData["recording"] {
  const defaultEvents: RecordingEventInfo[] = [
    { lineNumber: 1, type: "REQ_HOME", begin: 0, end: 100, label: "Event 1) Get: Homepage" },
    { lineNumber: 2, type: "REQ_GET", begin: 100, end: 200, label: "Event 2) Get: app.js" },
    { lineNumber: 3, type: "WS_RECV", begin: 200, end: 500, label: "Event 3) Updated: x" },
  ]
  return {
    events: (events as RecordingEventInfo[]) ?? defaultEvents,
    duration: 5000,
  }
}

describe("classifyEvent", () => {
  it("maps REQ_HOME to Homepage", () => {
    expect(classifyEvent("REQ_HOME")).toBe("Homepage")
  })

  it("maps REQ_GET to JS/CSS", () => {
    expect(classifyEvent("REQ_GET")).toBe("JS/CSS")
  })

  it("maps WS_OPEN to Start Session", () => {
    expect(classifyEvent("WS_OPEN")).toBe("Start Session")
  })

  it("maps WS_RECV to Calculate", () => {
    expect(classifyEvent("WS_RECV")).toBe("Calculate")
  })

  it("returns undefined for unmapped events", () => {
    expect(classifyEvent("WS_SEND")).toBeUndefined()
    expect(classifyEvent("WS_CLOSE")).toBeUndefined()
    expect(classifyEvent("REQ_POST")).toBeUndefined()
  })
})

describe("getRecordingLabel", () => {
  it("returns label from recording events by lineNumber", () => {
    const recording = makeRecording()
    expect(getRecordingLabel(recording, 1)).toBe("Event 1) Get: Homepage")
    expect(getRecordingLabel(recording, 3)).toBe("Event 3) Updated: x")
  })

  it("falls back to Event N when lineNumber not found", () => {
    const recording = makeRecording()
    expect(getRecordingLabel(recording, 99)).toBe("Event 99")
  })
})

describe("processRun", () => {
  it("returns empty paired array for empty rows", () => {
    const result = processRun({ name: "empty", rows: [] })
    expect(result.paired).toHaveLength(0)
    expect(result.name).toBe("empty")
  })

  it("pairs START/END events and computes time in seconds", () => {
    const run = {
      name: "test-run",
      rows: [
        makeRow({ event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ event: "REQ_HOME_END", timestamp: 1500, input_line_number: 1 }),
      ],
    }
    const result = processRun(run)
    expect(result.paired).toHaveLength(1)
    expect(result.paired[0]!.event_base).toBe("REQ_HOME")
    expect(result.paired[0]!.time).toBeCloseTo(0.5)
  })

  it("normalizes timestamps to relative seconds from first event", () => {
    const run = {
      name: "test-run",
      rows: [
        makeRow({ event: "REQ_HOME_START", timestamp: 10000, input_line_number: 1 }),
        makeRow({ event: "REQ_HOME_END", timestamp: 11000, input_line_number: 1 }),
      ],
    }
    const result = processRun(run)
    expect(result.paired[0]!.start).toBeCloseTo(0)
    expect(result.paired[0]!.end).toBeCloseTo(1.0)
  })

  it("sorts rows by timestamp before processing", () => {
    const run = {
      name: "test-run",
      rows: [
        makeRow({ event: "REQ_HOME_END", timestamp: 1500, input_line_number: 1 }),
        makeRow({ event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
      ],
    }
    const result = processRun(run)
    expect(result.paired).toHaveLength(1)
    expect(result.paired[0]!.time).toBeCloseTo(0.5)
  })

  it("filters out PLAYBACK_* events", () => {
    const run = {
      name: "test-run",
      rows: [
        makeRow({ event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ event: "REQ_HOME_END", timestamp: 1500, input_line_number: 1 }),
        makeRow({ event: "PLAYBACK_START", timestamp: 2000, input_line_number: 0 }),
        makeRow({ event: "PLAYBACK_DONE", timestamp: 2100, input_line_number: 0 }),
      ],
    }
    const result = processRun(run)
    expect(result.paired).toHaveLength(1)
    expect(result.paired[0]!.event_base).toBe("REQ_HOME")
  })

  it("filters out PLAYER_SESSION_CREATE events", () => {
    const run = {
      name: "test-run",
      rows: [
        makeRow({ event: "PLAYER_SESSION_CREATE", timestamp: 900, input_line_number: 0 }),
        makeRow({ event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ event: "REQ_HOME_END", timestamp: 1500, input_line_number: 1 }),
      ],
    }
    const result = processRun(run)
    expect(result.paired).toHaveLength(1)
  })

  it("filters out rows with input_line_number <= 0", () => {
    const run = {
      name: "test-run",
      rows: [
        makeRow({ event: "WS_OPEN_START", timestamp: 900, input_line_number: 0 }),
        makeRow({ event: "WS_OPEN_END", timestamp: 950, input_line_number: 0 }),
        makeRow({ event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ event: "REQ_HOME_END", timestamp: 1500, input_line_number: 1 }),
      ],
    }
    const result = processRun(run)
    expect(result.paired).toHaveLength(1)
  })

  it("tracks cumulative concurrency: WS_OPEN_START increments, WS_CLOSE_END decrements", () => {
    const run = {
      name: "test-run",
      rows: [
        makeRow({ event: "WS_OPEN_START", timestamp: 1000, input_line_number: 0 }),
        makeRow({ event: "WS_OPEN_START", timestamp: 1100, input_line_number: 0 }),
        makeRow({ event: "REQ_HOME_START", timestamp: 1200, input_line_number: 1 }),
        makeRow({ event: "REQ_HOME_END", timestamp: 1500, input_line_number: 1 }),
        makeRow({ event: "WS_CLOSE_END", timestamp: 1600, input_line_number: 0 }),
      ],
    }
    const result = processRun(run)
    expect(result.paired[0]!.concurrency).toBeGreaterThan(0)
  })

  it("tags all sessions as maintenance when there is a single worker", () => {
    const run = {
      name: "test-run",
      rows: [
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_END", timestamp: 1500, input_line_number: 1 }),
        makeRow({ session_id: 2, worker_id: 0, event: "REQ_HOME_START", timestamp: 2000, input_line_number: 1 }),
        makeRow({ session_id: 2, worker_id: 0, event: "REQ_HOME_END", timestamp: 2500, input_line_number: 1 }),
      ],
    }
    const result = processRun(run)
    expect(result.paired.every((p) => p.maintenance)).toBe(true)
  })

  it("tags only overlapping sessions as maintenance with multiple workers", () => {
    const run = {
      name: "test-run",
      rows: [
        // Worker 0: sessions overlap with worker 1 at s=2..4
        makeRow({ session_id: 10, worker_id: 0, event: "REQ_HOME_START", timestamp: 2000, input_line_number: 1 }),
        makeRow({ session_id: 10, worker_id: 0, event: "REQ_HOME_END", timestamp: 4000, input_line_number: 1 }),
        // Worker 1: sessions overlap with worker 0 at s=2..4
        makeRow({ session_id: 20, worker_id: 1, event: "REQ_HOME_START", timestamp: 2000, input_line_number: 1 }),
        makeRow({ session_id: 20, worker_id: 1, event: "REQ_HOME_END", timestamp: 4000, input_line_number: 1 }),
        // Early session on worker 0 (outside overlap)
        makeRow({ session_id: 30, worker_id: 0, event: "REQ_HOME_START", timestamp: 100, input_line_number: 1 }),
        makeRow({ session_id: 30, worker_id: 0, event: "REQ_HOME_END", timestamp: 200, input_line_number: 1 }),
      ],
    }
    const result = processRun(run)
    const maintenanceIds = result.paired.filter((p) => p.maintenance).map((p) => p.session_id)
    expect(maintenanceIds).toContain(10)
    expect(maintenanceIds).toContain(20)
    expect(maintenanceIds).not.toContain(30)
  })

  it("falls back to all sessions as maintenance if no sessions in window", () => {
    const run = {
      name: "test-run",
      rows: [
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_END", timestamp: 1100, input_line_number: 1 }),
        makeRow({ session_id: 2, worker_id: 1, event: "REQ_HOME_START", timestamp: 2000, input_line_number: 1 }),
        makeRow({ session_id: 2, worker_id: 1, event: "REQ_HOME_END", timestamp: 2100, input_line_number: 1 }),
      ],
    }
    const result = processRun(run)
    expect(result.paired.every((p) => p.maintenance)).toBe(true)
  })
})

describe("computeSessionDurations", () => {
  it("computes per-session duration as max(end) - min(start)", () => {
    const run = processRun({
      name: "test",
      rows: [
        makeRow({ session_id: 1, event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ session_id: 1, event: "REQ_HOME_END", timestamp: 2000, input_line_number: 1 }),
        makeRow({ session_id: 1, event: "REQ_GET_START", timestamp: 2000, input_line_number: 2 }),
        makeRow({ session_id: 1, event: "REQ_GET_END", timestamp: 3000, input_line_number: 2 }),
      ],
    })
    const stats = computeSessionDurations(run.paired, 5000)
    expect(stats.sessions).toHaveLength(1)
    expect(stats.sessions[0]!.duration).toBeCloseTo(2.0)
  })

  it("computes median and max correctly", () => {
    const run = processRun({
      name: "test",
      rows: [
        makeRow({ session_id: 1, event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ session_id: 1, event: "REQ_HOME_END", timestamp: 2000, input_line_number: 1 }),
        makeRow({ session_id: 2, event: "REQ_HOME_START", timestamp: 3000, input_line_number: 1 }),
        makeRow({ session_id: 2, event: "REQ_HOME_END", timestamp: 6000, input_line_number: 1 }),
      ],
    })
    const stats = computeSessionDurations(run.paired, 5000)
    // session 1: 1s duration, session 2: 3s duration; median([1,3])=2, max=3
    expect(stats.median).toBeCloseTo(2.0)
    expect(stats.max).toBeCloseTo(3.0)
  })

  it("converts recordingDuration from ms to seconds", () => {
    const stats = computeSessionDurations([], 7500)
    expect(stats.recordingDuration).toBeCloseTo(7.5)
  })

  it("handles empty paired array", () => {
    const stats = computeSessionDurations([], 5000)
    expect(stats.sessions).toHaveLength(0)
    expect(stats.median).toBe(0)
    expect(stats.max).toBe(0)
  })
})

describe("computeEventDurations", () => {
  function makeMaintenanceRun(name: string, times: { lineNum: number; ms: number }[]): ReturnType<typeof processRun> {
    const rows: SessionRow[] = []
    let ts = 1000
    let sessId = 1
    for (const { lineNum, ms } of times) {
      rows.push(makeRow({ session_id: sessId, worker_id: 0, event: "REQ_HOME_START", timestamp: ts, input_line_number: lineNum }))
      rows.push(makeRow({ session_id: sessId, worker_id: 0, event: "REQ_HOME_END", timestamp: ts + ms, input_line_number: lineNum }))
      ts += ms + 100
      sessId++
    }
    return processRun({ name, rows })
  }

  it("computes min/max/mean/median for maintenance sessions only", () => {
    const run = makeMaintenanceRun("run1", [
      { lineNum: 1, ms: 100 },
      { lineNum: 1, ms: 200 },
      { lineNum: 1, ms: 300 },
    ])
    const stats = computeEventDurations([run], makeRecording())
    expect(stats).toHaveLength(1)
    const s = stats[0]!
    expect(s.min_time).toBeCloseTo(0.1)
    expect(s.max_time).toBeCloseTo(0.3)
    expect(s.mean_time).toBeCloseTo(0.2)
    expect(s.count).toBe(3)
  })

  it("returns results sorted by max_time descending", () => {
    const run = makeMaintenanceRun("run1", [
      { lineNum: 1, ms: 500 },
      { lineNum: 2, ms: 100 },
    ])
    const recording = makeRecording()
    const stats = computeEventDurations([run], recording)
    expect(stats[0]!.max_time).toBeGreaterThanOrEqual(stats[1]!.max_time)
  })

  it("mean_diff is 0 for a single run", () => {
    const run = makeMaintenanceRun("run1", [{ lineNum: 1, ms: 200 }])
    const stats = computeEventDurations([run], makeRecording())
    expect(stats[0]!.mean_diff).toBe(0)
  })

  it("mean_diff is > 0 for multiple runs with different means", () => {
    const run1 = makeMaintenanceRun("run1", [{ lineNum: 1, ms: 100 }])
    const run2 = makeMaintenanceRun("run2", [{ lineNum: 1, ms: 500 }])
    const stats = computeEventDurations([run1, run2], makeRecording())
    expect(stats[0]!.mean_diff).toBeGreaterThan(0)
  })

  it("aggregates min of mins and max of maxes across runs", () => {
    const run1 = makeMaintenanceRun("run1", [{ lineNum: 1, ms: 100 }])
    const run2 = makeMaintenanceRun("run2", [{ lineNum: 1, ms: 900 }])
    const stats = computeEventDurations([run1, run2], makeRecording())
    expect(stats[0]!.min_time).toBeCloseTo(0.1)
    expect(stats[0]!.max_time).toBeCloseTo(0.9)
  })

  it("returns empty array when no maintenance events", () => {
    const stats = computeEventDurations([], makeRecording())
    expect(stats).toHaveLength(0)
  })
})

describe("computeEventConcurrency", () => {
  function makeRunWithConcurrency(): ReturnType<typeof processRun> {
    const rows: SessionRow[] = []
    for (let i = 0; i < 5; i++) {
      const ts = 1000 + i * 1000
      rows.push(makeRow({ session_id: i + 1, worker_id: 0, event: "WS_OPEN_START", timestamp: ts, input_line_number: 0 }))
      rows.push(makeRow({ session_id: i + 1, worker_id: 0, event: "REQ_HOME_START", timestamp: ts + 10, input_line_number: 1 }))
      rows.push(makeRow({ session_id: i + 1, worker_id: 0, event: "REQ_HOME_END", timestamp: ts + 100, input_line_number: 1 }))
    }
    return processRun({ name: "concurrency-run", rows })
  }

  it("returns slope=0 for events with fewer than 2 data points", () => {
    const run = processRun({
      name: "single",
      rows: [
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_END", timestamp: 1500, input_line_number: 1 }),
      ],
    })
    const stats = computeEventConcurrency([run], makeRecording())
    expect(stats[0]!.slope).toBe(0)
  })

  it("returns slope/intercept/maxError from linear regression with sufficient points", () => {
    const run = makeRunWithConcurrency()
    const stats = computeEventConcurrency([run], makeRecording())
    expect(stats).toHaveLength(1)
    expect(typeof stats[0]!.slope).toBe("number")
    expect(typeof stats[0]!.intercept).toBe("number")
    expect(typeof stats[0]!.maxError).toBe("number")
  })

  it("returns results sorted by |slope| descending", () => {
    const run1 = makeRunWithConcurrency()
    const recording = makeRecording([
      { lineNumber: 1, type: "REQ_HOME", begin: 0, end: 100, label: "Event 1" },
      { lineNumber: 2, type: "REQ_GET", begin: 100, end: 200, label: "Event 2" },
    ])
    const extraRows: SessionRow[] = []
    for (let i = 0; i < 5; i++) {
      const ts = 1000 + i * 1000
      extraRows.push(makeRow({ session_id: i + 1, worker_id: 0, event: "REQ_GET_START", timestamp: ts + 200, input_line_number: 2 }))
      extraRows.push(makeRow({ session_id: i + 1, worker_id: 0, event: "REQ_GET_END", timestamp: ts + 210, input_line_number: 2 }))
    }
    const run2 = processRun({ name: "r2", rows: [...run1.paired.flatMap((p) => [
      makeRow({ session_id: p.session_id, worker_id: p.worker_id, event: p.event_base + "_START", timestamp: Math.round(p.start * 1000 + 1000), input_line_number: p.input_line_number }),
      makeRow({ session_id: p.session_id, worker_id: p.worker_id, event: p.event_base + "_END", timestamp: Math.round(p.end * 1000 + 1000), input_line_number: p.input_line_number }),
    ]), ...extraRows] })
    const stats = computeEventConcurrency([run1, run2], recording)
    expect(stats.length).toBeGreaterThanOrEqual(2)
    for (let i = 0; i < stats.length - 1; i++) {
      expect(Math.abs(stats[i]!.slope)).toBeGreaterThanOrEqual(Math.abs(stats[i + 1]!.slope))
    }
  })

  it("returns empty array when no maintenance events", () => {
    const stats = computeEventConcurrency([], makeRecording())
    expect(stats).toHaveLength(0)
  })
})

describe("computeLatency", () => {
  function makeLatencyRun(name: string, sessId: number, httpMs: number, wsMs: number): ReturnType<typeof processRun> {
    return processRun({
      name,
      rows: [
        makeRow({ session_id: sessId, worker_id: 0, event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ session_id: sessId, worker_id: 0, event: "REQ_HOME_END", timestamp: 1000 + httpMs, input_line_number: 1 }),
        makeRow({ session_id: sessId, worker_id: 0, event: "WS_RECV_START", timestamp: 2000, input_line_number: 3 }),
        makeRow({ session_id: sessId, worker_id: 0, event: "WS_RECV_END", timestamp: 2000 + wsMs, input_line_number: 3 }),
      ],
    })
  }

  it("computes http latency as sum of Homepage + JS/CSS per session", () => {
    const run = processRun({
      name: "run1",
      rows: [
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_END", timestamp: 1200, input_line_number: 1 }),
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_GET_START", timestamp: 1200, input_line_number: 2 }),
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_GET_END", timestamp: 1500, input_line_number: 2 }),
      ],
    })
    const stats = computeLatency([run])
    expect(stats.http).toHaveLength(1)
    expect(stats.http[0]!.total).toBeCloseTo(0.5)
  })

  it("computes ws latency as max of Calculate per session", () => {
    // Two WS_RECV events for the same session at different line numbers: 0.3s and 0.4s
    // wsBySess should record max(0.3, 0.4) = 0.4 for the session
    const run = processRun({
      name: "run1",
      rows: [
        makeRow({ session_id: 1, worker_id: 0, event: "WS_RECV_START", timestamp: 1000, input_line_number: 3 }),
        makeRow({ session_id: 1, worker_id: 0, event: "WS_RECV_END", timestamp: 1300, input_line_number: 3 }),
        makeRow({ session_id: 1, worker_id: 0, event: "WS_RECV_START", timestamp: 1300, input_line_number: 4 }),
        makeRow({ session_id: 1, worker_id: 0, event: "WS_RECV_END", timestamp: 1700, input_line_number: 4 }),
      ],
    })
    const stats = computeLatency([run])
    expect(stats.ws).toHaveLength(1)
    expect(stats.ws[0]!.max).toBeCloseTo(0.4)
  })

  it("only includes maintenance sessions", () => {
    const run = processRun({
      name: "run1",
      rows: [
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_END", timestamp: 1500, input_line_number: 1 }),
        makeRow({ session_id: 2, worker_id: 1, event: "REQ_HOME_START", timestamp: 5000, input_line_number: 1 }),
        makeRow({ session_id: 2, worker_id: 1, event: "REQ_HOME_END", timestamp: 5500, input_line_number: 1 }),
      ],
    })
    const stats = computeLatency([run])
    const httpIds = stats.http.map((s) => s.session_id)
    for (const id of httpIds) {
      const paired = run.paired.find((p) => p.session_id === id)
      expect(paired!.maintenance).toBe(true)
    }
  })

  it("computes median and P95", () => {
    const runs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) =>
      makeLatencyRun(`run${i}`, i, i * 100, i * 100),
    )
    const stats = computeLatency(runs)
    expect(stats.httpMedian).toBeGreaterThan(0)
    expect(stats.httpP95).toBeGreaterThanOrEqual(stats.httpMedian)
    expect(stats.wsMedian).toBeGreaterThan(0)
    expect(stats.wsP95).toBeGreaterThanOrEqual(stats.wsMedian)
  })

  it("does not merge sessions from different runs that share the same session_id", () => {
    const run1 = makeLatencyRun("run1", 1, 200, 300)
    const run2 = makeLatencyRun("run2", 1, 800, 900)
    const stats = computeLatency([run1, run2])
    expect(stats.http).toHaveLength(2)
    expect(stats.ws).toHaveLength(2)
    const totals = stats.http.map((s) => s.total).sort((a, b) => a - b)
    expect(totals[0]).toBeCloseTo(0.2)
    expect(totals[1]).toBeCloseTo(0.8)
  })
})

describe("computeReportStats", () => {
  it("orchestrates all computations and returns per-run and aggregate stats", () => {
    const data: ReportData = {
      runs: [
        {
          name: "run1",
          rows: [
            makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
            makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_END", timestamp: 1500, input_line_number: 1 }),
          ],
        },
      ],
      recording: makeRecording(),
    }
    const result = computeReportStats(data)
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]!.name).toBe("run1")
    expect(result.runs[0]!.sessionDurations).toBeDefined()
    expect(result.runs[0]!.eventDurations).toBeDefined()
    expect(result.runs[0]!.eventConcurrency).toBeDefined()
    expect(result.runs[0]!.latency).toBeDefined()
    expect(result.aggregate.eventDurations).toBeDefined()
    expect(result.aggregate.eventConcurrency).toBeDefined()
  })

  it("aggregates event durations across multiple runs", () => {
    const makeRun = (name: string, ms: number) => ({
      name,
      rows: [
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_START", timestamp: 1000, input_line_number: 1 }),
        makeRow({ session_id: 1, worker_id: 0, event: "REQ_HOME_END", timestamp: 1000 + ms, input_line_number: 1 }),
      ],
    })
    const data: ReportData = {
      runs: [makeRun("run1", 200), makeRun("run2", 600)],
      recording: makeRecording(),
    }
    const result = computeReportStats(data)
    expect(result.aggregate.eventDurations).toHaveLength(1)
    expect(result.aggregate.eventDurations[0]!.mean_diff).toBeGreaterThan(0)
  })
})
