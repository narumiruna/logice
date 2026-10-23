import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { type LiveRecord, type LiveSnapshot, validateLiveSnapshot } from "./api"
import {
  allRecordIds,
  boundedRatio,
  buildTree,
  countNewRecords,
  flatten,
  isLinkable,
  matchingAncestorIds,
  reconcileAnchor,
  reconcileSelection,
  timeRatios,
} from "./model"

const trace = "1234567890abcdef1234567890abcdef"
function record(id: string, overrides: Partial<LiveRecord> = {}): LiveRecord {
  return {
    id,
    kind: "span",
    traceId: trace,
    spanId: BigInt(id.replace(/\D/g, "") || "1")
      .toString(16)
      .padStart(16, "0"),
    parentSpanId: "",
    name: id,
    serviceName: "api",
    startTime: "2026-10-23T00:00:00.000000001Z",
    durationNs: "100",
    statusCode: "Unset",
    statusMessage: "",
    severityText: "",
    severityNumber: 0,
    body: "",
    resourceAttributes: {},
    attributes: {},
    scopeName: "",
    scopeVersion: "",
    scopeAttributes: {},
    resourceSchemaUrl: "",
    scopeSchemaUrl: "",
    traceFlags: 0,
    occurrences: "1",
    conflict: false,
    parentConflict: false,
    contextOnly: false,
    stored: {},
    ...overrides,
  }
}
function snapshot(records: LiveRecord[]): LiveSnapshot {
  const empty = validateLiveSnapshot(
    JSON.parse(
      readFileSync(new URL("../../../tests/fixtures/live/empty.json", import.meta.url), "utf8"),
    ),
  )
  return {
    ...empty,
    spans: records.filter((item) => item.kind === "span" && !item.contextOnly),
    logs: records.filter((item) => item.kind === "log"),
    context: records.filter((item) => item.contextOnly),
  }
}
const rows = (records: LiveRecord[]) =>
  buildTree(snapshot(records), new Set(records.map((item) => item.id)))

