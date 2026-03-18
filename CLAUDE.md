## About shinyloadtest

`@posit-dev/shinyloadtest` — a TypeScript/Node.js CLI tool for loadtesting [Shiny apps](https://shiny.posit.co/).
It is a rewrite and consolidation of [shinycannon](https://github.com/rstudio/shinycannon) (originally Kotlin/JVM) and the [shinyloadtest](https://rstudio.github.io/shinyloadtest) (R package and HTML/JavaScript assets).

We forked `rstudio/shinycannon` into `posit-dev/shinyloadtest` for the rewrite.
The original Kotlin source is in both repos; historical community issues and pull requests can be found in the original repo.

## Organization notes

- `packages/shinycannon/` — stub npm package so `npx shinycannon` resolves to this package/
- `_dev/` — git-ignored development artifacts used to store specs, plans, notes, etc.

## Key decisions

- `shinycannon` CLI command is a backwards-compatible alias for `shinyloadtest replay`
- `SHINYCANNON_*` env vars are accepted as fallbacks for `SHINYLOADTEST_*`
- Per-session `tough-cookie` jars provide cookie isolation between workers
- `AsyncQueue` in `websocket.ts` buffers inbound WS messages (capacity defined
  in `types.ts`)
