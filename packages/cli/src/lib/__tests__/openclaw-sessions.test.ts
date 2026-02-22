import { beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enqueueSpawnResult, resetSpawnMock } from "../../test/spawn-mock"
import type { NormalizedConversation } from "../../types"

let sessions: typeof import("../openclaw-sessions")

describe("importLegacySessionsToOpenClawHistory", () => {
  beforeAll(async () => {
    sessions = await import("../openclaw-sessions")
  })

  beforeEach(() => {
    resetSpawnMock()
  })

  it("imports sessions and then skips unchanged content on rerun", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "reclaw-openclaw-sessions-test-"))
    const sessionsDir = join(workspace, ".openclaw", "agent-a")
    const sessionsPath = join(sessionsDir, "sessions.json")
    await mkdir(sessionsDir, { recursive: true })

    enqueueStatus(workspace, sessionsPath, "agent-a")

    const first = await sessions.importLegacySessionsToOpenClawHistory({
      workspacePath: workspace,
      providers: [
        {
          provider: "chatgpt",
          sourcePath: join(workspace, "chatgpt"),
          conversations: [conversation("conv-1", "hello")],
        },
      ],
    })

    expect(first.imported).toBe(1)
    expect(first.updated).toBe(0)
    expect(first.skipped).toBe(0)
    expect(first.failed).toBe(0)
    expect(first.attempted).toBe(1)

    const storeRaw = JSON.parse(await readFile(sessionsPath, "utf8")) as Record<
      string,
      { sessionFile: string; reclawLegacy?: { sourceConversationId?: string } }
    >
    const entries = Object.values(storeRaw)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.reclawLegacy?.sourceConversationId).toBe("conv-1")
    await expect(readFile(entries[0]?.sessionFile ?? "", "utf8")).resolves.toContain(
      '"customType":"reclaw:legacy-source"',
    )

    enqueueStatus(workspace, sessionsPath, "agent-a")
    const second = await sessions.importLegacySessionsToOpenClawHistory({
      workspacePath: workspace,
      providers: [
        {
          provider: "chatgpt",
          sourcePath: join(workspace, "chatgpt"),
          conversations: [conversation("conv-1", "hello")],
        },
      ],
    })
    expect(second.imported).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.skipped).toBe(1)
    expect(second.failed).toBe(0)
  })

  it("updates existing session when content changes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "reclaw-openclaw-sessions-test-"))
    const sessionsDir = join(workspace, ".openclaw", "agent-a")
    const sessionsPath = join(sessionsDir, "sessions.json")
    await mkdir(sessionsDir, { recursive: true })

    enqueueStatus(workspace, sessionsPath, "agent-a")
    await sessions.importLegacySessionsToOpenClawHistory({
      workspacePath: workspace,
      providers: [
        {
          provider: "claude",
          sourcePath: join(workspace, "claude"),
          conversations: [conversation("conv-2", "initial")],
        },
      ],
    })

    enqueueStatus(workspace, sessionsPath, "agent-a")
    const updated = await sessions.importLegacySessionsToOpenClawHistory({
      workspacePath: workspace,
      providers: [
        {
          provider: "claude",
          sourcePath: join(workspace, "claude"),
          conversations: [conversation("conv-2", "changed content")],
        },
      ],
    })

    expect(updated.imported).toBe(0)
    expect(updated.updated).toBe(1)
    expect(updated.skipped).toBe(0)
  })

  it("throws when workspace cannot be mapped to an agent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "reclaw-openclaw-sessions-test-"))
    const otherWorkspace = await mkdtemp(join(tmpdir(), "reclaw-openclaw-sessions-test-"))
    const sessionsPath = join(otherWorkspace, "sessions.json")

    enqueueStatus(otherWorkspace, sessionsPath, "agent-x")
    await expect(
      sessions.importLegacySessionsToOpenClawHistory({
        workspacePath: workspace,
        providers: [],
      }),
    ).rejects.toThrow("Could not map workspace")
  })

  it("throws when openclaw status contains no agents", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "reclaw-openclaw-sessions-test-"))

    enqueueSpawnResult({
      status: 0,
      stdout: JSON.stringify({ agents: { agents: [] } }),
      stderr: "",
    })

    await expect(
      sessions.importLegacySessionsToOpenClawHistory({
        workspacePath: workspace,
        providers: [],
      }),
    ).rejects.toThrow("did not include any registered agents")
  })

  it("reports per-conversation failures and continues importing remaining entries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "reclaw-openclaw-sessions-test-"))
    const sessionsDir = join(workspace, ".openclaw", "agent-a")
    const sessionsPath = join(sessionsDir, "sessions.json")
    await mkdir(sessionsDir, { recursive: true })

    const brokenConversation = conversation("broken", "x")
    brokenConversation.messages[1] = {
      ...brokenConversation.messages[1],
      get content() {
        throw new Error("message content read failed")
      },
    } as unknown as NormalizedConversation["messages"][number]

    enqueueStatus(workspace, sessionsPath, "agent-a")
    const result = await sessions.importLegacySessionsToOpenClawHistory({
      workspacePath: workspace,
      providers: [
        {
          provider: "chatgpt",
          sourcePath: join(workspace, "chatgpt"),
          conversations: [brokenConversation, conversation("ok", "works")],
        },
      ],
    })

    expect(result.attempted).toBe(2)
    expect(result.imported).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.errors[0]?.reason).toContain("message content read failed")
  })

  it("throws when existing session store JSON is not an object", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "reclaw-openclaw-sessions-test-"))
    const sessionsDir = join(workspace, ".openclaw", "agent-a")
    const sessionsPath = join(sessionsDir, "sessions.json")
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(sessionsPath, "[]", "utf8")

    enqueueStatus(workspace, sessionsPath, "agent-a")
    await expect(
      sessions.importLegacySessionsToOpenClawHistory({
        workspacePath: workspace,
        providers: [],
      }),
    ).rejects.toThrow("Invalid OpenClaw sessions store")
  })

  it("falls back timestamps for invalid inputs and records system role messages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "reclaw-openclaw-sessions-test-"))
    const sessionsDir = join(workspace, ".openclaw", "agent-a")
    const sessionsPath = join(sessionsDir, "sessions.json")
    await mkdir(sessionsDir, { recursive: true })

    const oddConversation: NormalizedConversation = {
      id: "odd",
      title: "Odd",
      source: "chatgpt",
      createdAt: "not-a-date",
      messageCount: 1,
      messages: [{ role: "system", content: "note" }],
    }

    enqueueStatus(workspace, sessionsPath, "agent-a")
    const result = await sessions.importLegacySessionsToOpenClawHistory({
      workspacePath: workspace,
      providers: [
        {
          provider: "chatgpt",
          sourcePath: join(workspace, "chatgpt"),
          conversations: [oddConversation],
        },
      ],
    })

    const storeRaw = JSON.parse(await readFile(result.sessionStorePath, "utf8")) as Record<
      string,
      { sessionFile: string }
    >
    const sessionFile = Object.values(storeRaw)[0]?.sessionFile
    const transcript = await readFile(sessionFile ?? "", "utf8")
    expect(transcript).toContain('"role":"system"')
    expect(transcript).toContain('"customType":"reclaw:legacy-source"')
  })
})

function enqueueStatus(workspacePath: string, sessionsPath: string, agentId: string): void {
  enqueueSpawnResult({
    status: 0,
    stdout: JSON.stringify({
      agents: {
        defaultId: agentId,
        agents: [{ id: agentId, workspaceDir: workspacePath, sessionsPath }],
      },
    }),
    stderr: "",
  })
}

function conversation(id: string, content: string): NormalizedConversation {
  return {
    id,
    title: id,
    source: "chatgpt",
    createdAt: "2026-02-22T10:00:00.000Z",
    updatedAt: "2026-02-22T11:00:00.000Z",
    messageCount: 2,
    model: "gpt-5",
    messages: [
      {
        role: "human",
        content: "input",
        timestamp: "2026-02-22T10:00:00.000Z",
      },
      {
        role: "assistant",
        content,
        timestamp: "2026-02-22T10:01:00.000Z",
      },
    ],
  }
}
