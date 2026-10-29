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
origin); `ws_recv_skipped` receive classifications; and `retry_wait` backoff
delays. `run_start` records the shinyloadtest and Node.js versions and the
worker/max-errors settings.

For meaningful JSON `WS_RECV` events, replay allows the remaining recorded
quiet interval plus 30 seconds of slack. Its deadline is at least 30 seconds
and at most 15 minutes from the start of the receive; a match can finish
earlier. A receive can also stop looking after 16 mismatched non-ignorable
messages. Matching remains key-based, not a comparison of output values;
buffered reordered messages can match later receives. Expected messages that
are now ignorable are skipped. After a skipped or ignored receive, residual
pacing before the next send, open-socket GET, or close is also capped at 15
minutes. Ordinary pacing is unchanged. Essential protocol receives and exact
string-frame matching retain their existing semantics. Replay is
response-driven, so this policy does not
enforce the recorded total duration, and very long gaps can exceed the cap.

Essential protocol receives cannot be skipped: the session ID and upload job
ID they carry (`WS_RECV_INIT`, `WS_RECV_BEGIN_UPLOAD`, and the SockJS open
frame matched by an exact string `WS_RECV`) are substituted into later
messages and URLs, so the session cannot continue without them. They have no
fixed deadline either — a cold app start can be slow, and failing a session
that would have recovered only adds retry load. They wait for the message,
logging a warning with the recording line every 30 seconds, and are bounded by
the run's end conditions rather than by a timer: the loaded-duration expiry,
`--max-errors` once other sessions have failed, and Ctrl+C. Warmup is the
exception: the loaded-duration timer starts only after every worker's first
session has finished, so a run in which all workers are waiting for a required
message at that point does not end on its own.

Each `session_end` includes counts for completed `WS_RECV` events:
`wsRecvMatched` (including buffered and string matches), `wsRecvIgnored`
(expected messages filtered as ignorable), `wsRecvTimeout` (no non-ignorable
message arrived), and `wsRecvMismatch` (messages arrived but none matched
before the deadline or mismatch limit). Incomplete receives on cancellation
or failure are not counted. INIT and upload receives are not included.
Each ignored, timeout, or mismatch result also produces a `ws_recv_skipped`
event with its `reason` and numeric `inputLineNumber` in the recording.
There is one event per ignored expectation, so older recordings with many
ignorable messages can produce larger logs; use the per-session counts for
summaries. Ignored expectations are not degradation; a nonzero timeout or
mismatch count indicates tolerated missing meaningful receives even if the
outcome is `done`. Older schema version 1 files without these counts mean
unknown, not zero.

Only IDs, recording line numbers, event types, status codes, durations,
counts, and enum-like outcomes are written. No URLs, headers, cookies, request
or WebSocket bodies, message-derived identifiers, application JSON key names,
credentials, or free-form error messages can reach the file: each line is
built from a per-event field whitelist, so extra properties are dropped even
if a caller attaches them by mistake.

Things to know when reading the file:

- It shows what the client did. shinyloadtest cannot observe server-side
  state: `ws_closed` records the client-side view of the transport, not
  whether the server (e.g. Posit Connect) considers its logical session
  released.
- The writer starts after server preflight validation, so it records replay
  sessions only — the requests made to detect the server type are not in
  the log.
- A session waiting for an essential protocol message has no event of its own:
  nothing follows its last `ws_open` until the message arrives or the run is
  cancelled. While it waits, the console repeats a warning naming the
  recording line every 30 seconds. If the console output was not captured, a
  file whose sessions end at `ws_open` with no `session_end` is the signature
  of a stuck run, not of a slow one.
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
faithful replay, verified app results, or released server sessions. Check the
receive counts and skip reasons before interpreting a completed session.

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
