import { describe, it, expect } from "vitest"

import {
  toISOTimestamp,
  makeHttpEvent,
  makeWsEvent,
  classifyGetRequest,
} from "../record/events.js"

describe("toISOTimestamp()", () => {
  it("returns ISO 8601 string", () => {
    const date = new Date("2024-01-15T10:30:00.000Z")
    expect(toISOTimestamp(date)).toBe("2024-01-15T10:30:00.000Z")
  })
})

describe("makeHttpEvent()", () => {
  it("creates event with correct fields", () => {
    const begin = new Date("2024-01-15T10:00:00.000Z")
    const end = new Date("2024-01-15T10:00:01.000Z")
    const event = makeHttpEvent("REQ_HOME", begin, end, 200, "/")
    expect(event.type).toBe("REQ_HOME")
    expect(event.begin).toBe("2024-01-15T10:00:00.000Z")
    expect(event.end).toBe("2024-01-15T10:00:01.000Z")
    expect(event.status).toBe(200)
    expect(event.url).toBe("/")
    expect(event.datafile).toBeUndefined()
  })

  it("includes datafile when provided", () => {
    const begin = new Date("2024-01-15T10:00:00.000Z")
    const end = new Date("2024-01-15T10:00:01.000Z")
    const event = makeHttpEvent(
      "REQ_POST",
      begin,
      end,
      200,
      "/upload",
      "recording.log.post.0",
    )
    expect(event.type).toBe("REQ_POST")
    expect(event.datafile).toBe("recording.log.post.0")
  })
})

describe("makeWsEvent()", () => {
  it("creates event with just type and begin for WS_CLOSE", () => {
    const begin = new Date("2024-01-15T10:00:00.000Z")
    const event = makeWsEvent("WS_CLOSE", begin)
    expect(event.type).toBe("WS_CLOSE")
    expect(event.begin).toBe("2024-01-15T10:00:00.000Z")
    expect(event.url).toBeUndefined()
    expect(event.message).toBeUndefined()
  })

  it("includes url for WS_OPEN", () => {
    const begin = new Date("2024-01-15T10:00:00.000Z")
    const event = makeWsEvent("WS_OPEN", begin, { url: "/app/ws" })
    expect(event.type).toBe("WS_OPEN")
    expect(event.url).toBe("/app/ws")
    expect(event.message).toBeUndefined()
  })

  it("includes message for WS_RECV", () => {
    const begin = new Date("2024-01-15T10:00:00.000Z")
    const event = makeWsEvent("WS_RECV", begin, { message: '{"data":1}' })
    expect(event.type).toBe("WS_RECV")
    expect(event.message).toBe('{"data":1}')
    expect(event.url).toBeUndefined()
  })
})

describe("classifyGetRequest()", () => {
  it('classifies "/" as REQ_HOME', () => {
    expect(classifyGetRequest("/")).toEqual({ type: "REQ_HOME" })
  })

  it('classifies "/app/" as REQ_HOME', () => {
    expect(classifyGetRequest("/app/")).toEqual({ type: "REQ_HOME" })
  })

  it('classifies "/app/something.Rmd" as REQ_HOME (case-insensitive)', () => {
    expect(classifyGetRequest("/app/something.Rmd")).toEqual({
      type: "REQ_HOME",
    })
  })

  it('classifies "/__token__" as REQ_TOK', () => {
    expect(classifyGetRequest("/__token__")).toEqual({ type: "REQ_TOK" })
  })

  it('classifies "/__sockjs__/000/abc123/n=xyz789" as REQ_SINF with robustId', () => {
    expect(classifyGetRequest("/__sockjs__/000/abc123/n=xyz789")).toEqual({
      type: "REQ_SINF",
      robustId: "xyz789",
    })
  })

  it('classifies "/shared/shiny.js" as REQ_GET', () => {
    expect(classifyGetRequest("/shared/shiny.js")).toEqual({ type: "REQ_GET" })
  })

  it("classifies path with query string correctly", () => {
    expect(classifyGetRequest("/app/?_ga=123")).toEqual({ type: "REQ_HOME" })
    expect(classifyGetRequest("/shared/shiny.js?v=1")).toEqual({
      type: "REQ_GET",
    })
    expect(
      classifyGetRequest("/__sockjs__/000/abc123/n=xyz789?foo=bar"),
    ).toEqual({ type: "REQ_SINF", robustId: "xyz789" })
  })
})
