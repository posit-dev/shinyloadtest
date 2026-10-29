import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReplayDiagnostics } from "../replay/diagnostics.js"

const { writeSync } = vi.hoisted(() => ({ writeSync: vi.fn() }))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  writeSync.mockImplementation(actual.writeSync)
  return { ...actual, writeSync }
})

const directories: string[] = []
afterEach(() => {
  writeSync.mockClear()
  for (const directory of directories)
    fs.rmSync(directory, { recursive: true, force: true })
  directories.length = 0
})

function makeDiagnostics() {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-write-"))
  directories.push(outputDir)
  return {
    outputDir,
    diagnostics: new ReplayDiagnostics({
      outputDir,
      numWorkers: 1,
      maxErrors: 0,
    }),
  }
}

describe("diagnostics I/O failures", () => {
  it("completes partial writes so each record stays parseable", async () => {
    const { outputDir, diagnostics } = makeDiagnostics()
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    writeSync.mockImplementationOnce(
      (fd: number, buffer: Buffer, offset: number) =>
        actual.writeSync(fd, buffer, offset, 3),
    )

    diagnostics.emit({
      type: "session_start",
      sessionId: 1,
      workerId: 0,
      iterationId: 0,
    })
    await diagnostics.finish()

    const records = fs
      .readFileSync(path.join(outputDir, "diagnostics.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(records.map((record) => record.type)).toEqual([
      "run_start",
      "session_start",
      "run_end",
    ])
    expect(records[1]).toMatchObject({
      sessionId: 1,
      workerId: 0,
      iterationId: 0,
    })
    expect(records[2]).toMatchObject({ complete: true })
  })

  it("retains an event write failure and does not claim complete diagnostics", async () => {
    const { outputDir, diagnostics } = makeDiagnostics()
    const diskError = new Error("disk full")
    writeSync.mockImplementationOnce(() => {
      throw diskError
    })

    expect(() =>
      diagnostics.emit({
        type: "session_start",
        sessionId: 1,
        workerId: 0,
        iterationId: 0,
      }),
    ).not.toThrow()
    await expect(diagnostics.finish()).rejects.toBe(diskError)

    const records = fs
      .readFileSync(path.join(outputDir, "diagnostics.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(records.at(-1)).toMatchObject({ type: "run_end", complete: false })
  })

  it("treats a write with no progress as an error rather than looping forever", async () => {
    const { diagnostics } = makeDiagnostics()
    writeSync.mockReturnValueOnce(0)

    expect(() =>
      diagnostics.emit({
        type: "session_start",
        sessionId: 1,
        workerId: 0,
        iterationId: 0,
      }),
    ).not.toThrow()
    await expect(diagnostics.finish()).rejects.toThrow(
      "Could not write replay diagnostics",
    )
  })
})
