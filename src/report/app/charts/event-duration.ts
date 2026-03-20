import * as Plot from "@observablehq/plot"
import * as d3 from "d3"
import { EVENT_COLORS, EVENT_TYPE_MAP, RUN_COLORS } from "../constants"
import { clearChart, makeGridPicker, makeSortableTable } from "../utils"
import type { AppState } from "../types"

export function renderEventDuration(state: AppState): void {
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

  const byEventRun = new Map<
    string,
    {
      label: string
      input_line_number: number
      event_base: string
      run_idx: number
      times: number[]
    }
  >()
  for (const d of allData) {
    const key = d.input_line_number + "|" + d.run_idx
    if (!byEventRun.has(key))
      byEventRun.set(key, {
        label: d.label,
        input_line_number: d.input_line_number,
        event_base: d.event_base,
        run_idx: d.run_idx,
        times: [],
      })
    byEventRun.get(key)!.times.push(d.time)
  }

  const perRunStats = [...byEventRun.values()].map((g) => {
    const times = g.times.sort((a, b) => a - b)
    const n = times.length
    const mid = Math.floor(n / 2)
    return {
      label: g.label,
      input_line_number: g.input_line_number,
      event_base: g.event_base,
      run_idx: g.run_idx,
      min_time: times[0],
      max_time: times[n - 1],
      mean_time: times.reduce((s, v) => s + v, 0) / n,
      median_time: n % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2,
      count: n,
    }
  })

  const byEvent = new Map<number, typeof perRunStats>()
  for (const s of perRunStats) {
    if (!byEvent.has(s.input_line_number)) byEvent.set(s.input_line_number, [])
    byEvent.get(s.input_line_number)!.push(s)
  }

  const stats = [...byEvent.entries()].map(([lineNum, runStats]) => {
    const means = runStats.map((s) => s.mean_time)
    return {
      label: runStats[0].label,
      input_line_number: lineNum,
      event_base: runStats[0].event_base,
      min_time: d3.min(runStats, (s) => s.min_time)!,
      max_time: d3.max(runStats, (s) => s.max_time)!,
      mean_time: d3.mean(means)!,
      median_time: d3.median(runStats.flatMap((s) => [s.median_time]))!,
      count: d3.sum(runStats, (s) => s.count),
      mean_diff: means.length > 1 ? d3.max(means)! - d3.min(means)! : 0,
    }
  })

  const byMax = [...stats].sort((a, b) => b.max_time - a.max_time)
  const byMin = [...stats].sort((a, b) => b.min_time - a.min_time)
  const byMeanDiff = [...stats].sort((a, b) => b.mean_diff - a.mean_diff)

  const totalEvents = stats.length
  let sharedGridCount = Math.min(12, totalEvents)

  const grids = [
    { id: "dur-max-grid", ordered: byMax },
    { id: "dur-min-grid", ordered: byMin },
  ]
  if (state.runs.length > 1) {
    grids.push({ id: "dur-mean-diff-grid", ordered: byMeanDiff })
  }

  type StatEntry = (typeof stats)[number]

  function buildGrid(
    container: HTMLElement,
    pickerEl: HTMLElement,
    orderedStats: StatEntry[],
    maxItems: number,
  ) {
    container.innerHTML = ""
    container.appendChild(pickerEl)
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

      let chart: SVGElement | HTMLElement
      if (state.runs.length > 1) {
        chart = Plot.plot({
          height: 160,
          width: 260,
          marginLeft: 40,
          marginRight: 10,
          x: { axis: null, padding: 0.15 },
          y: { label: "Time (sec)", grid: true },
          color: {
            domain: state.runs.map((r) => r.name),
            range: state.runs.map((_, i) => RUN_COLORS[i % RUN_COLORS.length]),
          },
          marks: [
            Plot.boxY(eventData, {
              x: "run_name",
              y: "time",
              fill: "run_name",
            }),
          ],
        })
      } else {
        chart = Plot.plot({
          height: 160,
          width: 260,
          marginLeft: 40,
          marginRight: 10,
          x: { axis: null, padding: 0.15 },
          y: { label: "Time (sec)", grid: true },
          marks: [
            Plot.boxY(eventData, {
              x: () => "",
              y: "time",
              fill:
                EVENT_COLORS[
                  EVENT_TYPE_MAP[stat.event_base as keyof typeof EVENT_TYPE_MAP]
                ] ?? "#999",
            }),
          ],
        })
      }
      item.appendChild(chart)
    }
  }

  const gridState = grids.map((g) => {
    const el = clearChart(g.id)
    const { picker } = makeGridPicker(totalEvents, sharedGridCount, (n) => {
      sharedGridCount = n
      renderAllDurGrids()
    })
    return { el, picker, ordered: g.ordered }
  })

  function renderAllDurGrids() {
    for (const g of gridState) {
      const input = g.picker.querySelector("input")
      if (input) input.value = String(sharedGridCount)
      buildGrid(g.el, g.picker, g.ordered, sharedGridCount)
    }
  }
  renderAllDurGrids()

  const tableCols = [
    { key: "label", label: "Event" },
    { key: "count", label: "Count" },
    { key: "min_time", label: "Min (s)" },
    { key: "mean_time", label: "Mean (s)" },
    { key: "max_time", label: "Max (s)" },
  ]
  if (state.runs.length > 1) {
    tableCols.push({ key: "mean_diff", label: "Mean Diff" })
  }
  makeSortableTable(
    clearChart("dur-table-content"),
    tableCols,
    stats as unknown as Record<string, unknown>[],
    "max_time",
    false,
  )
}
