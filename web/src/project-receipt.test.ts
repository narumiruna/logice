import { afterEach, describe, expect, it, vi } from "vitest"
import { observeReceipt } from "./project-receipt"
import { setupInstructions } from "./project-setup"

const window = { from: "2026-10-24T00:00:00Z", to: "2026-10-24T00:02:00Z" }
afterEach(() => vi.useRealTimers())
describe("project receipt observation", () => {
  it("checks at most once every five seconds in a frozen window and stops at two minutes", async () => {
    vi.useFakeTimers()
    const query = vi.fn().mockResolvedValue(false)
    const report = vi.fn()
    const done = observeReceipt(new AbortController().signal, window, report, query)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(query).toHaveBeenCalledTimes(24)
    expect(query.mock.calls.every(([value]) => value === window)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(report).toHaveBeenLastCalledWith("timeout")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("does not attribute stored data to a token and stops on success", async () => {
    vi.useFakeTimers()
    const report = vi.fn()
    await observeReceipt(
      new AbortController().signal,
      window,
      report,
      vi.fn().mockResolvedValue(true),
    )
    expect(report).toHaveBeenLastCalledWith("observed")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("cancels pending delays without another request", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const query = vi.fn().mockResolvedValue(false)
    const report = vi.fn()
    const done = observeReceipt(controller.signal, window, report, query)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    await done
    await vi.advanceTimersByTimeAsync(120_000)
    expect(query).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenLastCalledWith("stopped")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("reports storage errors instead of an empty or healthy result", async () => {
    vi.useFakeTimers()
    const report = vi.fn()
    await observeReceipt(
      new AbortController().signal,
      window,
      report,
      vi.fn().mockRejectedValue(new Error("unavailable")),
    )
    expect(report).toHaveBeenLastCalledWith("error")
    expect(vi.getTimerCount()).toBe(0)
  })
  it("ignores late success from an abort-ignoring request", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const report = vi.fn()
    let resolve: (value: boolean) => void = () => {}
    const done = observeReceipt(
      controller.signal,
      window,
      report,
      () =>
        new Promise<boolean>((r) => {
          resolve = r
        }),
    )
    await vi.advanceTimersByTimeAsync(120_000)
    expect(report).toHaveBeenLastCalledWith("timeout")
    resolve(true)
    await done
    expect(report.mock.calls.some(([value]) => value === "observed")).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("generates only placeholder configuration, not a token", () => {
    const text = setupInstructions("https://logice.example")
    expect(text).toContain("http/protobuf")
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The shell placeholder must remain literal.
    expect(text).toContain("${LOGICE_PROJECT_TOKEN}")
    expect(text).not.toContain("OTLP_TOKEN=")
    expect(text).not.toContain("/v1/traces")
  })
})
