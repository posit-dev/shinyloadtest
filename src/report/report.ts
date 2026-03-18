import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import { findOutputDirs, loadReportData } from "./load.js"
import { generateReportHTML } from "./template.js"

export interface ReportOptions {
  dirs: string[]
  output: string | undefined
  open: boolean
}

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
    console.error(
      `Found ${dirs.length} test run${dirs.length > 1 ? "s" : ""}: ${dirs.map((d) => path.basename(d)).join(", ")}`,
    )
  }

  // Validate directories exist
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Directory not found: ${dir}`)
    }
  }

  const data = loadReportData(dirs)
  const html = generateReportHTML(data)

  if (options.output) {
    // Save mode: write to file
    const outputPath = path.resolve(options.output)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, html)
    console.error(`Report saved to: ${outputPath}`)

    if (options.open) {
      openInBrowser(`file://${outputPath}`)
    }
  } else {
    // Serve mode: start local HTTP server
    await serveReport(html, options.open)
  }
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
      console.error(`Serving report at: ${url}`)
      console.error("Press Ctrl+C to stop.")

      if (open) {
        openInBrowser(url)
      }
    })

    function shutdown(): void {
      console.error("\nStopping server.")
      server.close(() => resolve())
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  })
}
