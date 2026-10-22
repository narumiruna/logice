import { describe, expect, it } from "vitest"
import {
  advancePreview,
  createPreviewState,
  durationMs,
  flattenPreview,
  MAX_TRACES,
  type PreviewEvent,
  type PreviewFilters,
  type PreviewState,
  type PreviewTrace,
} from "./model"

const now = Date.parse("2026-10-22T12:00:00Z")
const noFilters: PreviewFilters = { search: "", service: "all", errorsOnly: false }

function advance(state: PreviewState, ticks: number): PreviewState {
  let result = state
  for (let index = 0; index < ticks; index += 1) result = advancePreview(result)
  return result
}

function freezeState(state: PreviewState) {
  for (const trace of state.traces) {
    for (const event of trace.events) {
      Object.freeze(event.attributes)
      Object.freeze(event)
    }
    Object.freeze(trace.events)
    Object.freeze(trace)
  }
  Object.freeze(state.traces)
  Object.freeze(state)
}

function event(id: string, overrides: Partial<PreviewEvent> = {}): PreviewEvent {
  return {
    id,
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    parentId: null,
    kind: "span",
    message: id,
    service: "api",
    startMs: 100,
    durationMs: 50,
    status: "ok",
    level: "info",
    attributes: {},
    addedAtTick: 0,
    ...overrides,
  }
}

function fixture(): PreviewTrace[] {
  return [
    {
      id: "first",
      events: [
        event("log", {
          parentId: "db",
          startMs: 140,
          kind: "log",
          message: "Inventory reserved",
          service: "postgres",
          attributes: { "db.statement": "SELECT [SKU.*]", "order.id": "ORD-42" },
        }),
        event("sibling", { parentId: "root", startMs: 150 }),
        event("db", { parentId: "handler", startMs: 130, service: "postgres" }),
        event("handler", { parentId: "root", startMs: 120, service: "worker" }),
        event("root"),
      ],
    },
    {
      id: "second",
      events: [event("other", { startMs: 200, traceId: "a".repeat(32) })],
    },
  ]
}

function expandedIds(traces: PreviewTrace[]): Set<string> {
  return new Set(traces.flatMap((trace) => trace.events.map((item) => item.id)))
}

function ids(traces: PreviewTrace[], filters = noFilters, expanded = new Set<string>()): string[] {
  return flattenPreview(traces, expanded, filters).map((row) => row.event.id)
}

describe("preview seed", () => {
  it("creates 24 deterministic completed traces over the last 4.5 minutes", () => {
    const state = createPreviewState(now)
    expect(state).toEqual(createPreviewState(now))
    expect(state).toMatchObject({ now, tick: 0, nextSequence: 25 })
    expect(state.traces).toHaveLength(MAX_TRACES)
    expect(state.traces[0].id).toBe("trace-1")
    expect(state.traces[23].id).toBe("trace-24")
    expect(state.traces[0].events[0].startMs).toBe(now - 270_000)
    let previousStart = Number.NEGATIVE_INFINITY
    for (const trace of state.traces) {
      const root = trace.events[0]
      expect(root.startMs).toBeGreaterThan(previousStart)
      expect(root.startMs + root.durationMs).toBeLessThanOrEqual(now)
      previousStart = root.startMs
      for (const item of trace.events) {
        expect(item.status).not.toBe("running")
        expect(item.addedAtTick).toBe(0)
        expect(item.startMs).toBeGreaterThanOrEqual(root.startMs)
        expect(item.startMs + item.durationMs).toBeLessThanOrEqual(root.startMs + root.durationMs)
      }
    }
  })

  it("alternates checkout/chat templates and marks every fourth trace as an error", () => {
    const state = createPreviewState(now)
    for (const [index, trace] of state.traces.entries()) {
      const checkout = index % 2 === 0
      const failed = (index + 1) % 4 === 0
      const root = trace.events[0]
      expect(root.message).toBe(checkout ? "POST /checkout" : "POST /api/chat")
      expect(root.status).toBe(failed ? "error" : "ok")
      expect(trace.events.some((item) => item.status === "error")).toBe(failed)
      expect(trace.events.map((item) => item.message)).toContain(
        checkout ? "handle_checkout" : "agent.run",
      )
      expect(trace.events.map((item) => item.message)).toContain(
        checkout ? "inventory.reserve" : "llm.generate",
      )
      expect(trace.events.some((item) => Object.keys(item.attributes).length > 1)).toBe(true)
    }
    expect(
      new Set(state.traces.flatMap((trace) => trace.events.map((item) => item.service))),
    ).toEqual(new Set(["api", "worker", "postgres", "openai"]))
  })

  it("uses unique stable event/span IDs and correlates logs with their parent spans", () => {
    const state = createPreviewState(now)
    const eventIds = new Set<string>()
    const traceIds = new Set<string>()
    const spanIds = new Set<string>()
    for (const trace of state.traces) {
      const root = trace.events[0]
      expect(root.id).toBe(trace.id)
      expect(root.parentId).toBeNull()
      expect(root.traceId).toMatch(/^[a-f\d]{32}$/)
      expect(traceIds.has(root.traceId)).toBe(false)
      traceIds.add(root.traceId)
      const byId = new Map(trace.events.map((item) => [item.id, item]))
      for (const item of trace.events) {
        expect(eventIds.has(item.id)).toBe(false)
        eventIds.add(item.id)
        expect(item.traceId).toBe(root.traceId)
        expect(item.spanId).toMatch(/^[a-f\d]{16}$/)
        if (item.parentId) expect(byId.get(item.parentId)?.kind).toBe("span")
        if (item.kind === "log") {
          expect(item.spanId).toBe(byId.get(item.parentId ?? "")?.spanId)
        } else {
          expect(spanIds.has(item.spanId)).toBe(false)
          spanIds.add(item.spanId)
        }
      }
    }
    const rows = flattenPreview(state.traces, expandedIds(state.traces), noFilters)
    expect(Math.max(...rows.map((row) => row.depth))).toBeGreaterThanOrEqual(3)
  })

  it("does not share mutable state between separate seeds", () => {
    const first = createPreviewState(now)
    first.traces[0].events[0].attributes.changed = "yes"
    first.traces.pop()
    expect(createPreviewState(now).traces).toHaveLength(24)
    expect(createPreviewState(now).traces[0].events[0].attributes.changed).toBeUndefined()
  })
})

