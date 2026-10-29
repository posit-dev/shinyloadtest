## About shinyloadtest

`shinyloadtest` — a TypeScript/Node.js CLI tool for loadtesting [Shiny apps](https://shiny.posit.co/).
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
- Test teardown that awaits anything in a `finally` block replaces the error
  it is cleaning up after, so a failing teardown hides the assertion that
  failed (a hanging one turns into a bare test timeout). Route that teardown
  through `withTeardown` in `src/tests/helpers/teardown.ts`: the body error
  stays the thrown error, the teardown error becomes its `cause`, and the
  whole teardown is bounded by a deadline.

## Releasing

A version bump touches three places, which must all agree — on **every** bump,
including patches:

- `package.json` → `version`
- `packages/shinycannon/package.json` → `version`
- `packages/shinycannon/package.json` → `dependencies.shinyloadtest`

The stub's dependency is an **exact** version, never a range. npm resolves a
dependency range by preferring the version behind the `latest` dist-tag when
that version satisfies the range, before it sorts by version at all. With a
caret, `npx shinycannon@X` therefore runs whatever `latest` points at instead
of `X` — the alias reports a version its own manifest does not declare.
`src/tests/stub-package.test.ts` asserts all three agree, and the publish
workflow runs the full suite before publishing, so a mismatch blocks the
release instead of shipping silently.

Releases go out by publishing a GitHub release. The workflow derives the npm
dist-tag from the version string — a prerelease goes to `next`, a stable
version to `latest` — so a stable release moves `latest` without extra steps.
Recovery and re-publishing use `workflow_dispatch` with `ref` (publish or
re-publish a tag; steps skip versions already on the registry) and
`promote_latest` (move `latest` to that version).
