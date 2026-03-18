import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import WebSocket from "ws"
import { WebSocketServer } from "ws"
import { CookieJar } from "tough-cookie"
import { RecordingProxy } from "../record/proxy.js"
import { RecordingWriter } from "../record/writer.js"
import { RecordingTokens } from "../record/tokens.js"
import { ServerType } from "../types.js"

// ---------------------------------------------------------------------------
// Mock target server (HTTP + WebSocket)
// ---------------------------------------------------------------------------

interface MockTarget {
  server: http.Server
  wss: WebSocketServer
  port: number
  start(): Promise<void>
  stop(): Promise<void>
}

function createMockTarget(): MockTarget {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/"

    if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(
        "<!DOCTYPE html><html><head>" +
          '<base href="_w_workerabc/">' +
          '<script src="shared/shiny.min.js"></script>' +
          "</head><body>Shiny App</body></html>",
      )
      return
    }

    if (req.method === "GET" && url === "/__token__") {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("tokenvalue123")
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
          entropy: 87654321,
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

    res.writeHead(404)
    res.end("Not found")
  })

  const wss = new WebSocketServer({ server })

  wss.on("connection", (ws) => {
    ws.send("o")

    const initMsg = JSON.stringify({
      config: { sessionId: "session999" },
      custom: {},
    })
    ws.send(initMsg)

    ws.on("message", (_data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            values: { x: 1 },
            inputMessages: [],
            errors: {},
          }),
        )
      }
    })
  })

  let port = 0

  return {
    server,
    wss,
    get port() {
      return port
    },
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as import("node:net").AddressInfo
          port = addr.port
          resolve()
        })
      })
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        wss.close(() => {
          server.close(() => resolve())
        })
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          })
        })
        res.on("error", reject)
      },
    )
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