describe("preview animation", () => {
  it("adds a running root and log on tick 1 and completes the same root on tick 4", () => {
    const seed = createPreviewState(now)
    const one = advancePreview(seed)
    const first = one.traces[23]
    expect(one).toMatchObject({ tick: 1, now: now + 1000, nextSequence: 26 })
    expect(first.id).toBe("trace-25")
    expect(first.events).toHaveLength(2)
    const root = first.events[0]
    expect(root).toMatchObject({ status: "running", durationMs: 0, addedAtTick: 1 })
    expect(first.events[1]).toMatchObject({ kind: "log", parentId: root.id, addedAtTick: 1 })
    expect(durationMs(root, one.now)).toBe(0)
    expect(durationMs(root, one.now + 500)).toBe(500)

    const two = advancePreview(one)
    const three = advancePreview(two)
    const four = advancePreview(three)
    for (const [state, phase] of [
      [two, 1],
      [three, 2],
      [four, 3],
    ] as const) {
      const current = state.traces[23]
      expect(current.id).toBe(first.id)
      expect(current.events.length).toBeGreaterThan(first.events.length)
      expect(current.events.some((item) => item.addedAtTick === state.tick)).toBe(true)
      expect(current.events[0].durationMs).toBe(phase * 1000)
      expect(durationMs(current.events[0], state.now)).toBe(phase * 1000)
    }
    expect(two.traces[23].events[0].status).toBe("running")
    expect(three.traces[23].events[0].status).toBe("running")
    expect(four.traces[23].events.every((item) => item.status !== "running")).toBe(true)
    expect(durationMs(four.traces[23].events[0], four.now + 100_000)).toBe(3000)
    expect(advancePreview(four).traces[23].id).toBe("trace-26")
  })

  it("completes every fourth live sequence with an error", () => {
    const running = advance(createPreviewState(now), 15)
    expect(running.traces[23].id).toBe("trace-28")
    expect(running.traces[23].events[0].status).toBe("running")
    const completed = advancePreview(running)
    expect(completed.traces[23].events[0].status).toBe("error")
    expect(
      completed.traces[23].events.some((item) => item.kind === "log" && item.level === "error"),
    ).toBe(true)
  })

  it("keeps prior states immutable and changes only duration/status of existing running events", () => {
    let state = createPreviewState(now)
    for (let tick = 1; tick <= 20; tick += 1) {
      const snapshot = structuredClone(state)
      freezeState(state)
      const next = advancePreview(state)
      expect(state).toEqual(snapshot)
      const previous = new Map(
        state.traces.flatMap((trace) => trace.events.map((item) => [item.id, item])),
      )
      for (const trace of next.traces) {
        for (const item of trace.events) {
          const old = previous.get(item.id)
          if (!old) {
            expect(item.addedAtTick).toBe(tick)
          } else {
            expect(item).toEqual({ ...old, status: item.status, durationMs: item.durationMs })
            if (old.status !== "running") expect(item).toBe(old)
          }
        }
      }
      state = next
    }
  })

  it("caps traces and keeps sequence numbers, IDs, and insertion ticks consistent after 200 ticks", () => {
    let state = createPreviewState(now)
    const seenIds = new Map<string, number>()
    for (let tick = 1; tick <= 200; tick += 1) {
      state = advancePreview(state)
      expect(state.traces).toHaveLength(MAX_TRACES)
      expect(state.tick).toBe(tick)
      expect(state.now).toBe(now + tick * 1000)
      expect(state.nextSequence).toBe(25 + Math.ceil(tick / 4))
      const currentIds = new Set<string>()
      for (const trace of state.traces) {
        const byId = new Map(trace.events.map((item) => [item.id, item]))
        for (const item of trace.events) {
          expect(currentIds.has(item.id)).toBe(false)
          currentIds.add(item.id)
          expect(item.addedAtTick).toBeLessThanOrEqual(tick)
          if (seenIds.has(item.id)) expect(item.addedAtTick).toBe(seenIds.get(item.id))
          seenIds.set(item.id, item.addedAtTick)
          if (item.kind === "log") expect(item.spanId).toBe(byId.get(item.parentId ?? "")?.spanId)
        }
      }
    }
    expect(state.traces[0].id).toBe("trace-51")
    expect(state.traces[23].id).toBe("trace-74")
    expect(state.nextSequence).toBe(75)
    expect(
      state.traces.every((trace) => trace.events.every((item) => item.status !== "running")),
    ).toBe(true)
    expect(state).toEqual(advance(createPreviewState(now), 200))
  })

  it("clamps running durations before the start and keeps completed/log durations fixed", () => {
    const running = event("running", { status: "running", startMs: 100, durationMs: 7 })
    expect(durationMs(running, 50)).toBe(0)
    expect(durationMs(running, 250)).toBe(150)
    expect(durationMs(event("completed", { durationMs: 42 }), 10_000)).toBe(42)
    expect(durationMs(event("failed", { status: "error", durationMs: 21 }), 10_000)).toBe(21)
    expect(durationMs(event("log", { kind: "log", durationMs: 0 }), 10_000)).toBe(0)
  })
})

