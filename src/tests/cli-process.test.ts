import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { MockShinyServer } from "./helpers/mock-shiny-server.js"
import { withTeardown } from "./helpers/teardown.js"
import { REDACTED_HEADER_VALUE } from "../cli.js"

const MAIN_JS = path.resolve("dist/main.mjs")
const FAKE_URL = "http://127.0.0.1:65535"

// Keep inherited credentials out of CLI tests without changing the parent env.
const CONNECT_ENV_VARS = [
  "SHINYLOADTEST_CONNECT_API_KEY",
  "SHINYCANNON_CONNECT_API_KEY",
  "SHINYLOADTEST_USER",
  "SHINYCANNON_USER",
  "SHINYLOADTEST_PASS",
  "SHINYCANNON_PASS",
] as const

// Minimal valid recording content
const RECORDING_CONTENT = [
  "# version: 1",
  "# target_url: http://localhost:3838",
  "# target_type: R/Shiny",
  '{"type":"WS_OPEN","begin":"2020-01-01T00:00:00.000Z","url":"/websocket"}',
  '{"type":"WS_CLOSE","begin":"2020-01-01T00:00:01.000Z"}',
].join("\n")

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

function buildCliEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of CONNECT_ENV_VARS) {
    delete env[key]
  }
  return { ...env, ...overrides }
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs: number = 8000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [MAIN_JS, ...args],
      { timeout: timeoutMs, env: buildCliEnv(env) },
      (error, stdout, stderr) => {
        const exitCode =
          error && "code" in error && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0
        resolve({ exitCode, stdout, stderr })
      },
    )
  })
}

/** Recursively collect the text contents of every file under dir. */
function collectFileContents(dir: string): string[] {
  const contents: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      contents.push(...collectFileContents(full))
    } else {
      contents.push(fs.readFileSync(full, "utf-8"))
    }
  }
  return contents
}