function readRecordingLines(recordingPath: string): string[] {
  return fs
    .readFileSync(recordingPath, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
}

function readRecordingEvents(
  recordingPath: string,
): Array<Record<string, unknown>> {
  return readRecordingLines(recordingPath)
    .filter((line) => !line.startsWith("#"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function readRecordingHeaders(recordingPath: string): string[] {
  return readRecordingLines(recordingPath).filter((line) =>
    line.startsWith("#"),
  )
}

function waitForMessages(ws: WebSocket, count = 1): Promise<string[]> {
  return new Promise((resolve) => {
    const msgs: string[] = []
    ws.on("message", (data) => {
      msgs.push(data.toString())
      if (msgs.length >= count) resolve(msgs)
    })
  })
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.on("close", () => resolve())
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Recording E2E lifecycle", () => {
  let mockTarget: MockTarget
  let tmpDir: string
  let recordingPath: string
  let writer: RecordingWriter
  let tokens: RecordingTokens
  let proxy: RecordingProxy
  let proxyPort: number
  let shutdownCalled: boolean

  beforeEach(async () => {
    mockTarget = createMockTarget()
    await mockTarget.start()

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shinycannon-e2e-test-"))
    recordingPath = path.join(tmpDir, "recording.log")

    writer = new RecordingWriter({
      outputPath: recordingPath,
      targetUrl: `http://127.0.0.1:${mockTarget.port}`,
      targetType: ServerType.SHN,
      rscApiKeyRequired: false,
    })

    tokens = new RecordingTokens()
    shutdownCalled = false

    proxy = new RecordingProxy({
      targetUrl: `http://127.0.0.1:${mockTarget.port}`,
      host: "127.0.0.1",
      port: 0,
      writer,
      tokens,
      cookieJar: new CookieJar(),
      authHeaders: {},
      onShutdown: () => {
        shutdownCalled = true
      },
    })

    await proxy.start()
    const addr = proxy.httpServer!.address() as import("node:net").AddressInfo
    proxyPort = addr.port
  })

  afterEach(async () => {
    await proxy.stop()
    writer.close()
    await mockTarget.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it(
    "E2E-01: full recording lifecycle produces valid recording file",
    { timeout: 10000 },
    async () => {
      // --- HTTP phase ---

      const homeRes = await httpRequest(proxyPort, "GET", "/")
      expect(homeRes.statusCode).toBe(200)
      await delay(50)

      const tokRes = await httpRequest(proxyPort, "GET", "/__token__")
      expect(tokRes.body).toBe("tokenvalue123")
      await delay(50)

      // SINF has a ~750ms delay inside the proxy
      const sinfRes = await httpRequest(
        proxyPort,
        "GET",
        "/__sockjs__/000/abc/n=robustXYZ",
      )
      expect(sinfRes.statusCode).toBe(200)
      await delay(50)

      // --- POST phase ---

      const postRes = await httpRequest(
        proxyPort,
        "POST",
        "/upload",
        "upload-data",
      )
      expect(postRes.statusCode).toBe(200)
      await delay(50)

      // --- WebSocket phase ---

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/__sockjs__/000/sess001/websocket`,
      )

      // Collect "o" + config init (2 server-initiated messages) upfront,
      // then send a client message and collect the echo (1 more = 3 total).
      const serverMsgsPromise = waitForMessages(ws, 3)

      // Wait for the WS to be open before sending
      await new Promise<void>((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) {
          resolve()
        } else {
          ws.on("open", () => resolve())
          ws.on("error", reject)
        }
      })

      // Give the server time to send "o" and init before we send
      await delay(100)
      ws.send(JSON.stringify({ method: "init", data: {} }))

      const serverMsgs = await serverMsgsPromise
      expect(serverMsgs[0]).toBe("o")
      expect(serverMsgs[1]).toContain("sessionId")

      await delay(100)

      // Close the WS and wait for shutdown callback
      ws.close()
      await waitForClose(ws)
      // Wait longer than the shutdown grace period (500ms)
      await delay(700)

      expect(shutdownCalled).toBe(true)

      // --- Verify recording file ---

      // Header checks
      const headers = readRecordingHeaders(recordingPath)
      expect(headers).toContain("# version: 1")
      expect(
        headers.some((h) => h.includes(`http://127.0.0.1:${mockTarget.port}`)),
      ).toBe(true)
      expect(headers.some((h) => h.includes("R/Shiny"))).toBe(true)
      expect(headers.every((h) => !h.includes("rscApiKeyRequired"))).toBe(true)

      // Events in order
      const events = readRecordingEvents(recordingPath)
      const types = events.map((e) => e["type"])

      const homeIdx = types.indexOf("REQ_HOME")
      const tokIdx = types.indexOf("REQ_TOK")
      const sinfIdx = types.indexOf("REQ_SINF")
      const postIdx = types.indexOf("REQ_POST")
      const wsOpenIdx = types.indexOf("WS_OPEN")
      const wsCloseIdx = types.lastIndexOf("WS_CLOSE")

      expect(homeIdx).toBeGreaterThanOrEqual(0)
      expect(tokIdx).toBeGreaterThan(homeIdx)
      expect(sinfIdx).toBeGreaterThan(tokIdx)
      expect(postIdx).toBeGreaterThan(sinfIdx)
      expect(wsOpenIdx).toBeGreaterThan(postIdx)
      expect(wsCloseIdx).toBeGreaterThan(wsOpenIdx)

      // WS_RECV "o" frame
      const wsRecvO = events.find(
        (e) => e["type"] === "WS_RECV" && e["message"] === "o",
      )
      expect(wsRecvO).toBeDefined()
      expect(types.indexOf("WS_RECV")).toBeGreaterThan(wsOpenIdx)

      // WS_RECV_INIT
      const wsRecvInit = events.find((e) => e["type"] === "WS_RECV_INIT")
      expect(wsRecvInit).toBeDefined()
      expect(wsRecvInit!["message"]).toContain("${SESSION}")
      expect(wsRecvInit!["message"] as string).not.toContain("session999")

      // WS_SEND
      const wsSend = events.find((e) => e["type"] === "WS_SEND")
      expect(wsSend).toBeDefined()

      // WS_RECV echo (not the "o" frame)
      const wsRecvEcho = events.find(
        (e) =>
          e["type"] === "WS_RECV" &&
          typeof e["message"] === "string" &&
          (e["message"] as string).includes("values"),
      )
      expect(wsRecvEcho).toBeDefined()

      // Token replacements in recorded URLs
      const homeEvent = events[homeIdx]
      expect(homeEvent!["url"]).toBe("/")

      const sinfEvent = events[sinfIdx]
      expect(sinfEvent!["url"]).toContain("${ROBUST_ID}")
      expect(sinfEvent!["url"] as string).not.toContain("robustXYZ")

      const wsOpenEvent = events[wsOpenIdx]
      expect(wsOpenEvent!["url"]).toContain("${SOCKJSID}")
      expect(wsOpenEvent!["url"] as string).not.toContain("sess001")

      // POST datafile
      const postEvent = events[postIdx]
      expect(typeof postEvent!["datafile"]).toBe("string")
      const datafileName = postEvent!["datafile"] as string
      const datafilePath = path.join(tmpDir, datafileName)
      expect(fs.existsSync(datafilePath)).toBe(true)
      expect(fs.readFileSync(datafilePath, "utf-8")).toBe("upload-data")

      // Token discovery
      expect(tokens.has("WORKER")).toBe(true)
      expect(tokens.has("TOKEN")).toBe(true)
      expect(tokens.has("ROBUST_ID")).toBe(true)
      expect(tokens.has("SOCKJSID")).toBe(true)
      expect(tokens.has("SESSION")).toBe(true)
    },
  )
})
