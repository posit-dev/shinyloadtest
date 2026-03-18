/**
 * HTTP reverse proxy for recording Shiny sessions.
 * Intercepts browser requests, forwards them to the target app,
 * records events, and returns responses to the browser.
 */

import * as http from "node:http"
import * as https from "node:https"
import type { Socket } from "node:net"
import WebSocket, { WebSocketServer } from "ws"
import { CookieJar } from "tough-cookie"
import { RecordingWriter } from "./writer.js"
import { RecordingTokens } from "./tokens.js"
import { classifyGetRequest, makeHttpEvent, makeWsEvent } from "./events.js"
import { extractWorkerId, extractToken } from "../http.js"
import { canIgnore, parseMessage } from "../sockjs.js"
import { httpToWs } from "../url.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const SINF_DELAY_MS = 750

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHopByHop(
  headers: http.IncomingHttpHeaders,
): Record<string, string | string[]> {
  const toRemove = new Set(HOP_BY_HOP_HEADERS)
  const connHeader = headers["connection"]
  if (connHeader) {
    const raw = Array.isArray(connHeader) ? connHeader.join(",") : connHeader
    for (const token of raw.split(",")) {
      toRemove.add(token.trim().toLowerCase())
    }
  }

  const result: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !toRemove.has(key.toLowerCase())) {
      result[key] = value
    }
  }
  return result
}

