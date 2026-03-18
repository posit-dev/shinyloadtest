import * as fs from "node:fs"
import * as path from "node:path"
import { type RecordingEvent } from "./events.js"
import { type ServerType, SERVER_TYPE_NAMES } from "../types.js"

export interface RecordingWriterOptions {
  readonly outputPath: string
  readonly targetUrl: string
  readonly targetType: ServerType
  readonly rscApiKeyRequired: boolean
}

export class RecordingWriter {
  private readonly fd: number
  private readonly outputPath: string
  private postFileCount = 0
  private eventCount_ = 0

  constructor(options: RecordingWriterOptions) {
    this.outputPath = options.outputPath

    // Open file for writing (truncate if exists)
    this.fd = fs.openSync(options.outputPath, "w")

    // Write header
    const targetTypeName =
      SERVER_TYPE_NAMES.get(options.targetType) ?? options.targetType

    this.writeLine(`# version: 1`)
    this.writeLine(`# target_url: ${options.targetUrl}`)
    this.writeLine(`# target_type: ${targetTypeName}`)
    if (options.rscApiKeyRequired) {
      this.writeLine(`# rscApiKeyRequired: true`)
    }
  }

  writeEvent(event: RecordingEvent): void {
    this.writeLine(JSON.stringify(event))
    this.eventCount_++
  }

  /**
   * Write a POST body to an adjacent file.
   * Returns the basename of the created file (for the datafile field).
   */
  writePostData(data: Buffer): string {
    const postPath = `${this.outputPath}.post.${this.postFileCount}`
    this.postFileCount++
    fs.writeFileSync(postPath, data)
    return path.basename(postPath)
  }

  close(): void {
    fs.closeSync(this.fd)
  }

  /** Number of POST data files written. */
  get postFileCount_(): number {
    return this.postFileCount
  }

  /** Number of events written. */
  get eventCount(): number {
    return this.eventCount_
  }

  private writeLine(line: string): void {
    fs.writeSync(this.fd, line + "\n")
  }
}
