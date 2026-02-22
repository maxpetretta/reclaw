import { beforeAll, beforeEach, describe, expect, it } from "bun:test"

import { enqueueSpawnResult, getSpawnCalls, resetSpawnMock } from "../../test/spawn-mock"

let openclaw: typeof import("../openclaw")

describe("openclaw", () => {
  beforeAll(async () => {
    openclaw = await import("../openclaw")
  })

  beforeEach(() => {
    resetSpawnMock()
  })

  it("wraps ENOENT errors as CLI_NOT_FOUND", () => {
    const cliNotFoundError = Object.assign(new Error("not found"), { code: "ENOENT" })
    enqueueSpawnResult({ error: cliNotFoundError })

    expect(() => openclaw.runOpenClaw(["cron", "runs"])).toThrow("[CLI_NOT_FOUND]")
  })

  it("throws command failures for non-zero exit status", () => {
    enqueueSpawnResult({ status: 2, stdout: "", stderr: "failed command" })
    expect(() => openclaw.runOpenClaw(["cron", "runs"])).toThrow("[COMMAND_FAILED]")
  })

  it("schedules with legacy mode when legacy cron add succeeds", async () => {
    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-legacy"}', stderr: "" })

    const scheduled = await openclaw.scheduleSubagentCronJob({
      message: "summarize this",
      model: "gpt-5",
    })

    expect(scheduled).toEqual({ jobId: "job-legacy", mode: "legacy" })
    const calls = getSpawnCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toContain("cron")
    expect(calls[0]?.args).toContain("add")
  })

  it("falls back to compatible mode after legacy failures", async () => {
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler === "function") {
        handler()
      }

      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      enqueueSpawnResult({ status: 1, stdout: "", stderr: "legacy failed (1)" })
      enqueueSpawnResult({ status: 1, stdout: "", stderr: "legacy failed (2)" })
      enqueueSpawnResult({ status: 1, stdout: "", stderr: "legacy failed (3)" })
      enqueueSpawnResult({ status: 0, stdout: '{"id":"job-compatible"}', stderr: "" })

      const scheduled = await openclaw.scheduleSubagentCronJob({
        message: "summarize this",
        model: "gpt-5",
      })

      expect(scheduled).toEqual({ jobId: "job-compatible", mode: "compatible" })
      expect(getSpawnCalls()).toHaveLength(4)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it("returns summary when cron run finished with ok status", async () => {
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "ok", summary: "done", ts: 1 }],
      }),
      stderr: "",
    })

    await expect(openclaw.waitForCronSummary("job-1", 200)).resolves.toBe("done")
  })

  it("returns summary on delivery-target failure when summary is present", async () => {
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [
          {
            action: "finished",
            status: "error",
            summary: "partial summary",
            error: "cron delivery target is missing",
            ts: 2,
          },
        ],
      }),
      stderr: "",
    })

    await expect(openclaw.waitForCronSummary("job-2", 200)).resolves.toBe("partial summary")
  })

  it("throws scheduling failure when legacy and compatible scheduling both fail", async () => {
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler === "function") {
        handler()
      }

      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      for (let index = 0; index < 6; index += 1) {
        enqueueSpawnResult({ status: 1, stdout: "", stderr: `failed-${index}` })
      }

      await expect(openclaw.scheduleSubagentCronJob({ message: "x" })).rejects.toThrow("[SCHEDULING_FAILED]")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it("throws on non-delivery finished errors", async () => {
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "error", summary: "bad", error: "real failure", ts: 1 }],
      }),
      stderr: "",
    })

    await expect(openclaw.waitForCronSummary("job-3", 200)).rejects.toThrow("[JOB_FAILED]")
  })

  it("times out when no finished entry appears", async () => {
    await expect(openclaw.waitForCronSummary("job-4", 0)).rejects.toThrow("[TIMEOUT]")
  })

  it("swallows cleanup failures when removing cron jobs", () => {
    expect(() => openclaw.removeCronJob("job-5")).not.toThrow()
  })

  it("wraps unexpected thrown errors during retries", async () => {
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler === "function") {
        handler()
      }

      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      await expect(openclaw.scheduleSubagentCronJob({ message: "no-spawn-results" })).rejects.toThrow(
        "[COMMAND_FAILED]",
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })
})