describe("preview hierarchy", () => {
  it("collapses by default and expands only the specified nodes with direct child counts", () => {
    const traces = fixture()
    expect(ids(traces)).toEqual(["root", "other"])
    const rootOnly = flattenPreview(traces, new Set(["root"]), noFilters)
    expect(rootOnly.map((row) => row.event.id)).toEqual(["root", "handler", "sibling", "other"])
    expect(rootOnly[0]).toMatchObject({ depth: 0, hasChildren: true, childCount: 2 })
    expect(rootOnly[1]).toMatchObject({ depth: 1, hasChildren: true, childCount: 1 })
    expect(rootOnly[2]).toMatchObject({ depth: 1, hasChildren: false, childCount: 0 })
    const all = flattenPreview(traces, expandedIds(traces), noFilters)
    expect(all.map((row) => [row.event.id, row.depth])).toEqual([
      ["root", 0],
      ["handler", 1],
      ["db", 2],
      ["log", 3],
      ["sibling", 1],
      ["other", 0],
    ])
    expect(ids(traces, noFilters, new Set(["handler", "db"]))).toEqual(["root", "other"])
  })

  it("orders roots chronologically and siblings by start time then ID without changing input", () => {
    const traces = [
      { id: "later", events: [event("later", { startMs: 300 })] },
      {
        id: "earlier",
        events: [
          event("z", { parentId: "root", startMs: 120 }),
          event("b", { parentId: "root", startMs: 110 }),
          event("a", { parentId: "root", startMs: 110 }),
          event("root"),
        ],
      },
    ]
    const snapshot = structuredClone(traces)
    const expanded = expandedIds(traces)
    const before = [...expanded]
    expect(ids(traces, noFilters, expanded)).toEqual(["root", "a", "b", "z", "later"])
    expect(traces).toEqual(snapshot)
    expect([...expanded]).toEqual(before)
  })

  it("shows missing/self parents as roots and breaks cycles without duplicate rendered IDs", () => {
    const traces = [
      {
        id: "malformed",
        events: [
          event("a", { parentId: "b", startMs: 1 }),
          event("b", { parentId: "a", startMs: 2 }),
          event("leaf", { parentId: "b", startMs: 3 }),
          event("orphan", { parentId: "missing", startMs: 4 }),
          event("self", { parentId: "self", startMs: 5 }),
          event("a", { parentId: null, message: "duplicate", startMs: 6 }),
        ],
      },
    ]
    const rows = flattenPreview(traces, expandedIds(traces), noFilters)
    expect(rows.map((row) => [row.event.id, row.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["leaf", 2],
      ["orphan", 0],
      ["self", 0],
    ])
    expect(ids(traces)).toEqual(["a", "orphan", "self"])
    expect(ids(traces, { ...noFilters, search: "leaf" })).toEqual(["a", "b", "leaf"])
    expect(ids([...traces, ...traces], noFilters, expandedIds(traces))).toHaveLength(5)
  })

  it("caps depth at 16 without losing deep descendants", () => {
    const traces = [
      {
        id: "deep",
        events: Array.from({ length: 50 }, (_, index) =>
          event(`node-${index}`, { parentId: index ? `node-${index - 1}` : null, startMs: index }),
        ),
      },
    ]
    const rows = flattenPreview(traces, expandedIds(traces), noFilters)
    expect(rows).toHaveLength(50)
    expect(rows[15].depth).toBe(15)
    expect(rows.slice(16).every((row) => row.depth === 16)).toBe(true)
    expect(ids(traces, { ...noFilters, search: "node-49" })).toHaveLength(50)
  })

  it("handles an empty dataset", () => {
    expect(flattenPreview([], new Set(), noFilters)).toEqual([])
  })
})

describe("preview filters", () => {
  it.each(["INVENTORY RESERVED", "ORD-42", "db.statement", "[sku.*]"])(
    "matches literal case-insensitive messages/attributes for %s and retains ancestors",
    (search) => {
      expect(ids(fixture(), { ...noFilters, search })).toEqual(["root", "handler", "db", "log"])
    },
  )

  it("matches service and trace IDs as searchable text", () => {
    expect(ids(fixture(), { ...noFilters, search: "POSTGRES" })).toEqual([
      "root",
      "handler",
      "db",
      "log",
    ])
    expect(ids(fixture(), { ...noFilters, search: "4BF92F3577B34DA6" })).toEqual([
      "root",
      "handler",
      "db",
      "log",
      "sibling",
    ])
    expect(ids(fixture(), { ...noFilters, search: "aaaaaaaa" })).toEqual(["other"])
    expect(ids(fixture(), { ...noFilters, search: "not present" })).toEqual([])
    expect(ids(fixture(), { ...noFilters, search: "^Inventory" })).toEqual([])
  })

  it("uses exact service matching and opens collapsed ancestor paths", () => {
    const traces = fixture()
    const rows = flattenPreview(traces, new Set(), { ...noFilters, service: "postgres" })
    expect(rows.map((row) => row.event.id)).toEqual(["root", "handler", "db", "log"])
    expect(rows[0].childCount).toBe(2)
    expect(ids(traces, { ...noFilters, service: "post" })).toEqual([])
    expect(ids(traces, { ...noFilters, service: "POSTGRES" })).toEqual([])
    expect(ids(traces, { ...noFilters, service: "" })).toEqual(ids(traces))
    expect(ids(traces, { ...noFilters, service: "worker", search: "Inventory" })).toEqual([])
    expect(ids(traces, { ...noFilters, service: "postgres", search: "Inventory" })).toEqual([
      "root",
      "handler",
      "db",
      "log",
    ])
  })

  it("selects entire error traces, preserves healthy context, and opens paths to errors", () => {
    const traces = fixture()
    const db = traces[0].events.find((item) => item.id === "db")
    if (!db) throw new Error("Missing fixture database span")
    db.status = "error"
    const filters = { ...noFilters, errorsOnly: true }
    expect(ids(traces, filters)).toEqual(["root", "handler", "db", "sibling"])
    expect(ids(traces, filters, expandedIds(traces))).toEqual([
      "root",
      "handler",
      "db",
      "log",
      "sibling",
    ])
    expect(ids(traces, { ...filters, service: "postgres", search: "reserved" })).toEqual([
      "root",
      "handler",
      "db",
      "log",
    ])
    expect(ids(traces, { ...filters, search: "other" })).toEqual([])
    expect(ids(fixture(), filters)).toEqual([])
  })

  it("includes root errors and error-level logs even with healthy span statuses", () => {
    const traces = fixture()
    traces[0].events[0].level = "error"
    expect(ids(traces, { ...noFilters, errorsOnly: true })).toEqual([
      "root",
      "handler",
      "db",
      "log",
      "sibling",
    ])
    const rootError = [{ id: "error-root", events: [event("failure", { status: "error" })] }]
    expect(ids(rootError, { ...noFilters, errorsOnly: true })).toEqual(["failure"])
  })
})
