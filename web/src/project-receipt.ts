import { fetchList } from "./api"

export type ReceiptState = "observing" | "observed" | "timeout" | "error" | "stopped"
export interface ReceiptWindow {
  from: string
  to: string
}

export async function queryReceipt(window: ReceiptWindow, signal: AbortSignal): Promise<boolean> {
  const filters = {
    ...window,
    service: "",
    search: "",
    limit: 1,
    errorsOnly: false,
    minSeverity: 0,
    traceId: "",
  }
  const results = await Promise.allSettled([
    fetchList("traces", filters, signal),
    fetchList("logs", filters, signal),
  ])
  signal.throwIfAborted()
  if (results.some((result) => result.status === "fulfilled" && result.value.items.length > 0))
    return true
  const failure = results.find((result) => result.status === "rejected")
  if (failure) throw failure.reason
  return false
}

// A fixed observation window is not proof of a particular token's use.
export async function observeReceipt(
  parent: AbortSignal,
  window: ReceiptWindow,
  report: (state: ReceiptState) => void,
  query = queryReceipt,
): Promise<void> {
  const controller = new AbortController()
  let expired = false
  let delay: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const stop = () => {
    controller.abort()
    if (delay) clearTimeout(delay)
    wake?.()
  }
  const deadline = setTimeout(() => {
    expired = true
    stop()
    if (!parent.aborted) report("timeout")
  }, 120_000)
  parent.addEventListener("abort", stop, { once: true })
  if (parent.aborted) stop()
  try {
    report("observing")
    while (!controller.signal.aborted) {
      if (await query(window, controller.signal)) {
        if (!controller.signal.aborted) report("observed")
        return
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        delay = setTimeout(resolve, 5_000)
        if (controller.signal.aborted) resolve()
      })
    }
  } catch {
    if (!controller.signal.aborted) {
      report("error")
      return
    }
  } finally {
    clearTimeout(deadline)
    if (delay) clearTimeout(delay)
    parent.removeEventListener("abort", stop)
    if (controller.signal.aborted) report(expired ? "timeout" : "stopped")
    controller.abort()
  }
}
