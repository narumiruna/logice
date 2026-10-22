import { isTraceId, timestampNs } from "../telemetry"
import type { LiveRecord, LiveSnapshot } from "./api"

export interface LiveTiming {
  offsetRatio: number
  durationRatio: number
}
export interface LiveRow extends LiveTiming {
  record: LiveRecord
  depth: number
  hasChildren: boolean
  childCount: number
  parentId: string | null
  groupId: string
  issue: string | null
}
export interface LiveTree {
  byId: Map<string, LiveRecord>
  parents: Map<string, string | null>
  children: Map<string | null, string[]>
  roots: string[]
  timings: Map<string, LiveTiming>
  issues: Map<string, string>
}
export function isSpanId(id: string): boolean {
  return /^[a-f\d]{16}$/i.test(id) && !/^0{16}$/.test(id)
}
export function isLinkable(record: LiveRecord): boolean {
  return isTraceId(record.traceId) && isSpanId(record.spanId)
}
export function groupId(record: LiveRecord): string {
  return isTraceId(record.traceId) ? record.traceId.toLowerCase() : record.id
}
function pair(record: LiveRecord, spanId = record.spanId): string {
  return `${record.traceId.toLowerCase()}:${spanId.toLowerCase()}`
}
function chronological(a: LiveRecord, b: LiveRecord, starts: ReadonlyMap<string, bigint>): number {
  const left = starts.get(a.id) ?? 0n
  const right = starts.get(b.id) ?? 0n
  return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
export function boundedRatio(value: bigint, scale: bigint): number {
  if (value <= 0n || scale <= 0n) return 0
  if (value >= scale) return 1
  return Number((value * 1_000_000_000n) / scale) / 1_000_000_000
}
export function timeRatios(records: Iterable<LiveRecord>): Map<string, LiveTiming> {
  const rows = [...records]
  const bounds = new Map<string, { from: bigint; to: bigint }>()
  for (const item of rows) {
    const start = timestampNs(item.startTime) ?? 0n
    const end = start + (item.kind === "span" ? BigInt(item.durationNs) : 0n)
    const key = groupId(item)
    const previous = bounds.get(key)
    bounds.set(key, {
      from: previous && previous.from < start ? previous.from : start,
      to: previous && previous.to > end ? previous.to : end,
    })
  }
  let scale = 1n
  for (const { from, to } of bounds.values()) if (to - from > scale) scale = to - from
  return new Map(
    rows.map((item) => {
      const from = bounds.get(groupId(item))?.from ?? 0n
      return [
        item.id,
        {
          offsetRatio: boundedRatio((timestampNs(item.startTime) ?? 0n) - from, scale),
          durationRatio: item.kind === "span" ? boundedRatio(BigInt(item.durationNs), scale) : 0,
        },
      ]
    }),
  )
}

export function buildTree(snapshot: LiveSnapshot): LiveTree
export function buildTree(
  snapshot: LiveSnapshot,
  expanded: ReadonlySet<string>,
  forced?: boolean | ReadonlySet<string>,
): LiveRow[]
export function buildTree(
  snapshot: LiveSnapshot,
  expanded?: ReadonlySet<string>,
  forced: boolean | ReadonlySet<string> = false,
): LiveTree | LiveRow[] {
  const records = [...snapshot.spans, ...snapshot.logs, ...snapshot.context]
  const startTimes = new Map(records.map((item) => [item.id, timestampNs(item.startTime) ?? 0n]))
  records.sort((a, b) => chronological(a, b, startTimes))
  const byId = new Map(records.map((item) => [item.id, item]))
  const byPair = new Map<string, string | null>()
  for (const item of records) {
    if (item.kind !== "span" || !isLinkable(item)) continue
    const key = pair(item)
    byPair.set(key, byPair.has(key) ? null : item.id)
  }
  const parents = new Map<string, string | null>()
  const issues = new Map<string, string>()
  for (const item of records) {
    let parent: string | null = null
    let issue: string | null = null
    if (item.parentConflict) issue = "Ambiguous parent"
    else if (!isLinkable(item))
      issue =
        item.kind === "log" && !item.traceId && !item.spanId
          ? "Uncorrelated log"
          : "Invalid identifiers"
    else if (item.kind === "log" || item.parentSpanId) {
      const spanId = item.kind === "log" ? item.spanId : item.parentSpanId
      if (!isSpanId(spanId)) issue = "Invalid parent"
      else {
        const key = pair(item, spanId)
        parent = byPair.get(key) ?? null
        if (parent === item.id) {
          parent = null
          issue = "Self parent"
        } else if (!parent)
          issue = byPair.has(key)
            ? "Ambiguous parent"
            : item.kind === "log"
              ? "Missing span"
              : "Missing parent"
      }
    }
    parents.set(item.id, parent)
    if (issue) issues.set(item.id, issue)
  }
  // Remove the lexically smallest node's edge in each cycle, independent of arrival order.
  const settled = new Set<string>()
  for (const item of records) {
    const path: string[] = []
    const positions = new Map<string, number>()
    let id: string | null = item.id
    while (id !== null && !settled.has(id)) {
      const at = positions.get(id)
      if (at !== undefined) {
        const root = path.slice(at).sort()[0]
        parents.set(root, null)
        issues.set(root, "Cycle")
        break
      }
      positions.set(id, path.length)
      path.push(id)
      id = parents.get(id) ?? null
    }
    for (const id of path) settled.add(id)
  }
  // Context is useful only on an available ancestry path to a matching record.
  const retained = new Set<string>()
  for (const item of records) {
    if (item.contextOnly) continue
    let id: string | null = item.id
    while (id !== null && !retained.has(id)) {
      retained.add(id)
      id = parents.get(id) ?? null
    }
  }
  const children = new Map<string | null, string[]>()
  for (const item of records) {
    if (!retained.has(item.id)) {
      byId.delete(item.id)
      parents.delete(item.id)
      issues.delete(item.id)
      continue
    }
    const parent = parents.get(item.id) ?? null
    const siblings = children.get(parent) ?? []
    siblings.push(item.id)
    children.set(parent, siblings)
  }
  const starts = new Map<string, bigint>()
  for (const item of byId.values()) {
    const key = groupId(item)
    if (!starts.has(key)) starts.set(key, startTimes.get(item.id) ?? 0n)
  }
  const roots = children.get(null) ?? []
  roots.sort((left, right) => {
    const a = byId.get(left)
    const b = byId.get(right)
    if (!a || !b) return 0
    const aGroup = groupId(a)
    const bGroup = groupId(b)
    const aTime = starts.get(aGroup) ?? 0n
    const bTime = starts.get(bGroup) ?? 0n
    return aTime < bTime
      ? -1
      : aTime > bTime
        ? 1
        : aGroup < bGroup
          ? -1
          : aGroup > bGroup
            ? 1
            : chronological(a, b, startTimes)
  })
  const tree: LiveTree = {
    byId,
    parents,
    children,
    roots,
    timings: timeRatios(byId.values()),
    issues,
  }
  return expanded ? flatten(tree, expanded, forced) : tree
}

export function matchingAncestorIds(tree: LiveTree): Set<string> {
  const result = new Set<string>()
  for (const item of tree.byId.values()) {
    if (item.contextOnly) continue
    let parent = tree.parents.get(item.id) ?? null
    while (parent !== null && !result.has(parent)) {
      result.add(parent)
      parent = tree.parents.get(parent) ?? null
    }
  }
  return result
}
export function flatten(
  tree: LiveTree,
  expanded: ReadonlySet<string>,
  forced: boolean | ReadonlySet<string> = false,
): LiveRow[] {
  const open =
    typeof forced === "boolean" ? (forced ? matchingAncestorIds(tree) : new Set<string>()) : forced
  const rows: LiveRow[] = []
  const stack = tree.roots.map((id) => ({ id, depth: 0 })).reverse()
  while (stack.length) {
    const item = stack.pop()
    if (!item) continue
    const record = tree.byId.get(item.id)
    if (!record) continue
    const children = tree.children.get(item.id) ?? []
    rows.push({
      record,
      depth: item.depth,
      hasChildren: children.length > 0,
      childCount: children.length,
      parentId: tree.parents.get(item.id) ?? null,
      groupId: groupId(record),
      issue: tree.issues.get(item.id) ?? null,
      ...(tree.timings.get(item.id) ?? { offsetRatio: 0, durationRatio: 0 }),
    })
    if (!expanded.has(item.id) && !open.has(item.id)) continue
    for (let index = children.length - 1; index >= 0; index -= 1)
      stack.push({ id: children[index], depth: Math.min(16, item.depth + 1) })
  }
  return rows
}
export function allRecordIds(snapshot: LiveSnapshot): Set<string> {
  return new Set([...snapshot.spans, ...snapshot.logs, ...snapshot.context].map((item) => item.id))
}
export function countNewRecords(previous: LiveSnapshot | null, next: LiveSnapshot): number {
  if (!previous) return 0
  const ids = buildTree(previous).byId
  let count = 0
  for (const id of buildTree(next).byId.keys()) if (!ids.has(id)) count += 1
  return count
}
export function reconcileSelection(
  snapshot: LiveSnapshot,
  selected: LiveRecord | null,
): { record: LiveRecord | null; outside: boolean } {
  if (!selected) return { record: null, outside: false }
  const current = [...snapshot.spans, ...snapshot.logs, ...snapshot.context].find(
    (item) => item.id === selected.id,
  )
  return { record: current ?? selected, outside: !current }
}
export function reconcileAnchor(
  previous: readonly LiveRow[],
  next: readonly LiveRow[],
  id: string,
): { id: string | null; evicted: boolean } {
  const retained = new Set(next.map((row) => row.record.id))
  if (retained.has(id)) return { id, evicted: false }
  const position = previous.findIndex((row) => row.record.id === id)
  for (let distance = 1; position >= 0 && distance < previous.length; distance += 1) {
    for (const index of [position + distance, position - distance]) {
      const candidate = previous[index]?.record.id
      if (candidate && retained.has(candidate)) return { id: candidate, evicted: true }
    }
  }
  return {
    id: next[Math.min(Math.max(position, 0), next.length - 1)]?.record.id ?? null,
    evicted: true,
  }
}
