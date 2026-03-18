# shinyloadtest

A load-testing tool for [Shiny](https://shiny.posit.co/) applications.
shinyloadtest records a user session and replays it with concurrent workers
to measure application performance under load.

## Installation

Requires **Node.js 20+**.

Install globally via npm:

```bash
npm install -g @posit-dev/shinyloadtest
```

Or run directly with npx:

```bash
npx @posit-dev/shinyloadtest --help
```

## Quick Start

```bash
# 1. Record a session against a running Shiny app
shinyloadtest record https://example.com/app

# 2. Interact with the app in the browser at the printed proxy URL,
#    then close the browser tab to stop recording.

# 3. Replay the recording with multiple concurrent users
shinyloadtest replay recording.log https://example.com/app --workers 5
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
| `--debug-log` | Write verbose debug log |
| `--log-level <level>` | Console log level: `debug`, `info`, `warn`, `error` (default: `warn`) |

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

shinyloadtest is designed to work with the
[shinyloadtest](https://rstudio.github.io/shinyloadtest) R package.
Use the R package to analyze load test results.

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
