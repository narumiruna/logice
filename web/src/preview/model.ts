export type EventKind = "span" | "log"
export type EventStatus = "ok" | "error" | "running"
export type EventLevel = "info" | "debug" | "warn" | "error"

export interface PreviewEvent {
  id: string
  traceId: string
  spanId: string
  parentId: string | null
  kind: EventKind
  message: string
  service: string
  startMs: number
  durationMs: number
  status: EventStatus
  level: EventLevel
  attributes: Record<string, string>
  addedAtTick: number
}

export interface PreviewTrace {
  id: string
  events: PreviewEvent[]
}

export interface PreviewState {
  now: number
  tick: number
  nextSequence: number
  traces: PreviewTrace[]
}

export interface PreviewRow {
  event: PreviewEvent
  depth: number
  hasChildren: boolean
  childCount: number
}

export interface PreviewFilters {
  search: string
  service: string
  errorsOnly: boolean
}

export const MAX_TRACES = 24

function hexId(value: bigint, length: number): string {
  return BigInt.asUintN(length * 4, value)
    .toString(16)
    .padStart(length, "0")
}

function createTrace(
  sequence: number,
  startMs: number,
  firstTick: number,
  phase: number,
  seeded = false,
): PreviewTrace {
  const id = `trace-${sequence}`
  const traceId = hexId(
    0x4bf92f3577b34da6a3ce929d0e0e4736n + BigInt(sequence) * 0x9e3779b97f4a7c15n,
    32,
  )
  const checkout = sequence % 2 === 1
  const failed = sequence % 4 === 0
  const operationDuration = failed ? 900 : 320 + ((sequence * 37) % 360)
  const events: PreviewEvent[] = []

  function span(
    key: string,
    parentId: string | null,
    message: string,
    service: string,
    step: number,
    offset: number,
    completedDuration: number,
    error: boolean,
    attributes: Record<string, string>,
  ): PreviewEvent {
    const running = phase < 3
    const event: PreviewEvent = {
      id: key ? `${id}-${key}` : id,
      traceId,
      spanId: hexId(
        0x00f067aa0ba902b7n + BigInt(sequence) * 0x9e3779b97f4a7c15n + BigInt(events.length),
        16,
      ),
      parentId,
      kind: "span",
      message,
      service,
      startMs: startMs + offset,
      durationMs: running ? Math.max(0, phase * 1000 - offset) : completedDuration,
      status: running ? "running" : error ? "error" : "ok",
      level: "info",
      attributes,
      addedAtTick: seeded ? 0 : firstTick + step,
    }
    if (phase >= step) events.push(event)
    return event
  }

  function log(
    key: string,
    parent: PreviewEvent,
    message: string,
    step: number,
    offset: number,
    level: EventLevel = "info",
    attributes: Record<string, string> = {},
  ) {
    if (phase < step) return
    events.push({
      id: `${id}-${key}`,
      traceId,
      spanId: parent.spanId,
      parentId: parent.id,
      kind: "log",
      message,
      service: parent.service,
      startMs: startMs + offset,
      durationMs: 0,
      status: level === "error" ? "error" : "ok",
      level,
      attributes,
      addedAtTick: seeded ? 0 : firstTick + step,
    })
  }

  const root = span(
    "",
    null,
    checkout ? "POST /checkout" : "POST /api/chat",
    "api",
    0,
    0,
    3000,
    failed,
    {
      "http.request.method": "POST",
      "url.path": checkout ? "/checkout" : "/api/chat",
      "request.id": `req-${sequence.toString().padStart(6, "0")}`,
      "client.address": `10.0.1.${10 + (sequence % 80)}`,
    },
  )
  log("received", root, "Request received", 0, 0)

  const handler = span(
    "handler",
    root.id,
    checkout ? "handle_checkout" : "agent.run",
    "worker",
    1,
    1000,
    2000,
    failed,
    checkout
      ? { "order.id": `ord-${10400 + sequence}`, "cart.items": String(1 + (sequence % 5)) }
      : { "agent.name": "support-assistant", "conversation.id": `conv-${2000 + sequence}` },
  )
  log(
    "context",
    handler,
    checkout ? "Validating cart and delivery address" : "Loading conversation context",
    1,
    1000,
    "debug",
  )

  const operation = span(
    "operation",
    handler.id,
    checkout ? "inventory.reserve" : "llm.generate",
    checkout ? "worker" : "openai",
    2,
    2000,
    operationDuration,
    failed,
    checkout
      ? { "inventory.sku": `SKU-${100 + (sequence % 12)}`, "warehouse.name": "eu-west-1" }
      : {
          "gen_ai.system": "openai",
          "gen_ai.request.model": "gpt-4.1-mini",
          "gen_ai.usage.input_tokens": String(820 + sequence * 13),
          "gen_ai.usage.output_tokens": failed ? "0" : String(120 + sequence * 3),
        },
  )
  log(
    "progress",
    operation,
    checkout ? "Checking available stock" : "Sending completion request to OpenAI",
    2,
    2000,
    "debug",
  )

  const secondary = span(
    "secondary",
    handler.id,
    checkout ? "SELECT stock FROM inventory WHERE sku = $1" : "tool.execute",
    checkout ? "postgres" : "worker",
    3,
    2400,
    110 + ((sequence * 19) % 260),
    false,
    checkout
      ? { "db.system": "postgresql", "db.namespace": "shop", "db.operation.name": "SELECT" }
      : { "tool.name": "search_knowledge_base", "tool.results": String(2 + (sequence % 4)) },
  )
  log(
    "result",
    secondary,
    checkout ? "Inventory query returned 1 row" : "Knowledge search returned relevant documents",
    3,
    2450,
    "info",
  )
  log(
    "operation-result",
    operation,
    failed
      ? "OpenAI rate limit exceeded; retry budget exhausted"
      : checkout
        ? "Inventory reserved successfully"
        : "Completion generated successfully",
    3,
    2000 + operationDuration - 10,
    failed ? "error" : "info",
    failed ? { "error.type": "RateLimitError", "http.response.status_code": "429" } : {},
  )
  log(
    "finished",
    handler,
    failed
      ? "Request failed with upstream error"
      : checkout
        ? "Checkout completed"
        : "Response ready",
    3,
    3000,
    failed ? "warn" : "info",
  )
  return { id, events }
}

