import { type ReportData } from "./load.js"
import REPORT_HTML from "./app/dist/index.html"

export function generateReportHTML(data: ReportData): string {
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c")
  return REPORT_HTML.replace("/*__REPORT_DATA__*/", dataJson)
}
