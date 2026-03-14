import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../config";
import type { CommandLike } from "../cli/command-like";
import { registerImportCommands } from "../cli/register-import-commands";

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

describe("import CLI commands", () => {
  let tempDir = "";
  let openClawHome = "";
  let workspaceDir = "";
  let logDir = "";
  let originalOpenClawHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reclaw-import-cli-"));
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

  test("import transcripts accepts a grok directory and auto-resolves the export JSON", async () => {
    const root = new MockCommand("reclaw");
    registerImportCommands(root, {
      config: createConfig(logDir),
      workspaceDir,
      api: { config: {} } as never,
      runRestoreTranscriptsCommand: async (input) => {
        const sessionId = "reclaw:grok:grok-conv-1";
        const sessionsDir = join(openClawHome, "agents", "main", "sessions");
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(
          join(sessionsDir, `${sessionId}.jsonl`),
          [
            '{"type":"session","version":3,"id":"reclaw:grok:grok-conv-1","timestamp":"2024-01-01T00:00:00.000Z"}',
            '{"type":"message","timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
            '{"type":"message","timestamp":"2024-01-01T00:01:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}',
          ].join("\n"),
          "utf8",
        );
        expect(input.platform).toBe("grok");
        expect(input.filePath).toBe(join(grokDir, "conversations.json"));
        return {
          summary: {
            platform: "grok",
            parsed: 1,
            dedupedInInput: 0,
            selected: 1,
            skippedByDate: 0,
            skippedByMinMessages: 0,
            restored: 1,
            dryRun: false,
          },
          restoredSessions: [{ agentId: "main", sessionId }],
        };
      },
    });

    const importRoot = root.children.get("import [platform] [file]");
    const handler = importRoot?.children.get("transcripts <platform> <file>")?.actionHandler;
    expect(handler).toBeDefined();

    const grokDir = join(workspaceDir, "grok-export");
    await mkdir(grokDir, { recursive: true });
    await writeFile(
      join(grokDir, "conversations.json"),
      JSON.stringify({
        conversations: [
          {
            _id: "grok-conv-1",
            title: "Grok test",
            messages: [
              { id: "m1", role: "user", content: "hello", timestamp: 1704067200 },
              { id: "m2", role: "assistant", content: "world", timestamp: 1704067260 },
            ],
          },
        ],
      }),
      "utf8",
    );

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };

    try {
      await handler?.("grok", grokDir, { minMessages: 1 });
    } finally {
      console.log = originalLog;
    }

    const sessionId = "reclaw:grok:grok-conv-1";
    const sessionText = await readFile(join(openClawHome, "agents", "main", "sessions", `${sessionId}.jsonl`), "utf8");
    expect(sessionText).toContain('"role":"user"');
    expect(sessionText).toContain('"role":"assistant"');
    expect(output.join("\n")).toContain("Transcript restore grok");
  });
});
