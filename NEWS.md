# shinyloadtest 2.0.0 (development)

This release is a complete rewrite of shinycannon in TypeScript/Node.js,
published as `shinyloadtest` on npm.

* Install via `npm install -g shinyloadtest` or run directly with
  `npx shinyloadtest`. The `npx shinycannon` shorthand is also
  supported via a stub package.

* The primary CLI command is now `shinyloadtest replay <recording> [app-url]`.
  The `shinycannon` command is retained as a backwards-compatible alias.

* App URL is now optional; when omitted, the URL from the recording is used.

* Environment variables renamed to `SHINYLOADTEST_USER`, `SHINYLOADTEST_PASS`,
  and `SHINYLOADTEST_CONNECT_API_KEY`. The legacy `SHINYCANNON_*` names are
  still accepted as fallbacks.

* Fixed API-key authentication when recording or replaying login-protected
  Posit Connect apps. Keys set through `SHINYLOADTEST_CONNECT_API_KEY` or the
  legacy `SHINYCANNON_CONNECT_API_KEY` are now sent with the initial app
  requests (#7).

* Added `shinyloadtest report` to generate performance reports from load test
  results. Supports HTML (interactive dashboard), text (Markdown tables), and
  JSON output formats. The HTML report is self-contained and includes charts
  for session timelines, latency, event duration, and concurrency impact.

* Added a live terminal UI that displays per-worker status, session counts, and
  event throughput stats during the loaded phase.

* Added support for Jupyter widget / shinywidgets messages in recordings.

* Replay workers now back off between failed session attempts: about 1s after
  the first failure, doubling per consecutive failure up to 30s, with ±25%
  jitter, reset after a successful session. Earlier alphas retried immediately.

* Added `--diagnostics` to `replay` (off by default): writes a credential-free
  `diagnostics.jsonl` event log to the output directory, covering session
  lifecycle, bootstrap vs. playback HTTP timing, WebSocket lifecycle, and
  retry delays. No URLs, headers, credentials, or error strings are recorded.

* Warmup no longer hangs. A recorded message that the application never sends
  (`WS_RECV_INIT`, an upload response, or the SockJS open frame) is still
  waited for indefinitely, because it cannot be skipped and any fixed deadline
  would cut short an application that is slow to start. Previously nothing
  bounded that wait during warmup, since the loaded-duration timer starts only
  after the first session of every worker finishes, so a run in which every
  worker was waiting never finished and only Ctrl+C stopped it. Warmup now
  stops with a `Warmup timed out` error, naming the workers and the frame they
  were waiting on, when no session finishes within 15 minutes; a session that
  is slow but still finishing restarts that window.

* The recording format, output format, and analysis workflows with the
  shinyloadtest R package are fully compatible with previous versions.



# shinycannon 1.1.3

* Updated `log4j` to `2.17.0` (#67)


# shinycannon 1.1.2

* Updated dependencies: (#65)
  * `log4j`: `2.16.0` (@hekhuisk)
  * `maven`: `3.8.4`
  * `gson`: `2.8.9`
  * `httpclient`: `4.5.13`
  * `maven-assembly-plugin`: `3.3.0`
  * `fpm`: `1.14.1`
  * `junit`: `4.13.2` (0c64de4)
* Updated to use JDK 11 (from JDK 8) (#65)
  * Set a `Multi-Release` flag to true
  * Changed `kotlin-stdlib-jdk7` -> `kotlin-stdlib`
  * Set JVM target to 1.8 (Java 8)

# shinycannon 1.1.1

* Increased the `receiveQueue` limit from 5 to 50 to avoid queue limit errors when non-determinist custom messages are being sent out of order (#63)

# shinycannon 1.1.0

* Allow adding headers, including RStudio Connect API Key (#49, #56)
* Fixed an SSP issue when using `reconnect off` configuration would produce errors that were swallowed. (#58)

# shinycannon 1.0.0

## Bug Fixes

* Fixed an error that would show up in long-running sessions and was triggered
  by __extendsession__ POST requests (#41)

## Enhancements

* App detection is now tolerant of invalid HTML/XML (#42)
* Improved help output (#24, #27)
