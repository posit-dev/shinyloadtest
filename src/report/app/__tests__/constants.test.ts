import { describe, it, expect } from "vitest"
import { EVENT_TYPE_MAP, EVENT_COLORS, EVENT_ORDER } from "../constants"

describe("EVENT_TYPE_MAP", () => {
  it("maps REQ_HOME to Homepage", () => {
    expect(EVENT_TYPE_MAP["REQ_HOME"]).toBe("Homepage")
  })

  it("maps REQ_GET to JS/CSS", () => {
    expect(EVENT_TYPE_MAP["REQ_GET"]).toBe("JS/CSS")
  })

  it("maps WS_OPEN to Start Session", () => {
    expect(EVENT_TYPE_MAP["WS_OPEN"]).toBe("Start Session")
  })

  it("maps WS_RECV to Calculate", () => {
    expect(EVENT_TYPE_MAP["WS_RECV"]).toBe("Calculate")
  })

  it("has exactly 4 entries", () => {
    expect(Object.keys(EVENT_TYPE_MAP)).toHaveLength(4)
  })
})

describe("EVENT_COLORS", () => {
  it("has an entry for every item in EVENT_ORDER", () => {
    for (const label of EVENT_ORDER) {
      expect(EVENT_COLORS).toHaveProperty(label)
    }
  })

  it("all color values are non-empty strings", () => {
    for (const [, color] of Object.entries(EVENT_COLORS)) {
      expect(typeof color).toBe("string")
      expect(color.length).toBeGreaterThan(0)
    }
  })
})

describe("EVENT_ORDER", () => {
  it("contains the same labels as the values of EVENT_TYPE_MAP", () => {
    const mapValues = new Set(Object.values(EVENT_TYPE_MAP) as string[])
    for (const label of EVENT_ORDER) {
      expect(mapValues.has(label)).toBe(true)
    }
  })

  it("has the same length as EVENT_COLORS entries", () => {
    expect(EVENT_ORDER.length).toBe(Object.keys(EVENT_COLORS).length)
  })

  it("has no duplicate entries", () => {
    const unique = new Set(EVENT_ORDER)
    expect(unique.size).toBe(EVENT_ORDER.length)
  })
})
