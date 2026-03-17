# shinyloadtest

A load-generation tool for [Shiny](https://shiny.posit.co/) applications.
shinyloadtest replays recorded sessions against a deployed Shiny app, simulating
concurrent users to measure application performance under load.

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

## Usage

```bash
shinyloadtest replay recording.log https://example.com/app [options]
```

### Options

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

> **Note:** If the recording was made with a Connect API key, playback must
> also use a Connect API key. Likewise, if the recording was made without an
> API key, playback must not use one.

## Example

```bash
shinyloadtest replay recording.log https://rsc.example.com/app \
  --workers 5 \
  --loaded-duration-minutes 10 \
  --output-dir load-test-results
```

## Companion Package

shinyloadtest is designed to work with the
[shinyloadtest](https://rstudio.github.io/shinyloadtest) R package.
Use the R package to record sessions and analyze load test results.

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
