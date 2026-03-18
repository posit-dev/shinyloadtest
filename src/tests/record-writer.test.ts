import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, it, expect, afterEach } from "vitest"

import { RecordingWriter } from "../record/writer.js"
import { ServerType } from "../types.js"

let tempFiles: string[] = []

function tempPath(name: string): string {
  const p = path.join(os.tmpdir(), `record-writer-test-${Date.now()}-${name}`)
  tempFiles.push(p)
  return p
}

afterEach(() => {
  for (const f of tempFiles) {
    // Remove base file and any adjacent post data files
    for (let i = 0; i < 10; i++) {
      const postFile = `${f}.post.${i}`
      if (fs.existsSync(postFile)) fs.unlinkSync(postFile)
    }
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  tempFiles = []
})

describe("RecordingWriter constructor", () => {
  it("writes header with version, target_url, target_type", () => {
    const outputPath = tempPath("header.log")
    const writer = new RecordingWriter({
      outputPath,
      targetUrl: "https://example.com/app",
      targetType: ServerType.SHN,
      rscApiKeyRequired: false,
    })
    writer.close()

    const contents = fs.readFileSync(outputPath, "utf8")
    expect(contents).toContain("# version: 1")
    expect(contents).toContain("# target_url: https://example.com/app")
    expect(contents).toContain("# target_type: R/Shiny")
  })

  it("includes rscApiKeyRequired line when true", () => {
    const outputPath = tempPath("rsc-true.log")
    const writer = new RecordingWriter({
      outputPath,
      targetUrl: "https://connect.example.com/app",
      targetType: ServerType.RSC,
      rscApiKeyRequired: true,
    })
    writer.close()

    const contents = fs.readFileSync(outputPath, "utf8")
    expect(contents).toContain("# rscApiKeyRequired: true")
  })

  it("omits rscApiKeyRequired line when false", () => {
    const outputPath = tempPath("rsc-false.log")
    const writer = new RecordingWriter({
      outputPath,
      targetUrl: "https://example.com/app",
      targetType: ServerType.SHN,
      rscApiKeyRequired: false,
    })
    writer.close()

    const contents = fs.readFileSync(outputPath, "utf8")
    expect(contents).not.toContain("rscApiKeyRequired")
  })
})

describe("RecordingWriter writeEvent()", () => {
  it("appends JSON line", () => {
    const outputPath = tempPath("events.log")
    const writer = new RecordingWriter({
      outputPath,
      targetUrl: "https://example.com/app",
      targetType: ServerType.SHN,
      rscApiKeyRequired: false,
    })

    const event = {
      type: "REQ_HOME" as const,
      begin: "2024-01-15T10:00:00.000Z",
      end: "2024-01-15T10:00:01.000Z",
      status: 200,
      url: "/",
    }
    writer.writeEvent(event)
    writer.close()

    const lines = fs.readFileSync(outputPath, "utf8").split("\n")
    const jsonLine = lines.find((l) => l.startsWith("{"))
    expect(jsonLine).toBeDefined()
    expect(JSON.parse(jsonLine!)).toEqual(event)
  })
})

describe("RecordingWriter writePostData()", () => {
  it("creates adjacent file with correct name", () => {
    const outputPath = tempPath("post.log")
    const writer = new RecordingWriter({
      outputPath,
      targetUrl: "https://example.com/app",
      targetType: ServerType.SHN,
      rscApiKeyRequired: false,
    })

    const data = Buffer.from("hello=world")
    const basename = writer.writePostData(data)
    writer.close()

    expect(basename).toBe(path.basename(`${outputPath}.post.0`))
    const postPath = `${outputPath}.post.0`
    expect(fs.existsSync(postPath)).toBe(true)
    expect(fs.readFileSync(postPath)).toEqual(data)
  })

  it("increments file counter", () => {
    const outputPath = tempPath("postcounter.log")
    const writer = new RecordingWriter({
      outputPath,
      targetUrl: "https://example.com/app",
      targetType: ServerType.SHN,
      rscApiKeyRequired: false,
    })

    const first = writer.writePostData(Buffer.from("first"))
    const second = writer.writePostData(Buffer.from("second"))
    writer.close()

    expect(first).toBe(path.basename(`${outputPath}.post.0`))
    expect(second).toBe(path.basename(`${outputPath}.post.1`))
    expect(fs.existsSync(`${outputPath}.post.0`)).toBe(true)
    expect(fs.existsSync(`${outputPath}.post.1`)).toBe(true)
  })
})

describe("RecordingWriter close()", () => {
  it("does not throw", () => {
    const outputPath = tempPath("close.log")
    const writer = new RecordingWriter({
      outputPath,
      targetUrl: "https://example.com/app",
      targetType: ServerType.SHN,
      rscApiKeyRequired: false,
    })
    expect(() => writer.close()).not.toThrow()
  })
})
