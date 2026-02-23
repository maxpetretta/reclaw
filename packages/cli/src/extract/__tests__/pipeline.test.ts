import { beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enqueueSpawnResult, resetSpawnMock, setSpawnHook } from "../../test/spawn-mock"
import type { NormalizedConversation } from "../../types"
import type { ProviderConversations } from "../pipeline"

let pipeline: typeof import("../pipeline")

describe("pipeline", () => {
  beforeAll(async () => {
    pipeline = await import("../pipeline")
  })

  beforeEach(() => {
    resetSpawnMock()
    setSpawnHook(undefined)
  })

  it("groups conversations into local-day batches with deterministic ordering", () => {
    const conversations: ProviderConversations = {
      chatgpt: [
        buildConversation("chatgpt", "c2", localIso(2026, 2, 20, 12, 0)),
        buildConversation("chatgpt", "c1", localIso(2026, 2, 20, 9, 0)),
      ],
      claude: [],
      grok: [buildConversation("grok", "g1", localIso(2026, 2, 21, 11, 0))],
    }

    const plan = pipeline.planExtractionBatches({
      providerConversations: conversations,
      selectedProviders: ["chatgpt", "grok"],
    })

    expect(plan.conversationCount).toBe(3)
    expect(plan.batches).toHaveLength(2)
    expect(plan.batches[0]?.conversations.map((entry) => entry.id)).toEqual(["c1", "c2"])
    expect(plan.batches[1]?.conversations.map((entry) => entry.id)).toEqual(["g1"])
  })

  it("runs extraction end-to-end with mocked openclaw CLI responses", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-pipeline-test-"))
    const statePath = join(tempDir, "state.json")
    const targetPath = join(tempDir, "workspace")
    const providerConversations: ProviderConversations = {
      chatgpt: [buildConversation("chatgpt", "c1", localIso(2026, 2, 20, 10, 0))],
      claude: [],
      grok: [],
    }

    await mkdir(targetPath, { recursive: true })
    await writeFile(join(targetPath, "MEMORY.md"), "baseline memory", "utf8")
    await writeFile(join(targetPath, "USER.md"), "baseline user", "utf8")

    let mainDocWriteCount = 0
    setSpawnHook((_, args) => {
      const jobIdIndex = args.indexOf("--id")
      const jobId = jobIdIndex >= 0 ? args[jobIdIndex + 1] : undefined
      if (jobId === "job-main") {
        mainDocWriteCount += 1
        const suffix = `run-${mainDocWriteCount}`
        void writeFile(
          join(targetPath, "MEMORY.md"),
          `<!-- reclaw-memory:start -->\n${suffix}\n<!-- reclaw-memory:end -->\n`,
          "utf8",
        )
        void writeFile(
          join(targetPath, "USER.md"),
          `<!-- reclaw-user:start -->\n${suffix}\n<!-- reclaw-user:end -->\n`,
          "utf8",
        )
      }
    })

    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-batch"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "ok", summary: '{"summary":"Batch summary"}', ts: 1 }],
      }),
      stderr: "",
    })
    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-main"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "ok", summary: "ok", ts: 2 }],
      }),
      stderr: "",
    })

    const result = await pipeline.runExtractionPipeline({
      providerConversations,
      selectedProviders: ["chatgpt"],
      mode: "openclaw",
      model: "gpt-5",
      targetPath,
      statePath,
      maxParallelJobs: 1,
    })

    expect(result.totalBatches).toBe(1)
    expect(result.processedBatches).toBe(1)
    expect(result.failedBatches).toBe(0)
    expect(await readFile(statePath, "utf8")).toContain("Batch summary")
    expect(await readFile(join(targetPath, "memory", "2026-02-20.md"), "utf8")).toContain(
      "# Reclaw Memory Import 2026-02-20",
    )

    const savedState = JSON.parse(await readFile(statePath, "utf8")) as {
      completed?: Record<string, Record<string, unknown>>
    }
    const completedEntries = Object.values(savedState.completed ?? {})
    const firstCompleted = completedEntries[0]
    if (firstCompleted) {
      firstCompleted.provider = "invalid-provider"
      firstCompleted.providers = ["chatgpt", "invalid-provider"]
      firstCompleted.conversationRefs = [
        null,
        {},
        { id: 123 },
        { id: "c1", provider: "invalid-provider" },
        { id: "c1", provider: "chatgpt", timestamp: "2026-02-20T10:00:00.000Z" },
        { id: "c2", provider: "chatgpt" },
      ]
      firstCompleted.extraction = {}
    }
    await writeFile(statePath, JSON.stringify(savedState), "utf8")

    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-main"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "ok", summary: "ok", ts: 3 }],
      }),
      stderr: "",
    })

    const resumed = await pipeline.runExtractionPipeline({
      providerConversations,
      selectedProviders: ["chatgpt"],
      mode: "openclaw",
      model: "gpt-5",
      targetPath,
      statePath,
      maxParallelJobs: 1,
    })
    expect(resumed.processedBatches).toBe(0)
    expect(resumed.skippedBatches).toBe(1)
  })

  it("reports failed batches and throws when no batch succeeds", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-pipeline-failure-test-"))
    const statePath = join(tempDir, "state.json")
    const targetPath = join(tempDir, "workspace")
    await mkdir(targetPath, { recursive: true })
    await writeFile(join(targetPath, "MEMORY.md"), "baseline memory", "utf8")
    await writeFile(join(targetPath, "USER.md"), "baseline user", "utf8")

    const providerConversations: ProviderConversations = {
      chatgpt: [buildConversation("chatgpt", "bad-1", localIso(2026, 2, 22, 10, 0))],
      claude: [],
      grok: [],
    }

    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-bad"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "error", summary: "failed", error: "subagent failed", ts: 1 }],
      }),
      stderr: "",
    })
    enqueueSpawnResult({ status: 0, stdout: "", stderr: "" }) // cron rm best-effort cleanup

    await expect(
      pipeline.runExtractionPipeline({
        providerConversations,
        selectedProviders: ["chatgpt"],
        mode: "openclaw",
        model: "gpt-5",
        targetPath,
        statePath,
        maxParallelJobs: 0,
      }),
    ).rejects.toThrow("Extraction produced no successful batch results.")
  })

  it("rebuilds state when existing state file shape is invalid", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-pipeline-invalid-state-test-"))
    const statePath = join(tempDir, "state.json")
    const targetPath = join(tempDir, "workspace")
    await mkdir(targetPath, { recursive: true })
    await writeFile(join(targetPath, "MEMORY.md"), "baseline memory", "utf8")
    await writeFile(join(targetPath, "USER.md"), "baseline user", "utf8")
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        runKey: "stale-run",
        mode: "invalid-mode",
        model: "old",
        targetPath: "/tmp/old",
        createdAt: "x",
        updatedAt: "x",
        completed: [],
      }),
      "utf8",
    )

    setSpawnHook((_, args) => {
      const idIndex = args.indexOf("--id")
      const jobId = idIndex >= 0 ? args[idIndex + 1] : undefined
      if (jobId === "job-main") {
        void writeFile(
          join(targetPath, "MEMORY.md"),
          "<!-- reclaw-memory:start -->\nrebuilt\n<!-- reclaw-memory:end -->\n",
          "utf8",
        )
        void writeFile(
          join(targetPath, "USER.md"),
          "<!-- reclaw-user:start -->\nrebuilt\n<!-- reclaw-user:end -->\n",
          "utf8",
        )
      }
    })

    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-batch"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "ok", summary: '{"summary":"Recovered"}', ts: 1 }],
      }),
      stderr: "",
    })
    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-main"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "ok", summary: "ok", ts: 2 }],
      }),
      stderr: "",
    })

    const providerConversations: ProviderConversations = {
      chatgpt: [buildConversation("chatgpt", "recovered", localIso(2026, 2, 23, 9, 0))],
      claude: [],
      grok: [],
    }

    const result = await pipeline.runExtractionPipeline({
      providerConversations,
      selectedProviders: ["chatgpt"],
      mode: "openclaw",
      model: "gpt-5",
      targetPath,
      statePath,
      maxParallelJobs: 1,
    })

    expect(result.processedBatches).toBe(1)
    expect(await readFile(statePath, "utf8")).toContain('"runKey"')
  })

  it("writes zettel journals to vault but updates memory docs in the workspace path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-pipeline-zettel-paths-test-"))
    const statePath = join(tempDir, "state.json")
    const targetPath = join(tempDir, "vault")
    const memoryWorkspacePath = join(tempDir, "workspace")
    await mkdir(targetPath, { recursive: true })
    await mkdir(memoryWorkspacePath, { recursive: true })
    await writeFile(join(memoryWorkspacePath, "MEMORY.md"), "baseline memory", "utf8")
    await writeFile(join(memoryWorkspacePath, "USER.md"), "baseline user", "utf8")

    setSpawnHook((_, args) => {
      const idIndex = args.indexOf("--id")
      const jobId = idIndex >= 0 ? args[idIndex + 1] : undefined
      if (jobId === "job-main") {
        void writeFile(
          join(memoryWorkspacePath, "MEMORY.md"),
          "<!-- reclaw-memory:start -->\nworkspace memory\n<!-- reclaw-memory:end -->\n",
          "utf8",
        )
        void writeFile(
          join(memoryWorkspacePath, "USER.md"),
          "<!-- reclaw-user:start -->\nworkspace user\n<!-- reclaw-user:end -->\n",
          "utf8",
        )
      }
    })

    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-batch"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "ok", summary: '{"summary":"Batch summary"}', ts: 1 }],
      }),
      stderr: "",
    })
    enqueueSpawnResult({ status: 0, stdout: '{"id":"job-main"}', stderr: "" })
    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        entries: [{ action: "finished", status: "ok", summary: "ok", ts: 2 }],
      }),
      stderr: "",
    })

    const result = await pipeline.runExtractionPipeline({
      providerConversations: {
        chatgpt: [buildConversation("chatgpt", "c1", localIso(2026, 2, 24, 10, 0))],
        claude: [],
        grok: [],
      },
      selectedProviders: ["chatgpt"],
      mode: "zettelclaw",
      model: "gpt-5",
      targetPath,
      memoryWorkspacePath,
      statePath,
      maxParallelJobs: 1,
    })

    expect(result.failedBatches).toBe(0)
    expect(await readFile(join(targetPath, "03 Journal", "2026-02-24.md"), "utf8")).toContain("## Sessions")
    expect(await readFile(join(memoryWorkspacePath, "MEMORY.md"), "utf8")).toContain("workspace memory")
    expect(await readFile(join(memoryWorkspacePath, "USER.md"), "utf8")).toContain("workspace user")
    await expect(readFile(join(targetPath, "MEMORY.md"), "utf8")).rejects.toThrow()
    await expect(readFile(join(targetPath, "USER.md"), "utf8")).rejects.toThrow()
  })
})

function buildConversation(
  source: NormalizedConversation["source"],
  id: string,
  createdAt: string,
): NormalizedConversation {
  return {
    id,
    source,
    title: id,
    createdAt,
    updatedAt: createdAt,
    messageCount: 1,
    messages: [{ role: "human", content: `message-${id}`, timestamp: createdAt }],
  }
}

function localIso(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString()
}
