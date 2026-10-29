import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)

function readPackage(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf-8"))
}

describe("shinycannon stub package", () => {
  const stub = readPackage("packages/shinycannon/package.json")
  const root = readPackage("package.json")
  const dependencies = (stub.dependencies ?? {}) as Record<string, string>

  it("pins the exact shinyloadtest version it is published as", () => {
    // The stub is a pure alias: `shinycannon --version` reports the
    // shinyloadtest version it imports. A caret range would let npm resolve to
    // whichever version the `latest` dist-tag points at, so a stub user could
    // silently run a different (older) build than the stub's own version.
    expect(dependencies.shinyloadtest).toBe(stub.version)
  })

  it("tracks the same version as the main package", () => {
    expect(stub.version).toBe(root.version)
  })
})
