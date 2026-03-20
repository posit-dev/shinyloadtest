import * as Plot from "@observablehq/plot"
import * as d3 from "d3"
import { CHART_WIDTH } from "../constants"
import { clearChart } from "../utils"
import type { AppState } from "../types"

export function renderWaterfall(state: AppState): void {
  const el = clearChart("waterfall-chart")
  const allData = state.runs[state.currentRunIdx].paired
  if (allData.length === 0) {
    el.textContent = "No data"
    return
  }

  const labelOrder = state.rawData.recording.events.map((e) => e.label)

  const sessMin = new Map<number, number>()
  for (const d of allData) {
    if (!sessMin.has(d.session_id)) sessMin.set(d.session_id, Infinity)
    sessMin.set(d.session_id, Math.min(sessMin.get(d.session_id)!, d.start))
  }

  const waterfallData = allData
    .map((d) => ({
      session_id: d.session_id,
      maintenance: d.maintenance,
      relEnd: d.end - sessMin.get(d.session_id)!,
      label: state.getRecordingLabel(d.input_line_number),
      input_line_number: d.input_line_number,
      concurrency: d.concurrency,
    }))
    .sort((a, b) => a.input_line_number - b.input_line_number)

  const maintData = waterfallData.filter((d) => d.maintenance)
  const nonMaintData = waterfallData.filter((d) => !d.maintenance)
  const maxConc = d3.max(maintData, (d) => d.concurrency) ?? 1

  const maintRelEnds = maintData.map((d) => d.relEnd)
  const maintMin =
    maintRelEnds.length > 0 ? (d3.min(maintRelEnds) ?? null) : null
  const maintMax =
    maintRelEnds.length > 0 ? (d3.max(maintRelEnds) ?? null) : null

  const marks: Plot.Markish[] = []

  if (nonMaintData.length > 0) {
    marks.push(
      Plot.line(nonMaintData, {
        x: "relEnd",
        y: "label",
        z: "session_id",
        stroke: "#ccc",
        strokeWidth: 1,
        strokeOpacity: 0.4,
      }),
    )
  }

  marks.push(
    Plot.line(maintData, {
      x: "relEnd",
      y: "label",
      z: "session_id",
      stroke: "concurrency",
      strokeWidth: 1.5,
      strokeOpacity: 0.8,
    }),
  )

  marks.push(
    Plot.ruleY(
      maintData,
      Plot.pointerY({
        y: "label",
        stroke: "rgba(0,0,0,0.5)",
        strokeWidth: 1,
      }),
    ),
  )

  if (maintMin !== null && nonMaintData.length > 0) {
    marks.push(
      Plot.ruleX([maintMin, maintMax], {
        stroke: "rgba(0,0,0,0.7)",
        strokeDasharray: "4,4",
        strokeWidth: 0.5,
      }),
    )
  }

  const chart = Plot.plot({
    width: CHART_WIDTH,
    height: Math.max(300, labelOrder.length * 20 + 80),
    marginLeft: 240,
    x: { label: "Time since session start (sec)" },
    y: {
      label: null,
      domain: labelOrder,
    },
    color: {
      type: "linear",
      range: ["#413554", "#75aadb", "#9efa9e", "#fdc086"],
      interpolate: "rgb",
      domain: [0, maxConc * 0.33, maxConc * 0.67, maxConc],
      label: "concurrency",
    },
    marks,
  })

  el.appendChild(chart)
}
