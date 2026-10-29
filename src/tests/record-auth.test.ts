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
import { withTeardown, withTimeout } from "./helpers/teardown.js"

const API_KEY = "record-auth-test-key"
const AUTH_ENV_VARS = [
  "SHINYLOADTEST_CONNECT_API_KEY",
  "SHINYCANNON_CONNECT_API_KEY",
  "SHINYLOADTEST_USER",
  "SHINYLOADTEST_PASS",
  "SHINYCANNON_USER",
  "SHINYCANNON_PASS",
]

const RECORDING_STEP_TIMEOUT_MS = 5_000

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
  return withTeardown(
    async () => {
      proxy = await withTimeout(
        Promise.race([
          proxyReady,
          outcome.then(({ error }) => {
            throw error ?? new Error("Recording exited before startup")
          }),
        ]),
        RECORDING_STEP_TIMEOUT_MS,
        "Recording proxy startup",
      )
      const port = (proxy.httpServer!.address() as AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(RECORDING_STEP_TIMEOUT_MS),
      })
      await response.text()

      ws = new WebSocket(`ws://127.0.0.1:${port}/websocket`)
      // once() rejects connection errors; this listener also covers cleanup.
      ws.on("error", () => {})
      await withTimeout(
        once(ws, "message"),
        RECORDING_STEP_TIMEOUT_MS,
        "Recorded WebSocket message",
      )
      const closed = once(ws, "close")
      ws.close()
      await withTimeout(
        closed,
        RECORDING_STEP_TIMEOUT_MS,
        "Recorded WebSocket close",
      )
      const result = await withTimeout(
        outcome,
        RECORDING_STEP_TIMEOUT_MS,
        "Recording completion",
      )
      if (result.error !== null) throw result.error
      return response.status
    },
    async () => {
      ws?.terminate()
      if (proxy && !finished) {
        proxy.onShutdown()
        await withTimeout(
          outcome,
          RECORDING_STEP_TIMEOUT_MS,
          "Recording shutdown",
        )
      }
    },
    { operation: "Recording teardown" },
  )
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
