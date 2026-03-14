import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillImportedSessionSummaries, backfillSessionSummaries } from "../session-summary/backfill";

describe("session summary backfill", () => {
  test("writes imported session summaries and can force regeneration", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-summary-backfill-"));
    const openClawHome = join(tempDir, "openclaw");
    const sessionsDir = join(openClawHome, "agents", "main", "sessions");
    const logDir = join(tempDir, "reclaw");

    try {
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(join(logDir, "sessions"), { recursive: true });
      await writeFile(
        join(sessionsDir, "reclaw:chatgpt:conv-1.jsonl"),
        [
          '{"type":"session","version":3,"id":"reclaw:chatgpt:conv-1","timestamp":"2026-03-01T00:00:00.000Z"}',
          '{"type":"message","timestamp":"2026-03-01T00:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"We settled on transcript-only search."}]}}',
          '{"type":"message","timestamp":"2026-03-01T00:02:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"That keeps transcript lookup separate from normal memory search."}]}}',
          '{"type":"message","timestamp":"2026-03-01T00:03:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Good, keep transcript recall isolated."}]}}',
          '{"type":"message","timestamp":"2026-03-01T00:04:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"I will keep transcript recall isolated from normal memory."}]}}',
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(sessionsDir, "sessions.json"),
        JSON.stringify({
          "agent:main:reclaw:chatgpt:conv-1": {
            sessionId: "reclaw:chatgpt:conv-1",
          },
        }),
        "utf8",
      );

      const first = await backfillImportedSessionSummaries(
        {
          logPath: join(logDir, "log.jsonl"),
          projectionDir: join(logDir, "sessions"),
          model: "anthropic/claude-sonnet-4-6",
          openClawHome,
        },
        {
          generateSessionSummary: async () => ({
            content: "Settled on transcript-only search.",
            detail: "Normal memory search stays separate.",
            source: "model",
          }),
        },
      );

      const second = await backfillImportedSessionSummaries(
        {
          logPath: join(logDir, "log.jsonl"),
          projectionDir: join(logDir, "sessions"),
          model: "anthropic/claude-sonnet-4-6",
          openClawHome,
          force: true,
        },
        {
          generateSessionSummary: async () => ({
            content: "Finalized transcript-only search so transcript recall stays isolated.",
            source: "model",
          }),
        },
      );

      const logContent = await readFile(join(logDir, "log.jsonl"), "utf8");
      const projection = await readFile(join(logDir, "sessions", "reclaw:chatgpt:conv-1.md"), "utf8");

      expect(first.written).toBe(1);
      expect(second.written).toBe(2);
      expect(logContent.split("\n").filter((line) => line.includes('"session":"reclaw:chatgpt:conv-1"')).length).toBe(2);
      expect(projection).toContain("Finalized transcript-only search so transcript recall stays isolated.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("clearExisting removes prior session_summary events before rebuilding", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-summary-backfill-clear-"));
    const openClawHome = join(tempDir, "openclaw");
    const sessionsDir = join(openClawHome, "agents", "main", "sessions");
    const logDir = join(tempDir, "reclaw");

    try {
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(join(logDir, "sessions"), { recursive: true });
      await writeFile(
        join(sessionsDir, "sessions.json"),
        JSON.stringify({
          "agent:main:main:session-native": {
            sessionId: "session-native",
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
        join(sessionsDir, "session-native.jsonl"),
        [
          '{"type":"session","version":3,"id":"session-native","timestamp":"2026-03-01T00:00:00.000Z"}',
          '{"type":"message","timestamp":"2026-03-01T00:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Native session question."}]}}',
          '{"type":"message","timestamp":"2026-03-01T00:02:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Native session answer."}]}}',
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(logDir, "log.jsonl"),
        [
          '{"timestamp":"2026-03-01T00:02:00.000Z","id":"B1b2C3d4E5f6","type":"session_summary","content":"Old native summary.","session":"session-native"}',
          '{"timestamp":"2026-03-01T00:03:00.000Z","id":"C1b2C3d4E5f6","type":"fact","content":"Important fact","subject":"reclaw","session":"session-native"}',
        ].join("\n") + "\n",
        "utf8",
      );

      const result = await backfillSessionSummaries(
        {
          logPath: join(logDir, "log.jsonl"),
          projectionDir: join(logDir, "sessions"),
          model: "anthropic/claude-sonnet-4-6",
          openClawHome,
          mode: "projected",
          clearExisting: true,
          force: true,
        },
        {
          generateSessionSummary: async ({ sessionId }) => ({
            content: `Rebuilt summary for ${sessionId}.`,
            source: "model",
          }),
        },
      );

      const logContent = await readFile(join(logDir, "log.jsonl"), "utf8");
      expect(result.cleared).toBe(1);
      expect(logContent).not.toContain("Old native summary.");
      expect(logContent).toContain('"type":"fact"');
      expect(logContent).toContain("Rebuilt summary for session-native.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("supports bounded parallel session summary generation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-summary-backfill-parallel-"));
    const openClawHome = join(tempDir, "openclaw");
    const sessionsDir = join(openClawHome, "agents", "main", "sessions");
    const logDir = join(tempDir, "reclaw");

    try {
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(join(logDir, "sessions"), { recursive: true });
      await writeFile(
        join(sessionsDir, "sessions.json"),
        JSON.stringify({
          "agent:main:main:session-a": { sessionId: "session-a", origin: { provider: "webchat", surface: "webchat", chatType: "direct" } },
          "agent:main:main:session-b": { sessionId: "session-b", origin: { provider: "webchat", surface: "webchat", chatType: "direct" } },
          "agent:main:main:session-c": { sessionId: "session-c", origin: { provider: "webchat", surface: "webchat", chatType: "direct" } },
        }),
        "utf8",
      );

      for (const sessionId of ["session-a", "session-b", "session-c"]) {
        await writeFile(
          join(sessionsDir, `${sessionId}.jsonl`),
          [
            `{"type":"session","version":3,"id":"${sessionId}","timestamp":"2026-03-01T00:00:00.000Z"}`,
            '{"type":"message","timestamp":"2026-03-01T00:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Question."}]}}',
            '{"type":"message","timestamp":"2026-03-01T00:02:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Answer."}]}}',
          ].join("\n"),
          "utf8",
        );
      }

      let active = 0;
      let maxActive = 0;
      const result = await backfillSessionSummaries(
        {
          logPath: join(logDir, "log.jsonl"),
          projectionDir: join(logDir, "sessions"),
          model: "anthropic/claude-sonnet-4-6",
          openClawHome,
          mode: "projected",
          force: true,
          concurrency: 2,
        },
        {
          generateSessionSummary: async ({ sessionId }) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 25));
            active -= 1;
            return {
              content: `Summary for ${sessionId}.`,
              source: "model",
            };
          },
        },
      );

      expect(result.written).toBe(3);
      expect(maxActive).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("resumes a cleared rewrite without purging prior partial results", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-summary-backfill-resume-"));
    const openClawHome = join(tempDir, "openclaw");
    const sessionsDir = join(openClawHome, "agents", "main", "sessions");
    const logDir = join(tempDir, "reclaw");

    try {
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(join(logDir, "sessions"), { recursive: true });
      await writeFile(
        join(sessionsDir, "sessions.json"),
        JSON.stringify({
          "agent:main:main:session-a": { sessionId: "session-a", origin: { provider: "webchat", surface: "webchat", chatType: "direct" } },
          "agent:main:main:session-b": { sessionId: "session-b", origin: { provider: "webchat", surface: "webchat", chatType: "direct" } },
          "agent:main:main:session-c": { sessionId: "session-c", origin: { provider: "webchat", surface: "webchat", chatType: "direct" } },
        }),
        "utf8",
      );
      for (const sessionId of ["session-a", "session-b", "session-c"]) {
        await writeFile(
          join(sessionsDir, `${sessionId}.jsonl`),
          [
            `{"type":"session","version":3,"id":"${sessionId}","timestamp":"2026-03-01T00:00:00.000Z"}`,
            '{"type":"message","timestamp":"2026-03-01T00:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Question."}]}}',
            '{"type":"message","timestamp":"2026-03-01T00:02:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Answer."}]}}',
          ].join("\n"),
          "utf8",
        );
      }
      await writeFile(
        join(logDir, "log.jsonl"),
        '{"timestamp":"2026-03-01T00:02:00.000Z","id":"A1b2C3d4E5f6","type":"session_summary","content":"Summary for session-a.","session":"session-a"}\n',
        "utf8",
      );

      const result = await backfillSessionSummaries(
        {
          logPath: join(logDir, "log.jsonl"),
          projectionDir: join(logDir, "sessions"),
          model: "anthropic/claude-sonnet-4-6",
          openClawHome,
          mode: "projected",
          clearExisting: true,
          force: true,
          resume: {
            processed: 1,
            written: 1,
            cleared: 2,
            clearApplied: true,
            completedSessionIds: ["session-a"],
            writtenSessionIds: ["session-a"],
          },
        },
        {
          generateSessionSummary: async ({ sessionId }) => ({
            content: `Summary for ${sessionId}.`,
            source: "model",
          }),
        },
      );

      const logContent = await readFile(join(logDir, "log.jsonl"), "utf8");
      expect(result.cleared).toBe(2);
      expect(result.processed).toBe(3);
      expect(result.written).toBe(3);
      expect(logContent).toContain('"session":"session-a"');
      expect(logContent).toContain('"session":"session-b"');
      expect(logContent).toContain('"session":"session-c"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("resuming a cleared rewrite does not skip sessions that were completed but never written", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-summary-backfill-resume-written-"));
    const openClawHome = join(tempDir, "openclaw");
    const sessionsDir = join(openClawHome, "agents", "main", "sessions");
    const logDir = join(tempDir, "reclaw");

    try {
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(join(logDir, "sessions"), { recursive: true });
      await writeFile(
        join(sessionsDir, "sessions.json"),
        JSON.stringify({
          "agent:main:main:session-a": { sessionId: "session-a", origin: { provider: "webchat", surface: "webchat", chatType: "direct" } },
          "agent:main:main:session-b": { sessionId: "session-b", origin: { provider: "webchat", surface: "webchat", chatType: "direct" } },
        }),
        "utf8",
      );
      for (const sessionId of ["session-a", "session-b"]) {
        await writeFile(
          join(sessionsDir, `${sessionId}.jsonl`),
          [
            `{"type":"session","version":3,"id":"${sessionId}","timestamp":"2026-03-01T00:00:00.000Z"}`,
            '{"type":"message","timestamp":"2026-03-01T00:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Question."}]}}',
            '{"type":"message","timestamp":"2026-03-01T00:02:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Answer."}]}}',
          ].join("\n"),
          "utf8",
        );
      }
      await writeFile(
        join(logDir, "log.jsonl"),
        '{"timestamp":"2026-03-01T00:02:00.000Z","id":"A1b2C3d4E5f6","type":"session_summary","content":"Summary for session-a.","session":"session-a"}\n',
        "utf8",
      );

      const result = await backfillSessionSummaries(
        {
          logPath: join(logDir, "log.jsonl"),
          projectionDir: join(logDir, "sessions"),
          model: "anthropic/claude-sonnet-4-6",
          openClawHome,
          mode: "projected",
          clearExisting: true,
          force: true,
          resume: {
            processed: 2,
            written: 1,
            cleared: 1,
            clearApplied: true,
            completedSessionIds: ["session-a", "session-b"],
            writtenSessionIds: ["session-a"],
          },
        },
        {
          generateSessionSummary: async ({ sessionId }) => ({
            content: `Summary for ${sessionId}.`,
            source: "model",
          }),
        },
      );

      const logContent = await readFile(join(logDir, "log.jsonl"), "utf8");
      expect(result.processed).toBe(2);
      expect(result.written).toBe(2);
      expect(logContent).toContain('"session":"session-a"');
      expect(logContent).toContain('"session":"session-b"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("projected rewrite skips fallback summaries instead of appending them", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reclaw-summary-backfill-strict-"));
    const openClawHome = join(tempDir, "openclaw");
    const sessionsDir = join(openClawHome, "agents", "main", "sessions");
    const logDir = join(tempDir, "reclaw");

    try {
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(join(logDir, "sessions"), { recursive: true });
      await writeFile(
        join(sessionsDir, "sessions.json"),
        JSON.stringify({
          "agent:main:main:session-fallback": {
            sessionId: "session-fallback",
            origin: { provider: "webchat", surface: "webchat", chatType: "direct" },
          },
        }),
        "utf8",
      );
      await writeFile(
        join(sessionsDir, "session-fallback.jsonl"),
        [
          '{"type":"session","version":3,"id":"session-fallback","timestamp":"2026-03-01T00:00:00.000Z"}',
          '{"type":"message","timestamp":"2026-03-01T00:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Question."}]}}',
          '{"type":"message","timestamp":"2026-03-01T00:02:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Answer."}]}}',
        ].join("\n"),
        "utf8",
      );

      const result = await backfillSessionSummaries(
        {
          logPath: join(logDir, "log.jsonl"),
          projectionDir: join(logDir, "sessions"),
          model: "anthropic/claude-sonnet-4-6",
          openClawHome,
          mode: "projected",
          force: true,
        },
        {
          generateSessionSummary: async () => ({
            content: "Question.",
            detail: "Latest assistant response: Answer.",
            source: "fallback",
            fallbackReason: "model_error",
          }),
        },
      );

      expect(result.written).toBe(0);
      expect(result.skippedFallback).toBe(1);
      expect(await Bun.file(join(logDir, "log.jsonl")).exists()).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
