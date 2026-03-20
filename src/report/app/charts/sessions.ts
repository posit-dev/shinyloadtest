import * as Plot from "@observablehq/plot"
import * as d3 from "d3"
import { CHART_WIDTH, EVENT_COLORS, EVENT_ORDER, EVENT_TYPE_MAP } from "../constants"
import { clearChart, enableTooltips, eventLegend } from "../utils"
import type { AppState } from "../types"

export function renderSessions(state: AppState): void {
  const el = clearChart("sessions-chart")
  const data = state.runs[state.currentRunIdx].paired
    .filter(d => EVENT_TYPE_MAP[d.event_base as keyof typeof EVENT_TYPE_MAP])
    .map(d => ({ ...d, eventLabel: EVENT_TYPE_MAP[d.event_base as keyof typeof EVENT_TYPE_MAP], worker: "Worker " + d.worker_id }))

  if (data.length === 0) { el.textContent = "No data"; return }

  const nWorkers = new Set(data.map(d => d.worker_id)).size
  const desc = document.getElementById("sessions-desc")
  if (desc) desc.textContent = nWorkers + " simulated user" + (nWorkers !== 1 ? "s" : "") + " executing back-to-back sessions. Warmup or cooldown sessions (desaturated) start before or end after the vertical dotted line. Narrower event bars mean better performance."

  const maint = data.filter(d => d.maintenance)
  const maintMin = maint.length > 0 ? d3.min(maint, d => d.start) ?? null : null
  const maintMax = maint.length > 0 ? d3.max(maint, d => d.end) ?? null : null

  const workers = [...new Set(data.map(d => d.worker))].sort().reverse()
  const height = Math.max(200, workers.length * 40 + 80)

  const marks: Plot.Markish[] = [
    Plot.barX(data, {
      x1: "start",
      x2: "end",
      y: "worker",
      fill: "eventLabel",
      opacity: (d: typeof data[number]) => d.maintenance ? 1 : 0.35,
      title: (d: typeof data[number]) => state.getRecordingLabel(d.input_line_number) + "\n" + d.time.toFixed(2) + "s",
    }),
  ]

  if (maintMin !== null) {
    marks.push(
      Plot.ruleX([maintMin, maintMax], { stroke: "black", strokeDasharray: "4,4", strokeOpacity: 0.7 })
    )
  }

  const chart = Plot.plot({
    width: CHART_WIDTH,
    height,
    marginLeft: 80,
    x: { label: "Elapsed time (sec)", domain: state.globalSessionsXDomain },
    y: { label: "Simulated user #", domain: workers },
    color: { domain: EVENT_ORDER as unknown as string[], range: EVENT_ORDER.map(e => EVENT_COLORS[e]) },
    marks,
  })

  el.appendChild(eventLegend())
  el.appendChild(chart)
  enableTooltips(el)
}
