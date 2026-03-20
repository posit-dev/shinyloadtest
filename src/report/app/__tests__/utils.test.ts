// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest"
import { EVENT_COLORS, EVENT_ORDER, RUN_COLORS } from "../constants"
import type { PairedEvent, ProcessedRun } from "../types"
import {
  eventLegend,
  runLegend,
  classifiedRunData,
  clearChart,
  makeGridPicker,
  makeSortableTable,
} from "../utils"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePairedEvent(overrides: Partial<PairedEvent> = {}): PairedEvent {
  return {
    session_id: 1,
    worker_id: 0,
    iteration: 0,
    input_line_number: 1,
    event_base: "REQ_HOME",
    start: 0,
    end: 1,
    time: 1,
    concurrency: 1,
    maintenance: true,
    ...overrides,
  }
}

function makeRun(overrides: Partial<ProcessedRun> = {}): ProcessedRun {
  return { name: "test-run", paired: [], ...overrides }
}

// ---------------------------------------------------------------------------
// eventLegend
// ---------------------------------------------------------------------------

describe("eventLegend", () => {
  it("returns an HTMLElement with class 'legend'", () => {
    const el = eventLegend()
    expect(el.className).toBe("legend")
  })

  it("creates one legend item per EVENT_ORDER entry", () => {
    const el = eventLegend()
    const items = el.querySelectorAll(".legend-item")
    expect(items.length).toBe(EVENT_ORDER.length)
  })

  it("each item contains the correct label text", () => {
    const el = eventLegend()
    const items = el.querySelectorAll(".legend-item")
    EVENT_ORDER.forEach((label, i) => {
      expect(items[i]!.textContent).toContain(label)
    })
  })

  it("each swatch uses the corresponding EVENT_COLORS background", () => {
    const el = eventLegend()
    const swatches = el.querySelectorAll<HTMLElement>(".legend-swatch")
    EVENT_ORDER.forEach((label, i) => {
      expect(swatches[i]!.getAttribute("style")).toContain(EVENT_COLORS[label])
    })
  })
})

// ---------------------------------------------------------------------------
// runLegend
// ---------------------------------------------------------------------------

describe("runLegend", () => {
  it("returns null for an empty runs array", () => {
    expect(runLegend([])).toBeNull()
  })

  it("returns null for a single run", () => {
    expect(runLegend([makeRun()])).toBeNull()
  })

  it("returns an HTMLElement with class 'legend' for two or more runs", () => {
    const el = runLegend([
      makeRun({ name: "run-a" }),
      makeRun({ name: "run-b" }),
    ])
    expect(el).not.toBeNull()
    expect(el!.className).toBe("legend")
  })

  it("creates one item per run", () => {
    const runs = [
      makeRun({ name: "a" }),
      makeRun({ name: "b" }),
      makeRun({ name: "c" }),
    ]
    const el = runLegend(runs)!
    expect(el.querySelectorAll(".legend-item").length).toBe(3)
  })

  it("each item contains the run name", () => {
    const runs = [makeRun({ name: "alpha" }), makeRun({ name: "beta" })]
    const el = runLegend(runs)!
    const items = el.querySelectorAll(".legend-item")
    expect(items[0]!.textContent).toContain("alpha")
    expect(items[1]!.textContent).toContain("beta")
  })

  it("wraps around RUN_COLORS when there are more runs than colors", () => {
    const runs = Array.from({ length: RUN_COLORS.length + 1 }, (_, i) =>
      makeRun({ name: `run-${i}` }),
    )
    const el = runLegend(runs)!
    const swatches = el.querySelectorAll<HTMLElement>(".legend-swatch")
    // Last item wraps to index 0
    expect(swatches[RUN_COLORS.length]!.style.background).toBe(RUN_COLORS[0])
  })
})

// ---------------------------------------------------------------------------
// classifiedRunData
// ---------------------------------------------------------------------------

