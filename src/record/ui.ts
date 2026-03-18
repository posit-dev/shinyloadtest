/**
 * Terminal UI for the record subcommand. Provides spinners, colors,
 * and a live event counter when stderr is a TTY.
 */

import ora, { type Ora } from "ora"
import { bold, cyan, dim, green, yellow } from "yoctocolors"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordUIConfig {
  version: string
  targetUrl: string
  proxyUrl: string
  output: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min > 0) return `${min}m ${String(sec).padStart(2, "0")}s`
  return `${sec}s`
}

function timestamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ---------------------------------------------------------------------------
// RecordTerminalUI
// ---------------------------------------------------------------------------

export class RecordTerminalUI {
  private spinner: Ora
  private updateTimer: ReturnType<typeof setInterval> | null = null
  private recordingStartTime = 0
  private getEventCount: (() => number) | null = null

  constructor() {
    this.spinner = ora({
      stream: process.stderr,
      color: "cyan",
      discardStdin: false,
    })
  }

  startDetecting(): void {
    this.spinner.start("Detecting server type...")
  }

  detectedServerType(serverTypeName: string): void {
    this.spinner.succeed(`Target type: ${bold(serverTypeName)}`)
  }

  startAuthenticating(method: string): void {
    this.spinner = ora({
      stream: process.stderr,
      color: "cyan",
      discardStdin: false,
    })
    this.spinner.start(`Authenticating ${dim(`(${method})`)}`)
  }

  authenticated(serverName: string): void {
    this.spinner.succeed(`Logged in to ${bold(serverName)}`)
  }

  showBanner(config: RecordUIConfig): void {
    const { version, targetUrl, proxyUrl, output } = config
    const w = process.stderr.write.bind(process.stderr)

    w("\n")
    w(`  ${bold(cyan("shinyloadtest record"))} ${dim(`v${version}`)}\n`)
    w("\n")
    w(`  ${dim("Target:")}  ${bold(targetUrl)}\n`)
    w(`  ${dim("Proxy:")}   ${bold(cyan(proxyUrl))}\n`)
    w(`  ${dim("Output:")}  ${bold(output)}\n`)
    w("\n")
  }

  startWaiting(proxyUrl: string): void {
    const w = process.stderr.write.bind(process.stderr)
    w(`${cyan("\u2192")} Navigate to: ${bold(cyan(proxyUrl))}\n`)
    w("\n")
    this.spinner = ora({
      stream: process.stderr,
      color: "cyan",
      discardStdin: false,
    })
    this.spinner.start("Waiting for browser")
  }

  startRecording(getEventCount: () => number): void {
    this.getEventCount = getEventCount
    this.recordingStartTime = Date.now()

    this.spinner.succeed(`Browser connected ${dim(`[${timestamp()}]`)}`)
    this.spinner = ora({
      stream: process.stderr,
      color: "cyan",
      discardStdin: false,
    })
    this.spinner.start(this.recordingText())

    this.updateTimer = setInterval(() => {
      this.spinner.text = this.recordingText()
    }, 1000)
  }

  stopRecording(reason?: "disconnected" | "interrupted" | "cancelled"): void {
    this.stopUpdates()
    this.spinner.stop()
    const w = process.stderr.write.bind(process.stderr)
    const label =
      reason === "interrupted"
        ? "Recording interrupted"
        : reason === "cancelled"
          ? "Recording cancelled"
          : "Browser disconnected"
    w(`${green("\u2714")} ${label} ${dim(`[${timestamp()}]`)}\n`)
  }

  finish(config: {
    output: string
    eventCount: number
    postFileCount: number
    duration: number
  }): void {
    this.stopUpdates()

    const w = process.stderr.write.bind(process.stderr)

    w("\n")
    w(`${green("\u2714")} Recording saved to ${bold(config.output)}\n`)
    w(
      `  ${dim("Events:")}    ${bold(String(config.eventCount))} captured in ${bold(formatDuration(config.duration))}\n`,
    )
    if (config.postFileCount > 0) {
      w(
        `  ${dim("POST data:")} ${yellow(String(config.postFileCount))} file(s) created\n`,
      )
    }
    w("\n")
  }

  cleanup(): void {
    this.stopUpdates()
    this.spinner.stop()
  }

  private recordingText(): string {
    const count = this.getEventCount?.() ?? 0
    const elapsed = Date.now() - this.recordingStartTime
    return [
      `${bold("Recording")}  ${bold(formatDuration(elapsed))} ${dim("elapsed")}  ${dim("\u2502")}  ${bold(String(count))} ${dim("events captured")}`,
      `${cyan("\u2139")} ${dim("Close browser to stop recording")}`,
    ].join("\n")
  }

  private stopUpdates(): void {
    if (this.updateTimer !== null) {
      clearInterval(this.updateTimer)
      this.updateTimer = null
    }
  }
}
