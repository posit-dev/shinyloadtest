import { describe, it, expect } from "vitest"
import type { RawRun } from "../types"
import { processRun, identifyMaintenance } from "../data-processing"
import demo1 from "../fixtures/demo1.json"
import demo4 from "../fixtures/demo4.json"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(
  overrides: Partial<RawRun["rows"][number]>,
): RawRun["rows"][number] {
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

function makeRun(overrides?: Partial<RawRun>): RawRun {
  return { name: "test-run", rows: [], ...overrides }
}

// ---------------------------------------------------------------------------
// processRun — hand-crafted edge cases
// ---------------------------------------------------------------------------

describe("processRun", () => {
  it("returns empty paired array and preserves name for empty rows", () => {
    const result = processRun(makeRun({ name: "empty-run", rows: [] }))
    expect(result.name).toBe("empty-run")
    expect(result.paired).toHaveLength(0)
  })

  it("pairs START/END events and computes time in seconds", () => {
    const result = processRun(
      makeRun({
        rows: [
          makeRow({
            event: "REQ_HOME_START",
            timestamp: 1000,
            input_line_number: 1,
          }),
          makeRow({
            event: "REQ_HOME_END",
            timestamp: 1500,
            input_line_number: 1,
          }),
        ],
      }),
    )
    expect(result.paired).toHaveLength(1)
    expect(result.paired[0]!.event_base).toBe("REQ_HOME")
    expect(result.paired[0]!.time).toBeCloseTo(0.5)
  })

  it("normalizes timestamps relative to first event", () => {
    const result = processRun(
      makeRun({
        rows: [
          makeRow({
            event: "REQ_HOME_START",
            timestamp: 10000,
            input_line_number: 1,
          }),
          makeRow({
            event: "REQ_HOME_END",
            timestamp: 11000,
            input_line_number: 1,
          }),
        ],
      }),
    )
    expect(result.paired[0]!.start).toBeCloseTo(0)
    expect(result.paired[0]!.end).toBeCloseTo(1.0)
  })

  it("sorts rows by timestamp before pairing", () => {
    const result = processRun(
      makeRun({
        rows: [
          makeRow({
            event: "REQ_HOME_END",
            timestamp: 1500,
            input_line_number: 1,
          }),
          makeRow({
            event: "REQ_HOME_START",
            timestamp: 1000,
            input_line_number: 1,
          }),
        ],
      }),
    )
    expect(result.paired).toHaveLength(1)
    expect(result.paired[0]!.time).toBeCloseTo(0.5)
  })

  it("filters out PLAYBACK_* events", () => {
    const result = processRun(
      makeRun({
        rows: [
          makeRow({
            event: "REQ_HOME_START",
            timestamp: 1000,
            input_line_number: 1,
          }),
          makeRow({
            event: "REQ_HOME_END",
            timestamp: 1200,
            input_line_number: 1,
          }),
          makeRow({
            event: "PLAYBACK_START",
            timestamp: 500,
            input_line_number: 0,
          }),
          makeRow({
            event: "PLAYBACK_DONE",
            timestamp: 1300,
            input_line_number: 0,
          }),
        ],
      }),
    )
    expect(result.paired).toHaveLength(1)
    expect(result.paired[0]!.event_base).toBe("REQ_HOME")
  })

  it("filters out PLAYER_SESSION_CREATE events", () => {
    const result = processRun(
      makeRun({
        rows: [
          makeRow({
            event: "PLAYER_SESSION_CREATE",
            timestamp: 900,
            input_line_number: 0,
          }),
          makeRow({
            event: "REQ_HOME_START",
            timestamp: 1000,
            input_line_number: 1,
          }),
          makeRow({
            event: "REQ_HOME_END",
            timestamp: 1200,
            input_line_number: 1,
          }),
        ],
      }),
    )
    expect(result.paired).toHaveLength(1)
  })

  it("filters out rows with input_line_number <= 0", () => {
    const result = processRun(
      makeRun({
        rows: [
          makeRow({
            event: "WS_OPEN_START",
            timestamp: 900,
            input_line_number: 0,
          }),
          makeRow({
            event: "WS_OPEN_END",
            timestamp: 950,
            input_line_number: 0,
          }),
          makeRow({
            event: "REQ_HOME_START",
            timestamp: 1000,
            input_line_number: 1,
          }),
          makeRow({
            event: "REQ_HOME_END",
            timestamp: 1200,
            input_line_number: 1,
          }),
        ],
      }),
    )
    expect(result.paired).toHaveLength(1)
  })

  it("increments concurrency on WS_OPEN_START and decrements on WS_CLOSE_END", () => {
    const result = processRun(
      makeRun({
        rows: [
          makeRow({
            event: "WS_OPEN_START",
            timestamp: 1000,
            input_line_number: 0,
          }),
          makeRow({
            event: "WS_OPEN_START",
            timestamp: 1100,
            input_line_number: 0,
          }),
          makeRow({
            event: "REQ_HOME_START",
            timestamp: 1200,
            input_line_number: 1,
          }),
          makeRow({
            event: "REQ_HOME_END",
            timestamp: 1500,
            input_line_number: 1,
          }),
          makeRow({
            event: "WS_CLOSE_END",
            timestamp: 1600,
            input_line_number: 0,
          }),
          makeRow({
            event: "REQ_GET_START",
            timestamp: 1700,
            input_line_number: 2,
          }),
          makeRow({
            event: "REQ_GET_END",
            timestamp: 1800,
            input_line_number: 2,
          }),
        ],
      }),
    )
    const home = result.paired.find((p) => p.event_base === "REQ_HOME")
    const get = result.paired.find((p) => p.event_base === "REQ_GET")
    expect(home!.concurrency).toBeGreaterThan(get!.concurrency)
  })

  it("tags all sessions as maintenance for a single worker", () => {
    const result = processRun(
      makeRun({
        rows: [
          makeRow({
            session_id: 1,
            worker_id: 0,
            event: "REQ_HOME_START",
            timestamp: 1000,
            input_line_number: 1,
          }),
          makeRow({
            session_id: 1,
            worker_id: 0,
            event: "REQ_HOME_END",
            timestamp: 1500,
            input_line_number: 1,
          }),
          makeRow({
            session_id: 2,
            worker_id: 0,
            event: "REQ_HOME_START",
            timestamp: 2000,
            input_line_number: 1,
          }),
          makeRow({
            session_id: 2,
            worker_id: 0,
            event: "REQ_HOME_END",
            timestamp: 2500,
            input_line_number: 1,
          }),
        ],
      }),
    )
    expect(result.paired.every((p) => p.maintenance)).toBe(true)
  })

  it("tags only sessions inside the overlap window as maintenance for multiple workers", () => {
    const result = processRun(
      makeRun({
        rows: [
          // Early warmup session on worker 0 (before overlap)
          makeRow({
            session_id: 10,
            worker_id: 0,
            event: "REQ_HOME_START",
            timestamp: 100,
            input_line_number: 1,
          }),
          makeRow({
            session_id: 10,
            worker_id: 0,
            event: "REQ_HOME_END",
            timestamp: 200,
            input_line_number: 1,
          }),
          // Overlapping session on worker 0
          makeRow({
            session_id: 11,
            worker_id: 0,
            event: "REQ_HOME_START",
            timestamp: 2000,
            input_line_number: 1,
          }),
          makeRow({
            session_id: 11,
            worker_id: 0,
            event: "REQ_HOME_END",
            timestamp: 4000,
            input_line_number: 1,
          }),
          // Overlapping session on worker 1
          makeRow({
            session_id: 20,
            worker_id: 1,
            event: "REQ_HOME_START",
            timestamp: 2000,
            input_line_number: 1,
          }),
          makeRow({
            session_id: 20,
            worker_id: 1,
            event: "REQ_HOME_END",
            timestamp: 4000,
            input_line_number: 1,
          }),
        ],
      }),
    )
    const mainIds = new Set(
      result.paired.filter((p) => p.maintenance).map((p) => p.session_id),
    )
    expect(mainIds.has(11)).toBe(true)
    expect(mainIds.has(20)).toBe(true)
    expect(mainIds.has(10)).toBe(false)
  })

  it("falls back to all sessions as maintenance when no session fits the overlap window", () => {
    const result = processRun(
      makeRun({
        rows: [
          makeRow({
            session_id: 1,
            worker_id: 0,
            event: "REQ_HOME_START",
            timestamp: 1000,
            input_line_number: 1,
          }),
          makeRow({
            session_id: 1,
            worker_id: 0,
            event: "REQ_HOME_END",
            timestamp: 1100,
            input_line_number: 1,
          }),
          makeRow({
            session_id: 2,
            worker_id: 1,
            event: "REQ_HOME_START",
            timestamp: 5000,
            input_line_number: 1,
          }),
          makeRow({
            session_id: 2,
            worker_id: 1,
            event: "REQ_HOME_END",
            timestamp: 5100,
            input_line_number: 1,
          }),
        ],
      }),
    )
    expect(result.paired.every((p) => p.maintenance)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// processRun — fixture-based realistic tests
// ---------------------------------------------------------------------------

describe("processRun with demo1 fixture (single worker)", () => {
  const run = processRun(demo1.runs[0]!)

  it("produces paired events from demo1", () => {
    expect(run.paired.length).toBeGreaterThan(0)
  })

  it("all sessions are maintenance (single worker)", () => {
    expect(run.paired.every((p) => p.maintenance)).toBe(true)
  })

  it("all times are non-negative", () => {
    expect(run.paired.every((p) => p.time >= 0)).toBe(true)
  })

  it("all start values are non-negative", () => {
    expect(run.paired.every((p) => p.start >= 0)).toBe(true)
  })

  it("end >= start for every paired event", () => {
    expect(run.paired.every((p) => p.end >= p.start)).toBe(true)
  })
})

describe("processRun with demo4 fixture (multi-worker)", () => {
  const run = processRun(demo4.runs[0]!)

  it("produces paired events from demo4", () => {
    expect(run.paired.length).toBeGreaterThan(0)
  })

  it("has a mix of maintenance and non-maintenance sessions", () => {
    const mainCount = run.paired.filter((p) => p.maintenance).length
    const nonMainCount = run.paired.filter((p) => !p.maintenance).length
    expect(mainCount).toBeGreaterThan(0)
    expect(nonMainCount).toBeGreaterThan(0)
  })

  it("all times are non-negative", () => {
    expect(run.paired.every((p) => p.time >= 0)).toBe(true)
  })

  it("end >= start for every paired event", () => {
    expect(run.paired.every((p) => p.end >= p.start)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// identifyMaintenance
// ---------------------------------------------------------------------------

describe("identifyMaintenance", () => {
  it("returns empty set for empty input", () => {
    const result = identifyMaintenance([])
    expect(result.size).toBe(0)
  })

  it("returns all session IDs when there is only one worker", () => {
    const events = [
      { session_id: 1, worker_id: 0, start: 0, end: 1 },
      { session_id: 2, worker_id: 0, start: 1, end: 2 },
    ]
    const result = identifyMaintenance(events)
    expect(result).toEqual(new Set([1, 2]))
  })

  it("returns sessions fully within the overlap window for multiple workers", () => {
    const events = [
      // Worker 0 runs from t=2..5; worker 1 runs from t=3..6
      // Overlap window: latestStart=max(2,3)=3, earliestEnd=min(5,6)=5
      { session_id: 10, worker_id: 0, start: 3, end: 4.5 }, // inside [3,5]
      { session_id: 20, worker_id: 1, start: 3, end: 4 }, // inside [3,5]
      { session_id: 30, worker_id: 0, start: 0, end: 2.5 }, // outside (before)
      { session_id: 40, worker_id: 1, start: 5.5, end: 6 }, // outside (after)
    ]
    const result = identifyMaintenance(events)
    expect(result.has(10)).toBe(true)
    expect(result.has(20)).toBe(true)
    expect(result.has(30)).toBe(false)
    expect(result.has(40)).toBe(false)
  })

  it("falls back to all sessions when no session qualifies", () => {
    // Workers have disjoint time ranges so the overlap window catches nobody
    const events = [
      { session_id: 1, worker_id: 0, start: 0, end: 1 },
      { session_id: 2, worker_id: 1, start: 5, end: 6 },
    ]
    const result = identifyMaintenance(events)
    expect(result).toEqual(new Set([1, 2]))
  })
})
