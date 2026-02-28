import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../config";
import {
  BRIEFING_BEGIN_MARKER,
  BRIEFING_END_MARKER,
  generateBriefing,
} from "../briefing/generate";
import { LAST_HANDOFF_BEGIN_MARKER, LAST_HANDOFF_END_MARKER } from "../memory/handoff";

function createConfig(logDir: string): PluginConfig {
  return {
    logDir,
    extraction: {
      model: "anthropic/claude-sonnet-4-6",
      skipSessionTypes: ["cron:", "sub:", "hook:"],
    },
    briefing: {
      model: "anthropic/claude-sonnet-4-6",
      activeWindow: 14,
      decisionWindow: 7,
      staleThreshold: 30,
      maxLines: 80,
    },
    cron: {
      schedule: "0 3 * * *",
      timezone: "UTC",
    },
  };
}

const LOG_LINE =
  '{"id":"abc123def456","timestamp":"2026-02-20T00:00:00.000Z","type":"fact","content":"Queue retries enabled","session":"session-1"}\n';

describe("briefing generation", () => {
  let tempDir = "";
  let logPath = "";
  let memoryPath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zettelclaw-briefing-"));
    logPath = join(tempDir, "log.jsonl");
    memoryPath = join(tempDir, "MEMORY.md");

    await writeFile(logPath, LOG_LINE, "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("replaces content between markers", async () => {
    await writeFile(
      memoryPath,
      [
        "## Goals",
        "- Ship V3",
        "",
        BRIEFING_BEGIN_MARKER,
        "old generated content",
        BRIEFING_END_MARKER,
        "",
        "## Notes",
        "Keep this.",
      ].join("\n"),
      "utf8",
    );

    await generateBriefing(
      {
        logPath,
        memoryMdPath: memoryPath,
        config: createConfig(tempDir),
      },
      {
        callBriefingModel: async () => "## Active\n- auth-migration — Queue retries enabled",
      },
    );

    const content = await readFile(memoryPath, "utf8");

    expect(content).toContain("## Goals");
    expect(content).toContain("## Notes");
    expect(content).toContain("## Active");
    expect(content).toContain("auth-migration");
    expect(content).not.toContain("old generated content");
  });

  test("creates markers if missing", async () => {
    await writeFile(memoryPath, "## Goals\n- Ship V3\n", "utf8");

    await generateBriefing(
      {
        logPath,
        memoryMdPath: memoryPath,
        config: createConfig(tempDir),
      },
      {
        callBriefingModel: async () => "## Pending\n- Follow up with retries",
      },
    );

    const content = await readFile(memoryPath, "utf8");

    expect(content).toContain(BRIEFING_BEGIN_MARKER);
    expect(content).toContain(BRIEFING_END_MARKER);
    expect(content).toContain("## Pending");
  });

  test("preserves content outside generated markers", async () => {
    await writeFile(
      memoryPath,
      [
        "Header content",
        "",
        BRIEFING_BEGIN_MARKER,
        "old",
        BRIEFING_END_MARKER,
        "",
        "Footer content",
      ].join("\n"),
      "utf8",
    );

    await generateBriefing(
      {
        logPath,
        memoryMdPath: memoryPath,
        config: createConfig(tempDir),
      },
      {
        callBriefingModel: async () => "## Recent Decisions\n- 2026-02-20: Queue retries enabled",
      },
    );

    const content = await readFile(memoryPath, "utf8");

    expect(content).toContain("Header content");
    expect(content).toContain("Footer content");
    expect(content).toContain("## Recent Decisions");
  });

  test("pre-filters entries before sending input to briefing model", async () => {
    const now = Date.parse("2026-02-28T00:00:00.000Z");
    const entries = [
      {
        id: "aaa111bbb222",
        timestamp: "2026-02-27T12:00:00.000Z",
        type: "fact",
        content: "Active auth rollout",
        subject: "auth-migration",
        session: "session-1",
      },
      {
        id: "ccc333ddd444",
        timestamp: "2026-02-25T09:00:00.000Z",
        type: "decision",
        content: "Use queue retries",
        subject: "auth-migration",
        session: "session-2",
      },
      {
        id: "eee555fff666",
        timestamp: "2025-12-01T09:00:00.000Z",
        type: "decision",
        content: "Legacy decision should be excluded",
        subject: "legacy-system",
        session: "session-3",
      },
      {
        id: "ggg777hhh888",
        timestamp: "2025-10-01T09:00:00.000Z",
        type: "task",
        content: "Open task should remain",
        status: "open",
        subject: "legacy-system",
        session: "session-4",
      },
      {
        id: "iii999jjj000",
        timestamp: "2025-10-01T09:00:00.000Z",
        type: "task",
        content: "Closed task should be excluded",
        status: "done",
        subject: "legacy-system",
        session: "session-5",
      },
      {
        id: "kkk111lll222",
        timestamp: "2025-10-01T09:00:00.000Z",
        type: "question",
        content: "Open question should remain",
        subject: "legacy-system",
        session: "session-6",
      },
    ];

    await writeFile(
      logPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    let capturedUserInput = "";

    await generateBriefing(
      {
        logPath,
        memoryMdPath: memoryPath,
        config: createConfig(tempDir),
        now,
      },
      {
        callBriefingModel: async ({ userInput }) => {
          capturedUserInput = userInput;
          return "## Active\n- auth-migration — Active auth rollout";
        },
      },
    );

    expect(capturedUserInput).toContain("## Active Entries");
    expect(capturedUserInput).toContain("## Recent Decisions");
    expect(capturedUserInput).toContain("## Open Items");
    expect(capturedUserInput).toContain("## Stale Subjects");
    expect(capturedUserInput).toContain("## Included Entries (Deduped Union)");

    expect(capturedUserInput).toContain("Active auth rollout");
    expect(capturedUserInput).toContain("Use queue retries");
    expect(capturedUserInput).toContain("Open task should remain");
    expect(capturedUserInput).toContain("Open question should remain");

    expect(capturedUserInput).not.toContain("Legacy decision should be excluded");
    expect(capturedUserInput).not.toContain("Closed task should be excluded");
  });

  test("briefing generation preserves handoff markers and content", async () => {
    await writeFile(
      memoryPath,
      [
        "## Goals",
        "- Ship V3",
        "",
        BRIEFING_BEGIN_MARKER,
        "old briefing content",
        BRIEFING_END_MARKER,
        "",
        LAST_HANDOFF_BEGIN_MARKER,
        "Session: session-9 (2026-02-19T00:00:00.000Z)",
        "Auth migration handoff snapshot",
        LAST_HANDOFF_END_MARKER,
      ].join("\n"),
      "utf8",
    );

    await generateBriefing(
      {
        logPath,
        memoryMdPath: memoryPath,
        config: createConfig(tempDir),
      },
      {
        callBriefingModel: async () => "## Active\n- auth-migration — Queue retries enabled",
      },
    );

    const content = await readFile(memoryPath, "utf8");
    expect(content).toContain("## Active");
    expect(content).toContain(LAST_HANDOFF_BEGIN_MARKER);
    expect(content).toContain(LAST_HANDOFF_END_MARKER);
    expect(content).toContain("Auth migration handoff snapshot");
  });
});
