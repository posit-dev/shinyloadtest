import * as fs from "node:fs"
import * as path from "node:path"
import * as url from "node:url"
import { loadReportData } from "../../load.js"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const resourcesBase = path.resolve(
  __dirname,
  "../../../../_resources/shinyloadtest/vignettes/test_sessions",
)
const outDir = __dirname

const demos = ["demo1", "demo4"] as const

for (const demo of demos) {
  const dir = path.join(resourcesBase, demo)
  const data = loadReportData([dir])
  const outFile = path.join(outDir, `${demo}.json`)
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2))
  console.log(`Wrote ${outFile}`)
}
