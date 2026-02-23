import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildStatusReport, printStatus } from "../status"

describe("buildStatusReport", () => {
  it("returns a helpful report when the state file is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-status-missing-test-"))
    const statePath = join(tempDir, "missing-state.json")

    const report = await buildStatusReport(statePath)

    expect(report.stateFile.exists).toBe(false)
    expect(report.state).toBeUndefined()
    expect(report.notes.some((note) => note.includes("No state file found yet"))).toBe(true)
  })

  it("summarizes a valid state file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-status-valid-test-"))
    const targetPath = join(tempDir, "workspace")
    await mkdir(join(targetPath, "memory"), { recursive: true })

    const statePath = join(tempDir, "state.json")
    await writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          runKey: "abc123",
          mode: "openclaw",
          model: "haiku",
          targetPath,
          createdAt: "2026-02-20T01:00:00.000Z",
          updatedAt: "2026-02-21T02:00:00.000Z",
          completed: {
            "2026-02-20#0/1": {
              providers: ["chatgpt", "claude"],
              date: "2026-02-20",
              conversationCount: 3,
              conversationRefs: [
                { provider: "chatgpt", id: "c1" },
                { provider: "chatgpt", id: "c2" },
                { provider: "claude", id: "c3" },
              ],
            },
            "2026-02-21#0/1": {
              providers: ["grok"],
              date: "2026-02-21",
              conversationCount: 1,
              conversationRefs: [{ provider: "grok", id: "g1" }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    )

    const report = await buildStatusReport(statePath, new Date("2026-02-22T12:00:00.000Z"))

    expect(report.stateFile.exists).toBe(true)
    expect(report.state?.mode).toBe("openclaw")
    expect(report.state?.paths.targetPathExists).toBe(true)
    expect(report.state?.paths.outputDirExists).toBe(true)
    expect(report.state?.metrics.completedBatches).toBe(2)
    expect(report.state?.metrics.completedConversations).toBe(4)
    expect(report.state?.metrics.providerConversationCounts.chatgpt).toBe(2)
    expect(report.state?.metrics.providerConversationCounts.claude).toBe(1)
    expect(report.state?.metrics.providerConversationCounts.grok).toBe(1)
    expect(report.state?.metrics.earliestBatchDate).toBe("2026-02-20")
    expect(report.state?.metrics.latestBatchDate).toBe("2026-02-21")
    expect(
      report.notes.some((note) => note.includes("Pending/failed batch counts are not derivable from state alone")),
    ).toBe(true)
  })

  it("reports parse errors for invalid JSON", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-status-invalid-json-test-"))
    const statePath = join(tempDir, "state.json")
    await writeFile(statePath, "{ invalid", "utf8")

    const report = await buildStatusReport(statePath)

    expect(report.stateFile.exists).toBe(true)
    expect(report.state).toBeUndefined()
    expect(report.stateFile.parseError).toContain("Invalid JSON")
  })

  it("prints a human-readable status summary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-status-human-test-"))
    const statePath = join(tempDir, "missing-state.json")

    const originalLog = console.log
    const output: string[] = []
    console.log = (value?: unknown) => {
      output.push(String(value ?? ""))
    }

    try {
      await printStatus({ statePath })
    } finally {
      console.log = originalLog
    }

    const rendered = output.join("\n")
    expect(rendered).toContain("🦞 Reclaw - Status check")
    expect(rendered).toContain(`State file: ${statePath}`)
    expect(rendered).toContain("No state file found yet")
  })

  it("prints valid JSON status output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-status-json-test-"))
    const statePath = join(tempDir, "missing-state.json")

    const originalLog = console.log
    const output: string[] = []
    console.log = (value?: unknown) => {
      output.push(String(value ?? ""))
    }

    try {
      await printStatus({ statePath, json: true })
    } finally {
      console.log = originalLog
    }

    expect(output.length).toBe(1)
    const jsonLine = output[0]
    if (!jsonLine) {
      throw new Error("Expected JSON output from printStatus")
    }

    const parsed = JSON.parse(jsonLine) as {
      stateFile?: {
        path?: string
        exists?: boolean
      }
    }
    expect(parsed.stateFile?.path).toBe(statePath)
    expect(parsed.stateFile?.exists).toBe(false)
  })
})