describe("real Live hierarchy", () => {
  it("attaches spans and logs only through valid trace/span pairs and preserves stable identities after a late parent", () => {
    const root = record("r1")
    const child = record("r2", { parentSpanId: root.spanId })
    const log = record("r3", { kind: "log", spanId: child.spanId })
    const before = rows([child, log])
    expect(before.map((row) => [row.record.id, row.parentId])).toEqual([
      ["r2", null],
      ["r3", "r2"],
    ])
    expect(before[0].issue).toBe("Missing parent")
    expect(rows([log, root, child]).map((row) => [row.record.id, row.depth])).toEqual([
      ["r1", 0],
      ["r2", 1],
      ["r3", 2],
    ])
    expect(rows([log, root, child])[2].record).toBe(log)
    const other = record("r4", { traceId: "a".repeat(32), parentSpanId: root.spanId })
    expect(rows([root, other])[1].parentId).toBeNull()
  })
  it("keeps log-only traces, uncorrelated logs, malformed identifiers and multiple roots visible", () => {
    const data = [
      record("r1"),
      record("r2"),
      record("r3", { kind: "log" }),
      record("r4", { kind: "log", traceId: "", spanId: "" }),
      record("r5", { traceId: "broken", parentSpanId: "0000000000000001" }),
    ]
    const output = rows(data)
    expect(output).toHaveLength(5)
    expect(output.map((row) => row.issue)).toEqual([
      null,
      null,
      "Missing span",
      "Uncorrelated log",
      "Invalid identifiers",
    ])
    expect(isLinkable(data[4])).toBe(false)
    expect(isLinkable(record("r6", { spanId: "0".repeat(16) }))).toBe(false)
  })
  it("detaches ambiguous/conflicting parents, self-links and duplicate parent identities without hiding records", () => {
    const first = record("r1", {
      parentSpanId: "0000000000000002",
      parentConflict: true,
      conflict: true,
    })
    const second = record("r2", { parentSpanId: "0000000000000002" })
    const third = record("r3", { parentSpanId: "broken" })
    expect(rows([first, second, third]).map((row) => row.issue)).toEqual([
      "Ambiguous parent",
      "Self parent",
      "Invalid parent",
    ])
    const duplicate = record("r4", { spanId: first.spanId })
    const child = record("r5", { parentSpanId: first.spanId })
    expect(rows([first, duplicate, child]).find((row) => row.record.id === child.id)?.issue).toBe(
      "Ambiguous parent",
    )
    expect(first.parentSpanId).toBe("0000000000000002")
  })
  it("breaks cycles deterministically independent of input order and timestamps", () => {
    const first = record("r1", {
      parentSpanId: "0000000000000002",
      startTime: "2026-10-23T00:00:00.000000003Z",
    })
    const second = record("r2", { parentSpanId: "0000000000000003" })
    const third = record("r3", { parentSpanId: first.spanId })
    const expected = rows([first, second, third]).map((row) => [
      row.record.id,
      row.parentId,
      row.issue,
    ])
    expect(expected).toEqual([
      ["r1", null, "Cycle"],
      ["r3", "r1", null],
      ["r2", "r3", null],
    ])
    expect(
      rows([third, first, second]).map((row) => [row.record.id, row.parentId, row.issue]),
    ).toEqual(expected)
  })
  it("retains context ancestry only and forces matching paths without changing manual expansion", () => {
    const root = record("r1", { contextOnly: true })
    const middle = record("r2", { contextOnly: true, parentSpanId: root.spanId })
    const unused = record("r3", { contextOnly: true, parentSpanId: root.spanId })
    const match = record("r4", { parentSpanId: middle.spanId })
    const tree = buildTree(snapshot([match, unused, middle, root]))
    expect([...tree.byId.keys()]).toEqual(["r1", "r2", "r4"])
    expect(matchingAncestorIds(tree)).toEqual(new Set(["r2", "r1"]))
    const expanded = new Set<string>()
    expect(flatten(tree, expanded)).toHaveLength(1)
    expect(flatten(tree, expanded, true).map((row) => row.record.id)).toEqual(["r1", "r2", "r4"])
    expect(expanded.size).toBe(0)
    expect(flatten(tree, expanded, new Set(["r1"]))).toHaveLength(2)
    expect(flatten(tree, expanded)[0]).toMatchObject({ hasChildren: true, childCount: 1 })
  })
  it("sorts roots and siblings by exact nanoseconds then stable ID, not map or arrival order", () => {
    const first = record("r1", {
      startTime: "2026-10-23T00:00:00.000000001Z",
      attributes: { a: "1", b: "2" },
    })
    const second = record("r2", { startTime: "2026-10-23T00:00:00.000000002Z" })
    const tied = record("r3", { startTime: first.startTime })
    expect(rows([second, tied, first]).map((row) => row.record.id)).toEqual(["r1", "r3", "r2"])
    expect(
      rows([{ ...first, attributes: { b: "2", a: "1" } }, second, tied]).map(
        (row) => row.record.id,
      ),
    ).toEqual(["r1", "r3", "r2"])
  })
  it("keeps trace root groups contiguous and orders them by their earliest retained event", () => {
    const first = record("r1")
    const laterRoot = record("r2", { startTime: "2026-10-23T00:00:00.000000003Z" })
    const other = record("r3", {
      traceId: "a".repeat(32),
      startTime: "2026-10-23T00:00:00.000000002Z",
    })
    expect(rows([laterRoot, other, first]).map((row) => row.record.id)).toEqual(["r1", "r2", "r3"])
  })
  it("handles 1500-deep and wide trees iteratively, bounds indentation, and does not mutate records", () => {
    const deep = Array.from({ length: 1500 }, (_, index) =>
      record(`r${index + 1}`, {
        parentSpanId: index === 0 ? "" : BigInt(index).toString(16).padStart(16, "0"),
      }),
    )
    for (const item of deep) Object.freeze(item)
    const output = rows(deep)
    expect(output).toHaveLength(1500)
    expect(output[1499].depth).toBe(16)
    const wide = deep.map((item, index) => ({
      ...item,
      parentSpanId: index === 0 ? "" : deep[0].spanId,
    }))
    expect(rows(wide)[0].childCount).toBe(1499)
    expect(
      rows(wide)
        .slice(1)
        .every((row) => row.depth === 1),
    ).toBe(true)
  })
})