let tempDir: string
let recordingPath: string

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shinyloadtest-test-"))
  recordingPath = path.join(tempDir, "recording.log")
  fs.writeFileSync(recordingPath, RECORDING_CONTENT, "utf-8")
})

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("CLI Process", () => {
  // CLI-01: --help (root)
  it("--help exits 0 and lists subcommands", async () => {
    const result = await runCli(["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage/i)
    expect(result.stdout).toContain("replay")
  }, 10000)

  // CLI-01: replay --help
  it("replay --help exits 0 and shows replay usage", async () => {
    const result = await runCli(["replay", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage/i)
    expect(result.stdout).toContain("--workers")
    expect(result.stdout).toContain("--loaded-duration-minutes")
  }, 10000)

  // CLI-02: --version
  it("--version exits 0 and prints version", async () => {
    const result = await runCli(["--version"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  }, 10000)

  // CLI-02: -V (short form)
  it("-V exits 0 and prints version", async () => {
    const result = await runCli(["-V"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  }, 10000)

  // CLI-04: --workers 0
  it("--workers 0 exits non-zero with error", async () => {
    const result = await runCli([
      "replay",
      recordingPath,
      FAKE_URL,
      "--workers",
      "0",
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain("error")
  }, 10000)

  // CLI-04: --workers abc
  it("--workers abc exits non-zero with error", async () => {
    const result = await runCli([
      "replay",
      recordingPath,
      FAKE_URL,
      "--workers",
      "abc",
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain("error")
  }, 10000)

  // CLI-04: --workers 1.5
  it("--workers 1.5 exits non-zero with error", async () => {
    const result = await runCli([
      "replay",
      recordingPath,
      FAKE_URL,
      "--workers",
      "1.5",
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain("error")
  }, 10000)

  // CLI-16: non-existent recording file
  it("non-existent recording exits non-zero with 'not found'", async () => {
    const result = await runCli([
      "replay",
      path.join(tempDir, "does-not-exist.log"),
      FAKE_URL,
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain("not found")
  }, 10000)

  // CLI-17: app-url is optional — resolved from recording's target_url
  // (The process will exit non-zero because the target_url is unreachable,
  // but the error should NOT be about missing arguments.)
  it("omitting app-url resolves from recording target_url", async () => {
    const result = await runCli([
      "replay",
      recordingPath,
      "--output-dir",
      path.join(tempDir, "output"),
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).not.toMatch(/missing.*argument/i)
  }, 10000)

  // CLI-18: no arguments shows help
  it("no arguments exits 0 and shows help", async () => {
    const result = await runCli([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage/i)
    expect(result.stdout).toContain("replay")
  }, 10000)

  // CLI-19: `replay` with no arguments shows replay help
  it("replay with no arguments exits 0 and shows replay help", async () => {
    const result = await runCli(["replay"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage/i)
    expect(result.stdout).toContain("--workers")
    expect(result.stdout).toContain("recording")
  }, 10000)
})

// ---------------------------------------------------------------------------
// Replay against a login-protected Posit Connect mock (GitHub #7)
// ---------------------------------------------------------------------------

const FAKE_API_KEY = "slt-fake-connect-key-9876543210abcdef"
const CUSTOM_HEADER_VALUE = "retained-by-cli"

function replayArgs(
  recordingPath: string,
  appUrl: string,
  outputDir: string,
): string[] {
  return [
    "replay",
    recordingPath,
    appUrl,
    "--workers",
    "1",
    "--loaded-duration-minutes",
    "0.01",
    "--start-interval",
    "0",
    "--max-errors",
    "1",
    "-H",
    `X-Test: ${CUSTOM_HEADER_VALUE}`,
    "-H",
    "authorization: Bearer superseded",
    "--output-dir",
    outputDir,
    "--debug-log",
    "--log-level",
    "debug",
  ]
}

describe.each(["SHINYLOADTEST_CONNECT_API_KEY", "SHINYCANNON_CONNECT_API_KEY"])(
  "CLI Process replay with Connect API key (%s)",
  (envVar) => {
    it("replays a login-protected Connect app successfully", async () => {
      const mock = new MockShinyServer({ connectApiKey: FAKE_API_KEY })
      await mock.start()

      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "shinyloadtest-replay-cli-"),
      )
      await withTeardown(
        async () => {
          const recordingPath = path.join(tmpDir, "recording.log")
          fs.writeFileSync(recordingPath, mock.makeRecording(), "utf-8")
          const outputDir = path.join(tmpDir, "output")

          const result = await runCli(
            replayArgs(recordingPath, mock.url, outputDir),
            { [envVar]: FAKE_API_KEY },
            60000,
          )

          expect(result.exitCode).toBe(0)

          expect(mock.httpRequests.length).toBeGreaterThan(0)
          for (const headers of mock.httpRequests) {
            expect(headers).toMatchObject({
              authorization: `Key ${FAKE_API_KEY}`,
              "x-test": CUSTOM_HEADER_VALUE,
            })
          }

          expect(mock.wsRequests.length).toBeGreaterThanOrEqual(1)
          for (const headers of mock.wsRequests) {
            expect(headers).toMatchObject({
              authorization: `Key ${FAKE_API_KEY}`,
              "x-test": CUSTOM_HEADER_VALUE,
            })
            expect(headers.cookie).toContain("rscid=mock-connect-session")
          }

          const sessionsDir = path.join(outputDir, "sessions")
          const csvNames = fs
            .readdirSync(sessionsDir)
            .filter((name) => name.endsWith(".csv"))
          expect(csvNames.length).toBeGreaterThan(0)
          const csvs = csvNames.map((name) =>
            fs.readFileSync(path.join(sessionsDir, name), "utf-8"),
          )
          expect(csvs.join("\n")).toContain("PLAYBACK_DONE")
          // The metadata comments keep the benign header but never the
          // credential-bearing one (see the session CSV regression tests).
          expect(csvs.join("\n")).toContain('-H "X-Test: retained-by-cli"')
          expect(csvs.join("\n")).toContain(
            `-H "authorization: ${REDACTED_HEADER_VALUE}"`,
          )

          const allOutput = [
            ...collectFileContents(outputDir),
            result.stdout,
            result.stderr,
          ].join("\n")
          expect(allOutput).not.toContain(FAKE_API_KEY)
          expect(allOutput).not.toContain("Bearer superseded")
        },
        async () => {
          await mock.stop()
          fs.rmSync(tmpDir, { recursive: true, force: true })
        },
      )
    }, 60000)
  },
)

describe("CLI Process replay with invalid Connect API key", () => {
  it("fails at preflight with HTTP 401 and never opens a WebSocket", async () => {
    const mock = new MockShinyServer({ connectApiKey: "correct-mock-key" })
    await mock.start()

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "shinyloadtest-invalid-key-"),
    )
    await withTeardown(
      async () => {
        const recordingPath = path.join(tmpDir, "recording.log")
        fs.writeFileSync(recordingPath, mock.makeRecording(), "utf-8")
        const outputDir = path.join(tmpDir, "output")

        const result = await runCli(
          replayArgs(recordingPath, mock.url, outputDir),
          { SHINYLOADTEST_CONNECT_API_KEY: "wrong-key-value" },
          60000,
        )

        expect(result.exitCode).not.toBe(0)

        expect(mock.httpRequests).toHaveLength(1)
        expect(mock.httpRequests[0]?.authorization).toMatch(/^Key /)
        expect(result.stderr).toContain("HTTP 401")
        expect(mock.wsRequests).toHaveLength(0)
      },
      async () => {
        await mock.stop()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      },
    )
  }, 60000)
})
