import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"
import { findOutputDirs, loadReportData } from "../load"

const __dirname = dirname(fileURLToPath(import.meta.url))

function devDataPlugin(): Plugin {
  return {
    name: "report-dev-data",
    apply: "serve",
    configureServer(server) {
      const devDir = process.env["REPORT_DEV_DIR"]
      if (!devDir) return
      server.middlewares.use("/__dev_data__.json", (_req, res) => {
        try {
          let json: string
          if (devDir.startsWith("fixture:")) {
            const name = devDir.slice("fixture:".length)
            if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
              throw new Error(`Invalid fixture name: ${name}`)
            }
            const fixturePath = resolve(__dirname, "fixtures", `${name}.json`)
            json = readFileSync(fixturePath, "utf-8")
          } else {
            let dirs = devDir
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean)
            if (dirs.length === 1) {
              const discovered = findOutputDirs(dirs[0])
              if (discovered.length > 0) {
                dirs = discovered
              }
            }
            json = JSON.stringify(loadReportData(dirs))
          }
          res.setHeader("Content-Type", "application/json")
          res.end(json)
        } catch (err) {
          console.error("[report-dev-data]", err)
          res.statusCode = 500
          res.end("Failed to load report data")
        }
      })
    },
  }
}

export default defineConfig({
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  plugins: [devDataPlugin(), viteSingleFile()],
})