describe("classifiedRunData", () => {
  it("returns empty array when run has no paired events", () => {
    expect(classifiedRunData(makeRun())).toHaveLength(0)
  })

  it("filters out non-maintenance events", () => {
    const run = makeRun({
      paired: [
        makePairedEvent({ event_base: "REQ_HOME", maintenance: false }),
        makePairedEvent({ event_base: "REQ_HOME", maintenance: true }),
      ],
    })
    const result = classifiedRunData(run)
    expect(result).toHaveLength(1)
    expect(result[0]!.maintenance).toBe(true)
  })

  it("filters out events whose base is not in EVENT_TYPE_MAP", () => {
    const run = makeRun({
      paired: [
        makePairedEvent({ event_base: "UNKNOWN_EVENT", maintenance: true }),
        makePairedEvent({ event_base: "REQ_GET", maintenance: true }),
      ],
    })
    const result = classifiedRunData(run)
    expect(result).toHaveLength(1)
    expect(result[0]!.event_base).toBe("REQ_GET")
  })

  it("attaches the correct eventLabel from EVENT_TYPE_MAP", () => {
    const run = makeRun({
      paired: [
        makePairedEvent({ event_base: "REQ_HOME", maintenance: true }),
        makePairedEvent({ event_base: "WS_RECV", maintenance: true }),
      ],
    })
    const result = classifiedRunData(run)
    const labels = result.map((r) => r.eventLabel)
    expect(labels).toContain("Homepage")
    expect(labels).toContain("Calculate")
  })

  it("does not mutate the original paired events", () => {
    const event = makePairedEvent({ event_base: "REQ_HOME", maintenance: true })
    const run = makeRun({ paired: [event] })
    const result = classifiedRunData(run)
    expect(result[0]).not.toBe(event)
    expect(event).not.toHaveProperty("eventLabel")
  })
})

// ---------------------------------------------------------------------------
// clearChart
// ---------------------------------------------------------------------------

