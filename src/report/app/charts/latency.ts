import * as Plot from "@observablehq/plot"
import * as d3 from "d3"
import { CHART_WIDTH, EVENT_COLORS, EVENT_ORDER } from "../constants"
import { clearChart, classifiedRunData, enableTooltips, eventLegend } from "../utils"
import type { AppState } from "../types"

export function renderLatency(state: AppState): void {
  renderLatencyFaceted(state, "http-latency-chart", ["Homepage", "JS/CSS"], 5)
  renderLatencyFaceted(state, "ws-latency-chart", ["Calculate"], 20)
}

function renderLatencyFaceted(state: AppState, containerId: string, eventLabels: string[], cutoff: number): void {
  const el = clearChart(containerId)

  for (let ri = 0; ri < state.runs.length; ri++) {
    const run = state.runs[ri]
    const data = classifiedRunData(run).filter(d => eventLabels.includes(d.eventLabel))
    if (data.length === 0) continue

    if (state.runs.length > 1) {
      const label = document.createElement("p")
      label.className = "run-panel-label"
      label.textContent = run.name
      el.appendChild(label)
    }

    const bySess = new Map<number, typeof data>()
    for (const d of data) {
      if (!bySess.has(d.session_id)) bySess.set(d.session_id, [])
      bySess.get(d.session_id)!.push(d)
    }

    const chartData: Array<{ session: string; eventLabel: string; latency: number; maintenance: boolean }> = []
    for (const [sid, events] of bySess) {
      for (const label of EVENT_ORDER) {
        const evts = events.filter(e => e.eventLabel === label)
        if (evts.length > 0) {
          const total = d3.sum(evts, e => e.time)
          chartData.push({ session: "S" + sid, eventLabel: label, latency: total, maintenance: evts[0].maintenance })
        }
      }
    }

    const maintSessions = [...new Set(chartData.filter(d => d.maintenance).map(d => d.session))]
    const allSessions = [...new Set(chartData.map(d => d.session))]

    const marks: Plot.Markish[] = [
      Plot.barY(chartData, eventLabels.length > 1
        ? Plot.stackY({ x: "session", y: "latency", fill: "eventLabel", order: EVENT_ORDER as unknown as string[], title: (d: typeof chartData[number]) => d.eventLabel + "\n" + d.latency.toFixed(2) + "s" })
        : { x: "session", y: "latency", fill: "eventLabel", title: (d: typeof chartData[number]) => d.eventLabel + "\n" + d.latency.toFixed(2) + "s" }
      ),
      Plot.ruleY([cutoff], { stroke: "red", strokeWidth: 1.5 }),
    ]

    if (maintSessions.length > 0 && maintSessions.length < allSessions.length) {
      const maintIndices = maintSessions.map(s => allSessions.indexOf(s)).filter(i => i >= 0)
      const minIdx = Math.min(...maintIndices)
      const maxIdx = Math.max(...maintIndices)
      const boundaryLabels: string[] = []
      if (minIdx > 0) boundaryLabels.push(allSessions[minIdx])
      if (maxIdx < allSessions.length - 1) boundaryLabels.push(allSessions[maxIdx])
      if (boundaryLabels.length > 0) {
        marks.push(
          Plot.ruleX(boundaryLabels, { stroke: "rgba(0,0,0,0.7)", strokeDasharray: "4,4" })
        )
      }
    }

    const chart = Plot.plot({
      width: CHART_WIDTH,
      height: 300,
      marginBottom: 30,
      x: { label: null, axis: null },
      y: { label: "Total latency (sec)" },
      color: { domain: EVENT_ORDER as unknown as string[], range: EVENT_ORDER.map(e => EVENT_COLORS[e]) },
      marks,
    })

    el.appendChild(chart)
    enableTooltips(chart as unknown as HTMLElement)
  }

  el.insertBefore(eventLegend(), el.firstChild)
}
