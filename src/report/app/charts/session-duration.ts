import * as Plot from "@observablehq/plot"
import * as d3 from "d3"
import { CHART_WIDTH, EVENT_COLORS, EVENT_ORDER } from "../constants"
import { clearChart, classifiedRunData, enableTooltips, eventLegend } from "../utils"
import type { AppState } from "../types"

export function renderSessionDuration(state: AppState): void {
  const el = clearChart("session-duration-chart")
  const data = classifiedRunData(state.runs[state.currentRunIdx])
  if (data.length === 0) { el.textContent = "No data"; return }

  const nSess = new Set(data.map(d => d.session_id)).size
  const cutoffSec = Math.round(state.recordingDuration || 60)
  const desc = document.getElementById("session-duration-desc")
  if (desc) desc.textContent = nSess + " maintenance session" + (nSess !== 1 ? "s" : "") + " ordered from fastest to slowest completion time. The red line marks how long the original recording session took to complete (~" + cutoffSec + "s). Sessions should end around the same time as each other for consistent behavior."

  const bySess = new Map<number, number>()
  for (const d of data) {
    if (!bySess.has(d.session_id)) bySess.set(d.session_id, Infinity)
    bySess.set(d.session_id, Math.min(bySess.get(d.session_id)!, d.start))
  }

  const relData = data.map(d => {
    const sessStart = bySess.get(d.session_id)!
    return { ...d, relStart: d.start - sessStart, relEnd: d.end - sessStart }
  })

  const sessMaxEnd = new Map<number, number>()
  for (const d of relData) {
    const cur = sessMaxEnd.get(d.session_id) ?? 0
    sessMaxEnd.set(d.session_id, Math.max(cur, d.relEnd))
  }
  const orderedSessions = [...sessMaxEnd.entries()]
    .sort((a, b) => a[1] - b[1])
    .map((d, i) => [d[0], "Session " + i] as [number, string])
  const sessOrder = new Map(orderedSessions)
  const yDomain = orderedSessions.map(d => d[1])

  const plotData = relData.map(d => ({
    ...d,
    sessLabel: sessOrder.get(d.session_id),
  }))

  const cutoff = state.recordingDuration || 60
  const nSessions = sessOrder.size
  const maxEnd = d3.max(relData, d => d.relEnd) ?? 0
  const xMax = Math.max(maxEnd, cutoff)

  const chart = Plot.plot({
    width: CHART_WIDTH,
    height: Math.max(300, nSessions * 12 + 80),
    marginLeft: 20,
    x: { label: "Time since session start (sec)", domain: [0, xMax * 1.05] },
    y: { label: "Sessions (ordered by total duration)", domain: yDomain, axis: null },
    color: { domain: EVENT_ORDER as unknown as string[], range: EVENT_ORDER.map(e => EVENT_COLORS[e]) },
    marks: [
      Plot.barX(plotData, {
        x1: "relStart",
        x2: "relEnd",
        y: "sessLabel",
        fill: "eventLabel",
        title: (d: typeof plotData[number]) => state.getRecordingLabel(d.input_line_number) + "\n" + d.time.toFixed(2) + "s",
      }),
      Plot.ruleX([cutoff], { stroke: "red", strokeWidth: 1.5 }),
    ],
  })

  el.appendChild(eventLegend())
  el.appendChild(chart)
  enableTooltips(el)
}
