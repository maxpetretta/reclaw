import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOpenClawImportSource, parseOpenClawConversations } from "../import/adapters/openclaw";

describe("openclaw import adapter", () => {
  let tempDir = "";
  let openClawHome = "";
  let memoryDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zettelclaw-import-openclaw-"));
    openClawHome = join(tempDir, "openclaw");
    memoryDir = join(tempDir, "workspace", "memory");
    await mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("prefers session transcripts over markdown fallback when session id is present", async () => {
    await writeFile(
      join(memoryDir, "2026-02-27.md"),
      [
        "# Daily Notes",
        "",
        "Fallback markdown content that should not be used when transcript exists.",
        "",
        "## Sessions",
        "- session:abc123",
      ].join("\n"),
      "utf8",
    );

    const sessionsDir = join(openClawHome, "agents", "main", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "abc123.jsonl"),
      [
        JSON.stringify({
          type: "message",
          timestamp: "2026-02-27T10:00:00.000Z",
          message: {
            role: "user",
            content: "Transcript question",
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-02-27T10:01:00.000Z",
          message: {
            role: "assistant",
            content: "Transcript answer",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const source = await loadOpenClawImportSource(memoryDir, {
      openClawHome,
      preferredAgentId: "main",
    });
    const conversations = parseOpenClawConversations(source);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.platform).toBe("openclaw");
    expect(conversations[0]?.sourcePath).toBe("2026-02-27.md");
    expect(conversations[0]?.messages.map((message) => message.content)).toEqual([
      "Transcript question",
      "Transcript answer",
    ]);
    expect(conversations[0]?.messages.some((message) => message.content.includes("Fallback markdown content"))).toBe(
      false,
    );
  });

  test("falls back to markdown content when no transcript can be resolved", async () => {
    await mkdir(join(memoryDir, "projects"), { recursive: true });
    await writeFile(
      join(memoryDir, "projects", "roadmap.md"),
      [
        "---",
        "title: Roadmap",
        "---",
        "",
        "# Roadmap",
        "",
        "- Ship billing migration in March.",
      ].join("\n"),
      "utf8",
    );

    const source = await loadOpenClawImportSource(memoryDir, {
      openClawHome,
      preferredAgentId: "main",
    });
    const conversations = parseOpenClawConversations(source);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.sourcePath).toBe("projects/roadmap.md");
    expect(conversations[0]?.messages).toHaveLength(1);
    expect(conversations[0]?.messages[0]?.role).toBe("user");
    expect(conversations[0]?.messages[0]?.content).toContain("Ship billing migration in March.");
  });
});
