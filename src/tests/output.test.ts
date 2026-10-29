import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

import {
  createOutputDir,
  defaultOutputDir,
  SessionWriter,
} from "../replay/output.js"
import {
  serializeArgs,
  REDACTED_HEADER_VALUE,
  type ParsedArgs,
} from "../cli.js"
import { LogLevel } from "../logger.js"

describe("defaultOutputDir", () => {
  it("replaces colons with underscores", () => {
    const dir = defaultOutputDir()
    expect(dir).toMatch(/^test-logs-/)
    expect(dir).not.toContain(":")
  })
})

describe("createOutputDir", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shinyloadtest-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates directory structure", () => {
    const outputDir = path.join(tmpDir, "output")
    const recordingPath = path.join(tmpDir, "recording.log")
    fs.writeFileSync(recordingPath, "test recording content")

    createOutputDir({
      outputDir,
      overwrite: false,
      version: "1.0.0",
      recordingPath,
    })

    expect(fs.existsSync(path.join(outputDir, "sessions"))).toBe(true)
    expect(
      fs.readFileSync(
        path.join(outputDir, "shinyloadtest-version.txt"),
        "utf-8",
      ),
    ).toBe("1.0.0")
    expect(
      fs.readFileSync(path.join(outputDir, "recording.log"), "utf-8"),
    ).toBe("test recording content")
  })

  it("throws if dir exists and overwrite is false", () => {
    const outputDir = path.join(tmpDir, "output")
    fs.mkdirSync(outputDir)
    expect(() =>
      createOutputDir({
        outputDir,
        overwrite: false,
        version: "1.0.0",
        recordingPath: path.join(tmpDir, "rec.log"),
      }),
    ).toThrow("already exists")
  })

  it("overwrites if dir exists and overwrite is true", () => {
    const outputDir = path.join(tmpDir, "output")
    fs.mkdirSync(outputDir)
    fs.writeFileSync(path.join(outputDir, "old.txt"), "old")

    const recordingPath = path.join(tmpDir, "recording.log")
    fs.writeFileSync(recordingPath, "new recording")

    createOutputDir({
      outputDir,
      overwrite: true,
      version: "2.0.0",
      recordingPath,
    })

    expect(fs.existsSync(path.join(outputDir, "old.txt"))).toBe(false)
    expect(
      fs.readFileSync(
        path.join(outputDir, "shinyloadtest-version.txt"),
        "utf-8",
      ),
    ).toBe("2.0.0")
  })
})

describe("SessionWriter", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shinyloadtest-test-"))
    fs.mkdirSync(path.join(tmpDir, "sessions"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes CSV with headers and rows", () => {
    const writer = new SessionWriter({
      outputDir: tmpDir,
      sessionId: 0,
      workerId: 0,
      iterationId: 0,
      argsString: "recording.log https://example.com --workers 1",
      argsJson: '{"recordingPath":"recording.log"}',
    })

    writer.writeCsv(0, 0, 0, "PLAYER_SESSION_CREATE", 1704067200000, 0, "")
    writer.writeCsv(0, 0, 0, "REQ_HOME_START", 1704067200001, 2, "")
    writer.close()

    const content = fs.readFileSync(
      path.join(tmpDir, "sessions", "0_0_0.csv"),
      "utf-8",
    )
    const lines = content.split("\n").filter((l) => l.length > 0)

    expect(lines[0]).toBe("# recording.log https://example.com --workers 1")
    expect(lines[1]).toBe('# {"recordingPath":"recording.log"}')
    expect(lines[2]).toBe(
      "session_id,worker_id,iteration,event,timestamp,input_line_number,comment",
    )
    expect(lines[3]).toBe("0,0,0,PLAYER_SESSION_CREATE,1704067200000,0,")
    expect(lines[4]).toBe("0,0,0,REQ_HOME_START,1704067200001,2,")
  })

  // Regression for the metadata comments: explicit -H credentials must not
  // reach the session CSV, while the remaining invocation stays readable.
  it("writes redacted header values in the CSV metadata comments", () => {
    const parsedArgs: ParsedArgs = {
      recordingPath: "recording.log",
      appUrl: "https://example.com/app",
      workers: 1,
      loadedDurationMinutes: 0.01,
      startInterval: 0,
      maxErrors: 1,
      headers: {
        authorization: "Key header-secret-sentinel",
        Cookie: "session=another-sentinel",
        "X-Test": "retained-by-cli",
      },
      outputDir: tmpDir,
      overwriteOutput: false,
      debugLog: false,
      logLevel: LogLevel.WARN,
      creds: { user: null, pass: null, connectApiKey: null },
    }
    const { argsString, argsJson } = serializeArgs(parsedArgs)

    const writer = new SessionWriter({
      outputDir: tmpDir,
      sessionId: 0,
      workerId: 0,
      iterationId: 0,
      argsString,
      argsJson,
    })
    writer.writeCsv(0, 0, 0, "PLAYER_SESSION_CREATE", 1704067200000, 0, "")
    writer.close()

    const content = fs.readFileSync(
      path.join(tmpDir, "sessions", "0_0_0.csv"),
      "utf-8",
    )
    const commentLines = content.split("\n").filter((l) => l.startsWith("#"))

    expect(commentLines).toHaveLength(2)
    expect(content).not.toContain("header-secret-sentinel")
    expect(content).not.toContain("another-sentinel")
    expect(content).toContain(`-H "authorization: ${REDACTED_HEADER_VALUE}"`)
    expect(content).toContain(`-H "Cookie: ${REDACTED_HEADER_VALUE}"`)
    expect(content).toContain('-H "X-Test: retained-by-cli"')
    expect(JSON.parse(commentLines[1]!.substring(2)).headers).toEqual({
      authorization: REDACTED_HEADER_VALUE,
      Cookie: REDACTED_HEADER_VALUE,
      "X-Test": "retained-by-cli",
    })
  })
})
