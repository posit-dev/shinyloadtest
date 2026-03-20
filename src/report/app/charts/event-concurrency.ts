import * as Plot from "@observablehq/plot"
import * as d3 from "d3"
import { EVENT_COLORS, EVENT_TYPE_MAP, RUN_COLORS } from "../constants"
import {
  clearChart,
  makeGridPicker,
  makeSortableTable,
  runLegend,
} from "../utils"
import type { AppState } from "../types"

export function renderEventConcurrency(state: AppState): void {
  const allData = state.runs.flatMap((run, ri) =>
    run.paired
      .filter((d) => d.maintenance)
      .map((d) => ({
        ...d,
        run_name: run.name,
        run_idx: ri,
        label: state.getRecordingLabel(d.input_line_number),
      })),
  )
  if (allData.length === 0) return

  const byEventRun = new Map<string, typeof allData>()
  for (const d of allData) {
    const key = d.input_line_number + "|" + d.run_idx
    if (!byEventRun.has(key)) byEventRun.set(key, [])
    byEventRun.get(key)!.push(d)
  }

  const perRunStats: Array<{
    label: string
    input_line_number: number
    event_base: string
    run_idx: number
    slope: number
    intercept: number
    maxError: number
  }> = []
  for (const [, events] of byEventRun) {
    const n = events.length
    const lineNum = events[0].input_line_number
    const label = events[0].label
    const eventBase = events[0].event_base
    const runIdx = events[0].run_idx

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
    const sumX = d3.sum(events, (d) => d.concurrency)
    const sumY = d3.sum(events, (d) => d.time)
    const sumXY = d3.sum(events, (d) => d.concurrency * d.time)
    const sumX2 = d3.sum(events, (d) => d.concurrency * d.concurrency)
    const denom = n * sumX2 - sumX * sumX
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0
    const intercept = (sumY - slope * sumX) / n
    const maxError =
      d3.max(events, (d) =>
        Math.abs(d.time - (slope * d.concurrency + intercept)),
      ) ?? 0
    perRunStats.push({
      label,
      input_line_number: lineNum,
      event_base: eventBase,
      run_idx: runIdx,
      slope,
      intercept,
      maxError,
    })
  }

  const byEvent = new Map<number, typeof perRunStats>()
  for (const s of perRunStats) {
    if (!byEvent.has(s.input_line_number)) byEvent.set(s.input_line_number, [])
    byEvent.get(s.input_line_number)!.push(s)
  }

  const stats = [...byEvent.entries()].map(([lineNum, runStats]) => {
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
      label: runStats[0].label,
      input_line_number: lineNum,
      event_base: runStats[0].event_base,
      slope: worstSlope.slope,
      intercept: worstIntercept.intercept,
      maxError: worstError.maxError,
    }
  })

  const bySlope = [...stats].sort(
    (a, b) => Math.abs(b.slope) - Math.abs(a.slope),
  )
  const byIntercept = [...stats].sort(
    (a, b) => Math.abs(b.intercept) - Math.abs(a.intercept),
  )
  const byMaxError = [...stats].sort((a, b) => b.maxError - a.maxError)

  const concTotalEvents = stats.length
  let sharedConcGridCount = Math.min(12, concTotalEvents)

  const concGrids = [
    { id: "conc-slope-grid", ordered: bySlope },
    { id: "conc-intercept-grid", ordered: byIntercept },
    { id: "conc-error-grid", ordered: byMaxError },
  ]

  type StatEntry = (typeof stats)[number]

  function buildConcGrid(
    container: HTMLElement,
    pickerEl: HTMLElement,
    orderedStats: StatEntry[],
    maxItems: number,
  ) {
    container.innerHTML = ""
    container.appendChild(pickerEl)
    if (state.runs.length > 1) {
      const legend = runLegend(state.runs)
      if (legend) container.appendChild(legend)
    }
    const grid = document.createElement("div")
    grid.className = "chart-grid"
    container.appendChild(grid)

    for (const stat of orderedStats.slice(0, maxItems)) {
      const item = document.createElement("div")
      item.className = "chart-grid-item"
      grid.appendChild(item)

      const title = document.createElement("h4")
      title.textContent = stat.label
      title.title = stat.label
      item.appendChild(title)

      const eventData = allData.filter(
        (d) => d.input_line_number === stat.input_line_number,
      )

      const marks: Plot.Markish[] = []
      if (state.runs.length > 1) {
        marks.push(
          Plot.dot(eventData, {
            x: "concurrency",
            y: "time",
            fill: (d: (typeof eventData)[number]) =>
              RUN_COLORS[d.run_idx % RUN_COLORS.length],
            fillOpacity: 0.6,
            r: 3,
          }),
        )
      } else {
        marks.push(
          Plot.dot(eventData, {
            x: "concurrency",
            y: "time",
            fill:
              EVENT_COLORS[
                EVENT_TYPE_MAP[stat.event_base as keyof typeof EVENT_TYPE_MAP]
              ] ?? "#999",
            fillOpacity: 0.6,
            r: 3,
          }),
        )
      }
      marks.push(
        Plot.linearRegressionY(eventData, {
          x: "concurrency",
          y: "time",
          stroke: "#999",
          strokeWidth: 1.5,
        }),
      )

      const chart = Plot.plot({
        height: 160,
        width: 260,
        marginLeft: 40,
        marginRight: 10,
        x: { label: "Concurrency", grid: true },
        y: { label: "Time (sec)", grid: true },
        marks,
      })
      item.appendChild(chart)
    }
  }

  const concGridState = concGrids.map((g) => {
    const el = clearChart(g.id)
    const { picker } = makeGridPicker(
      concTotalEvents,
      sharedConcGridCount,
      (n) => {
        sharedConcGridCount = n
        renderAllConcGrids()
      },
    )
    return { el, picker, ordered: g.ordered }
  })

  function renderAllConcGrids() {
    for (const g of concGridState) {
      const input = g.picker.querySelector("input")
      if (input) input.value = String(sharedConcGridCount)
      buildConcGrid(g.el, g.picker, g.ordered, sharedConcGridCount)
    }
  }
  renderAllConcGrids()

  makeSortableTable(
    clearChart("conc-table-content"),
    [
      { key: "label", label: "Event" },
      { key: "slope", label: "Slope" },
      { key: "intercept", label: "Intercept" },
      { key: "maxError", label: "Max Error" },
    ],
    stats as unknown as Record<string, unknown>[],
    "slope",
    false,
  )
}
