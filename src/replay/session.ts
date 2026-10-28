/**
 * Session playback module. This is the core event loop that plays back
 * a recorded session against a live Shiny application.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { CookieJar } from "tough-cookie"
import { VERSION } from "../version.js"
import {
  loginUrlFor,
  extractHiddenInputs,
  isProtected,
  loginRSC,
  loginSSP,
  getConnectCookies,
  withConnectApiKey,
} from "../auth.js"
import { detectServerType } from "../detect.js"
import {
  HttpClient,
  validateStatus,
  extractWorkerId,
  extractToken,
  getCookieString,
} from "../http.js"
import type { Logger } from "../logger.js"
import { SessionWriter } from "./output.js"
import { canIgnore, normalizeMessage, parseMessage } from "../sockjs.js"
import { replaceTokens, createTokenDictionary } from "../tokens.js"
import type { Recording, RecordingEvent, Creds } from "../types.js"
import {
  ALLOWED_TOKENS,
  ServerType,
  hasUserPass,
  hasConnectApiKey,
} from "../types.js"
import { joinPaths, httpToWs } from "../url.js"
import { ShinyWebSocket } from "./websocket.js"
import type { DiagnosticContext, ReplayDiagnostics } from "./diagnostics.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_AGENT = `shinyloadtest/${VERSION}`

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export class Stats {
  private running = 0
  private done = 0
  private failed = 0
  private canceled = 0
  private events = 0

  transition(t: "running" | "done" | "failed" | "canceled"): void {
    switch (t) {
      case "running":
        this.running++
        break
      case "done":
        this.done++
        this.running--
        break
      case "failed":
        this.failed++
        this.running--
        break
      case "canceled":
        this.canceled++
        this.running--
        break
    }
  }

  recordEvent(): void {
    this.events++
  }

  getCounts(): {
    running: number
    done: number
    failed: number
    canceled: number
    events: number
  } {
    return {
      running: this.running,
      done: this.done,
      failed: this.failed,
      canceled: this.canceled,
      events: this.events,
    }
  }

  /** Record a failure without decrementing running (for pre-start failures). */
  recordFailure(): void {
    this.failed++
  }

  toString(): string {
    return `Running: ${this.running}, Failed: ${this.failed}, Done: ${this.done}, Canceled: ${this.canceled}, Events: ${this.events}`
  }
}

// ---------------------------------------------------------------------------
// SessionConfig
// ---------------------------------------------------------------------------

export type SessionOutcome = "done" | "failed" | "canceled"

export interface SessionConfig {
  sessionId: number
  workerId: number
  iterationId: number
  httpUrl: string
  recording: Recording
  recordingPath: string
  headers: Record<string, string>
  creds: Creds
  logger: Logger
  outputDir: string
  argsString: string
  argsJson: string
  signal?: AbortSignal
  diagnostics?: ReplayDiagnostics
  /** Called after each recording event is processed. */
  onProgress?: (eventIndex: number, totalEvents: number) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(
  ms: number,
  signal?: AbortSignal,
  failureSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const signals = [signal, failureSignal].filter(
      (value): value is AbortSignal => value !== undefined,
    )
    const aborted = signals.find((value) => value.aborted)
    if (aborted) {
      reject(aborted.reason ?? new Error("Aborted"))
      return
    }
    const cleanup = () => {
      for (const value of signals) value.removeEventListener("abort", onAbort)
    }
    const onAbort = (event: Event) => {
      clearTimeout(timer)
      cleanup()
      reject((event.target as AbortSignal).reason ?? new Error("Aborted"))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    for (const value of signals) {
      value.addEventListener("abort", onAbort, { once: true })
    }
  })
}

function nowMs(): number {
  return Date.now()
}

