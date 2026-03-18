import { describe, it, expect } from "vitest"
import { WebSocketServer } from "ws"
import { AsyncQueue, ShinyWebSocket } from "../replay/websocket.js"
import type { WSMessage } from "../replay/websocket.js"

describe("AsyncQueue", () => {
  it("returns items in FIFO order", async () => {
    const q = new AsyncQueue<string>(10)
    q.offer("a")
    q.offer("b")
    expect(await q.poll(100)).toBe("a")
    expect(await q.poll(100)).toBe("b")
  })

  it("poll waits for item and returns it", async () => {
    const q = new AsyncQueue<string>(10)
    const pollPromise = q.poll(1000)
    q.offer("delayed")
    expect(await pollPromise).toBe("delayed")
  })

  it("poll returns null on timeout", async () => {
    const q = new AsyncQueue<number>(10)
    const result = await q.poll(50)
    expect(result).toBeNull()
  })

  it("offer returns false when queue is full", () => {
    const q = new AsyncQueue<string>(2)
    expect(q.offer("a")).toBe(true)
    expect(q.offer("b")).toBe(true)
    expect(q.offer("c")).toBe(false)
  })

  it("reports correct size", () => {
    const q = new AsyncQueue<string>(10)
    expect(q.size).toBe(0)
    q.offer("a")
    expect(q.size).toBe(1)
    q.offer("b")
    expect(q.size).toBe(2)
  })

  it("handles multiple concurrent polls", async () => {
    const q = new AsyncQueue<string>(10)
    const p1 = q.poll(1000)
    const p2 = q.poll(1000)
    q.offer("first")
    q.offer("second")
    expect(await p1).toBe("first")
    expect(await p2).toBe("second")
  })

  it("size decreases after poll consumes an item", async () => {
    const q = new AsyncQueue<string>(10)
    q.offer("a")
    q.offer("b")
    expect(q.size).toBe(2)
    await q.poll(100)
    expect(q.size).toBe(1)
  })

  it("offer resolves a waiter without increasing size", async () => {
    const q = new AsyncQueue<string>(10)
    const pollPromise = q.poll(1000)
    expect(q.size).toBe(0)
    q.offer("item")
    expect(q.size).toBe(0)
    expect(await pollPromise).toBe("item")
  })
})

describe("ShinyWebSocket malformed frame handling", () => {
  it("routes malformed frame through triggerFailure instead of throwing uncaught", async () => {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.once("listening", resolve))
    const { port } = wss.address() as { port: number }

    wss.once("connection", (ws) => {
      ws.send("notvalidjson[")
    })

    const sws = new ShinyWebSocket({
      url: `ws://127.0.0.1:${port}`,
      headers: {},
    })

    try {
      await expect(sws.receive(() => {})).rejects.toThrow()
    } finally {
      sws.close()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })
})

describe("WSMessage", () => {
  it("represents text messages", () => {
    const msg: WSMessage = { kind: "text", text: "hello" }
    expect(msg.kind).toBe("text")
    if (msg.kind === "text") {
      expect(msg.text).toBe("hello")
    }
  })

  it("represents error messages", () => {
    const err = new Error("connection failed")
    const msg: WSMessage = { kind: "error", error: err }
    expect(msg.kind).toBe("error")
    if (msg.kind === "error") {
      expect(msg.error.message).toBe("connection failed")
    }
  })
})
