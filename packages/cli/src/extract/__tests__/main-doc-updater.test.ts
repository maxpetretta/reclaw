import { beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { writeFileSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enqueueSpawnResult, getSpawnCalls, resetSpawnMock, setSpawnHook } from "../../test/spawn-mock"
import type { MainAgentDocUpdateOptions } from "../main-doc-updater"

let updater: typeof import("../main-doc-updater")

describe("updateMemoryAndUserWithMainAgent", () => {
  beforeAll(async () => {
    updater = await import("../main-doc-updater")
  })

  beforeEach(() => {
    resetSpawnMock()
    setSpawnHook(undefined)
  })

  it("succeeds when both managed sections are written and files changed", async () => {
    const targetPath = await mkdtemp(join(tmpdir(), "reclaw-main-doc-test-"))
    const memoryPath = join(targetPath, "MEMORY.md")
    const userPath = join(targetPath, "USER.md")
    await writeFile(memoryPath, "old memory", "utf8")
    await writeFile(userPath, "old user", "utf8")

    setSpawnHook((_, args) => {
      const idIndex = args.indexOf("--id")
      const jobId = idIndex >= 0 ? args[idIndex + 1] : ""
      if (jobId === "job-1") {
        writeFileSync(
          memoryPath,
          "<!-- reclaw-memory:start -->\nUpdated: 2026-02-22T12:00:00.000Z\n<!-- reclaw-memory:end -->\n",
          "utf8",
        )
        writeFileSync(userPath, "<!-- reclaw-user:start -->\n- critical context\n<!-- reclaw-user:end -->\n", "utf8")
      }
    })

    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-1"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({ entries: [{ action: "finished", status: "ok", summary: "done", ts: 1 }] }),
      stderr: "",
    })

    await updater.updateMemoryAndUserWithMainAgent(buildOptions(targetPath, memoryPath, userPath))
  })

  it("throws when managed section markers are missing", async () => {
    const targetPath = await mkdtemp(join(tmpdir(), "reclaw-main-doc-test-"))
    const memoryPath = join(targetPath, "MEMORY.md")
    const userPath = join(targetPath, "USER.md")
    await writeFile(memoryPath, "old memory", "utf8")
    await writeFile(userPath, "old user", "utf8")

    setSpawnHook((_, args) => {
      const idIndex = args.indexOf("--id")
      const jobId = idIndex >= 0 ? args[idIndex + 1] : ""
      if (jobId === "job-1") {
        writeFileSync(memoryPath, "no marker here", "utf8")
        writeFileSync(userPath, "<!-- reclaw-user:start -->ok<!-- reclaw-user:end -->", "utf8")
      }
    })

    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-1"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({ entries: [{ action: "finished", status: "ok", summary: "done", ts: 1 }] }),
      stderr: "",
    })

    await expect(
      updater.updateMemoryAndUserWithMainAgent(buildOptions(targetPath, memoryPath, userPath)),
    ).rejects.toThrow("required managed section markers")
  })

  it("throws when files are unchanged after successful run", async () => {
    const targetPath = await mkdtemp(join(tmpdir(), "reclaw-main-doc-test-"))
    const memoryPath = join(targetPath, "MEMORY.md")
    const userPath = join(targetPath, "USER.md")
    const stableMemory = "<!-- reclaw-memory:start -->\nsame\n<!-- reclaw-memory:end -->\n"
    const stableUser = "<!-- reclaw-user:start -->\nsame\n<!-- reclaw-user:end -->\n"
    await writeFile(memoryPath, stableMemory, "utf8")
    await writeFile(userPath, stableUser, "utf8")

    setSpawnHook((_, args) => {
      const idIndex = args.indexOf("--id")
      const jobId = idIndex >= 0 ? args[idIndex + 1] : ""
      if (jobId === "job-1") {
        writeFileSync(memoryPath, stableMemory, "utf8")
        writeFileSync(userPath, stableUser, "utf8")
      }
    })

    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-1"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({ entries: [{ action: "finished", status: "ok", summary: "done", ts: 1 }] }),
      stderr: "",
    })

    await expect(
      updater.updateMemoryAndUserWithMainAgent(buildOptions(targetPath, memoryPath, userPath)),
    ).rejects.toThrow("did not modify expected files")
  })

  it("cleans up cron job when summary polling fails", async () => {
    const targetPath = await mkdtemp(join(tmpdir(), "reclaw-main-doc-test-"))
    const memoryPath = join(targetPath, "MEMORY.md")
    const userPath = join(targetPath, "USER.md")
    await writeFile(memoryPath, "old memory", "utf8")
    await writeFile(userPath, "old user", "utf8")

    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-1"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "error", summary: "bad", error: "real failure", ts: 1 }],
      }),
      stderr: "",
    })

    await expect(
      updater.updateMemoryAndUserWithMainAgent(buildOptions(targetPath, memoryPath, userPath)),
    ).rejects.toThrow("Main agent doc update failed")
    expect(getSpawnCalls().some((entry) => entry.args[0] === "cron" && entry.args[1] === "rm")).toBeTrue()
  })
})

function buildOptions(targetPath: string, memoryFilePath: string, userFilePath: string): MainAgentDocUpdateOptions {
  return {
    mode: "openclaw",
    targetPath,
    memoryWorkspacePath: targetPath,
    model: "gpt-5",
    insights: {
      summary: "summary",
      interests: [],
      projects: [],
      facts: [],
      preferences: [],
      people: [],
      decisions: [],
    },
    batchResults: [],
    memoryFilePath,
    userFilePath,
  }
}
