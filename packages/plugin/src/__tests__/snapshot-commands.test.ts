import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../config";
import type { CommandLike } from "../cli/command-like";
import { registerBriefingCommands, runSessionHandoffRefresh } from "../cli/register-briefing-commands";
import { writeState } from "../state";
import { LAST_HANDOFF_BEGIN_MARKER, LAST_HANDOFF_END_MARKER } from "../memory/markers";

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

describe("snapshot and handoff CLI commands", () => {
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

  test("registers snapshot and handoff command sets with refresh/list/status", () => {
    const root = new MockCommand("reclaw");
    registerBriefingCommands(root, {
      config: createConfig(logDir),
      workspaceDir,
      api: { config: {} } as never,
    });

    expect(root.children.has("snapshot")).toBe(true);
    expect(root.children.has("handoff")).toBe(true);
    expect(root.children.has("briefing")).toBe(false);

    const snapshot = root.children.get("snapshot");
    expect(snapshot?.children.has("refresh")).toBe(true);
    expect(snapshot?.children.has("generate")).toBe(true);
    expect(snapshot?.children.has("list")).toBe(true);
    expect(snapshot?.children.has("status")).toBe(true);

    const handoff = root.children.get("handoff");
    expect(handoff?.children.has("refresh")).toBe(true);
    expect(handoff?.children.has("list")).toBe(true);
    expect(handoff?.children.has("status [sessionId]")).toBe(true);

    expect(root.children.has("status")).toBe(true);
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
      '{"timestamp":"2026-03-03T09:02:00.000Z","id":"M3n4O5p6Q7r8","type":"handoff","subject":"reclaw","content":"Latest handoff content","session":"session-a"}\n',
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
    expect(rendered).toContain("Handoffs");
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


  test("handoff status command reports compaction and extraction for a session", async () => {
    const root = new MockCommand("reclaw");
    registerBriefingCommands(root, {
      config: createConfig(logDir),
      workspaceDir,
      api: { config: {} } as never,
    });

    await writeFile(
      join(logDir, "log.jsonl"),
      '{"timestamp":"2026-03-01T09:00:00.000Z","id":"M3n4O5p6Q7r8","type":"handoff","subject":"reclaw","content":"Session handoff","session":"session-42"}\n',
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
      .get("handoff")
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
    expect(rendered).toContain("Handoff status for session=session-42");
    expect(rendered).toContain("Compaction: extracted");
    expect(rendered).toContain("Extraction: success");
    expect(rendered).toContain("Handoff: yes");
  });
  test("runSessionHandoffRefresh writes the latest handoff entry into MEMORY.md", async () => {
    const logPath = join(logDir, "log.jsonl");
    await writeFile(
      logPath,
      [
        '{"timestamp":"2026-03-01T00:01:00.000Z","id":"A1b2C3d4E5f6","type":"fact","subject":"reclaw","content":"Fact entry","session":"s-1"}',
        '{"timestamp":"2026-03-01T00:02:00.000Z","id":"G7h8I9j0K1l2","type":"handoff","subject":"reclaw","content":"Earlier handoff","session":"s-2"}',
        '{"timestamp":"2026-03-01T00:03:00.000Z","id":"M3n4O5p6Q7r8","type":"handoff","subject":"reclaw","content":"Latest handoff","detail":"Carry this forward","session":"s-3"}',
        "",
      ].join("\n"),
      "utf8",
    );

    const memoryPath = join(workspaceDir, "MEMORY.md");
    await writeFile(
      memoryPath,
      [LAST_HANDOFF_BEGIN_MARKER, "Old handoff text", LAST_HANDOFF_END_MARKER, ""].join("\n"),
      "utf8",
    );

    const result = await runSessionHandoffRefresh({
      config: createConfig(logDir),
      workspaceDir,
    });

    expect(result.updated).toBe(true);
    const memoryText = await readFile(memoryPath, "utf8");
    expect(memoryText).toContain("## Previous Session Handoff (s-3)");
    expect(memoryText).toContain("Latest handoff");
    expect(memoryText).toContain("### Details");
    expect(memoryText).toContain("Carry this forward");
    expect(memoryText).not.toContain("Old handoff text");
  });

  test("runSessionHandoffRefresh is a no-op when no handoff entries exist", async () => {
    const logPath = join(logDir, "log.jsonl");
    await writeFile(
      logPath,
      '{"timestamp":"2026-03-01T00:01:00.000Z","id":"A1b2C3d4E5f6","type":"fact","subject":"reclaw","content":"Fact entry","session":"s-1"}\n',
      "utf8",
    );

    const memoryPath = join(workspaceDir, "MEMORY.md");
    await writeFile(memoryPath, "Manual memory content\n", "utf8");

    const result = await runSessionHandoffRefresh({
      config: createConfig(logDir),
      workspaceDir,
    });

    expect(result.updated).toBe(false);
    expect(await readFile(memoryPath, "utf8")).toBe("Manual memory content\n");
  });
});