describe("nanosecond time mapping and bounded reconciliation", () => {
  it("uses one common duration scale with trace-local offsets and log markers", () => {
    const first = record("r1", { durationNs: "1000" })
    const later = record("r2", { startTime: "2026-10-23T00:00:00.000000501Z", durationNs: "100" })
    const log = record("r3", { kind: "log", startTime: later.startTime, durationNs: "90000" })
    const other = record("r4", { traceId: "a".repeat(32), durationNs: "500" })
    const tree = buildTree(snapshot([first, later, log, other]))
    expect(tree.scaleNs).toBe(1000n)
    const timings = timeRatios([first, later, log, other])
    expect(timings.get(first.id)).toEqual({ offsetRatio: 0, durationRatio: 1 })
    expect(timings.get(later.id)).toEqual({ offsetRatio: 0.5, durationRatio: 0.1 })
    expect(timings.get(log.id)).toEqual({ offsetRatio: 0.5, durationRatio: 0 })
    expect(timings.get(other.id)).toEqual({ offsetRatio: 0, durationRatio: 0.5 })
    expect(first.statusCode).toBe("Unset")
    expect(first.durationNs).toBe("1000")
    expect(boundedRatio(1n, 0n)).toBe(0)
    expect(boundedRatio(-1n, 10n)).toBe(0)
    expect(boundedRatio(20n, 10n)).toBe(1)
    expect(boundedRatio(9_007_199_254_740_993n, 18_014_398_509_481_986n)).toBe(0.5)
  })
  it("exposes an exact shared timing scale without counting log duration or unused context", () => {
    const root = record("r1", { durationNs: "9007199254740993" })
    const unused = record("r2", { contextOnly: true, durationNs: "999999999999999999" })
    const log = record("r3", { kind: "log", spanId: root.spanId, durationNs: "999999999999999999" })
    expect(buildTree(snapshot([root, log, unused])).scaleNs).toBe(9007199254740993n)
    expect(buildTree(snapshot([])).scaleNs).toBe(1n)
    expect(buildTree(snapshot([record("r4", { durationNs: "0" })])).scaleNs).toBe(1n)
  })
  it("counts logical new records relative only to the previous bounded response", () => {
    const first = snapshot([record("r1")])
    const next = snapshot([
      record("r1", { occurrences: "100" }),
      record("r2"),
      record("r3", { contextOnly: true }),
    ])
    expect(countNewRecords(null, first)).toBe(0)
    expect(countNewRecords(first, first)).toBe(0)
    expect(countNewRecords(first, next)).toBe(1)
    expect(allRecordIds(next)).toEqual(new Set(["r1", "r2", "r3"]))
    const child = record("r2", { parentSpanId: "0000000000000001" })
    expect(
      countNewRecords(snapshot([child]), snapshot([child, record("r1", { contextOnly: true })])),
    ).toBe(1)
  })
  it("retains only the selected copy on eviction and updates it when its identity returns", () => {
    const selected = record("r1")
    expect(reconcileSelection(snapshot([]), null)).toEqual({ record: null, outside: false })
    expect(reconcileSelection(snapshot([]), selected)).toEqual({ record: selected, outside: true })
    const updated = record("r1", { name: "canonical new representative", occurrences: "2" })
    expect(reconcileSelection(snapshot([updated]), selected)).toEqual({
      record: updated,
      outside: false,
    })
  })
  it("keeps the anchor or chooses the nearest retained neighbor with an eviction notice", () => {
    const old = rows([record("r1"), record("r2"), record("r3"), record("r4")])
    expect(reconcileAnchor(old, old, "r2")).toEqual({ id: "r2", evicted: false })
    expect(reconcileAnchor(old, rows([record("r1"), record("r3")]), "r2")).toEqual({
      id: "r3",
      evicted: true,
    })
    expect(reconcileAnchor(old, rows([record("r9")]), "r4")).toEqual({ id: "r9", evicted: true })
    expect(reconcileAnchor(old, [], "r4")).toEqual({ id: null, evicted: true })
  })
})
