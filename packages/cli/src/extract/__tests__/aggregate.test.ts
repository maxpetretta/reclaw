import { beforeEach, describe, expect, it } from "bun:test"
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enqueueSpawnResult, resetSpawnMock, setSpawnHook } from "../../test/spawnMock"
import { writeExtractionArtifacts } from "../aggregate"
import type { BatchExtractionResult } from "../contracts"

describe("writeExtractionArtifacts", () => {
  beforeEach(() => {
    resetSpawnMock()
    setSpawnHook(undefined)
  })

  it("writes openclaw daily memory files and backups", async () => {
    const targetPath = await mkdtemp(join(tmpdir(), "reclaw-aggregate-test-"))
    await mkdir(join(targetPath, "memory"), { recursive: true })
    await writeFile(join(targetPath, "MEMORY.md"), "old memory", "utf8")
    await writeFile(join(targetPath, "USER.md"), "old user", "utf8")

    setSpawnHook((_, args) => {
      const idIndex = args.indexOf("--id")
      const jobId = idIndex >= 0 ? args[idIndex + 1] : ""
      if (jobId === "job-main") {
        writeFileSync(
          join(targetPath, "MEMORY.md"),
          "<!-- reclaw-memory:start -->\nupdated\n<!-- reclaw-memory:end -->\n",
          "utf8",
        )
        writeFileSync(
          join(targetPath, "USER.md"),
          "<!-- reclaw-user:start -->\nupdated\n<!-- reclaw-user:end -->\n",
          "utf8",
        )
      }
    })
    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-main"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({ entries: [{ action: "finished", status: "ok", summary: "done", ts: 1 }] }),
      stderr: "",
    })

    const result = await writeExtractionArtifacts([batch("chatgpt"), batch("claude")], {
      mode: "openclaw",
      targetPath,
      model: "gpt-5",
      backupMode: "overwrite",
    })

    expect(result.outputFiles).toEqual([join(targetPath, "memory", "2026-02-22.md")])
    expect(await readFile(join(targetPath, "MEMORY.md.bak"), "utf8")).toBe("old memory")
    expect(await readFile(join(targetPath, "USER.md.bak"), "utf8")).toBe("old user")

    const daily = await readFile(join(targetPath, "memory", "2026-02-22.md"), "utf8")
    expect(daily).toContain("# Reclaw Import 2026-02-22")
    expect(daily).toContain("## Sessions")
  })

  it("writes zettel artifacts and timestamped backups", async () => {
    const targetPath = await mkdtemp(join(tmpdir(), "reclaw-aggregate-zettel-test-"))
    await writeFile(join(targetPath, "MEMORY.md"), "old memory", "utf8")
    await writeFile(join(targetPath, "USER.md"), "old user", "utf8")

    setSpawnHook((_, args) => {
      const idIndex = args.indexOf("--id")
      const jobId = idIndex >= 0 ? args[idIndex + 1] : ""
      if (jobId === "job-main") {
        writeFileSync(
          join(targetPath, "MEMORY.md"),
          "<!-- reclaw-memory:start -->\nupdated-z\n<!-- reclaw-memory:end -->\n",
          "utf8",
        )
        writeFileSync(
          join(targetPath, "USER.md"),
          "<!-- reclaw-user:start -->\nupdated-z\n<!-- reclaw-user:end -->\n",
          "utf8",
        )
      }
    })
    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-main"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({ entries: [{ action: "finished", status: "ok", summary: "done", ts: 2 }] }),
      stderr: "",
    })

    const result = await writeExtractionArtifacts([batch("grok")], {
      mode: "zettelclaw",
      targetPath,
      model: "gpt-5",
      backupMode: "timestamped",
    })

    expect(result.outputFiles).toEqual([join(targetPath, "03 Journal", "2026-02-22.md")])
    const files = await readdir(targetPath)
    expect(files.some((entry) => /^MEMORY\.md\.bak\.\d{8}-\d{6}-\d{3}$/.test(entry))).toBeTrue()
    expect(files.some((entry) => /^USER\.md\.bak\.\d{8}-\d{6}-\d{3}$/.test(entry))).toBeTrue()
  })
})

function batch(provider: BatchExtractionResult["providers"][number]): BatchExtractionResult {
  return {
    batchId: `${provider}-b1`,
    providers: [provider],
    date: "2026-02-22",
    conversationIds: [`${provider}-1`],
    conversationRefs: [{ provider, id: `${provider}-1`, timestamp: "2026-02-22T11:00:00.000Z" }],
    conversationCount: 1,
    extraction: {
      summary: "decision: Ship v1; fact: Uses bun test; interest: Reliability",
    },
  }
}
