import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshTranscriptProjectionSession,
  refreshTranscriptProjections,
} from "../projections/transcripts";

describe("transcript projections", () => {
  let tempDir = "";
  let openClawHome = "";
  let projectionDir = "";
  let originalOpenClawHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reclaw-transcript-projections-"));
    openClawHome = join(tempDir, "openclaw");
    projectionDir = join(tempDir, "reclaw", "transcripts");
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

  test("refreshTranscriptProjectionSession writes cleaned markdown and removes stale chunks", async () => {
    const sessionId = "reclaw:chatgpt:session-1";
    const sessionDir = join(projectionDir, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "chunk-0002.md"), "# stale\n", "utf8");

    await refreshTranscriptProjectionSession({
      projectionDir,
      agentId: "main",
      sessionId,
      messages: [
        {
          role: "user",
          timestamp: "2026-03-13T12:00:00.000Z",
          content: [
            "Sender (untrusted metadata):",
            "```json",
            '{"label":"openclaw-tui"}',
            "```",
            "",
            "[Fri 2026-03-13 08:00 EDT] what happened to the briefing?",
          ].join("\n"),
        },
        {
          role: "assistant",
          timestamp: "2026-03-13T12:00:10.000Z",
          content: '{"queries":["briefing cron status"],"source_filter":["files_uploaded_in_conversation"]}',
        },
        {
          role: "assistant",
          timestamp: "2026-03-13T12:00:20.000Z",
          content: "The briefing cron was failing on timeouts and an invalid fallback model.",
        },
        {
          role: "assistant",
          timestamp: "2026-03-13T12:00:30.000Z",
          content: "import pdfplumber, re, pathlib",
        },
        {
          role: "user",
          timestamp: "2026-03-13T12:01:00.000Z",
          content: "Can you fix it?",
        },
        {
          role: "user",
          timestamp: "2026-03-13T12:01:30.000Z",
          content: [
            "You are running an isolated one-shot task.",
            "",
            "## System Prompt",
            "You are the memory extraction agent.",
            "",
            "## User Prompt",
            "Extract memory entries.",
          ].join("\n"),
        },
        {
          role: "user",
          timestamp: "2026-03-13T12:02:00.000Z",
          content: '[System Message] [sessionId: sub-1] A subagent task "Do some work"',
        },
      ],
    });

    const transcriptPath = join(projectionDir, `${sessionId}.md`);
    const markdown = await readFile(transcriptPath, "utf8");

    expect(markdown).toContain("# Transcript reclaw:chatgpt:session-1");
    expect(markdown).toContain("- Agent: `main`");
    expect(markdown).toContain("- Turns: `3`");
    expect(markdown).toContain("what happened to the briefing?");
    expect(markdown).toContain("The briefing cron was failing on timeouts and an invalid fallback model.");
    expect(markdown).toContain("Can you fix it?");
    expect(markdown).not.toContain("Sender (untrusted metadata)");
    expect(markdown).not.toContain('{"queries"');
    expect(markdown).not.toContain("import pdfplumber");
    expect(markdown).not.toContain("You are running an isolated one-shot task.");
    expect(markdown).not.toContain("[System Message] [sessionId:");
    expect(await Bun.file(sessionDir).exists()).toBe(false);
  });

  test("refreshTranscriptProjections keeps direct user sessions, including non-main and orphaned main files, and skips cron sessions", async () => {
    const sessionsDir = join(openClawHome, "agents", "main", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main:session-1": {
          sessionId: "session-1",
        },
        "agent:main:cron:job-1": {
          sessionId: "session-cron",
        },
        "agent:main:reclaw:chatgpt:import-1": {
          sessionId: "reclaw:chatgpt:import-1",
        },
        "agent:main:reclaw:chatgpt:import-short": {
          sessionId: "reclaw:chatgpt:import-short",
        },
        "agent:main:tui-random": {
          sessionId: "session-tui",
          origin: {
            provider: "webchat",
            surface: "webchat",
            chatType: "direct",
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "session-1.jsonl"),
      [
        '{"type":"session","version":3,"id":"session-1","timestamp":"2026-03-13T12:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-03-13T12:01:00.000Z","message":{"role":"user","content":"Need retry strategy"}}',
        '{"type":"message","timestamp":"2026-03-13T12:02:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Use exponential backoff."}]}}',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "session-cron.jsonl"),
      [
        '{"type":"session","version":3,"id":"session-cron","timestamp":"2026-03-13T12:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-03-13T12:01:00.000Z","message":{"role":"user","content":"Run agent\\nCurrent time: Thursday"}}',
        '{"type":"message","timestamp":"2026-03-13T12:02:00.000Z","message":{"role":"assistant","content":"HEARTBEAT_OK"}}',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "reclaw:chatgpt:import-1.jsonl"),
      [
        '{"type":"session","version":3,"id":"reclaw:chatgpt:import-1","timestamp":"2026-03-13T12:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-03-13T12:01:00.000Z","message":{"role":"user","content":"Imported question"}}',
        '{"type":"message","timestamp":"2026-03-13T12:02:00.000Z","message":{"role":"assistant","content":"Imported answer"}}',
        '{"type":"message","timestamp":"2026-03-13T12:03:00.000Z","message":{"role":"user","content":"Imported follow-up"}}',
        '{"type":"message","timestamp":"2026-03-13T12:04:00.000Z","message":{"role":"assistant","content":"Imported follow-up answer"}}',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "reclaw:chatgpt:import-short.jsonl"),
      [
        '{"type":"session","version":3,"id":"reclaw:chatgpt:import-short","timestamp":"2026-03-13T12:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-03-13T12:01:00.000Z","message":{"role":"user","content":"Short imported question"}}',
        '{"type":"message","timestamp":"2026-03-13T12:02:00.000Z","message":{"role":"assistant","content":"Short imported answer"}}',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "session-tui.jsonl"),
      [
        '{"type":"session","version":3,"id":"session-tui","timestamp":"2026-03-13T12:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-03-13T12:01:00.000Z","message":{"role":"user","content":"Opened from tui"}}',
        '{"type":"message","timestamp":"2026-03-13T12:02:00.000Z","message":{"role":"assistant","content":"TUI answer"}}',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "session-orphan.jsonl"),
      [
        '{"type":"session","version":3,"id":"session-orphan","timestamp":"2026-03-13T12:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-03-13T12:01:00.000Z","message":{"role":"user","content":"Recovered orphan session"}}',
        '{"type":"message","timestamp":"2026-03-13T12:02:00.000Z","message":{"role":"assistant","content":"Recovered orphan answer"}}',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "session-orphan-cronlike.jsonl"),
      [
        '{"type":"session","version":3,"id":"session-orphan-cronlike","timestamp":"2026-03-13T12:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-03-13T12:01:00.000Z","message":{"role":"user","content":"[cron:job-9] You are running an isolated one-shot task.\\n\\n## System Prompt\\nDo work\\n\\n## User Prompt\\nDo work"}}',
        '{"type":"message","timestamp":"2026-03-13T12:02:00.000Z","message":{"role":"assistant","content":"{\\\"search_query\\\":[{\\\"q\\\":\\\"noop\\\"}]}"}}',
      ].join("\n"),
      "utf8",
    );

    await mkdir(join(projectionDir, "stale-session"), { recursive: true });
    await writeFile(join(projectionDir, "stale-session", "chunk-0001.md"), "# stale\n", "utf8");

    await refreshTranscriptProjections({
      projectionDir,
      openClawHome,
    });

    const markdown = await readFile(join(projectionDir, "session-1.md"), "utf8");
    expect(markdown).toContain("Need retry strategy");
    expect(markdown).toContain("Use exponential backoff.");
    expect(await Bun.file(join(projectionDir, "session-tui.md")).exists()).toBe(true);
    expect(await Bun.file(join(projectionDir, "session-orphan.md")).exists()).toBe(true);
    expect(await Bun.file(join(projectionDir, "session-cron.md")).exists()).toBe(false);
    expect(await Bun.file(join(projectionDir, "session-orphan-cronlike.md")).exists()).toBe(false);
    expect(await Bun.file(join(projectionDir, "reclaw:chatgpt:import-1.md")).exists()).toBe(true);
    expect(await Bun.file(join(projectionDir, "reclaw:chatgpt:import-short.md")).exists()).toBe(false);
    expect(await Bun.file(join(projectionDir, "stale-session")).exists()).toBe(false);
  });

  test("refreshTranscriptProjections skips reset-only orphan sessions", async () => {
    const sessionsDir = join(openClawHome, "agents", "main", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "sessions.json"), "{}", "utf8");
    await writeFile(
      join(sessionsDir, "session-reset-only.jsonl.reset.2026-03-13T12-00-00.000Z"),
      [
        '{"type":"session","version":3,"id":"session-reset-only","timestamp":"2026-03-13T12:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-03-13T12:01:00.000Z","message":{"role":"user","content":"You are running an isolated one-shot task.\\n\\n## System Prompt\\nDo work\\n\\n## User Prompt\\nDo work"}}',
        '{"type":"message","timestamp":"2026-03-13T12:02:00.000Z","message":{"role":"assistant","content":"Task completed."}}',
      ].join("\n"),
      "utf8",
    );

    await refreshTranscriptProjections({
      projectionDir,
      openClawHome,
    });

    expect(await Bun.file(join(projectionDir, "session-reset-only.md")).exists()).toBe(false);
  });
});
