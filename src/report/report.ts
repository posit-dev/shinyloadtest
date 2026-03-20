import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import { bold, cyan, dim, green } from "yoctocolors"
import { findOutputDirs, loadReportData } from "./load.js"
import { generateReportJSON } from "./format-json.js"
import { generateReportText } from "./format-text.js"
import { generateReportHTML } from "./template.js"

export interface ReportOptions {
  dirs: string[]
  output: string | undefined
  open: boolean
  format: "html" | "text" | "json"
}

const w = process.stderr.write.bind(process.stderr)

export async function report(options: ReportOptions): Promise<void> {
  let dirs = options.dirs

  // Auto-detect output directories if none specified
  if (dirs.length === 0) {
    dirs = findOutputDirs(process.cwd())
    if (dirs.length === 0) {
      throw new Error(
        "No test output directories found. Run `shinyloadtest replay` first " +
          "or specify directories explicitly: `shinyloadtest report <dir> [dir2...]`",
      )
    }
  }

  // Validate directories exist
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Directory not found: ${dir}`)
    }
  }

  const data = loadReportData(dirs)

  if (options.format === "text" || options.format === "json") {
    const output =
      options.format === "json" ? generateReportJSON(data) : generateReportText(data)

    if (options.output) {
      const outputPath = path.resolve(options.output)
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, output)
      w(`\n  ${green("✔")} Report saved to ${bold(outputPath)}\n\n`)
    } else {
      process.stdout.write(output + "\n")
    }
    return
  }

  // HTML format
  w("\n")
  w(`  ${bold(cyan("shinyloadtest report"))}\n`)
  w("\n")

  const nRuns = dirs.length
  w(`  ${dim("Runs:")} ${bold(String(nRuns))}\n`)
  for (const dir of dirs) {
    w(`    ${dim("•")} ${path.basename(dir)}\n`)
  }
  w("\n")

  const nEvents = data.recording.events.length
  const totalRows = data.runs.reduce((s, r) => s + r.rows.length, 0)
  const durationSec = Math.round(data.recording.duration / 1000)

  w(`  ${dim("Recording:")}  ${bold(String(nEvents))} events${dim(",")} ${bold(`${durationSec}s`)} duration\n`)
  w(`  ${dim("Sessions:")}   ${bold(totalRows.toLocaleString("en-US"))} data points\n`)
  w("\n")

  const html = generateReportHTML(data)

  if (options.output) {
    // Save mode: write to file
    const outputPath = path.resolve(options.output)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, html)
    w(`  ${green("✔")} Report saved to ${bold(outputPath)}\n`)

    if (options.open) {
      openInBrowser(`file://${outputPath}`)
    }
  } else {
    // Serve mode: start local HTTP server
    await serveReport(html, options.open)
  }

  w("\n")
}

function openInBrowser(url: string): void {
  if (process.platform === "win32") {
    execFile("cmd", ["/c", "start", "", url])
  } else {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open"
    execFile(cmd, [url])
  }
}

function serveReport(html: string, open: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html),
      })
      res.end(html)
    })

    server.on("error", reject)

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"))
        return
      }
      const url = `http://127.0.0.1:${addr.port}`
      w(`  ${green("✔")} Serving at ${bold(cyan(url))}\n`)
      w(`  ${cyan("ℹ")} Press Ctrl+C to stop.\n`)
      w("\n")

      if (open) {
        openInBrowser(url)
      }
    })

    let isShuttingDown = false

    function shutdown(): void {
      if (isShuttingDown) return
      isShuttingDown = true
      w(`\n  ${dim("Stopping server.")}\n\n`)
      server.close(() => {
        process.off("SIGINT", shutdown)
        process.off("SIGTERM", shutdown)
        resolve()
      })
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  })
}
