import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { once } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AddressInfo } from "node:net"
import WebSocket from "ws"
import { record } from "../record/record.js"
import { RecordingProxy } from "../record/proxy.js"
import { HttpStatusError } from "../http.js"
import { readRecording } from "../recording.js"
import { ServerType } from "../types.js"
import { MockShinyServer } from "./helpers/mock-shiny-server.js"

const API_KEY = "record-auth-test-key"
const AUTH_ENV_VARS = [
  "SHINYLOADTEST_CONNECT_API_KEY",
  "SHINYCANNON_CONNECT_API_KEY",
  "SHINYLOADTEST_USER",
  "SHINYLOADTEST_PASS",
  "SHINYCANNON_USER",
  "SHINYCANNON_PASS",
]

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Recording test timed out")),
      5000,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function driveRecording(
  targetUrl: string,
  output: string,
): Promise<number> {
  // Observe the real proxy startup to use port 0 without reserving or polling ports.
  const originalStart = RecordingProxy.prototype.start
  const proxyReady = new Promise<RecordingProxy>((resolve) => {
    vi.spyOn(RecordingProxy.prototype, "start").mockImplementation(
      async function (this: RecordingProxy) {
        await originalStart.call(this)
        resolve(this)
      },
    )
  })
  let finished = false
  const outcome = record({
    targetUrl,
    host: "127.0.0.1",
    port: 0,
    output,
    open: false,
  }).then(
    () => {
      finished = true
      return { error: null }
    },
    (error: unknown) => {
      finished = true
      return { error }
    },
  )
  let proxy: RecordingProxy | undefined
  let ws: WebSocket | undefined
  try {
    proxy = await withTimeout(
      Promise.race([
        proxyReady,
        outcome.then(({ error }) => {
          throw error ?? new Error("Recording exited before startup")
        }),
      ]),
    )
    const port = (proxy.httpServer!.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(5000),
    })
    await response.text()

    ws = new WebSocket(`ws://127.0.0.1:${port}/websocket`)
    // once() rejects connection errors; this listener also covers cleanup errors.
    ws.on("error", () => {})
    await withTimeout(once(ws, "message"))
    const closed = once(ws, "close")
    ws.close()
    await withTimeout(closed)
    const result = await withTimeout(outcome)
    if (result.error !== null) throw result.error
    return response.status
  } finally {
    ws?.terminate()
    if (proxy && !finished) {
      proxy.onShutdown()
      await withTimeout(outcome)
    }
  }
}

describe("recording protected Connect content", () => {
  let target: MockShinyServer
  let tmpDir: string
  let output: string
  let logs: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    for (const key of AUTH_ENV_VARS) vi.stubEnv(key, "")
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slt-record-auth-"))
    output = path.join(tmpDir, "recording.log")
    logs = vi.spyOn(console, "error").mockImplementation(() => {})
    target = new MockShinyServer({ connectApiKey: API_KEY })
    await target.start()
  })

  afterEach(async () => {
    await target.stop()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each(["SHINYLOADTEST_CONNECT_API_KEY", "SHINYCANNON_CONNECT_API_KEY"])(
    "authenticates detection and proxy HTTP/WebSocket requests using %s",
    async (envKey) => {
      vi.stubEnv(envKey, API_KEY)

      const status = await driveRecording(target.url, output)

      expect(status).toBe(200)
      expect(target.httpRequests.length).toBeGreaterThanOrEqual(2)
      for (const headers of target.httpRequests)
        expect(headers.authorization).toBe(`Key ${API_KEY}`)
      expect(target.httpRequests[0]?.cookie).toBeUndefined()
      expect(target.httpRequests[1]?.cookie).toBe("rscid=mock-connect-session")
      expect(target.wsRequests).toHaveLength(1)
      expect(target.wsRequests[0]).toMatchObject({
        authorization: `Key ${API_KEY}`,
        cookie: "rscid=mock-connect-session",
      })
      const recording = readRecording(output)
      expect(recording.props.targetType).toBe(ServerType.RSC)
      expect(recording.props.rscApiKeyRequired).toBe(true)
      expect(recording.events.map((event) => event.type)).toContain("REQ_HOME")
      expect(recording.events.map((event) => event.type)).toContain("WS_OPEN")
      expect(fs.readFileSync(output, "utf8")).not.toContain(API_KEY)
      expect(logs.mock.calls.flat().join("\n")).not.toContain(API_KEY)
    },
  )

  it.each([null, "invalid-test-key"])(
    "rejects a missing or invalid key (%s) before starting the proxy",
    async (key) => {
      if (key !== null) vi.stubEnv("SHINYLOADTEST_CONNECT_API_KEY", key)
      const start = vi.spyOn(RecordingProxy.prototype, "start")

      await expect(
        record({
          targetUrl: target.url,
          host: "127.0.0.1",
          port: 0,
          output,
          open: false,
        }),
      ).rejects.toMatchObject({
        name: HttpStatusError.name,
        statusCode: 401,
        url: target.url,
      })

      expect(start).not.toHaveBeenCalled()
      expect(target.httpRequests).toHaveLength(1)
      expect(target.httpRequests[0]?.authorization).toBe(
        key === null ? undefined : `Key ${key}`,
      )
      expect(target.wsRequests).toHaveLength(0)
      expect(fs.existsSync(output)).toBe(false)
    },
  )
})
