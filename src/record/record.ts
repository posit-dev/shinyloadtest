import { execFile } from "node:child_process"
import * as readline from "node:readline"
import { CookieJar } from "tough-cookie"
import { VERSION } from "../version.js"
import { ServerType, SERVER_TYPE_NAMES } from "../types.js"
import { HttpClient } from "../http.js"
import { detectServerType } from "../detect.js"
import {
  isProtected,
  loginRSC,
  loginSSP,
  loginUrlFor,
  extractHiddenInputs,
  getCreds,
  connectApiKeyHeader,
} from "../auth.js"
import { RecordingWriter } from "./writer.js"
import { RecordingTokens } from "./tokens.js"
import { RecordingProxy } from "./proxy.js"
import { RecordTerminalUI } from "./ui.js"

export interface RecordOptions {
  readonly targetUrl: string
  readonly port: number
  readonly host: string
  readonly output: string
  readonly open: boolean
}

export async function record(options: RecordOptions): Promise<void> {
  const { targetUrl, port, host, output, open } = options

  const ui = process.stderr.isTTY ? new RecordTerminalUI() : undefined

  // Validate target URL
  let parsedUrl: URL
  try {
    parsedUrl = new URL(targetUrl)
  } catch {
    throw new Error(`Invalid target URL: ${targetUrl}`)
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Target URL must use http or https: ${targetUrl}`)
  }

  // Set up HTTP client for detection and auth
  const cookieJar = new CookieJar()
  const httpClient = new HttpClient({
    cookieJar,
    headers: {},
    userAgent: `shinyloadtest/${VERSION}`,
  })

  try {
    // Detect server type
    ui?.startDetecting()
    const serverType = await detectServerType(targetUrl, httpClient)
    const serverTypeName = SERVER_TYPE_NAMES.get(serverType) ?? serverType
    ui?.detectedServerType(serverTypeName)
    if (!ui) console.error(`Target type: ${serverTypeName}`)

    // Reject shinyapps.io
    if (serverType === ServerType.SAI) {
      ui?.cleanup()
      throw new Error("Recording shinyapps.io applications is not supported.")
    }

    // RSC fragment check
    if (serverType === ServerType.RSC && targetUrl.includes("#")) {
      ui?.cleanup()
      throw new Error(
        "The app URL contains a '#' fragment. For Posit Connect, use the " +
          "content URL (solo mode) instead of the dashboard URL.",
      )
    }

    // Authentication
    const creds = getCreds()
    let authHeaders: Record<string, string> = {}
    let rscApiKeyRequired = false

    if (creds.connectApiKey !== null) {
      ui?.startAuthenticating("Connect API key")
      authHeaders = connectApiKeyHeader(creds.connectApiKey)
      rscApiKeyRequired = true
      ui?.authenticated("Posit Connect")
      if (!ui) console.error("Logged in to Posit Connect")
    } else if (await isProtected(httpClient, targetUrl)) {
      let username = creds.user
      let password = creds.pass

      if (username === null || password === null) {
        ui?.cleanup()
        console.error("The application requires authentication.")
        const prompted = await promptCredentials()
        username = prompted.username
        password = prompted.password
      }

      const loginUrl = loginUrlFor(targetUrl, serverType)

      if (serverType === ServerType.RSC) {
        ui?.startAuthenticating("username/password")
        await loginRSC(httpClient, loginUrl, username, password)
        ui?.authenticated("Posit Connect")
        if (!ui) console.error("Logged in to Posit Connect")
      } else if (serverType === ServerType.SSP) {
        ui?.startAuthenticating("username/password")
        const loginPage = await httpClient.get(loginUrl)
        const hiddenInputs = extractHiddenInputs(loginPage.body)
        await loginSSP(httpClient, loginUrl, username, password, hiddenInputs)
        ui?.authenticated("Shiny Server Pro")
        if (!ui) console.error("Logged in to Shiny Server Pro")
      }
    }

    // Create recording writer
    const writer = new RecordingWriter({
      outputPath: output,
      targetUrl,
      targetType: serverType,
      rscApiKeyRequired,
    })

    // Create recording tokens
    const tokens = new RecordingTokens()

    // Create and start proxy
    const startTime = Date.now()
    let shutdownResolve: (() => void) | null = null
    const shutdownPromise = new Promise<void>((resolve) => {
      shutdownResolve = resolve
    })

    const proxy = new RecordingProxy({
      targetUrl,
      host,
      port,
      writer,
      tokens,
      cookieJar,
      authHeaders,
      onFirstConnection: () => {
        ui?.startRecording(() => writer.eventCount)
      },
      onShutdown: () => {
        ui?.stopRecording()
        if (!ui) console.error("Client disconnected. Stopping recording.")
        shutdownResolve?.()
      },
    })

    await proxy.start()

    const proxyUrl = `http://${host}:${port}`

    ui?.showBanner({ version: VERSION, targetUrl, proxyUrl, output })
    ui?.startWaiting(proxyUrl)
    if (!ui) {
      console.error(`Proxy URL: ${proxyUrl}`)
      console.error(`Output: ${output}`)
      console.error(
        `Navigate your browser to the proxy URL to begin recording: ${proxyUrl}`,
      )
    }

    // Open browser if requested
    if (open) {
      openBrowser(proxyUrl)
    }

    // Handle Ctrl+C
    const handleSignal = (): void => {
      ui?.stopRecording()
      if (!ui) console.error("Interrupted. Stopping recording.")
      shutdownResolve?.()
    }
    process.on("SIGINT", handleSignal)
    process.on("SIGTERM", handleSignal)

    // Wait for shutdown
    await shutdownPromise

    // Clean up
    process.removeListener("SIGINT", handleSignal)
    process.removeListener("SIGTERM", handleSignal)

    await proxy.stop()
    writer.close()

    ui?.finish({
      output,
      eventCount: writer.eventCount,
      postFileCount: writer.postFileCount_,
      duration: Date.now() - startTime,
    })
    if (!ui) {
      console.error(`Recording saved to: ${output}`)
      if (writer.postFileCount_ > 0) {
        console.error(
          `Note: ${writer.postFileCount_} POST file(s) saved alongside the recording.`,
        )
      }
    }
  } finally {
    ui?.cleanup()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function promptCredentials(): Promise<{
  username: string
  password: string
}> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer))
    })

  const questionHidden = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      const stdin = process.stdin
      const wasTTY = stdin.isTTY && typeof stdin.setRawMode === "function"
      if (wasTTY) stdin.setRawMode(true)
      process.stderr.write(prompt)

      let input = ""
      const onData = (ch: Buffer): void => {
        const c = ch.toString()
        if (c === "\n" || c === "\r") {
          if (wasTTY) stdin.setRawMode(false)
          stdin.removeListener("data", onData)
          process.stderr.write("\n")
          resolve(input)
        } else if (c === "\u0003") {
          // Ctrl+C
          if (wasTTY) stdin.setRawMode(false)
          stdin.removeListener("data", onData)
          resolve("")
        } else if (c === "\u007f" || c === "\b") {
          input = input.slice(0, -1)
        } else {
          input += c
        }
      }
      stdin.resume()
      stdin.on("data", onData)
    })

  try {
    const username = await question("Username: ")
    const password = await questionHidden("Password: ")

    if (!username || !password) {
      throw new Error("Login aborted (credentials not provided).")
    }

    return { username, password }
  } finally {
    rl.close()
  }
}

function openBrowser(url: string): void {
  const platform = process.platform
  let cmd: string
  let args: string[]
  if (platform === "darwin") {
    cmd = "open"
    args = [url]
  } else if (platform === "win32") {
    cmd = "cmd"
    args = ["/c", "start", "", url]
  } else {
    cmd = "xdg-open"
    args = [url]
  }
  execFile(cmd, args, (err) => {
    if (err) {
      console.error(`Could not open browser: ${err.message}`)
    }
  })
}