function sleepBefore(
  event: RecordingEvent,
  lastEventEnded: number | null,
  wsOpen: boolean,
): number {
  switch (event.type) {
    case "WS_SEND":
    case "WS_CLOSE":
      return event.begin - (lastEventEnded ?? event.begin)
    case "REQ_GET":
      return wsOpen ? event.begin - (lastEventEnded ?? event.begin) : 0
    default:
      return 0
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function maybeLogin(
  httpClient: HttpClient,
  httpUrl: string,
  creds: Creds,
  logger: Logger,
  signal?: AbortSignal,
): Promise<void> {
  // Connect API Key takes precedence
  if (hasConnectApiKey(creds)) {
    await getConnectCookies(httpClient, httpUrl, signal)
    return
  }

  if (hasUserPass(creds)) {
    const appProtected = await isProtected(httpClient, httpUrl)
    if (appProtected) {
      const serverType = await detectServerType(httpUrl, httpClient)
      const loginUrl = loginUrlFor(httpUrl, serverType)

      if (serverType === ServerType.RSC) {
        await loginRSC(httpClient, loginUrl, creds.user!, creds.pass!)
      } else {
        // SSP: need to fetch login page for hidden inputs
        const loginPageResp = await httpClient.get(loginUrl)
        const hiddenInputs = extractHiddenInputs(loginPageResp.body)
        await loginSSP(
          httpClient,
          loginUrl,
          creds.user!,
          creds.pass!,
          hiddenInputs,
        )
      }
    } else {
      logger.info(
        "SHINYLOADTEST_USER and SHINYLOADTEST_PASS set, but target app doesn't require authentication.",
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/** Cap receive deadlines and post-skip pacing at 15 minutes. A genuinely
 * longer quiet interval may therefore be skipped rather than waited out. */
const WS_RECV_MAX_GAP_MS = 15 * 60_000

/** Minimum receive wait and slack beyond the recorded quiet interval. */
const WS_RECV_SLACK_MS = 30_000

/** Maximum mismatched messages buffered while looking for one receive. */
const WS_RECV_MISMATCH_LIMIT = 16

interface TimingAnchor {
  recorded: number
  /** Monotonic time, so wall-clock adjustments cannot extend a wait. */
  actual: number
}

// Payload-free receive classification used by timing and diagnostics.
type ReceiveResult = {
  reason: "matched" | "ignored" | "timeout" | "mismatch"
  line: number
}

function remainingRecordedGap(
  event: RecordingEvent,
  anchor: TimingAnchor | null,
): number {
  if (anchor === null) return 0
  const gap = event.begin - anchor.recorded
  const elapsed = performance.now() - anchor.actual
  const boundedGap = Number.isFinite(gap)
    ? Math.min(WS_RECV_MAX_GAP_MS, Math.max(0, gap))
    : 0
  const validElapsed = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
  return Math.max(0, boundedGap - validElapsed)
}

interface SessionState {
  httpClient: HttpClient
  httpUrl: string
  tokenDictionary: Map<string, string>
  commIdMapping: Map<string, string>
  recordingPath: string
  logger: Logger
  webSocket: ShinyWebSocket | null
  failure: Error | null
  failureController: AbortController
  headers: Record<string, string>
  creds: Creds
  signal?: AbortSignal
  diagnostics?: ReplayDiagnostics
  diagnosticContext: DiagnosticContext
  /** Messages received out of order, waiting to be matched by a later WS_RECV. */
  reorderBuffer: string[]
  timingAnchor: TimingAnchor | null
  skippedReceive: boolean
}

function replaceSessionTokens(
  s: string,
  tokenDictionary: ReadonlyMap<string, string>,
): string {
  return replaceTokens(s, ALLOWED_TOKENS, tokenDictionary)
}

async function handleReqHome(
  event: RecordingEvent & { type: "REQ_HOME" },
  state: SessionState,
): Promise<void> {
  const renderedUrl = replaceSessionTokens(event.url, state.tokenDictionary)
  const url = joinPaths(state.httpUrl, renderedUrl)
  const resp = await state.httpClient.get(url, state.signal)
  validateStatus(event.status, resp.statusCode, url, resp.body)

  const workerId = extractWorkerId(resp.body)
  if (workerId !== null) {
    state.tokenDictionary.set("WORKER", workerId)
  }
}

async function handleReqSinf(
  event: RecordingEvent & { type: "REQ_SINF" },
  state: SessionState,
): Promise<void> {
  const renderedUrl = replaceSessionTokens(event.url, state.tokenDictionary)
  const url = joinPaths(state.httpUrl, renderedUrl)
  const resp = await state.httpClient.get(url, state.signal)
  validateStatus(event.status, resp.statusCode, url, resp.body)
}

async function handleReqTok(
  event: RecordingEvent & { type: "REQ_TOK" },
  state: SessionState,
): Promise<void> {
  const renderedUrl = replaceSessionTokens(event.url, state.tokenDictionary)
  const url = joinPaths(state.httpUrl, renderedUrl)
  const resp = await state.httpClient.get(url, state.signal)
  validateStatus(event.status, resp.statusCode, url, resp.body)
  state.tokenDictionary.set("TOKEN", extractToken(resp.body))
}

async function handleReqGet(
  event: RecordingEvent & { type: "REQ_GET" },
  state: SessionState,
): Promise<void> {
  const renderedUrl = replaceSessionTokens(event.url, state.tokenDictionary)
  const url = joinPaths(state.httpUrl, renderedUrl)
  const resp = await state.httpClient.get(url, state.signal)
  validateStatus(event.status, resp.statusCode, url, resp.body)
}

async function handleReqPost(
  event: RecordingEvent & { type: "REQ_POST" },
  state: SessionState,
): Promise<void> {
  const renderedUrl = replaceSessionTokens(event.url, state.tokenDictionary)
  const url = joinPaths(state.httpUrl, renderedUrl)

  let body: string | Buffer | undefined
  let contentType: string | undefined

  if (event.datafile !== undefined) {
    const parentDir = path.dirname(state.recordingPath)
    const filePath = path.resolve(parentDir, event.datafile)
    const realParent = fs.realpathSync(path.resolve(parentDir))
    let realFile: string
    try {
      realFile = fs.realpathSync(filePath)
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new Error(`Datafile not found: ${event.datafile}`)
      }
      throw err
    }
    if (
      !realFile.startsWith(realParent + path.sep) &&
      realFile !== realParent
    ) {
      throw new Error(
        `Datafile path escapes recording directory: ${event.datafile}`,
      )
    }
    body = fs.readFileSync(realFile)
    contentType = "application/octet-stream"
  }

  const resp = await state.httpClient.post(url, body, contentType, state.signal)
  validateStatus(event.status, resp.statusCode, url, resp.body)
}

async function handleWsOpen(
  event: RecordingEvent & { type: "WS_OPEN" },
  state: SessionState,
): Promise<void> {
  if (state.webSocket !== null) {
    throw new Error("Tried to WS_OPEN but already have a websocket")
  }

  const wsBaseUrl = httpToWs(state.httpUrl)
  const renderedUrl = replaceSessionTokens(event.url, state.tokenDictionary)
  const wsUrl = joinPaths(wsBaseUrl, renderedUrl)

  const cookieString = await getCookieString(
    state.httpClient.cookieJar,
    state.httpUrl,
  )

  const wsHeaders: Record<string, string> = {
    ...state.headers,
    "user-agent": USER_AGENT,
  }
  if (cookieString) {
    wsHeaders["cookie"] = cookieString
  }

  const ws = new ShinyWebSocket({
    url: wsUrl,
    headers: wsHeaders,
    diagnostics: state.diagnostics
      ? { writer: state.diagnostics, context: state.diagnosticContext }
      : undefined,
    onIgnored: (msg) => {
      state.logger.debug(`Ignoring: ${msg}`)
    },
  })

  ws.onFailure((error) => {
    state.failure = error
    state.failureController.abort(error)
  })

  state.webSocket = ws
}

/** @internal Exported for testing. */
export function extractCommId(commOpenJson: string): string | null {
  try {
    const obj = JSON.parse(commOpenJson) as Record<string, unknown>
    const content = obj["content"] as Record<string, unknown> | undefined
    return typeof content?.["comm_id"] === "string" ? content["comm_id"] : null
  } catch {
    return null
  }
}

function extractCommIdMapping(
  expectingObj: Record<string, unknown>,
  receivedObj: Record<string, unknown> | null,
  state: SessionState,
): void {
  const expectingCustom = expectingObj["custom"] as
    | Record<string, unknown>
    | undefined
  const receivedCustom = receivedObj?.["custom"] as
    | Record<string, unknown>
    | undefined
  if (expectingCustom == null || receivedCustom == null) return

  const commOpenKey = "shinywidgets_comm_open"
  if (!(commOpenKey in expectingCustom) || !(commOpenKey in receivedCustom))
    return

  const recordedCommId = extractCommId(expectingCustom[commOpenKey] as string)
  const actualCommId = extractCommId(receivedCustom[commOpenKey] as string)
  if (recordedCommId != null && actualCommId != null) {
    state.commIdMapping.set(recordedCommId, actualCommId)
    state.logger.debug(`Mapped comm_id: ${recordedCommId} -> ${actualCommId}`)
  }
}

/** @internal Exported for testing. */
export function replaceCommIds(
  s: string,
  commIdMapping: ReadonlyMap<string, string>,
): string {
  let result = s
  for (const [recorded, actual] of commIdMapping) {
    result = result.replaceAll(recorded, actual)
  }
  return result
}

function handleWsSend(
  event: RecordingEvent & { type: "WS_SEND" },
  state: SessionState,
): void {
  if (state.webSocket === null) {
    throw new Error("Tried to WS_SEND but no websocket is open")
  }
  const tokenReplaced = replaceSessionTokens(
    event.message,
    state.tokenDictionary,
  )
  const text = replaceCommIds(tokenReplaced, state.commIdMapping)
  state.webSocket.send(text)
  state.logger.debug(`WS_SEND sent: ${text}`)
}

/** Parse a raw WS message and return its sorted top-level key string. */
function messageKeys(raw: string): string {
  const obj = parseMessage(normalizeMessage(raw))
  return obj ? Object.keys(obj).sort().join(",") : ""
}

async function handleWsRecv(
  event: RecordingEvent & { type: "WS_RECV" },
  state: SessionState,
): Promise<ReceiveResult> {
  if (state.webSocket === null) {
    throw new Error("Tried to WS_RECV but no websocket is open")
  }

  // Skip WS_RECV events whose expected message would now be filtered by
  // canIgnore. This handles recordings made before canIgnore was updated
  // (e.g. Shiny for Python empty updates with object-typed errors/values).
  if (canIgnore(normalizeMessage(event.message))) {
    state.logger.debug(
      `WS_RECV line ${event.lineNumber}: expected message is now ignorable, skipping`,
    )
    return { reason: "ignored", line: event.lineNumber }
  }

  const expectingStr = replaceSessionTokens(
    event.message,
    state.tokenDictionary,
  )
  const expectingObj = parseMessage(expectingStr)

  if (expectingObj === null) {
    // String comparison (e.g. the "o" open frame) — must match exactly.
    const receivedStr = await receiveNext(event, state)
    if (expectingStr !== receivedStr) {
      throw new Error(`Expected string ${expectingStr} but got ${receivedStr}`)
    }
    return { reason: "matched", line: event.lineNumber }
  }

  const expectingKeys = Object.keys(expectingObj).sort().join(",")

  // 1. Check the reorder buffer for an already-received matching message.
  const bufIdx = state.reorderBuffer.findIndex(
    (msg) => messageKeys(msg) === expectingKeys,
  )
  if (bufIdx !== -1) {
    const matched = state.reorderBuffer.splice(bufIdx, 1)[0]!
    state.logger.debug(`WS_RECV matched from reorder buffer: ${matched}`)
    const receivedObj = parseMessage(normalizeMessage(matched))
    extractCommIdMapping(expectingObj, receivedObj, state)
    return { reason: "matched", line: event.lineNumber }
  }

  // One deadline covers all polls, including after mismatched messages.
  const timeoutMs = Math.min(
    WS_RECV_MAX_GAP_MS,
    Math.max(
      WS_RECV_SLACK_MS,
      remainingRecordedGap(event, state.timingAnchor) + WS_RECV_SLACK_MS,
    ),
  )
  const deadline = performance.now() + timeoutMs
  let mismatches = 0
  while (mismatches < WS_RECV_MISMATCH_LIMIT) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    const msg = await state.webSocket.receiveQueue.poll(remaining, state.signal)

    if (state.signal?.aborted) throw state.signal.reason ?? new Error("Aborted")
    if (msg === null) break
    if (msg.kind === "error") throw msg.error

    const receivedStr = msg.text
    state.logger.debug(`WS_RECV received: ${receivedStr}`)
    const receivedKeys = messageKeys(receivedStr)

    if (expectingKeys === receivedKeys) {
      const receivedObj = parseMessage(normalizeMessage(receivedStr))
      extractCommIdMapping(expectingObj, receivedObj, state)
      return { reason: "matched", line: event.lineNumber }
    }

    state.reorderBuffer.push(receivedStr)
    mismatches++
    state.logger.debug(
      `WS_RECV reorder: buffered [${receivedKeys}], looking for [${expectingKeys}]`,
    )
  }

  if (mismatches === 0) {
    state.logger.warn(
      `WS_RECV line ${event.lineNumber}: no message received after ${timeoutMs / 1000}s, skipping`,
    )
    return { reason: "timeout", line: event.lineNumber }
  }

  state.logger.warn(
    `WS_RECV line ${event.lineNumber}: expected [${expectingKeys}] but no match found after lookahead, continuing`,
  )
  return { reason: "mismatch", line: event.lineNumber }
}

/** Receive the next non-ignorable message from the WebSocket. */
async function receiveNext(
  event: RecordingEvent & {
    type: "WS_RECV" | "WS_RECV_INIT" | "WS_RECV_BEGIN_UPLOAD"
  },
  state: SessionState,
): Promise<string> {
  const receivedStr = await state.webSocket!.receive((elapsed) => {
    state.logger.warn(
      `${event.type} line ${event.lineNumber}: Haven't received message after ${elapsed} seconds`,
    )
  }, state.signal)
  state.logger.debug(`${event.type} received: ${receivedStr}`)
  return receivedStr
}

async function handleWsRecvInit(
  event: RecordingEvent & { type: "WS_RECV_INIT" },
  state: SessionState,
): Promise<void> {
  if (state.webSocket === null) {
    throw new Error("Tried to WS_RECV_INIT but no websocket is open")
  }

  const receivedStr = await state.webSocket.receive((elapsed) => {
    state.logger.warn(
      `WS_RECV_INIT line ${event.lineNumber}: Haven't received message after ${elapsed} seconds`,
    )
  }, state.signal)
  state.logger.debug(`WS_RECV_INIT received: ${receivedStr}`)

  const parsed = parseMessage(receivedStr)
  const sessionId = (
    parsed?.["config"] as Record<string, unknown> | undefined
  )?.["sessionId"]

  if (typeof sessionId !== "string") {
    throw new Error(
      `Expected sessionId from WS_RECV_INIT message. Message: ${receivedStr}`,
    )
  }

  state.tokenDictionary.set("SESSION", sessionId)
  state.logger.debug(`WS_RECV_INIT got SESSION: ${sessionId}`)
}

async function handleWsRecvBeginUpload(
  event: RecordingEvent & { type: "WS_RECV_BEGIN_UPLOAD" },
  state: SessionState,
): Promise<void> {
  if (state.webSocket === null) {
    throw new Error("Tried to WS_RECV_BEGIN_UPLOAD but no websocket is open")
  }

  const receivedStr = await state.webSocket.receive((elapsed) => {
    state.logger.warn(
      `WS_RECV_BEGIN_UPLOAD line ${event.lineNumber}: Haven't received message after ${elapsed} seconds`,
    )
  }, state.signal)
  state.logger.debug(`WS_RECV_BEGIN_UPLOAD received: ${receivedStr}`)

  const parsed = parseMessage(receivedStr)
  const response = parsed?.["response"] as Record<string, unknown> | undefined
  const value = response?.["value"] as Record<string, unknown> | undefined
  const jobId = value?.["jobId"]

  if (typeof jobId !== "string") {
    throw new Error("Expected jobId from WS_RECV_BEGIN_UPLOAD message")
  }

  state.tokenDictionary.set("UPLOAD_JOB_ID", jobId)
  state.logger.debug(`WS_RECV_BEGIN_UPLOAD got jobId: ${jobId}`)
}

function handleWsClose(
  _event: RecordingEvent & { type: "WS_CLOSE" },
  state: SessionState,
): void {
  if (state.webSocket === null) {
    throw new Error("Tried to WS_CLOSE but no websocket is open")
  }
  state.webSocket.close()
  state.logger.debug("WS_CLOSE sent")
  state.webSocket = null
}

async function handleEvent(
  event: RecordingEvent,
  state: SessionState,
): Promise<ReceiveResult | void> {
  switch (event.type) {
    case "REQ_HOME":
      return handleReqHome(event, state)
    case "REQ_SINF":
      return handleReqSinf(event, state)
    case "REQ_TOK":
      return handleReqTok(event, state)
    case "REQ_GET":
      return handleReqGet(event, state)
    case "REQ_POST":
      return handleReqPost(event, state)
    case "WS_OPEN":
      return handleWsOpen(event, state)
    case "WS_SEND":
      handleWsSend(event, state)
      return
    case "WS_RECV":
      return handleWsRecv(event, state)
    case "WS_RECV_INIT":
      return handleWsRecvInit(event, state)
    case "WS_RECV_BEGIN_UPLOAD":
      return handleWsRecvBeginUpload(event, state)
    case "WS_CLOSE":
      handleWsClose(event, state)
      return
  }
}

// ---------------------------------------------------------------------------
// runSession
// ---------------------------------------------------------------------------

export async function runSession(
  config: SessionConfig,
  stats: Stats,
  startDelayMs?: number,
): Promise<SessionOutcome> {
  const {
    sessionId,
    workerId,
    iterationId,
    httpUrl,
    recording,
    recordingPath,
    creds,
    logger,
    outputDir,
    argsString,
    argsJson,
  } = config
  const signal = config.signal
  const diagnostics = config.diagnostics
  const diagnosticContext = { sessionId, workerId, iterationId }

  const cookieJar = new CookieJar()
  const tokenDictionary = createTokenDictionary()

  // Authenticate the cookie bootstrap as well as recorded requests.
  const headers = withConnectApiKey(config.headers, creds.connectApiKey)

  const httpClient = new HttpClient({
    cookieJar,
    headers,
    userAgent: USER_AGENT,
    diagnostics: diagnostics
      ? { writer: diagnostics, context: diagnosticContext }
      : undefined,
  })

  const writer = new SessionWriter({
    outputDir,
    sessionId,
    workerId,
    iterationId,
    argsString,
    argsJson,
  })

  const state: SessionState = {
    httpClient,
    httpUrl,
    tokenDictionary,
    commIdMapping: new Map(),
    recordingPath,
    logger,
    webSocket: null,
    failure: null,
    failureController: new AbortController(),
    headers,
    creds,
    signal,
    diagnostics,
    diagnosticContext,
    reorderBuffer: [],
    timingAnchor: null,
    skippedReceive: false,
  }

  let started = false
  let outcome: SessionOutcome = "failed"
  const receiveCounts = {
    wsRecvMatched: 0,
    wsRecvIgnored: 0,
    wsRecvTimeout: 0,
    wsRecvMismatch: 0,
  }
  diagnostics?.emit({ type: "session_start", ...diagnosticContext })

  try {
    writer.writeCsv(
      sessionId,
      workerId,
      iterationId,
      "PLAYER_SESSION_CREATE",
      nowMs(),
      0,
      "",
    )

    // Login if needed
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted")
    await maybeLogin(httpClient, httpUrl, creds, logger, signal)
    httpClient.setDiagnosticPhase("playback")

    // Start delay
    if (startDelayMs !== undefined && startDelayMs > 0) {
      writer.writeCsv(
        sessionId,
        workerId,
        iterationId,
        "PLAYBACK_START_INTERVAL_START",
        nowMs(),
        0,
        "",
      )
      await sleep(startDelayMs, signal)
      writer.writeCsv(
        sessionId,
        workerId,
        iterationId,
        "PLAYBACK_START_INTERVAL_END",
        nowMs(),
        0,
        "",
      )
    }

    stats.transition("running")
    started = true

    let lastEventEnded: number | null = null
    const totalEvents = recording.events.length
    let eventIndex = 0

    for (const event of recording.events) {
      const needsResidualPacing =
        state.skippedReceive &&
        (event.type === "WS_SEND" ||
          event.type === "WS_CLOSE" ||
          (event.type === "REQ_GET" && state.webSocket !== null))
      const sleepFor = needsResidualPacing
        ? remainingRecordedGap(event, state.timingAnchor)
        : sleepBefore(event, lastEventEnded, state.webSocket !== null)

      if (sleepFor > 0) {
        writer.writeCsv(
          sessionId,
          workerId,
          iterationId,
          "PLAYBACK_SLEEPBEFORE_START",
          nowMs(),
          event.lineNumber,
          "",
        )
        await sleep(sleepFor, signal, state.failureController.signal)
        writer.writeCsv(
          sessionId,
          workerId,
          iterationId,
          "PLAYBACK_SLEEPBEFORE_END",
          nowMs(),
          event.lineNumber,
          "",
        )
      }

      // Check for async failure (e.g. WebSocket error during sleep)
      if (state.failure !== null) {
        throw state.failure
      }

      if (signal?.aborted) {
        throw signal.reason ?? new Error("Aborted")
      }

      // Handle the event with START/END logging
      writer.writeCsv(
        sessionId,
        workerId,
        iterationId,
        `${event.type}_START`,
        nowMs(),
        event.lineNumber,
        "",
      )

      const handlerStartedAt = performance.now()
      const receiveResult = await handleEvent(event, state)
      const handlerEndedAt = performance.now()
      if (receiveResult && receiveResult.reason !== "matched") {
        const reason = receiveResult.reason
        if (reason === "ignored") receiveCounts.wsRecvIgnored++
        else if (reason === "timeout") receiveCounts.wsRecvTimeout++
        else receiveCounts.wsRecvMismatch++
        diagnostics?.emit({
          type: "ws_recv_skipped",
          ...diagnosticContext,
          inputLineNumber: receiveResult.line,
          reason,
        })
        state.skippedReceive = true
      } else {
        if (receiveResult) receiveCounts.wsRecvMatched++
        state.timingAnchor = {
          recorded: event.begin,
          // Recorded receives represent arrivals; other event timestamps mark
          // handler starts, so their execution time counts toward the gap.
          actual:
            event.type === "WS_RECV" ||
            event.type === "WS_RECV_INIT" ||
            event.type === "WS_RECV_BEGIN_UPLOAD"
              ? handlerEndedAt
              : handlerStartedAt,
        }
        state.skippedReceive = false
      }
      stats.recordEvent()
      config.onProgress?.(++eventIndex, totalEvents)

      writer.writeCsv(
        sessionId,
        workerId,
        iterationId,
        `${event.type}_END`,
        nowMs(),
        event.lineNumber,
        "",
      )

      lastEventEnded = event.begin

      // Check for async failure after event handling
      if (state.failure !== null) {
        throw state.failure
      }
    }

    stats.transition("done")
    writer.writeCsv(
      sessionId,
      workerId,
      iterationId,
      "PLAYBACK_DONE",
      nowMs(),
      0,
      "",
    )
    outcome = "done"
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    const aborted =
      signal?.aborted === true &&
      (error.name === "AbortError" || signal.reason === err)
    if (aborted) {
      outcome = "canceled"
      // Graceful shutdown — don't count as failure
      if (started) {
        stats.transition("canceled")
      }
      writer.writeCsv(
        sessionId,
        workerId,
        iterationId,
        "PLAYBACK_CANCEL",
        nowMs(),
        0,
        "",
      )
      logger.info("Playback cancelled (shutdown)")
    } else {
      if (started) {
        stats.transition("failed")
      } else {
        // Failed before entering "running" state — record failure without
        // decrementing the running counter.
        stats.recordFailure()
      }
      writer.writeCsv(
        sessionId,
        workerId,
        iterationId,
        "PLAYBACK_FAIL",
        nowMs(),
        0,
        "",
      )
      const failurePhase = started ? "" : "Session setup: "
      logger.error(`Playback failed: ${failurePhase}${error.message}`, error)
    }
  } finally {
    if (state.webSocket !== null) {
      try {
        state.webSocket.close()
      } catch {
        /* ignore close errors */
      }
      state.webSocket = null
    }
    writer.close()
    diagnostics?.emit({
      type: "session_end",
      ...diagnosticContext,
      outcome,
      ...receiveCounts,
    })
  }
  return outcome
}
