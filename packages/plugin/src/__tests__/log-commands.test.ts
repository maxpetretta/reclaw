import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../config";
import type { CommandLike } from "../cli/command-like";
import { registerLogCommands } from "../cli/register-log-commands";

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

describe("log CLI commands", () => {
  let tempDir = "";
  let logDir = "";
  let workspaceDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reclaw-log-cli-"));
    logDir = join(tempDir, "reclaw-store");
    workspaceDir = join(tempDir, "workspace");
    await mkdir(logDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("trace supports date-range filter and per-chain limit", async () => {
    const root = new MockCommand("reclaw");
    registerLogCommands(root, {
      config: createConfig(logDir),
      workspaceDir,
    });

    await writeFile(
      join(logDir, "log.jsonl"),
      [
        '{"timestamp":"2026-03-01T10:00:00.000Z","id":"trace0000001","type":"decision","subject":"auth-migration","content":"First change","session":"s1"}',
        '{"timestamp":"2026-03-02T10:00:00.000Z","id":"trace0000002","type":"decision","subject":"auth-migration","content":"Second change","session":"s2"}',
        '{"timestamp":"2026-03-03T10:00:00.000Z","id":"trace0000003","type":"decision","subject":"auth-migration","content":"Third change","session":"s3"}',
        '{"timestamp":"2026-03-03T11:00:00.000Z","id":"trace0000004","type":"fact","subject":"other-subject","content":"Other chain","session":"s4"}',
        "",
      ].join("\n"),
      "utf8",
    );

    const handler = root.children.get("trace [id]")?.actionHandler;
    expect(handler).toBeDefined();

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };

    try {
      await handler?.(undefined, {
        subject: "auth-migration",
        from: "2026-03-02",
        to: "2026-03-04",
        limit: "1",
      });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Chain 1 (auth-migration):");
    expect(rendered).toContain("showing most recent 1 of 2");
    expect(rendered).toContain("[id=trace0000003]");
    expect(rendered).not.toContain("[id=trace0000002]");
    expect(rendered).not.toContain("[id=trace0000001]");
  });

  test("trace --summary prints compact chain lines", async () => {
    const root = new MockCommand("reclaw");
    registerLogCommands(root, {
      config: createConfig(logDir),
      workspaceDir,
    });

    await writeFile(
      join(logDir, "log.jsonl"),
      [
        '{"timestamp":"2026-03-01T10:00:00.000Z","id":"trace0000001","type":"decision","subject":"auth-migration","content":"First change","session":"s1"}',
        '{"timestamp":"2026-03-02T10:00:00.000Z","id":"trace0000002","type":"decision","subject":"auth-migration","content":"Second change","session":"s2"}',
        '{"timestamp":"2026-03-03T10:00:00.000Z","id":"trace0000003","type":"decision","subject":"auth-migration","content":"Third change","session":"s3"}',
        "",
      ].join("\n"),
      "utf8",
    );

    const handler = root.children.get("trace [id]")?.actionHandler;
    expect(handler).toBeDefined();

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };

    try {
      await handler?.(undefined, {
        summary: true,
      });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Chain 1 (auth-migration): entries=3");
    expect(rendered).toContain("latestId=trace0000003");
    expect(rendered).not.toContain("Third change");
    expect(rendered).not.toContain("->");
  });
});

