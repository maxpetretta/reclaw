import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../config";
import type { CommandLike } from "../cli/command-like";
import { registerBriefingCommands, runSessionSummaryRefresh } from "../cli/register-briefing-commands";
import { parseRefreshScopes, registerRefreshCommands, runRefresh } from "../cli/register-refresh-commands";
import { writeState } from "../state";
import {
  LAST_SESSION_SUMMARY_BEGIN_MARKER,
  LAST_SESSION_SUMMARY_END_MARKER,
} from "../memory/markers";

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

class MockCommand implements CommandLike {
  readonly children = new Map<string, MockCommand>();
  actionHandler: ((...args: unknown[]) => unknown) | undefined;

  constructor(readonly name: string) {}

  command(name: string): CommandLike {
    const child = new MockCommand(name);
    this.children.set(name, child);
    return child;
  }

  description(_text: string): CommandLike {
    return this;
  }

  option(_flag: string, _description?: string, _defaultValue?: unknown): CommandLike {
    return this;
  }

  argument(_spec: string, _description?: string): CommandLike {
    return this;
  }

  action(handler: (...args: unknown[]) => unknown): CommandLike {
    this.actionHandler = handler;
    return this;
  }
}

describe("snapshot and summary CLI commands", () => {
  let tempDir = "";
  let workspaceDir = "";
  let logDir = "";
  let originalOpenClawHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reclaw-snapshot-cli-"));
    workspaceDir = join(tempDir, "workspace");
    logDir = join(tempDir, "reclaw-store");
    originalOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = tempDir;

    await mkdir(workspaceDir, { recursive: true });
    await mkdir(logDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  test("registers unified refresh command and removes old refresh subcommands", () => {
    const root = new MockCommand("reclaw");
    registerRefreshCommands(root, {
      config: createConfig(logDir),
      workspaceDir,
      api: { config: {} } as never,
    });
    registerBriefingCommands(root, {
      config: createConfig(logDir),
      workspaceDir,
      api: { config: {} } as never,
    });

    expect(root.children.has("refresh")).toBe(true);

    const snapshot = root.children.get("snapshot");
    expect(snapshot?.children.has("refresh")).toBe(false);
    expect(snapshot?.children.has("list")).toBe(true);
    expect(snapshot?.children.has("status")).toBe(true);

    const summary = root.children.get("summary");
    expect(summary?.children.has("refresh")).toBe(false);
    expect(summary?.children.has("list")).toBe(true);
    expect(summary?.children.has("status [sessionId]")).toBe(true);

    expect(root.children.has("status")).toBe(true);
    expect(root.children.has("projection")).toBe(false);
    expect(root.children.has("handoff")).toBe(false);
  });

  test("parseRefreshScopes defaults to all scopes and supports aliases", () => {
    expect(parseRefreshScopes(undefined)).toEqual(["subjects", "sessions", "transcripts", "summary", "snapshot"]);
    expect(parseRefreshScopes("memory,transcript,summary")).toEqual(["subjects", "transcripts", "summary"]);
    expect(parseRefreshScopes(["sessions", "snapshot"])).toEqual(["sessions", "snapshot"]);
  });

  test("runRefresh sessions scope only refreshes existing projections by default", async () => {
    await mkdir(join(logDir, "sessions"), { recursive: true });
    await writeFile(
      join(logDir, "log.jsonl"),
      '{"timestamp":"2026-03-01T00:02:00.000Z","id":"A1b2C3d4E5f6","type":"session_summary","content":"Native summary.","session":"session-native"}\n',
      "utf8",
    );

    const result = await runRefresh({
      config: createConfig(logDir),
      api: { config: {} } as never,
      workspaceDir,
      scope: "sessions",
    });

    const logContent = await readFile(join(logDir, "log.jsonl"), "utf8");
    const projection = await readFile(join(logDir, "sessions", "session-native.md"), "utf8");

    expect(result.sessionSummaryBackfilled).toBe(0);
    expect(logContent).toContain('"type":"session_summary"');
    expect(logContent).toContain('"session":"session-native"');
    expect(projection).toContain("# Session session-native");
  });

  test("runRefresh can rewrite existing native session summaries when requested", async () => {
    await writeFile(
      join(logDir, "log.jsonl"),
      [
        '{"timestamp":"2026-03-01T00:02:00.000Z","id":"A1b2C3d4E5f6","type":"session_summary","content":"Old native summary.","session":"session-native"}',
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await runRefresh({
      config: createConfig(logDir),
      api: { config: {} } as never,
      workspaceDir,
      scope: "sessions",
      rewriteExistingSessionSummaries: true,
    }, {
      backfillSessionSummaries: async ({ logPath, onProgress }) => {
        await writeFile(
          logPath,
          '{"timestamp":"2026-03-01T00:02:00.001Z","id":"B1b2C3d4E5f6","type":"session_summary","content":"Rebuilt native summary.","session":"session-native"}\n',
          "utf8",
        );
        await onProgress?.({
          total: 1,
          processed: 1,
          written: 1,
          existing: 0,
          skippedNoTranscript: 0,
          skippedNoConversation: 0,
          skippedFallback: 0,
          cleared: 1,
        });
        return {
          scanned: 1,
          total: 1,
          processed: 1,
          written: 1,
          existing: 0,
          skippedNoTranscript: 0,
          skippedNoConversation: 0,
          skippedFallback: 0,
          cleared: 1,
        };
      },
    });

    const logContent = await readFile(join(logDir, "log.jsonl"), "utf8");
    const summaryLines = logContent.split("\n").filter((line) => line.includes('"session":"session-native"'));

    expect(result.sessionSummaryBackfilled).toBe(1);
    expect(result.sessionSummaryCleared).toBe(1);
    expect(summaryLines.length).toBe(1);
  });

  test("runRefresh forwards configurable session summary concurrency", async () => {
    const observed: number[] = [];

    const result = await runRefresh({
      config: createConfig(logDir),
      api: { config: {} } as never,
      workspaceDir,
      scope: "sessions",
      rewriteExistingSessionSummaries: true,
      sessionSummaryConcurrency: "7",
    }, {
      backfillSessionSummaries: async ({ concurrency, onProgress }) => {
        observed.push(concurrency ?? -1);
        await onProgress?.({
          total: 1,
          processed: 1,
          written: 1,
          existing: 0,
          skippedNoTranscript: 0,
          skippedNoConversation: 0,
          skippedFallback: 0,
          cleared: 0,
        });
        return {
          scanned: 1,
          total: 1,
          processed: 1,
          written: 1,
          existing: 0,
          skippedNoTranscript: 0,
          skippedNoConversation: 0,
          skippedFallback: 0,
          cleared: 0,
        };
      },
    });

    expect(result.sessionSummaryBackfilled).toBe(1);
    expect(observed).toEqual([7]);
  });

  test("runRefresh resumes an incomplete projected session summary rewrite", async () => {
    await writeState(join(logDir, "state.json"), {
      extractedSessions: {},
      failedSessions: {},
      importedConversations: {},
      eventUsage: {},
      importJobs: {},
      compactionSessions: {},
      snapshotRuns: [],
      sessionSummaryRewrite: {
        mode: "projected",
        status: "failed",
        startedAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:10:00.000Z",
        finishedAt: "2026-03-01T00:10:00.000Z",
        total: 10,
        processed: 4,
        written: 3,
        cleared: 12,
        clearApplied: true,
        completedSessionIds: ["session-a", "session-b", "session-c", "session-d"],
        writtenSessionIds: ["session-a", "session-b", "session-c"],
      },
    });

    let observedResume: unknown;
    const result = await runRefresh({
      config: createConfig(logDir),
      api: { config: {} } as never,
      workspaceDir,
      scope: "sessions",
      rewriteExistingSessionSummaries: true,
    }, {
      backfillSessionSummaries: async ({ resume, onProgress }) => {
        observedResume = resume;
        await onProgress?.({
          total: 10,
          processed: 5,
          written: 4,
          existing: 0,
          skippedNoTranscript: 0,
          skippedNoConversation: 0,
          skippedFallback: 0,
          cleared: 12,
          completedSessionId: "session-e",
          wroteSessionId: "session-e",
        });
        return {
          scanned: 10,
          total: 10,
          processed: 5,
          written: 4,
          existing: 0,
          skippedNoTranscript: 0,
          skippedNoConversation: 0,
          skippedFallback: 0,
          cleared: 12,
        };
      },
    });

    const state = await readFile(join(logDir, "state.json"), "utf8");
    expect(result.sessionSummaryBackfilled).toBe(4);
    expect(observedResume).toEqual({
      processed: 4,
      written: 3,
      cleared: 12,
      clearApplied: true,
      completedSessionIds: ["session-a", "session-b", "session-c", "session-d"],
      writtenSessionIds: ["session-a", "session-b", "session-c"],
      skipFirstProcessedCount: 0,
    });
    expect(state).toContain('"status": "completed"');
    expect(state).toContain('"completedSessionIds": [');
    expect(state).toContain('"session-e"');
  });

  test("status command prints recent snapshots, extractions, and handoffs", async () => {
    const root = new MockCommand("reclaw");
    registerBriefingCommands(root, {
      config: createConfig(logDir),
      workspaceDir,
      api: { config: {} } as never,
    });

    await writeState(join(logDir, "state.json"), {
      extractedSessions: {
        "session-a": {
          at: "2026-03-03T09:01:00.000Z",
          entries: 3,
          lastMessageAt: "2026-03-03T09:00:00.000Z",
        },
      },
      failedSessions: {
        "session-failed": {
          at: "2026-03-03T09:03:00.000Z",
          error: "extraction model returned non-empty output but no valid entries",
          retries: 1,
          sourceSessionKey: "agent:main:main:session-failed",
          workerSessionKey: "agent:main:cron:job-9:run:worker-failed",
        },
      },
      importedConversations: {},
      eventUsage: {},
      importJobs: {},
      compactionSessions: {
        "session-a": {
          at: "2026-03-03T09:00:30.000Z",
          messageCount: 24,
          compactedCount: 12,
          status: "extracted",
          extractedAt: "2026-03-03T09:01:00.000Z",
          entries: 3,
        },
        "session-failed": {
          at: "2026-03-03T09:02:30.000Z",
          messageCount: 18,
          compactedCount: 7,
          status: "failed",
          error: "extraction model returned non-empty output but no valid entries",
        },
        "session-compaction-only": {
          at: "2026-03-03T09:04:00.000Z",
          messageCount: 12,
          compactedCount: 5,
          status: "skipped",
          reason: "no new messages since last extraction",
        },
      },
      snapshotRuns: [
        {
          at: "2026-03-03T09:05:00.000Z",
          status: "success",
          memoryMdPath: join(workspaceDir, "MEMORY.md"),
          workerSessionId: "snapshot-worker-session-id",
          workerSessionKey: "agent:main:cron:job-2:run:snapshot-worker-session-id",
        },
      ],
    });

    await writeFile(
      join(logDir, "log.jsonl"),
      '{"timestamp":"2026-03-03T09:02:00.000Z","id":"M3n4O5p6Q7r8","type":"session_summary","content":"Latest handoff content","session":"session-a"}\n',
      "utf8",
    );
    await mkdir(join(tempDir, "agents", "main", "sessions"), { recursive: true });
    await writeFile(
      join(tempDir, "agents", "main", "sessions", "sessions.json"),
      JSON.stringify({
        "agent:main:main:session-a": {
          sessionId: "session-a",
        },
        "agent:main:main:session-compaction-only": {
          sessionId: "session-compaction-only",
        },
      }),
      "utf8",
    );

    const handler = root.children.get("status")?.actionHandler;
    expect(handler).toBeDefined();

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };

    try {
      await handler?.({ limit: "5" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Reclaw status (recent 5)");
    expect(rendered).toContain("Snapshots");
    expect(rendered).toContain("status=success");
    expect(rendered).toContain("workerSessionKey=agent:main:cron:job-2:run:snapshot-worker-session-id");
    expect(rendered).toContain("Extractions");
    expect(rendered).toContain("session=session-a result=success entries=3 compaction=extracted");
    expect(rendered).toContain("sourceSessionKey=agent:main:main:session-a");
    expect(rendered).toContain("workerSessionKey=n/a");
    expect(rendered).toContain("session=session-failed result=failed retries=1 compaction=failed");
    expect(rendered).toContain("error=extraction model returned non-empty output but no valid entries");
    expect(rendered).toContain("sourceSessionKey=agent:main:main:session-failed");
    expect(rendered).toContain("workerSessionKey=agent:main:cron:job-9:run:worker-failed");
    expect(rendered).toContain("session=session-compaction-only result=none compaction=skipped");
    expect(rendered).toContain("compactionDetail=no new messages since last extraction");
    expect(rendered).toContain("Session summaries");
    expect(rendered).toContain("session=session-a compact=extracted Latest handoff content");
    expect(rendered).toContain("sourceSessionKey=agent:main:main:session-a");
  });

  test("status command --all ignores --limit", async () => {
    const root = new MockCommand("reclaw");
    registerBriefingCommands(root, {
      config: createConfig(logDir),
      workspaceDir,
      api: { config: {} } as never,
    });

    await writeState(join(logDir, "state.json"), {
      extractedSessions: {
        "session-one": {
          at: "2026-03-03T09:01:00.000Z",
          entries: 1,
        },
        "session-two": {
          at: "2026-03-03T09:02:00.000Z",
          entries: 2,
        },
      },
      failedSessions: {},
      importedConversations: {},
      eventUsage: {},
      importJobs: {},
      compactionSessions: {},
      snapshotRuns: [],
    });

    const handler = root.children.get("status")?.actionHandler;
    expect(handler).toBeDefined();

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };

    try {
      await handler?.({ limit: "1", all: true });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Reclaw status (all)");
    expect(rendered).toContain("session=session-one");
    expect(rendered).toContain("session=session-two");
  });


  test("summary status command reports compaction and extraction for a session", async () => {
    const root = new MockCommand("reclaw");
    registerBriefingCommands(root, {
      config: createConfig(logDir),
      workspaceDir,
      api: { config: {} } as never,
    });

    await writeFile(
      join(logDir, "log.jsonl"),
      '{"timestamp":"2026-03-01T09:00:00.000Z","id":"M3n4O5p6Q7r8","type":"session_summary","content":"Session summary","session":"session-42"}\n',
      "utf8",
    );

    await writeState(join(logDir, "state.json"), {
      extractedSessions: {
        "session-42": {
          at: "2026-03-01T09:01:00.000Z",
          entries: 2,
        },
      },
      failedSessions: {},
      importedConversations: {},
      eventUsage: {},
      importJobs: {},
      compactionSessions: {
        "session-42": {
          at: "2026-03-01T09:00:30.000Z",
          messageCount: 24,
          compactedCount: 12,
          status: "extracted",
          extractedAt: "2026-03-01T09:01:00.000Z",
          entries: 2,
        },
      },
      snapshotRuns: [],
    });

    const handler = root
      .children
      .get("summary")
      ?.children
      .get("status [sessionId]")
      ?.actionHandler;

    expect(handler).toBeDefined();

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };

    try {
      await handler?.("session-42");
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Session summary status for session=session-42");
    expect(rendered).toContain("Compaction: extracted");
    expect(rendered).toContain("Extraction: success");
    expect(rendered).toContain("Session summary: yes");
  });
  test("runSessionSummaryRefresh writes the latest session summary into MEMORY.md", async () => {
    const logPath = join(logDir, "log.jsonl");
    await writeFile(
      logPath,
      [
        '{"timestamp":"2026-03-01T00:01:00.000Z","id":"A1b2C3d4E5f6","type":"fact","subject":"reclaw","content":"Fact entry","session":"s-1"}',
        '{"timestamp":"2026-03-01T00:02:00.000Z","id":"G7h8I9j0K1l2","type":"session_summary","content":"Earlier summary","session":"s-2"}',
        '{"timestamp":"2026-03-01T00:03:00.000Z","id":"M3n4O5p6Q7r8","type":"session_summary","content":"Latest summary","detail":"Carry this forward","session":"s-3"}',
        "",
      ].join("\n"),
      "utf8",
    );

    const memoryPath = join(workspaceDir, "MEMORY.md");
    await writeFile(
      memoryPath,
      [LAST_SESSION_SUMMARY_BEGIN_MARKER, "Old summary text", LAST_SESSION_SUMMARY_END_MARKER, ""].join("\n"),
      "utf8",
    );

    const result = await runSessionSummaryRefresh({
      config: createConfig(logDir),
      workspaceDir,
    });

    expect(result.updated).toBe(true);
    const memoryText = await readFile(memoryPath, "utf8");
    expect(memoryText).toContain("## Previous Session Summary (s-3)");
    expect(memoryText).toContain("Latest summary");
    expect(memoryText).toContain("### Details");
    expect(memoryText).toContain("Carry this forward");
    expect(memoryText).not.toContain("Old summary text");
  });

  test("runSessionSummaryRefresh is a no-op when no session summary entries exist", async () => {
    const logPath = join(logDir, "log.jsonl");
    await writeFile(
      logPath,
      '{"timestamp":"2026-03-01T00:01:00.000Z","id":"A1b2C3d4E5f6","type":"fact","subject":"reclaw","content":"Fact entry","session":"s-1"}\n',
      "utf8",
    );

    const memoryPath = join(workspaceDir, "MEMORY.md");
    await writeFile(memoryPath, "Manual memory content\n", "utf8");

    const result = await runSessionSummaryRefresh({
      config: createConfig(logDir),
      workspaceDir,
    });

    expect(result.updated).toBe(false);
    expect(await readFile(memoryPath, "utf8")).toBe("Manual memory content\n");
  });
});
