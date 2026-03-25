#!/usr/bin/env node

// Legacy `shinycannon` command.
// Delegates to `shinyloadtest replay` from shinyloadtest.

if (process.argv[2] !== "replay") {
  process.argv.splice(2, 0, "replay");
}

import("shinyloadtest");
