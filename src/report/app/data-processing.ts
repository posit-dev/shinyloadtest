import type { RawRun, PairedEvent, ProcessedRun } from "./types"

export function processRun(run: RawRun): ProcessedRun {
  const rows = [...run.rows].sort((a, b) => a.timestamp - b.timestamp)
  if (rows.length === 0) return { name: run.name, paired: [] }

  const minTs = rows[0].timestamp

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

  const groups = new Map<string, typeof relevant>()
  for (const row of relevant) {
    const key =
      row.session_id +
      "," +
      row.worker_id +
      "," +
      row.iteration +
      "," +
      row.input_line_number
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }

  const paired: Omit<PairedEvent, "maintenance">[] = []
  for (const [, groupRows] of groups) {
    const start = Math.min(...groupRows.map((r) => r.ts))
    const end = Math.max(...groupRows.map((r) => r.ts))
    const concSum = groupRows.reduce((s, r) => s + r.concurrency, 0)
    const baseEvent = groupRows[0].event.replace(/_(START|END)$/, "")

    paired.push({
      session_id: groupRows[0].session_id,
      worker_id: groupRows[0].worker_id,
      iteration: groupRows[0].iteration,
      input_line_number: groupRows[0].input_line_number,
      event_base: baseEvent,
      start,
      end,
      time: end - start,
      concurrency: concSum / groupRows.length,
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

export function identifyMaintenance(
  events: Array<{
    session_id: number
    worker_id: number
    start: number
    end: number
  }>,
): Set<number> {
  const byWorker = new Map<number, typeof events>()
  for (const e of events) {
    if (!byWorker.has(e.worker_id)) byWorker.set(e.worker_id, [])
    byWorker.get(e.worker_id)!.push(e)
  }

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
    if (!bySess.has(e.session_id))
      bySess.set(e.session_id, { min: Infinity, max: -Infinity })
    const s = bySess.get(e.session_id)!
    s.min = Math.min(s.min, e.start)
    s.max = Math.max(s.max, e.end)
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
