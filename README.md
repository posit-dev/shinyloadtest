# shinyloadtest

A load-testing tool for [Shiny](https://shiny.posit.co/) applications.
shinyloadtest records a user session and replays it with concurrent workers
to measure application performance under load.

## Installation

Requires **Node.js 20+**.

Install globally via npm:

```bash
npm install -g shinyloadtest
```

Or run directly with npx:

```bash
npx shinyloadtest --help
```

## Quick Start

```bash
# 1. Record a session against a running Shiny app
shinyloadtest record https://example.com/app

# 2. Interact with the app in the browser at the printed proxy URL,
#    then close the browser tab to stop recording.

# 3. Replay the recording with multiple concurrent users
shinyloadtest replay recording.log https://example.com/app --workers 5

# 4. Generate a performance report
shinyloadtest report
```

## Recording

```bash
shinyloadtest record <app-url> [options]
```

Starts a local reverse proxy that sits between your browser and the Shiny
application. All HTTP and WebSocket traffic is captured to a recording file.
Navigate to the proxy URL printed on startup, interact with the app as a
typical user would, then close the browser tab (or press Ctrl+C) to stop.

### Record Options

| Option | Description |
|--------|-------------|
| `--port <n>` | Local proxy port (default: `8600`) |
| `--host <host>` | Local proxy host (default: `127.0.0.1`) |
| `--output <file>` | Output recording file (default: `recording.log`) |
| `--open` | Open browser automatically |

## Replay

```bash
shinyloadtest replay <recording> [app-url] [options]
```

Replays a recorded session with one or more concurrent workers. If `app-url`
is omitted, the target URL from the recording file is used.

### Replay Options

| Option | Description |
|--------|-------------|
| `--workers <n>` | Number of concurrent workers (default: 1) |
| `--loaded-duration-minutes <n>` | Minutes to maintain load after warmup (default: 5) |
| `--start-interval <ms>` | Milliseconds between starting workers (default: recording duration / workers) |
| `-H, --header <header>` | Custom HTTP header, repeatable |
| `--output-dir <dir>` | Directory for session logs |
| `--overwrite-output` | Overwrite existing output directory |
| `--max-errors <n>` | Stop the test after this many cumulative session failures (0 to disable, default: workers * 5) |
| `--debug-log` | Write verbose debug log |
| `--diagnostics` | Write a credential-free diagnostics event log (`diagnostics.jsonl`) to the output directory (default: off) |
| `--log-level <level>` | Console log level: `debug`, `info`, `warn`, `error` (default: `warn`) |

When a session fails, its worker waits before the next attempt: about 1s
after the first failure, doubling per consecutive failure up to 30s, with
±25% jitter so workers that fail together don't retry in lockstep. A
successful session resets the delay. Waiting workers are not active app
sessions: the requested worker count is not proof of achieved concurrency
when sessions are failing. This changes failure traffic compared to earlier
alphas, which retried immediately; it reduces request
amplification during failures but is not a fix for any particular
server-side cause, so a baseline run with an earlier version can still be
informative when reproducing an older report.

### Diagnostics

`--diagnostics` writes `diagnostics.jsonl` to the output directory: one JSON
object per line, each with `schemaVersion`, `timestamp` (Unix time in
milliseconds), and `type` plus only the allowlisted fields for that event
type. Durations and retry delays are also in milliseconds. The events cover the session
lifecycle (`session_start`; `session_end` with a `done`/`failed`/`canceled`
outcome), HTTP requests split into `bootstrap` (authentication/session setup) and
`playback` phases with method, status code, and duration, and an `aborted`
flag on errors; the WebSocket lifecycle (`ws_created`, `ws_open`,
`ws_close_requested`, `ws_error`, and `ws_closed` with close code and close
origin); and `retry_wait` backoff delays. `run_start` records the shinyloadtest
and Node.js versions and the worker/max-errors settings.

Only IDs, event types, status codes, durations, counts, and enum-like
outcomes are written. No URLs, headers, cookies, request bodies, credentials,
or free-form error messages can reach the file: each line is built from a
per-event field whitelist, so extra properties are dropped even if a caller
attaches them by mistake.

Things to know when reading the file:

- It shows what the client did. shinyloadtest cannot observe server-side
  state: `ws_closed` records the client-side view of the transport, not
  whether the server (e.g. Posit Connect) considers its logical session
  released.
- The writer starts after server preflight validation, so it records replay
  sessions only — the requests made to detect the server type are not in
  the log.
- On an orderly finish, `run_end` is the last line, with `activeSockets`
  (WebSockets that never reported closure within the wait window) and a
  `complete` flag. Ctrl+C or `SIGTERM` exits immediately: a file with no
  `run_end` line is an interrupted run — the events that were written are
  valid, but the tail of the run is missing.

#### Sharing diagnostics

To report a problem, share **only** the `diagnostics.jsonl` file, plus
sanitized recordings and server logs. Do not share the session CSVs: each
one embeds the full command line as a comment line, which contains any
headers passed with `-H` (typically an API key). Do not share the debug log
either — it records full WebSocket message payloads. If the test uses several
concurrent CLI processes, collect one diagnostics file from each output
directory and label them by recording and worker count. Keep the original
workload settings and add `--diagnostics`; use a separate output directory
for each process. Client “done” outcomes indicate completed playback, not
verified app results or released server sessions.

To run a specific branch locally instead of an installed version:

```bash
git clone https://github.com/posit-dev/shinyloadtest.git
cd shinyloadtest
git checkout <branch>
npm ci
npm run build
node dist/main.mjs replay recording.log https://example.com/app --diagnostics
# or install the checkout globally: npm install -g .
```

## Report

```bash
shinyloadtest report [dirs...] [options]
```

Generates a performance report from the session logs produced by `replay`.
If no directories are specified, any `test-logs-*` directories in the current
working directory that contain a `sessions/` subdirectory are used
automatically.

The default HTML report is a self-contained interactive dashboard with charts
covering session timelines, latency, event duration, concurrency impact, and
more.

### Report Options

| Option | Description |
|--------|-------------|
| `--format <format>` | Output format: `html` (default), `text` (Markdown tables), or `json` |
| `--output <file>` | Save report to a file instead of serving/printing |
| `--no-open` | Do not open the HTML report in the browser |

When using the default `html` format without `--output`, the report is served
on a local HTTP server and opened in your browser. With `--output`, the report
is written to the specified file. The `text` and `json` formats print to stdout
unless `--output` is provided.

## Authentication

shinyloadtest supports authentication via environment variables:

| Variable | Purpose |
|----------|---------|
| `SHINYLOADTEST_USER` | Username for Shiny Server Pro or Posit Connect |
| `SHINYLOADTEST_PASS` | Password for Shiny Server Pro or Posit Connect |
| `SHINYLOADTEST_CONNECT_API_KEY` | API key for Posit Connect |

These variables are used during both recording and replay. If the app requires
login and environment variables are not set, `record` will prompt interactively
(TTY required).

> **Note:** If the recording was made with a Connect API key, playback must
> also use a Connect API key. Likewise, if the recording was made without an
> API key, playback must not use one.

## Companion Package

Report generation is built in via `shinyloadtest report`. The
[shinyloadtest](https://rstudio.github.io/shinyloadtest) R package can still be
used for custom analysis of load test results in R.

## Migration from shinycannon

This is a TypeScript rewrite of [shinycannon](https://github.com/rstudio/shinycannon),
the original Kotlin/JVM load-testing tool. The rewrite uses the same recording
format and output format — existing recordings and analysis workflows are
fully compatible.

The `shinycannon` command is supported as an alias for backwards compatibility.
The legacy `SHINYCANNON_USER`, `SHINYCANNON_PASS`, and
`SHINYCANNON_CONNECT_API_KEY` environment variables are also still accepted.

## License

MIT
