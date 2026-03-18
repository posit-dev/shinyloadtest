import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import WebSocket, { WebSocketServer } from "ws"
import { CookieJar } from "tough-cookie"
import { RecordingProxy } from "../record/proxy.js"
import { RecordingWriter } from "../record/writer.js"
import { RecordingTokens } from "../record/tokens.js"
import { ServerType } from "../types.js"

// ---------------------------------------------------------------------------
// Mock target server (HTTP + WebSocket)
// ---------------------------------------------------------------------------

interface MockTargetOptions {
  /** Extra messages to send after the config init message */
  extraMessages?: string[]
}

interface MockTarget {
  server: http.Server
  wss: WebSocketServer
  port: number
  start(): Promise<void>
  stop(): Promise<void>
}

function createMockTarget(options: MockTargetOptions = {}): MockTarget {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/"
    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(
        "<!DOCTYPE html><html><head>" +
          '<base href="_w_abc/">' +
          "</head><body>Shiny App</body></html>",
      )
      return
    }
    res.writeHead(404)
    res.end("Not found")
  })

  const wss = new WebSocketServer({ server })

  wss.on("connection", (ws) => {
    // Send SockJS open frame
    ws.send("o")

    // Send config init message
    const initMsg = JSON.stringify({
      config: { sessionId: "sess-12345" },
      custom: {},
    })
    ws.send(initMsg)

    // Send any extra messages after init
    for (const msg of options.extraMessages ?? []) {
      ws.send(msg)
    }

    // Echo client messages back as a response
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

function readRecordingEvents(
  recordingPath: string,
): Array<Record<string, unknown>> {
  return fs
    .readFileSync(recordingPath, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
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

function connectWsToProxy(proxyPort: number, wsPath: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${proxyPort}${wsPath}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("RecordingProxy WebSocket", () => {
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

    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "shinycannon-ws-proxy-test-"),
    )
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
    "WS-01: WS_OPEN is recorded with token-replaced URL",
    { timeout: 5000 },
    async () => {
      const ws = connectWsToProxy(proxyPort, "/__sockjs__/000/abc123/websocket")
      // Wait for "o" frame (first message)
      await waitForMessages(ws, 1)
      ws.close()
      await waitForClose(ws)
      await delay(100)

      const events = readRecordingEvents(recordingPath)
      const openEvent = events.find((e) => e["type"] === "WS_OPEN")
      expect(openEvent).toBeDefined()
      expect(openEvent!["url"]).toContain("${SOCKJSID}")
      expect(openEvent!["url"]).not.toContain("abc123")
      expect(tokens.has("SOCKJSID")).toBe(true)
    },
  )

  it(
    "WS-02: SockJS open frame is recorded as WS_RECV",
    { timeout: 5000 },
    async () => {
      const ws = connectWsToProxy(proxyPort, "/__sockjs__/000/abc123/websocket")
      await waitForMessages(ws, 1)
      ws.close()
      await waitForClose(ws)
      await delay(100)

      const events = readRecordingEvents(recordingPath)
      const recvEvent = events.find(
        (e) => e["type"] === "WS_RECV" && e["message"] === "o",
      )
      expect(recvEvent).toBeDefined()
    },
  )

  it(
    "WS-03: Config init message is recorded as WS_RECV_INIT with SESSION token",
    { timeout: 5000 },
    async () => {
      const ws = connectWsToProxy(proxyPort, "/__sockjs__/000/abc123/websocket")
      // Wait for "o" and config message (2 messages)
      await waitForMessages(ws, 2)
      ws.close()
      await waitForClose(ws)
      await delay(100)

      const events = readRecordingEvents(recordingPath)
      const initEvent = events.find((e) => e["type"] === "WS_RECV_INIT")
      expect(initEvent).toBeDefined()
      expect(initEvent!["message"]).toContain("${SESSION}")
      expect(initEvent!["message"] as string).not.toContain("sess-12345")
      expect(tokens.has("SESSION")).toBe(true)
    },
  )

  it(
    "WS-04: Client messages are recorded as WS_SEND",
    { timeout: 5000 },
    async () => {
      const ws = connectWsToProxy(proxyPort, "/__sockjs__/000/abc123/websocket")
      // Wait for init sequence ("o" + config)
      await waitForMessages(ws, 2)

      const clientMsg = JSON.stringify({ method: "init", data: {} })
      ws.send(clientMsg)
      // Wait for echo response
      await waitForMessages(ws, 1)
      await delay(100)

      ws.close()
      await waitForClose(ws)
      await delay(100)

      const events = readRecordingEvents(recordingPath)
      const sendEvent = events.find((e) => e["type"] === "WS_SEND")
      expect(sendEvent).toBeDefined()
      expect(sendEvent!["message"]).toBe(clientMsg)
    },
  )

  it(
    "WS-05: Server response is recorded as WS_RECV",
    { timeout: 5000 },
    async () => {
      const ws = connectWsToProxy(proxyPort, "/__sockjs__/000/abc123/websocket")
      await waitForMessages(ws, 2)

      ws.send(JSON.stringify({ method: "init", data: {} }))
      await waitForMessages(ws, 1)
      await delay(100)

      ws.close()
      await waitForClose(ws)
      await delay(100)

      const events = readRecordingEvents(recordingPath)
      const recvEvents = events.filter((e) => e["type"] === "WS_RECV")
      // Should have at least: "o" frame + echo response
      const echoEvent = recvEvents.find(
        (e) =>
          typeof e["message"] === "string" &&
          (e["message"] as string).includes("values"),
      )
      expect(echoEvent).toBeDefined()
    },
  )

  it(
    "WS-06: Heartbeat 'h' is relayed to client but NOT recorded",
    { timeout: 5000 },
    async () => {
      // Create a fresh mock that sends "h" after init
      await proxy.stop()
      writer.close()
      await mockTarget.stop()
      fs.rmSync(tmpDir, { recursive: true, force: true })

      mockTarget = createMockTarget({ extraMessages: ["h"] })
      await mockTarget.start()

      tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "shinycannon-ws-proxy-test-h-"),
      )
      recordingPath = path.join(tmpDir, "recording.log")

      writer = new RecordingWriter({
        outputPath: recordingPath,
        targetUrl: `http://127.0.0.1:${mockTarget.port}`,
        targetType: ServerType.SHN,
        rscApiKeyRequired: false,
      })

      tokens = new RecordingTokens()

      proxy = new RecordingProxy({
        targetUrl: `http://127.0.0.1:${mockTarget.port}`,
        host: "127.0.0.1",
        port: 0,
        writer,
        tokens,
        cookieJar: new CookieJar(),
        authHeaders: {},
        onShutdown: () => {},
      })

      await proxy.start()
      const addr = proxy.httpServer!.address() as import("node:net").AddressInfo
      proxyPort = addr.port

      const ws = connectWsToProxy(proxyPort, "/__sockjs__/000/abc123/websocket")
      // Wait for "o", config, and "h" (3 messages)
      const msgs = await waitForMessages(ws, 3)
      await delay(100)

      // "h" should have been relayed to the client
      expect(msgs).toContain("h")

      ws.close()
      await waitForClose(ws)
      await delay(100)

      const events = readRecordingEvents(recordingPath)
      // No event should have message "h"
      const heartbeatEvent = events.find((e) => e["message"] === "h")
      expect(heartbeatEvent).toBeUndefined()
    },
  )

  it(
    "WS-07: Client disconnect records WS_CLOSE and triggers onShutdown",
    { timeout: 5000 },
    async () => {
      const ws = connectWsToProxy(proxyPort, "/__sockjs__/000/abc123/websocket")
      await waitForMessages(ws, 2)

      ws.close()
      await waitForClose(ws)
      // Wait longer than the shutdown grace period (500ms)
      await delay(700)

      const events = readRecordingEvents(recordingPath)
      const closeEvent = events.find((e) => e["type"] === "WS_CLOSE")
      expect(closeEvent).toBeDefined()
      expect(shutdownCalled).toBe(true)
    },
  )
})