function shouldIgnoreGet(path: string): boolean {
  return /.*favicon\.ico$/.test(path)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordingProxyOptions {
  targetUrl: string
  host: string
  port: number
  writer: RecordingWriter
  tokens: RecordingTokens
  cookieJar: CookieJar
  authHeaders: Record<string, string>
  onFirstConnection?: () => void
  onShutdown: () => void
}

interface ForwardedResponse {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

// ---------------------------------------------------------------------------
// RecordingProxy
// ---------------------------------------------------------------------------

export class RecordingProxy {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private readonly target: URL
  private readonly host: string
  private readonly port: number
  private readonly writer: RecordingWriter
  private readonly tokens: RecordingTokens
  private readonly cookieJar: CookieJar
  private readonly authHeaders: Record<string, string>
  private onFirstConnection: (() => void) | null
  readonly onShutdown: () => void
  private connected = false
  private activeWsCount = 0
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly SHUTDOWN_GRACE_MS = 500

  constructor(options: RecordingProxyOptions) {
    this.target = new URL(options.targetUrl)
    this.host = options.host
    this.port = options.port
    this.writer = options.writer
    this.tokens = options.tokens
    this.cookieJar = options.cookieJar
    this.authHeaders = options.authHeaders
    this.onFirstConnection = options.onFirstConnection ?? null
    this.onShutdown = options.onShutdown
  }

  private notifyFirstConnection(): void {
    if (!this.connected) {
      this.connected = true
      this.onFirstConnection?.()
      this.onFirstConnection = null
    }
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.notifyFirstConnection()
      this.handleRequest(req, res).catch((err) => {
        console.error("Proxy error:", err)
        if (!res.headersSent) {
          res.writeHead(502)
          res.end("Bad Gateway")
        }
      })
    })

    this.wss = new WebSocketServer({ noServer: true })

    this.server.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket as Socket, head)
    })

    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      this.server!.once("error", onError)
      this.server!.listen(this.port, this.host, () => {
        this.server!.removeListener("error", onError)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer)
      this.shutdownTimer = null
    }
    return new Promise<void>((resolve) => {
      const closeServer = (): void => {
        if (this.server) {
          this.server.close(() => resolve())
        } else {
          resolve()
        }
      }
      if (this.wss) {
        this.wss.close(() => closeServer())
      } else {
        closeServer()
      }
    })
  }

  /** Expose the underlying server for WebSocket upgrade handling. */
  get httpServer(): http.Server | null {
    return this.server
  }

  // -------------------------------------------------------------------------
  // WebSocket handling
  // -------------------------------------------------------------------------

  private handleUpgrade(
    req: http.IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void {
    this.wss!.handleUpgrade(req, socket, head, (clientWs) => {
      this.handleWebSocket(req, clientWs)
    })
  }

  private handleWebSocket(
    req: http.IncomingMessage,
    clientWs: WebSocket,
  ): void {
    this.activeWsCount++
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer)
      this.shutdownTimer = null
    }

    const rawUrl = req.url ?? "/"
    let parsed: URL
    try {
      parsed = new URL(rawUrl, "http://localhost")
    } catch {
      this.activeWsCount--
      clientWs.close(1002, "Malformed URL")
      return
    }
    const pathInfo = parsed.pathname

    // Discover SOCKJSID from the path
    // Pattern: /.../<server>/<session>/websocket
    const sockjsMatch = /\/([^/]+\/[^/]+)\/websocket$/.exec(pathInfo)
    if (sockjsMatch?.[1]) {
      this.tokens.discover("SOCKJSID", sockjsMatch[1])
    }

    // Record WS_OPEN with token-replaced URL
    this.writer.writeEvent(
      makeWsEvent("WS_OPEN", new Date(), {
        url: this.tokens.replaceInString(pathInfo),
      }),
    )

    // Build target WebSocket URL
    const targetHttpUrl = new URL(this.target.toString())
    targetHttpUrl.pathname = this.target.pathname.replace(/\/$/, "") + pathInfo
    targetHttpUrl.search = parsed.search
    const wsUrl = httpToWs(targetHttpUrl.toString())

    // Build outgoing WS headers (cookies + auth)
    const wsHeaders: Record<string, string> = {}
    const cookieString = this.cookieJar.getCookieStringSync(
      this.target.toString(),
    )
    if (cookieString) {
      wsHeaders["Cookie"] = cookieString
    }
    for (const [key, value] of Object.entries(this.authHeaders)) {
      wsHeaders[key] = value
    }

    // Connect to target
    const serverWs = new WebSocket(wsUrl, { headers: wsHeaders })

    // Server send buffer (for messages from client before server is open)
    const serverSendBuffer: string[] = []

    const serverSend = (msg: string): void => {
      if (
        serverWs.readyState === WebSocket.OPEN &&
        serverSendBuffer.length === 0
      ) {
        serverWs.send(msg)
      } else {
        serverSendBuffer.push(msg)
      }
    }

    const sendToClient = (msg: string): void => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(msg)
      }
    }

    // Server -> Client relay
    serverWs.on("message", (data) => {
      const msg = data.toString()

      // SockJS open frame: record and relay
      if (msg === "o") {
        this.writer.writeEvent(
          makeWsEvent("WS_RECV", new Date(), { message: msg }),
        )
        sendToClient(msg)
        return
      }

      // Ignorable messages: relay but don't record
      if (canIgnore(msg)) {
        sendToClient(msg)
        return
      }

      let parsed: Record<string, unknown> | null = null
      try {
        parsed = parseMessage(msg)
      } catch {
        // parseMessage failed on malformed/non-SockJS frame; fall through
        // to generic WS_RECV recording below
      }

      // WS_RECV_INIT: config message
      if (
        parsed &&
        "config" in parsed &&
        typeof parsed["config"] === "object" &&
        parsed["config"] !== null
      ) {
        const config = parsed["config"] as Record<string, unknown>
        if (typeof config["sessionId"] === "string") {
          this.tokens.discover("SESSION", config["sessionId"])
        }
        this.writer.writeEvent(
          makeWsEvent("WS_RECV_INIT", new Date(), {
            message: this.tokens.replaceInString(msg),
          }),
        )
        sendToClient(msg)
        return
      }

      // WS_RECV_BEGIN_UPLOAD: upload response with jobId
      if (parsed) {
        const response = parsed["response"]
        if (response && typeof response === "object") {
          const value = (response as Record<string, unknown>)["value"]
          if (value && typeof value === "object") {
            const v = value as Record<string, unknown>
            if (typeof v["jobId"] === "string") {
              if (typeof v["uploadUrl"] === "string") {
                this.tokens.discover("UPLOAD_URL", v["uploadUrl"])
              }
              this.tokens.discover("UPLOAD_JOB_ID", v["jobId"])
              this.writer.writeEvent(
                makeWsEvent("WS_RECV_BEGIN_UPLOAD", new Date(), {
                  message: this.tokens.replaceInString(msg),
                }),
              )
              sendToClient(msg)
              return
            }
          }
        }
      }

      // Regular WS_RECV
      this.writer.writeEvent(
        makeWsEvent("WS_RECV", new Date(), { message: msg }),
      )
      sendToClient(msg)
    })

    // Server open: flush buffer
    serverWs.on("open", () => {
      for (const msg of serverSendBuffer) {
        serverWs.send(msg)
      }
      serverSendBuffer.length = 0
    })

    // Server close: close client if still open
    serverWs.on("close", () => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close()
      }
    })

    serverWs.on("error", (err) => {
      console.error("Server WebSocket error:", err)
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close()
      }
    })

    // Client -> Server relay
    clientWs.on("message", (data) => {
      const msg = data.toString()

      if (canIgnore(msg)) {
        serverSend(msg)
        return
      }

      this.writer.writeEvent(
        makeWsEvent("WS_SEND", new Date(), {
          message: this.tokens.replaceInString(msg),
        }),
      )
      serverSend(msg)
    })

    // Client close: close server, record WS_CLOSE, schedule shutdown
    clientWs.on("close", () => {
      if (serverWs.readyState <= WebSocket.OPEN) {
        serverWs.close()
      }
      this.writer.writeEvent(makeWsEvent("WS_CLOSE", new Date()))
      this.activeWsCount--
      if (this.activeWsCount <= 0) {
        this.shutdownTimer = setTimeout(() => {
          if (this.activeWsCount <= 0) {
            this.onShutdown()
          }
        }, RecordingProxy.SHUTDOWN_GRACE_MS)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET"
    const pathWithQuery = req.url ?? "/"

    // Build the full target URL preserving the base path
    const incoming = new URL(pathWithQuery, "http://localhost")
    const targetUrl = new URL(this.target.toString())
    targetUrl.pathname =
      this.target.pathname.replace(/\/$/, "") + incoming.pathname
    targetUrl.search = incoming.search

    // Buffer request body (for POST)
    const requestBody = await this.bufferBody(req)

    // Build outgoing headers
    const outHeaders = this.buildOutgoingHeaders(req.headers, targetUrl)

    // Add request body content-length for POST
    if (method === "POST" && requestBody.length > 0) {
      outHeaders["content-length"] = String(requestBody.length)
    }

    // Capture timing
    const begin = new Date()

    // Forward request to target
    const forwarded = await this.forwardRequest(
      method,
      targetUrl,
      outHeaders,
      requestBody,
    )

    const end = new Date()

    // Store cookies from response
    await this.storeCookies(forwarded.headers, targetUrl.toString())

    // Record event (may introduce delay for SINF)
    if (method === "POST") {
      await this.recordPost(
        pathWithQuery,
        forwarded.statusCode,
        requestBody,
        begin,
        end,
      )
    } else if (method === "GET") {
      await this.recordGet(
        pathWithQuery,
        forwarded.statusCode,
        forwarded.body,
        begin,
        end,
      )
    }
    // Other methods (HEAD, PUT, etc.) are proxied but not recorded

    // Send response back to browser
    const cleanHeaders = stripHopByHop(forwarded.headers)
    // Strip content-encoding: we remove accept-encoding from outgoing requests
    // so the upstream should return uncompressed content; this is a safety net
    delete cleanHeaders["content-encoding"]
    // Update content-length to match the actual body we're sending
    cleanHeaders["content-length"] = String(forwarded.body.length)

    res.writeHead(forwarded.statusCode, cleanHeaders)
    res.end(forwarded.body)
  }

  // -------------------------------------------------------------------------
  // Header building
  // -------------------------------------------------------------------------

  private buildOutgoingHeaders(
    incomingHeaders: http.IncomingHttpHeaders,
    targetUrl: URL,
  ): Record<string, string> {
    const cleaned = stripHopByHop(incomingHeaders)
    const result: Record<string, string> = {}

    // Flatten to single strings (take first value for arrays)
    for (const [key, value] of Object.entries(cleaned)) {
      if (Array.isArray(value)) {
        result[key] = value[0] ?? ""
      } else {
        result[key] = value
      }
    }

    // Rewrite host to target
    const portSuffix = targetUrl.port ? `:${targetUrl.port}` : ""
    result["host"] = targetUrl.hostname + portSuffix

    // Don't send accept-encoding so we get uncompressed responses
    delete result["accept-encoding"]

    // Add cookies from jar
    const cookieString = this.cookieJar.getCookieStringSync(
      targetUrl.toString(),
    )
    if (cookieString) {
      result["cookie"] = cookieString
    }

    // Add auth headers
    for (const [key, value] of Object.entries(this.authHeaders)) {
      result[key] = value
    }

    return result
  }

  // -------------------------------------------------------------------------
  // Request forwarding
  // -------------------------------------------------------------------------

  private forwardRequest(
    method: string,
    targetUrl: URL,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<ForwardedResponse> {
    return new Promise<ForwardedResponse>((resolve, reject) => {
      const transport = targetUrl.protocol === "https:" ? https : http

      const options: http.RequestOptions = {
        method,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        headers,
      }

      const outReq = transport.request(options, (outRes) => {
        const chunks: Buffer[] = []
        outRes.on("data", (chunk: Buffer) => chunks.push(chunk))
        outRes.on("end", () => {
          resolve({
            statusCode: outRes.statusCode ?? 502,
            headers: outRes.headers,
            body: Buffer.concat(chunks),
          })
        })
        outRes.on("error", reject)
      })

      outReq.on("error", reject)

      if (body.length > 0) {
        outReq.write(body)
      }
      outReq.end()
    })
  }

  // -------------------------------------------------------------------------
  // Body buffering
  // -------------------------------------------------------------------------

  private bufferBody(stream: http.IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on("data", (chunk: Buffer) => chunks.push(chunk))
      stream.on("end", () => resolve(Buffer.concat(chunks)))
      stream.on("error", reject)
    })
  }

  // -------------------------------------------------------------------------
  // Cookie management
  // -------------------------------------------------------------------------

  private async storeCookies(
    headers: http.IncomingHttpHeaders,
    url: string,
  ): Promise<void> {
    const setCookieHeaders = headers["set-cookie"]
    if (!setCookieHeaders) return

    const cookies = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : [setCookieHeaders]

    for (const cookie of cookies) {
      await this.cookieJar.setCookie(cookie, url)
    }
  }

  // -------------------------------------------------------------------------
  // Event recording
  // -------------------------------------------------------------------------

  private async recordGet(
    pathWithQuery: string,
    statusCode: number,
    responseBody: Buffer,
    begin: Date,
    end: Date,
  ): Promise<void> {
    const pathOnly = pathWithQuery.split("?")[0] ?? pathWithQuery

    // Don't record favicon requests
    if (shouldIgnoreGet(pathOnly)) return

    const { type, robustId } = classifyGetRequest(pathWithQuery)
    const bodyText = responseBody.toString("utf-8")

    // Token discovery based on event type
    if (type === "REQ_HOME") {
      const workerId = extractWorkerId(bodyText)
      if (workerId) {
        this.tokens.discover("WORKER", workerId)
      }
    } else if (type === "REQ_TOK") {
      const token = extractToken(bodyText)
      if (token) {
        this.tokens.discover("TOKEN", token)
      }
    } else if (type === "REQ_SINF" && robustId) {
      this.tokens.discover("ROBUST_ID", robustId)
      // Crude workaround: delay before responding
      await delay(SINF_DELAY_MS)
    }

    const recordedUrl = this.tokens.replaceInString(pathWithQuery)

    this.writer.writeEvent(
      makeHttpEvent(type, begin, end, statusCode, recordedUrl),
    )
  }

  private async recordPost(
    pathWithQuery: string,
    statusCode: number,
    requestBody: Buffer,
    begin: Date,
    end: Date,
  ): Promise<void> {
    const recordedUrl = this.tokens.replaceInString(pathWithQuery)

    let datafile: string | undefined
    if (requestBody.length > 0) {
      datafile = this.writer.writePostData(requestBody)
    }

    this.writer.writeEvent(
      makeHttpEvent("REQ_POST", begin, end, statusCode, recordedUrl, datafile),
    )
  }
}
