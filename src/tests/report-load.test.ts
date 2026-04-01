import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { findOutputDirs, loadReportData } from "../report/load.js"

const RECORDING_CONTENT = [
  "# version: 1",
  "# target_url: http://localhost:3838",
  "# target_type: R/Shiny",
  '{"type":"WS_OPEN","begin":"2020-01-01T00:00:00.000Z","url":"/websocket"}',
  '{"type":"WS_CLOSE","begin":"2020-01-01T00:00:01.000Z"}',
].join("\n")

const CSV_HEADER =
  "session_id,worker_id,iteration,event,timestamp,input_line_number,comment"

function makeCsvContent(): string {
  return [
    "# args",
    "# json",
    CSV_HEADER,
    "0,0,0,PLAYER_SESSION_CREATE,1704067200000,0,",
    "0,0,0,REQ_HOME_START,1704067200001,1,",
    "0,0,0,REQ_HOME_END,1704067200050,1,",
  ].join("\n")
}

/** Create a test-logs dir with a recording.log and sessions/ containing a CSV */
function makeValidDir(parent: string, name: string): string {
  const dir = path.join(parent, name)
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true })
  fs.writeFileSync(path.join(dir, "recording.log"), RECORDING_CONTENT)
  fs.writeFileSync(path.join(dir, "sessions", "0_0_0.csv"), makeCsvContent())
  return dir
}

/** Create a test-logs dir with sessions/ but no CSV files (aborted replay) */
function makeEmptyDir(parent: string, name: string): string {
  const dir = path.join(parent, name)
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true })
  fs.writeFileSync(path.join(dir, "recording.log"), RECORDING_CONTENT)
  return dir
}

describe("findOutputDirs", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shinyloadtest-report-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("includes directories with sessions/ even if they have no CSV files", () => {
    makeValidDir(tmpDir, "test-logs-valid")
    makeEmptyDir(tmpDir, "test-logs-empty")

    const dirs = findOutputDirs(tmpDir)
    expect(dirs).toHaveLength(2)
  })

  it("excludes directories without a sessions/ subdirectory", () => {
    const dir = path.join(tmpDir, "test-logs-no-sessions")
    fs.mkdirSync(dir)

    const dirs = findOutputDirs(tmpDir)
    expect(dirs).toHaveLength(0)
  })
})

describe("loadReportData", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shinyloadtest-report-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("skips empty directories and loads valid ones", () => {
    const validDir = makeValidDir(tmpDir, "test-logs-valid")
    const emptyDir = makeEmptyDir(tmpDir, "test-logs-empty")

    const data = loadReportData([emptyDir, validDir])

    expect(data.runs).toHaveLength(1)
    expect(data.runs[0]!.name).toBe("test-logs-valid")
    expect(data.skipped).toEqual([emptyDir])
  })

  it("throws when all directories are empty", () => {
    const empty1 = makeEmptyDir(tmpDir, "test-logs-empty1")
    const empty2 = makeEmptyDir(tmpDir, "test-logs-empty2")

    expect(() => loadReportData([empty1, empty2])).toThrow(
      /No session data found/,
    )
  })
})
