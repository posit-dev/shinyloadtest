import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CookieJar } from "tough-cookie"
import { RecordingProxy } from "../record/proxy.js"
import { RecordingWriter } from "../record/writer.js"
import { RecordingTokens } from "../record/tokens.js"
import { ServerType } from "../types.js"

// ---------------------------------------------------------------------------
// Mock target server
// ---------------------------------------------------------------------------

function createMockTarget(): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? "/"

    if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
      res.writeHead(200, { "Content-Type": "text/html", "x-custom": "hello" })
      res.end(
        "<!DOCTYPE html><html><head>" +
          '<base href="_w_testworker/">' +
          '<script src="shared/shiny.min.js"></script>' +
          "</head><body>Shiny App</body></html>",
      )
      return
    }

    if (req.method === "GET" && url === "/__token__") {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("test-token-abc")
      return
    }

    if (
      req.method === "GET" &&
      url.startsWith("/__sockjs__/") &&
      url.includes("n=")
    ) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          websocket: true,
          cookie_needed: false,
          origins: ["*:*"],
          entropy: 12345678,
        }),
      )
      return
    }

    if (req.method === "POST" && url === "/upload") {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        const body = Buffer.concat(chunks)
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end(body)
      })
      return
    }

    if (req.method === "GET" && url === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/x-icon" })
      res.end("")
      return
    }

    if (req.method === "GET" && url.includes("/shared/")) {
      res.writeHead(200, { "Content-Type": "application/javascript" })
      res.end("// js")
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })
}

// ---------------------------------------------------------------------------
// HTTP request helper
// ---------------------------------------------------------------------------

interface ProxyResponse {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: string
}

function makeRequest(
  proxyPort: number,
  method: string,
  urlPath: string,
  body?: string,
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: proxyPort,
      path: urlPath,
      method,
      headers: body
        ? {
            "content-type": "text/plain",
            "content-length": String(Buffer.byteLength(body)),
          }
        : {},
    }

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        })
      })
      res.on("error", reject)
    })

    req.on("error", reject)

    if (body) {
      req.write(body)
    }
    req.end()
  })
}

function get(proxyPort: number, urlPath: string): Promise<ProxyResponse> {
  return makeRequest(proxyPort, "GET", urlPath)
}

function post(
  proxyPort: number,
  urlPath: string,
  body: string,
): Promise<ProxyResponse> {
  return makeRequest(proxyPort, "POST", urlPath, body)
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo
      resolve(addr.port)
    })
  })
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

function readRecordingEvents(
  recordingPath: string,
): Array<Record<string, unknown>> {
  return fs
    .readFileSync(recordingPath, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("RecordingProxy", () => {
  let mockTarget: http.Server
  let mockTargetPort: number
  let tmpDir: string
  let recordingPath: string
  let writer: RecordingWriter
  let tokens: RecordingTokens
  let proxy: RecordingProxy
  let proxyPort: number

  beforeEach(async () => {
    mockTarget = createMockTarget()
    mockTargetPort = await startServer(mockTarget)

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shinycannon-proxy-test-"))
    recordingPath = path.join(tmpDir, "recording.log")

    writer = new RecordingWriter({
      outputPath: recordingPath,
      targetUrl: `http://127.0.0.1:${mockTargetPort}`,
      targetType: ServerType.SHN,
      rscApiKeyRequired: false,
    })

    tokens = new RecordingTokens()

    // Find a free port for the proxy by using port 0 and extracting it after start
    proxy = new RecordingProxy({
      targetUrl: `http://127.0.0.1:${mockTargetPort}`,
      host: "127.0.0.1",
      port: 0,
      writer,
      tokens,
      cookieJar: new CookieJar(),
      authHeaders: {},
      onShutdown: () => {},
    })

    await proxy.start()
    const server = proxy.httpServer!
    const addr = server.address() as import("node:net").AddressInfo
    proxyPort = addr.port
  })

  afterEach(async () => {
    await proxy.stop()
    writer.close()
    await stopServer(mockTarget)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("PRXY-01: GET / is proxied and recorded as REQ_HOME", async () => {
    const res = await get(proxyPort, "/")

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<base href="_w_testworker/">')

    const events = readRecordingEvents(recordingPath)
    const homeEvent = events.find((e) => e["type"] === "REQ_HOME")
    expect(homeEvent).toBeDefined()
    expect(homeEvent!["status"]).toBe(200)

    expect(tokens.has("WORKER")).toBe(true)
  })

  it("PRXY-02: GET __token__ is recorded as REQ_TOK", async () => {
    const res = await get(proxyPort, "/__token__")

    expect(res.body).toBe("test-token-abc")

    const events = readRecordingEvents(recordingPath)
    const tokEvent = events.find((e) => e["type"] === "REQ_TOK")
    expect(tokEvent).toBeDefined()
    expect(tokEvent!["status"]).toBe(200)

    expect(tokens.has("TOKEN")).toBe(true)
  })

  it(
    "PRXY-03: GET __sockjs__ info is recorded as REQ_SINF with ROBUST_ID discovery",
    { timeout: 5000 },
    async () => {
      const res = await get(proxyPort, "/__sockjs__/000/abc/n=robustid123")

      expect(res.statusCode).toBe(200)

      const events = readRecordingEvents(recordingPath)
      const sinfEvent = events.find((e) => e["type"] === "REQ_SINF")
      expect(sinfEvent).toBeDefined()
      expect(sinfEvent!["status"]).toBe(200)

      expect(tokens.has("ROBUST_ID")).toBe(true)
    },
  )

  it("PRXY-04: POST is recorded as REQ_POST with datafile", async () => {
    const res = await post(proxyPort, "/upload", "test-post-body")

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe("test-post-body")

    const events = readRecordingEvents(recordingPath)
    const postEvent = events.find((e) => e["type"] === "REQ_POST")
    expect(postEvent).toBeDefined()
    expect(typeof postEvent!["datafile"]).toBe("string")

    const datafileName = postEvent!["datafile"] as string
    const datafilePath = path.join(tmpDir, datafileName)
    expect(fs.existsSync(datafilePath)).toBe(true)
    expect(fs.readFileSync(datafilePath, "utf-8")).toBe("test-post-body")
  })

  it("PRXY-05: favicon.ico is proxied but NOT recorded", async () => {
    const res = await get(proxyPort, "/favicon.ico")

    expect(res.statusCode).toBe(200)

    const events = readRecordingEvents(recordingPath)
    expect(events.length).toBe(0)
  })

  it("PRXY-06: token replacement in recorded URLs", async () => {
    // First request discovers WORKER token
    await get(proxyPort, "/")
    // Second request uses the worker path
    await get(proxyPort, "/_w_testworker/shared/something.js")

    const events = readRecordingEvents(recordingPath)

    const getEvent = events.find(
      (e) => e["type"] === "REQ_GET" && (e["url"] as string).includes("shared"),
    )
    expect(getEvent).toBeDefined()
    expect(getEvent!["url"]).toBe("/_w_${WORKER}/shared/something.js")
  })

  it("PRXY-07: response headers are passed through (minus hop-by-hop)", async () => {
    const res = await get(proxyPort, "/")

    // Custom header passes through
    expect(res.headers["x-custom"]).toBe("hello")

    // Hop-by-hop headers are stripped
    expect(res.headers["transfer-encoding"]).toBeUndefined()
  })
})
