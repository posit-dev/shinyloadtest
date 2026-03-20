import { EVENT_COLORS, EVENT_ORDER, EVENT_TYPE_MAP, RUN_COLORS } from "./constants"
import type { PairedEvent, ProcessedRun } from "./types"

export function eventLegend(): HTMLElement {
  const div = document.createElement("div")
  div.className = "legend"
  for (const label of EVENT_ORDER) {
    const item = document.createElement("span")
    item.className = "legend-item"
    item.innerHTML = '<span class="legend-swatch" style="background:' + EVENT_COLORS[label] + '"></span>' + label
    div.appendChild(item)
  }
  return div
}

export function runLegend(runs: ProcessedRun[]): HTMLElement | null {
  if (runs.length <= 1) return null
  const div = document.createElement("div")
  div.className = "legend"
  runs.forEach((run, i) => {
    const item = document.createElement("span")
    item.className = "legend-item"
    const swatch = document.createElement("span")
    swatch.className = "legend-swatch"
    swatch.style.background = RUN_COLORS[i % RUN_COLORS.length]
    item.appendChild(swatch)
    item.appendChild(document.createTextNode(run.name))
    div.appendChild(item)
  })
  return div
}

export function classifiedRunData(run: ProcessedRun): Array<PairedEvent & { eventLabel: string }> {
  return run.paired
    .filter(d => d.maintenance && EVENT_TYPE_MAP[d.event_base as keyof typeof EVENT_TYPE_MAP])
    .map(d => ({ ...d, eventLabel: EVENT_TYPE_MAP[d.event_base as keyof typeof EVENT_TYPE_MAP] }))
}

export function clearChart(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (el) el.innerHTML = ""
  return el!
}

const tooltip = document.createElement("div")
tooltip.className = "chart-tooltip"
tooltip.style.opacity = "0"
document.body.appendChild(tooltip)

let hideTimer: ReturnType<typeof setTimeout> | null = null

export function enableTooltips(chartEl: HTMLElement): void {
  const elems = chartEl.querySelectorAll("title")
  for (const titleEl of elems) {
    const parent = titleEl.parentElement
    if (!parent) continue
    const text = titleEl.textContent ?? ""
    titleEl.remove()
    parent.setAttribute("role", "img")
    parent.setAttribute("aria-label", text)
    parent.addEventListener("mouseenter", e => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
      tooltip.textContent = text
      tooltip.style.opacity = "1"
      const rect = parent.getBoundingClientRect()
      tooltip.style.left = Math.max(8, Math.min((e as MouseEvent).clientX + 12, window.innerWidth - tooltip.offsetWidth - 8)) + "px"
      tooltip.style.top = (rect.top - tooltip.offsetHeight - 6) + "px"
      if (parseFloat(tooltip.style.top) < 0) {
        tooltip.style.top = (rect.bottom + 6) + "px"
      }
    })
    parent.addEventListener("mousemove", e => {
      tooltip.style.left = Math.max(8, Math.min((e as MouseEvent).clientX + 12, window.innerWidth - tooltip.offsetWidth - 8)) + "px"
    })
    parent.addEventListener("mouseleave", () => {
      hideTimer = setTimeout(() => { tooltip.style.opacity = "0" }, 500)
    })
  }
}

export function makeGridPicker(
  totalEvents: number,
  defaultCount: number,
  onChangeCallback: (n: number) => void
): { picker: HTMLElement; getCount: () => number } {
  const count = Math.min(defaultCount, totalEvents)
  const picker = document.createElement("div")
  picker.className = "grid-picker"
  picker.innerHTML = "Show <input type='number' value='" + count + "' min='1' max='" + totalEvents + "'> of " + totalEvents + " events"
  const input = picker.querySelector("input")!
  input.addEventListener("input", () => {
    const val = Math.max(1, Math.min(totalEvents, Number(input.value) || count))
    onChangeCallback(val)
  })
  return { picker, getCount: () => Math.max(1, Math.min(totalEvents, Number(input.value) || count)) }
}

export function makeSortableTable(
  el: HTMLElement | null,
  columns: Array<{ key: string; label: string }>,
  rows: Record<string, unknown>[],
  defaultSortCol: string,
  defaultSortAsc: boolean
): void {
  if (!el) return
  let sortCol = defaultSortCol
  let sortAsc = defaultSortAsc
  const fmt = (v: unknown) =>
    v !== undefined && v !== null ? (typeof v === "number" ? v.toFixed(3) : String(v)) : ""

  function render() {
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol]
      if (typeof av === "number" && typeof bv === "number") return sortAsc ? av - bv : bv - av
      return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })

    const table = document.createElement("table")
    table.className = "data-table"
    const thead = document.createElement("thead")
    const headRow = document.createElement("tr")
    columns.forEach(col => {
      const th = document.createElement("th")
      th.textContent = col.label + (sortCol === col.key ? (sortAsc ? " \u25B2" : " \u25BC") : "")
      th.style.cursor = "pointer"
      th.addEventListener("click", () => {
        if (sortCol === col.key) { sortAsc = !sortAsc } else { sortCol = col.key; sortAsc = false }
        render()
      })
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)
    table.appendChild(thead)

    const tbody = document.createElement("tbody")
    for (const row of sorted) {
      const tr = document.createElement("tr")
      columns.forEach(col => {
        const td = document.createElement("td")
        td.textContent = fmt(row[col.key])
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)

    el.innerHTML = ""
    el.appendChild(table)
  }

  render()
}
