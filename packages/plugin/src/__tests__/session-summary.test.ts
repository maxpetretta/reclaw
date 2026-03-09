import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { registerExtractionHooks } from "../hooks/extraction";
import { readLog } from "../log/schema";

type HookHandlers = {
  before_reset?: (
    event: { messages?: unknown[]; sessionFile?: string },
    ctx: { agentId?: string; sessionId?: string; sessionKey?: string; workspaceDir?: string },
  ) => void | Promise<void>;
};

function createMockApi(config: unknown, handlers: HookHandlers): OpenClawPluginApi {
  return {
    config,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    registerHook() {},
    on(hookName: string, handler: (...args: unknown[]) => void | Promise<void>) {
      (handlers as Record<string, (...args: unknown[]) => void | Promise<void>>)[hookName] = handler;
    },
  } as unknown as OpenClawPluginApi;
}

function createPluginConfig(logDir: string): PluginConfig {
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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("timed out waiting for condition");
}

describe("session summary flow", () => {
  let tempDir = "";
  let logDir = "";
  let workspaceDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reclaw-session-summary-"));
    logDir = join(tempDir, "reclaw");
    workspaceDir = join(tempDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("before_reset writes a session summary synchronously and continues durable extraction in background", async () => {
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      generateSessionSummary: async () => ({
        content: "Worked on auth migration rollout.",
        detail: "Retry validation remains open.",
      }),
      extractFromTranscript: async () =>
        '{"type":"fact","content":"Auth migration retry validation remains open","subject":"auth-migration"}',
    });

    await handlers.before_reset?.(
      {
        messages: [
          {
            role: "user",
            content: "We finished the rollout work but still need retry validation.",
          },
          {
            role: "assistant",
            content: "I will carry that forward.",
          },
        ],
      },
      {
        sessionId: "session-reset-summary",
        sessionKey: "agent:main",
        workspaceDir,
      },
    );

    const memoryContent = await readFile(join(workspaceDir, "MEMORY.md"), "utf8");
    const immediateEntries = await readLog(join(logDir, "log.jsonl"));

    expect(memoryContent).toContain("## Previous Session Summary (agent:main)");
    expect(memoryContent).toContain("Worked on auth migration rollout.");
    expect(immediateEntries.some((entry) => entry.type === "session_summary")).toBe(true);

    await waitFor(async () => {
      const entries = await readLog(join(logDir, "log.jsonl"));
      return entries.some((entry) => entry.type === "fact");
    });

    const finalEntries = await readLog(join(logDir, "log.jsonl"));
    expect(finalEntries.some((entry) => entry.type === "fact")).toBe(true);
  });
});
