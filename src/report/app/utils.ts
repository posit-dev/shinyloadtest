import {
  EVENT_COLORS,
  EVENT_ORDER,
  EVENT_TYPE_MAP,
  RUN_COLORS,
} from "./constants"
import type { PairedEvent, ProcessedRun } from "./types"

export function eventLegend(): HTMLElement {
  const div = document.createElement("div")
  div.className = "legend"
  div.setAttribute("role", "list")
  div.setAttribute("aria-label", "Chart legend")
  for (const label of EVENT_ORDER) {
    const item = document.createElement("span")
    item.className = "legend-item"
    item.setAttribute("role", "listitem")
    const swatch = document.createElement("span")
    swatch.className = "legend-swatch"
    swatch.style.background = EVENT_COLORS[label]
    swatch.setAttribute("aria-hidden", "true")
    item.appendChild(swatch)
    item.appendChild(document.createTextNode(label))
    div.appendChild(item)
  }
  return div
}

export function runLegend(runs: ProcessedRun[]): HTMLElement | null {
  if (runs.length <= 1) return null
  const div = document.createElement("div")
  div.className = "legend"
  div.setAttribute("role", "list")
  div.setAttribute("aria-label", "Run legend")
  runs.forEach((run, i) => {
    const item = document.createElement("span")
    item.className = "legend-item"
    item.setAttribute("role", "listitem")
    const swatch = document.createElement("span")
    swatch.className = "legend-swatch"
    swatch.style.background = RUN_COLORS[i % RUN_COLORS.length]
    swatch.setAttribute("aria-hidden", "true")
    item.appendChild(swatch)
    item.appendChild(document.createTextNode(run.name))
    div.appendChild(item)
  })
  return div
}

export function classifiedRunData(
  run: ProcessedRun,
): Array<PairedEvent & { eventLabel: string }> {
  return run.paired
    .filter(
      (d) =>
        d.maintenance &&
        EVENT_TYPE_MAP[d.event_base as keyof typeof EVENT_TYPE_MAP],
    )
    .map((d) => ({
      ...d,
      eventLabel: EVENT_TYPE_MAP[d.event_base as keyof typeof EVENT_TYPE_MAP],
    }))
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

function showTooltip(parent: Element, text: string, e: MouseEvent): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  tooltip.textContent = text
  tooltip.style.opacity = "1"
  const rect = parent.getBoundingClientRect()
  tooltip.style.left =
    Math.max(
      8,
      Math.min(
        e.clientX + 12,
        window.innerWidth - tooltip.offsetWidth - 8,
      ),
    ) + "px"
  tooltip.style.top = rect.top - tooltip.offsetHeight - 6 + "px"
  if (parseFloat(tooltip.style.top) < 0) {
    tooltip.style.top = rect.bottom + 6 + "px"
  }
}

function hideTooltip(): void {
  hideTimer = setTimeout(() => {
    tooltip.style.opacity = "0"
  }, 500)
}

export function enableTooltips(chartEl: HTMLElement): void {
  const elems = chartEl.querySelectorAll("title")
  for (const titleEl of elems) {
    const parent = titleEl.parentElement
    if (!parent) continue
    const text = titleEl.textContent ?? ""
    titleEl.remove()
    parent.setAttribute("role", "img")
    parent.setAttribute("aria-label", text)
    parent.addEventListener("mouseenter", (e) => {
      showTooltip(parent, text, e as MouseEvent)
    })
    parent.addEventListener("mousemove", (e) => {
      tooltip.style.left =
        Math.max(
          8,
          Math.min(
            (e as MouseEvent).clientX + 12,
            window.innerWidth - tooltip.offsetWidth - 8,
          ),
        ) + "px"
    })
    parent.addEventListener("mouseleave", hideTooltip)
  }
}

export function makeGridPicker(
  totalEvents: number,
  defaultCount: number,
  onChangeCallback: (n: number) => void,
): { picker: HTMLElement; getCount: () => number } {
  const count = Math.min(defaultCount, totalEvents)
  const picker = document.createElement("div")
  picker.className = "grid-picker"

  const labelEl = document.createElement("label")
  labelEl.textContent = "Show "
  const input = document.createElement("input")
  input.type = "number"
  input.value = String(count)
  input.min = "1"
  input.max = String(totalEvents)
  input.setAttribute("aria-label", "Number of events to show")
  labelEl.appendChild(input)
  picker.appendChild(labelEl)
  picker.appendChild(document.createTextNode(" of " + totalEvents + " events"))

  const clamp = () => {
    const n = Number(input.value)
    return Math.max(1, Math.min(totalEvents, Number.isFinite(n) ? n : count))
  }
  input.addEventListener("input", () => onChangeCallback(clamp()))
  return { picker, getCount: clamp }
}

export function makeSortableTable(
  el: HTMLElement | null,
  columns: Array<{ key: string; label: string }>,
  rows: Record<string, unknown>[],
  defaultSortCol: string,
  defaultSortAsc: boolean,
  caption?: string,
): void {
  if (!el) return
  const container = el
  let sortCol = defaultSortCol
  let sortAsc = defaultSortAsc
  const fmt = (v: unknown) =>
    v !== undefined && v !== null
      ? typeof v === "number"
        ? v.toFixed(3)
        : String(v)
      : ""

  function render() {
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortCol],
        bv = b[sortCol]
      if (typeof av === "number" && typeof bv === "number")
        return sortAsc ? av - bv : bv - av
      return sortAsc
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av))
    })

    const table = document.createElement("table")
    table.className = "data-table"
    if (caption) {
      const cap = document.createElement("caption")
      cap.className = "visually-hidden"
      cap.textContent = caption
      table.appendChild(cap)
    }
    const thead = document.createElement("thead")
    const headRow = document.createElement("tr")
    columns.forEach((col) => {
      const th = document.createElement("th")
      th.scope = "col"
      th.textContent =
        col.label +
        (sortCol === col.key ? (sortAsc ? " \u25B2" : " \u25BC") : "")
      th.style.cursor = "pointer"
      if (sortCol === col.key) {
        th.setAttribute("aria-sort", sortAsc ? "ascending" : "descending")
      }
      th.addEventListener("click", () => {
        if (sortCol === col.key) {
          sortAsc = !sortAsc
        } else {
          sortCol = col.key
          sortAsc = false
        }
        render()
      })
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)
    table.appendChild(thead)

    const tbody = document.createElement("tbody")
    for (const row of sorted) {
      const tr = document.createElement("tr")
      columns.forEach((col) => {
        const td = document.createElement("td")
        td.textContent = fmt(row[col.key])
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)

    container.innerHTML = ""
    container.appendChild(table)
  }

  render()
}