describe("clearChart", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("clears innerHTML of the target element", () => {
    const container = document.createElement("div")
    container.id = "my-chart"
    container.innerHTML = "<svg><rect /></svg>"
    document.body.appendChild(container)

    clearChart("my-chart")
    expect(container.innerHTML).toBe("")
  })

  it("returns the element by id", () => {
    const container = document.createElement("div")
    container.id = "chart-x"
    document.body.appendChild(container)

    const returned = clearChart("chart-x")
    expect(returned).toBe(container)
  })

  it("returns null when the element does not exist", () => {
    const returned = clearChart("does-not-exist")
    expect(returned).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// makeGridPicker
// ---------------------------------------------------------------------------

describe("makeGridPicker", () => {
  it("returns a picker element and a getCount function", () => {
    const { picker, getCount } = makeGridPicker(10, 5, () => {})
    expect(picker).toBeInstanceOf(HTMLElement)
    expect(typeof getCount).toBe("function")
  })

  it("picker has class 'grid-picker'", () => {
    const { picker } = makeGridPicker(10, 5, () => {})
    expect(picker.className).toBe("grid-picker")
  })

  it("input default value is clamped to min(defaultCount, totalEvents)", () => {
    const { picker } = makeGridPicker(3, 10, () => {})
    const input = picker.querySelector<HTMLInputElement>("input")!
    expect(Number(input.value)).toBe(3)
  })

  it("input max attribute equals totalEvents", () => {
    const { picker } = makeGridPicker(20, 5, () => {})
    const input = picker.querySelector<HTMLInputElement>("input")!
    expect(Number(input.max)).toBe(20)
  })

  it("getCount returns the current input value clamped between 1 and totalEvents", () => {
    const { picker, getCount } = makeGridPicker(10, 5, () => {})
    const input = picker.querySelector<HTMLInputElement>("input")!
    input.value = "7"
    expect(getCount()).toBe(7)
  })

  it("getCount clamps values above totalEvents", () => {
    const { picker, getCount } = makeGridPicker(10, 5, () => {})
    const input = picker.querySelector<HTMLInputElement>("input")!
    input.value = "999"
    expect(getCount()).toBe(10)
  })

  it("getCount clamps 0 to 1", () => {
    const { picker, getCount } = makeGridPicker(10, 5, () => {})
    const input = picker.querySelector<HTMLInputElement>("input")!
    input.value = "0"
    expect(getCount()).toBe(1)
  })

  it("getCount clamps non-numeric input to 1 (number input coerces to empty)", () => {
    const { picker, getCount } = makeGridPicker(10, 5, () => {})
    const input = picker.querySelector<HTMLInputElement>("input")!
    input.value = "abc"
    // HTML number input coerces "abc" to "", Number("") is 0, clamped to 1
    expect(getCount()).toBe(1)
  })

  it("onChangeCallback is called with clamped value on input event", () => {
    const calls: number[] = []
    const { picker } = makeGridPicker(10, 5, (n) => calls.push(n))
    const input = picker.querySelector<HTMLInputElement>("input")!
    input.value = "3"
    input.dispatchEvent(new Event("input"))
    input.value = "999"
    input.dispatchEvent(new Event("input"))
    input.value = "0"
    input.dispatchEvent(new Event("input"))
    input.value = "abc"
    input.dispatchEvent(new Event("input"))
    expect(calls).toEqual([3, 10, 1, 1])
  })

  it("picker text contains the totalEvents count", () => {
    const { picker } = makeGridPicker(42, 10, () => {})
    expect(picker.textContent).toContain("42")
  })
})

// ---------------------------------------------------------------------------
// makeSortableTable
// ---------------------------------------------------------------------------

describe("makeSortableTable", () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
  })

  const columns = [
    { key: "name", label: "Name" },
    { key: "value", label: "Value" },
  ]
  const rows = [
    { name: "banana", value: 2 },
    { name: "apple", value: 3 },
    { name: "cherry", value: 1 },
  ]

  it("does nothing when el is null", () => {
    expect(() =>
      makeSortableTable(null, columns, rows, "name", true),
    ).not.toThrow()
  })

  it("renders a table with class 'data-table'", () => {
    makeSortableTable(container, columns, rows, "name", true)
    const table = container.querySelector("table")
    expect(table).not.toBeNull()
    expect(table!.className).toBe("data-table")
  })

  it("renders the correct column headers", () => {
    makeSortableTable(container, columns, rows, "name", true)
    const headers = container.querySelectorAll("th")
    const texts = Array.from(headers).map((th) => th.textContent ?? "")
    expect(texts.some((t) => t.includes("Name"))).toBe(true)
    expect(texts.some((t) => t.includes("Value"))).toBe(true)
  })

  it("renders one tbody row per data row", () => {
    makeSortableTable(container, columns, rows, "name", true)
    const trs = container.querySelectorAll("tbody tr")
    expect(trs.length).toBe(rows.length)
  })

  it("sorts ascending by the default sort column", () => {
    makeSortableTable(container, columns, rows, "name", true)
    const cells = container.querySelectorAll("tbody tr td:first-child")
    const names = Array.from(cells).map((td) => td.textContent)
    expect(names).toEqual(["apple", "banana", "cherry"])
  })

  it("sorts descending when defaultSortAsc is false", () => {
    makeSortableTable(container, columns, rows, "name", false)
    const cells = container.querySelectorAll("tbody tr td:first-child")
    const names = Array.from(cells).map((td) => td.textContent)
    expect(names).toEqual(["cherry", "banana", "apple"])
  })

  it("sorts numeric columns correctly", () => {
    makeSortableTable(container, columns, rows, "value", true)
    const cells = container.querySelectorAll("tbody tr td:nth-child(2)")
    const values = Array.from(cells).map((td) => td.textContent)
    expect(values).toEqual(["1.000", "2.000", "3.000"])
  })

  it("marks the active sort column header with an arrow indicator", () => {
    makeSortableTable(container, columns, rows, "name", true)
    const headers = container.querySelectorAll("th")
    const nameHeader = Array.from(headers).find((th) =>
      th.textContent?.includes("Name"),
    )
    expect(nameHeader!.textContent).toMatch(/[▲▼]/)
  })

  it("clicking a header re-sorts by that column", () => {
    makeSortableTable(container, columns, rows, "name", true)
    const headers = container.querySelectorAll("th")
    const valueHeader = Array.from(headers).find((th) =>
      th.textContent?.includes("Value"),
    )!
    valueHeader.click()
    const cells = container.querySelectorAll("tbody tr td:nth-child(2)")
    const values = Array.from(cells).map((td) => td.textContent)
    expect(values).toEqual(["3.000", "2.000", "1.000"])
  })

  it("clicking the active header toggles sort direction", () => {
    makeSortableTable(container, columns, rows, "name", true)
    const headers = container.querySelectorAll("th")
    const nameHeader = Array.from(headers).find((th) =>
      th.textContent?.includes("Name"),
    )!
    nameHeader.click()
    const cells = container.querySelectorAll("tbody tr td:first-child")
    const names = Array.from(cells).map((td) => td.textContent)
    expect(names).toEqual(["cherry", "banana", "apple"])
  })

  it("formats numbers with 3 decimal places", () => {
    makeSortableTable(
      container,
      columns,
      [{ name: "x", value: 1.5 }],
      "name",
      true,
    )
    const td = container.querySelector("tbody tr td:nth-child(2)")
    expect(td!.textContent).toBe("1.500")
  })

  it("renders empty string for null and undefined values", () => {
    makeSortableTable(
      container,
      columns,
      [
        { name: "x", value: null },
        { name: "y", value: undefined },
      ],
      "name",
      true,
    )
    const tds = container.querySelectorAll("tbody tr td:nth-child(2)")
    expect(tds[0]!.textContent).toBe("")
    expect(tds[1]!.textContent).toBe("")
  })
})
