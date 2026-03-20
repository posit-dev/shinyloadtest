import "./style.css"
import type { RawData, AppState } from "./types"
import { processRun } from "./data-processing"
import { setupNavigation, setupRunSelector, getUrlState, navigateToSection, navigateToSubTab } from "./navigation"
import { renderSessions } from "./charts/sessions"
import { renderSessionDuration } from "./charts/session-duration"
import { renderWaterfall } from "./charts/waterfall"
import { renderLatency } from "./charts/latency"
import { renderEventDuration } from "./charts/event-duration"
import { renderEventConcurrency } from "./charts/event-concurrency"
import * as d3 from "d3"

let rawData: RawData

if (import.meta.env.DEV) {
  try {
    const res = await fetch("/__dev_data__.json")
    if (res.ok) {
      rawData = (await res.json()) as RawData
    } else {
      rawData = (await import("./fixtures/demo1.json")).default as RawData
    }
  } catch {
    rawData = (await import("./fixtures/demo1.json")).default as RawData
  }
} else {
  rawData = JSON.parse(
    document.getElementById("report-data")!.textContent!
  ) as RawData
}

const runs = rawData.runs.map(processRun)
const recordingDuration = rawData.recording.duration / 1000

const recordingLabelMap = new Map(
  rawData.recording.events.map(e => [e.lineNumber, e.label])
)

const globalSessionsXDomain: [number, number] = [
  d3.min(runs, run => d3.min(run.paired, d => d.start)) ?? 0,
  d3.max(runs, run => d3.max(run.paired, d => d.end)) ?? 1,
]

const state: AppState = {
  rawData,
  runs,
  currentRunIdx: 0,
  recordingDuration,
  globalSessionsXDomain,
  getRecordingLabel: (lineNum: number) =>
    recordingLabelMap.get(lineNum) ?? `Event ${lineNum}`,
}

function renderPerRun() {
  const perRun: Array<[string, (s: AppState) => void]> = [
    ["Sessions", renderSessions],
    ["Session Duration", renderSessionDuration],
    ["Waterfall", renderWaterfall],
  ]
  for (const [name, fn] of perRun) {
    try {
      fn(state)
    } catch (e) {
      console.error(`${name} render error:`, e)
      if (import.meta.env.DEV) throw e
    }
  }
}

function renderAll() {
  renderPerRun()
  const allRun: Array<[string, (s: AppState) => void]> = [
    ["Latency", renderLatency],
    ["Event Duration", renderEventDuration],
    ["Event Concurrency", renderEventConcurrency],
  ]
  for (const [name, fn] of allRun) {
    try {
      fn(state)
    } catch (e) {
      console.error(`${name} render error:`, e)
      if (import.meta.env.DEV) throw e
    }
  }
}

setupNavigation()
setupRunSelector(runs, idx => {
  state.currentRunIdx = idx
  renderPerRun()
})

if (runs.length > 1) {
  const meanDiffTab = document.getElementById("dur-mean-diff-tab")
  if (meanDiffTab) meanDiffTab.style.display = ""
}

renderAll()

const urlState = getUrlState()
const runIdx = Number(urlState.run)
if (Number.isInteger(runIdx) && runIdx >= 0 && runIdx < runs.length) {
  state.currentRunIdx = runIdx
  const runSelect = document.getElementById("run-select") as HTMLSelectElement | null
  if (runSelect) runSelect.value = String(state.currentRunIdx)
  renderPerRun()
}
if (urlState.section && urlState.section !== "sessions") {
  navigateToSection(urlState.section, false)
}
if (urlState.tab) {
  const activeSection = document.querySelector(".section.active")
  if (activeSection) navigateToSubTab(activeSection as HTMLElement, urlState.tab, false)
}
