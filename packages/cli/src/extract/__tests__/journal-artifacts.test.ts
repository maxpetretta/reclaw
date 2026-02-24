import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { BatchExtractionResult } from "../contracts"
import { writeZettelclawArtifacts } from "../journal-artifacts"

describe("writeZettelclawArtifacts", () => {
  it("creates a new journal file with Log/Open/Sessions sections", async () => {
    const vault = await mkdtemp(join(tmpdir(), "reclaw-journal-test-"))

    const result = await writeZettelclawArtifacts([batch("chatgpt", "cg-1", "14:25")], vault, {
      includeSessionFooters: true,
    })
    const journalPath = join(vault, "03 Journal", "2026-02-22.md")

    expect(result.outputFiles).toEqual([journalPath])
    const content = await readFile(journalPath, "utf8")
    expect(content).toContain("type: journal")
    expect(content).toContain("## Log")
    expect(content).toContain("## Todo")
    expect(content).toContain("## Sessions")
    expect(content).not.toContain("## Decisions")
    expect(content).not.toContain("## Facts")
    expect(content).not.toContain("## Interests")
    expect(content).toContain("- chatgpt:cg-1 — 14:25")
  })

  it("appends to existing Log section and dedupes sessions", async () => {
    const vault = await mkdtemp(join(tmpdir(), "reclaw-journal-test-"))
    const journalDir = join(vault, "03 Journal")
    const journalPath = join(journalDir, "2026-02-22.md")
    await mkdir(journalDir, { recursive: true })
    await writeFile(
      journalPath,
      [
        "---",
        "type: journal",
        "created: 2026-02-22",
        "updated: 2026-02-20",
        "---",
        "## Log",
        "- existing log item",
        "",
        "---",
        "## Sessions",
        "- chatgpt:cg-1 — 14:25",
      ].join("\n"),
      "utf8",
    )

    const result = await writeZettelclawArtifacts(
      [batch("chatgpt", "cg-1", "14:25"), batch("claude", "cl-1", "2026-02-22T15:30:00.000Z")],
      vault,
      { includeSessionFooters: true },
    )
    expect(result.outputFiles).toEqual([journalPath])

    const content = await readFile(journalPath, "utf8")
    expect(content).toContain("## Log")
    expect(content).toContain("- existing log item")
    expect(content).toContain("- chatgpt:cg-1 — 14:25")
    expect(content).toContain("- claude:cl-1 —")
    expect(content).toContain("## Sessions")
  })

  it("repairs malformed journal layout and normalizes unknown timestamps", async () => {
    const vault = await mkdtemp(join(tmpdir(), "reclaw-journal-test-"))
    const journalDir = join(vault, "03 Journal")
    const journalPath = join(journalDir, "2026-02-22.md")
    await mkdir(journalDir, { recursive: true })
    await writeFile(
      journalPath,
      [
        "---",
        "type: journal",
        "created: 2026-02-22",
        "---",
        "",
        "",
        "## Log",
        "",
        "## Sessions",
        "- chatgpt:existing-no-time",
      ].join("\n"),
      "utf8",
    )

    const result = await writeZettelclawArtifacts(
      [batch("chatgpt", "existing-no-time", "not-a-date"), batch("grok", "new-ref", "not-a-date")],
      vault,
      { includeSessionFooters: true },
    )
    expect(result.outputFiles).toEqual([journalPath])

    const content = await readFile(journalPath, "utf8")
    expect(content).toContain("---\n## Sessions")
    expect(content).toContain("- chatgpt:existing-no-time")
    expect(content).toContain("- grok:new-ref — unknown")
    expect(content).not.toContain("\n\n\n")
  })

  it("is idempotent after an initial normalization run", async () => {
    const vault = await mkdtemp(join(tmpdir(), "reclaw-journal-test-"))
    const journalDir = join(vault, "03 Journal")
    const journalPath = join(journalDir, "2026-02-22.md")
    await mkdir(journalDir, { recursive: true })
    await writeFile(
      journalPath,
      [
        "---",
        "type: journal",
        "created: 2026-02-22",
        "updated: 2026-02-22",
        "---",
        "## Log",
        "- Ship v1",
        "- Uses bun test",
        "- Quality",
        "",
        "## Todo",
        "- Follow up docs",
        "",
        "---",
        "## Sessions",
        "- chatgpt:cg-1 — 14:25",
        "",
      ].join("\n"),
      "utf8",
    )

    const firstRun = await writeZettelclawArtifacts([batch("chatgpt", "cg-1", "14:25")], vault, {
      includeSessionFooters: true,
    })
    expect(firstRun.outputFiles).toEqual([journalPath])

    const secondRun = await writeZettelclawArtifacts([batch("chatgpt", "cg-1", "14:25")], vault, {
      includeSessionFooters: true,
    })
    expect(secondRun.outputFiles).toEqual([])
  })

  it("omits the sessions footer when includeSessionFooters is disabled", async () => {
    const vault = await mkdtemp(join(tmpdir(), "reclaw-journal-test-"))

    const result = await writeZettelclawArtifacts([batch("chatgpt", "cg-1", "14:25")], vault, {
      includeSessionFooters: false,
    })
    const journalPath = join(vault, "03 Journal", "2026-02-22.md")

    expect(result.outputFiles).toEqual([journalPath])
    const content = await readFile(journalPath, "utf8")
    expect(content).toContain("## Log")
    expect(content).toContain("## Todo")
    expect(content).not.toContain("## Sessions")
  })
})

function batch(
  provider: BatchExtractionResult["providers"][number],
  id: string,
  timestamp: string,
): BatchExtractionResult {
  return {
    batchId: `${provider}-${id}`,
    providers: [provider],
    date: "2026-02-22",
    conversationIds: [id],
    conversationRefs: [{ provider, id, timestamp }],
    conversationCount: 1,
    extraction: {
      summary: "decision: Ship v1; fact: Uses bun test; interest: Quality; open: Follow up docs",
    },
  }
}