export function createPreviewState(now: number): PreviewState {
  return {
    now,
    tick: 0,
    nextSequence: MAX_TRACES + 1,
    traces: Array.from({ length: MAX_TRACES }, (_, index) =>
      createTrace(index + 1, now - 270_000 + index * 11_500, 0, 3, true),
    ),
  }
}

export function advancePreview(state: PreviewState): PreviewState {
  const tick = state.tick + 1
  const now = state.now + 1000
  let nextSequence = state.nextSequence
  const traces = state.traces.map((trace) => {
    const root = trace.events[0]
    if (root?.status !== "running") return trace
    const previous = new Map(trace.events.map((event) => [event.id, event]))
    const updated = createTrace(
      nextSequence - 1,
      root.startMs,
      root.addedAtTick,
      Math.min(3, tick - root.addedAtTick),
    )
    return {
      ...updated,
      events: updated.events.map((event) => {
        const existing = previous.get(event.id)
        return existing && existing.status !== "running" ? existing : event
      }),
    }
  })
  if ((tick - 1) % 4 === 0) {
    traces.push(createTrace(nextSequence, now, tick, 0))
    nextSequence += 1
  }
  return { now, tick, nextSequence, traces: traces.slice(-MAX_TRACES) }
}

export function durationMs(event: PreviewEvent, now: number): number {
  return event.status === "running" ? Math.max(0, now - event.startMs) : event.durationMs
}

function chronological(a: PreviewEvent, b: PreviewEvent): number {
  return a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function isError(event: PreviewEvent): boolean {
  return event.status === "error" || event.level === "error"
}

export function flattenPreview(
  traces: PreviewTrace[],
  expanded: ReadonlySet<string>,
  filters: PreviewFilters,
): PreviewRow[] {
  const byId = new Map<string, PreviewEvent>()
  const errorContext = new Set<string>()
  for (const trace of traces) {
    const failed = trace.events.some(isError)
    for (const event of trace.events) {
      if (!byId.has(event.id)) byId.set(event.id, event)
      if (failed) errorContext.add(event.id)
    }
  }
  const events = [...byId.values()].sort(chronological)
  const parents = new Map(
    events.map((event) => [
      event.id,
      event.parentId !== event.id && event.parentId && byId.has(event.parentId)
        ? event.parentId
        : null,
    ]),
  )

  // Break one edge per cycle, so every node belongs to a finite tree.
  const settled = new Set<string>()
  for (const event of events) {
    const path = new Set<string>()
    let id: string | null = event.id
    while (id !== null && !settled.has(id)) {
      if (path.has(id)) {
        parents.set(id, null)
        break
      }
      path.add(id)
      id = parents.get(id) ?? null
    }
    for (const visited of path) settled.add(visited)
  }

  const children = new Map<string | null, PreviewEvent[]>()
  for (const event of events) {
    const parent = parents.get(event.id) ?? null
    const siblings = children.get(parent) ?? []
    siblings.push(event)
    children.set(parent, siblings)
  }

  const search = filters.search.toLowerCase()
  const service = filters.service === "all" ? "" : filters.service
  const fieldFilters = search !== "" || service !== ""
  const retained = new Set<string>()
  const forcedOpen = new Set<string>()
  function retainPath(event: PreviewEvent) {
    retained.add(event.id)
    let parent = parents.get(event.id) ?? null
    while (parent !== null) {
      retained.add(parent)
      forcedOpen.add(parent)
      parent = parents.get(parent) ?? null
    }
  }
  for (const event of events) {
    if (filters.errorsOnly && !errorContext.has(event.id)) continue
    if (fieldFilters) {
      if (service && event.service !== service) continue
      const values = [
        event.message,
        event.service,
        event.traceId,
        ...Object.entries(event.attributes).flat(),
      ]
      if (search && !values.some((value) => value.toLowerCase().includes(search))) continue
      retainPath(event)
    } else {
      retained.add(event.id)
      if (filters.errorsOnly && isError(event)) retainPath(event)
    }
  }

  const rows: PreviewRow[] = []
  const stack = (children.get(null) ?? []).map((event) => ({ event, depth: 0 })).reverse()
  while (stack.length > 0) {
    const item = stack.pop()
    if (!item || !retained.has(item.event.id)) continue
    const descendants = children.get(item.event.id) ?? []
    rows.push({ ...item, hasChildren: descendants.length > 0, childCount: descendants.length })
    if (!expanded.has(item.event.id) && !forcedOpen.has(item.event.id)) continue
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      stack.push({ event: descendants[index], depth: Math.min(16, item.depth + 1) })
    }
  }
  return rows
}
