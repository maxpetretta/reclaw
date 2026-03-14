import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../config";
import { runRestoreTranscriptsCommand } from "../cli/commands";

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
      staleThreshold: 30,
      maxLines: 120,
    },
    cron: {
      schedule: "0 3 * * *",
      timezone: "UTC",
    },
  };
}

describe("import transcript restore", () => {
  let tempDir = "";
  let openClawHome = "";
  let workspaceDir = "";
  let logDir = "";
  let originalOpenClawHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reclaw-restore-transcripts-"));
    openClawHome = join(tempDir, "openclaw");
    workspaceDir = join(tempDir, "workspace");
    logDir = join(tempDir, "reclaw");
    await mkdir(workspaceDir, { recursive: true });
    originalOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openClawHome;
  });

  afterEach(async () => {
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  test("runRestoreTranscriptsCommand rewrites imported OpenClaw sessions without touching the Reclaw log", async () => {
    const exportPath = join(workspaceDir, "chatgpt-export.json");
    await writeFile(
      exportPath,
      JSON.stringify([
        {
          id: "conv-1",
          title: "Imported chat",
          create_time: "2026-02-01T12:00:00.000Z",
          update_time: "2026-02-01T12:05:00.000Z",
          messages: [
            {
              id: "u-1",
              role: "user",
              content: "How should I debug this timeout?\nStart with the retry path.",
              create_time: "2026-02-01T12:00:00.000Z",
            },
            {
              id: "a-1",
              role: "assistant",
              content: "Start by checking which fallback model is failing first.\nThen inspect the timeout budget.",
              create_time: "2026-02-01T12:01:00.000Z",
            },
            {
              id: "u-2",
              role: "user",
              content: "Then I should inspect the timeout budget in the retry wrapper, right?",
              create_time: "2026-02-01T12:02:00.000Z",
            },
            {
              id: "a-2",
              role: "assistant",
              content: "Yes. Verify the wrapper timeout and the downstream model timeout separately.",
              create_time: "2026-02-01T12:03:00.000Z",
            },
          ],
        },
      ]),
      "utf8",
    );

    const result = await runRestoreTranscriptsCommand({
      config: createConfig(logDir),
      workspaceDir,
      platform: "chatgpt",
      filePath: exportPath,
      opts: { minMessages: 1 },
    });

    expect(result.summary.parsed).toBe(1);
    expect(result.summary.selected).toBe(1);
    expect(result.summary.restored).toBe(1);

    const sessionId = "reclaw:chatgpt:conv-1";
    const sessionsDir = join(openClawHome, "agents", "main", "sessions");
    const transcriptJsonl = await readFile(join(sessionsDir, `${sessionId}.jsonl`), "utf8");
    const sessionsStore = JSON.parse(await readFile(join(sessionsDir, "sessions.json"), "utf8")) as Record<
      string,
      { sessionId?: string }
    >;
    const projection = await readFile(join(logDir, "transcripts", `${sessionId}.md`), "utf8");

    expect(transcriptJsonl).toContain('"role":"user"');
    expect(transcriptJsonl).toContain('"role":"assistant"');
    expect(transcriptJsonl).toContain("How should I debug this timeout?\\nStart with the retry path.");
    expect(transcriptJsonl).toContain(
      "Start by checking which fallback model is failing first.\\nThen inspect the timeout budget.",
    );
    expect(sessionsStore["agent:main:reclaw:chatgpt:conv-1"]?.sessionId).toBe(sessionId);
    expect(projection).toContain("How should I debug this timeout?\nStart with the retry path.");
    expect(projection).toContain(
      "Start by checking which fallback model is failing first.\nThen inspect the timeout budget.",
    );
    expect(await Bun.file(join(logDir, "log.jsonl")).exists()).toBe(false);
    expect(await Bun.file(join(logDir, "sessions", `${sessionId}.md`)).exists()).toBe(false);
  });

  test("runRestoreTranscriptsCommand dry-run previews transcript restore without writing session files", async () => {
    const exportPath = join(workspaceDir, "chatgpt-export.json");
    await writeFile(
      exportPath,
      JSON.stringify([
        {
          id: "conv-2",
          title: "Short chat",
          create_time: "2026-02-01T12:00:00.000Z",
          update_time: "2026-02-01T12:05:00.000Z",
          messages: [
            {
              id: "u-1",
              role: "user",
              content: "Hello",
              create_time: "2026-02-01T12:00:00.000Z",
            },
            {
              id: "a-1",
              role: "assistant",
              content: "Hi",
              create_time: "2026-02-01T12:01:00.000Z",
            },
          ],
        },
      ]),
      "utf8",
    );

    const result = await runRestoreTranscriptsCommand({
      config: createConfig(logDir),
      workspaceDir,
      platform: "chatgpt",
      filePath: exportPath,
      opts: { dryRun: true, minMessages: 1 },
    });

    expect(result.summary.dryRun).toBe(true);
    expect(result.summary.selected).toBe(1);
    expect(result.summary.restored).toBe(0);
    expect(await Bun.file(join(openClawHome, "agents", "main", "sessions", "sessions.json")).exists()).toBe(false);
    expect(await Bun.file(join(logDir, "transcripts", "reclaw:chatgpt:conv-2.md")).exists()).toBe(false);
  });
});
