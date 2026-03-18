import { describe, it, expect } from "vitest"

import { RecordingTokens } from "../record/tokens.js"

describe("RecordingTokens", () => {
  describe("discover()", () => {
    it("registers a token and increases size", () => {
      const tokens = new RecordingTokens()
      expect(tokens.size).toBe(0)
      tokens.discover("WORKER", "abc123")
      expect(tokens.size).toBe(1)
    })

    it("is a no-op for empty values", () => {
      const tokens = new RecordingTokens()
      tokens.discover("WORKER", "")
      expect(tokens.size).toBe(0)
    })
  })

  describe("replaceInString()", () => {
    it("replaces known values with ${PLACEHOLDER}", () => {
      const tokens = new RecordingTokens()
      tokens.discover("WORKER", "abc123")
      expect(tokens.replaceInString("hello abc123 world")).toBe(
        "hello ${WORKER} world",
      )
    })

    it("returns the original string when no tokens are registered", () => {
      const tokens = new RecordingTokens()
      expect(tokens.replaceInString("hello world")).toBe("hello world")
    })

    it("replaces longer values first to avoid partial matches", () => {
      const tokens = new RecordingTokens()
      tokens.discover("WORKER", "abc")
      tokens.discover("SESSION", "abcdef")
      expect(tokens.replaceInString("abcdef")).toBe("${SESSION}")
    })

    it("replaces all occurrences in the string", () => {
      const tokens = new RecordingTokens()
      tokens.discover("TOKEN", "xyz")
      expect(tokens.replaceInString("xyz and xyz")).toBe(
        "${TOKEN} and ${TOKEN}",
      )
    })
  })

  describe("has()", () => {
    it("returns true for discovered token names", () => {
      const tokens = new RecordingTokens()
      tokens.discover("SESSION", "sess-val")
      expect(tokens.has("SESSION")).toBe(true)
    })

    it("returns false for undiscovered token names", () => {
      const tokens = new RecordingTokens()
      tokens.discover("SESSION", "sess-val")
      expect(tokens.has("WORKER")).toBe(false)
    })
  })
})
