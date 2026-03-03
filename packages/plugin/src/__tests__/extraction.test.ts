import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { registerExtractionHooks } from "../hooks/extraction";
import { appendEntry, readLog, type LogEntry } from "../log/schema";
import {
  BRIEFING_BEGIN_MARKER,
  BRIEFING_END_MARKER,
  LAST_HANDOFF_BEGIN_MARKER,
  LAST_HANDOFF_END_MARKER,
} from "../memory/markers";
import { readState } from "../state";
import { readRegistry, writeRegistry } from "../subjects/registry";

type HookHandlers = {
  session_end?: (
    event: { sessionId: string; messageCount: number },
    ctx: { agentId?: string; sessionId: string; workspaceDir?: string },
  ) => Promise<void>;
  before_reset?: (
    event: { messages?: unknown[]; sessionFile?: string },
    ctx: { agentId?: string; sessionId?: string; sessionKey?: string; workspaceDir?: string },
  ) => Promise<void>;
  after_compaction?: (
    event: { messageCount: number; compactedCount: number; tokenCount?: number; sessionFile?: string },
    ctx: { agentId?: string; sessionId?: string; sessionKey?: string; workspaceDir?: string },
  ) => Promise<void>;
  gateway_start?: (event: { port: number }) => Promise<void>;
};

function createMockApi(config: unknown, handlers: HookHandlers): OpenClawPluginApi {
  const api = {
    config,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    registerHook() {},
    on(hookName: string, handler: (...args: unknown[]) => Promise<void>) {
      (handlers as Record<string, (...args: unknown[]) => Promise<void>>)[hookName] = handler;
    },
  };

  return api as unknown as OpenClawPluginApi;
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

async function seedLogEntry(logDir: string, entry: LogEntry): Promise<void> {
  await appendEntry(join(logDir, "log.jsonl"), entry);
}

async function seedMainSession(openclawHome: string, agentId: string, sessionId: string): Promise<void> {
  const sessionsDir = join(openclawHome, "agents", agentId, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const storePath = join(sessionsDir, "sessions.json");
  let store: Record<string, unknown> = {};
  try {
    store = JSON.parse(await readFile(storePath, "utf8")) as Record<string, unknown>;
  } catch {}
  store[`agent:${agentId}:main:${sessionId}`] = { sessionId };
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

describe("extraction hooks", () => {
  let tempDir = "";
  let openclawHome = "";
  let logDir = "";
  let originalOpenClawHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reclaw-extraction-"));
    openclawHome = join(tempDir, "openclaw");
    logDir = join(tempDir, "reclaw");

    originalOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
  });

  afterEach(async () => {
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  test("session_end runs extraction pipeline and dedups repeated sessions", async () => {
    await seedMainSession(openclawHome, "agent-1", "session-1");
    const transcriptPath = join(openclawHome, "agents", "agent-1", "sessions", "session-1.jsonl");
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-1","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"user","content":"Decide retry policy"}}',
        '{"type":"message","timestamp":"2026-02-20T00:02:00.000Z","message":{"role":"assistant","content":"Use queue + backoff"}}',
      ].join("\n"),
      "utf8",
    );

    let llmCalls = 0;
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        return [
          '{"type":"decision","content":"Queue retries for webhooks","detail":"Avoid sync retry storms","subject":"auth-migration"}',
          "not-json",
        ].join("\n");
      },
    });

    await handlers.session_end?.(
      { sessionId: "session-1", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-1" },
    );

    await handlers.session_end?.(
      { sessionId: "session-1", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-1" },
    );

    const entries = await readLog(join(logDir, "log.jsonl"));
    const state = await readState(join(logDir, "state.json"));
    const registry = await readRegistry(join(logDir, "subjects.json"));

    expect(llmCalls).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.session).toBe("session-1");
    expect(registry["auth-migration"]?.display).toBe("Auth Migration");
    expect(state.extractedSessions["session-1"]?.entries).toBe(1);
  });

  test("session_end skips non-main sessions discovered from sessions.json key", async () => {
    const sessionsDir = join(openclawHome, "agents", "agent-1", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "session-sub.jsonl"),
      [
        '{"type":"session","id":"session-sub","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"user","content":"should be skipped"}}',
        '{"type":"message","timestamp":"2026-02-20T00:02:00.000Z","message":{"role":"assistant","content":"ack"}}',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "sub:worker:agent-1": {
            sessionId: "session-sub",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    let llmCalls = 0;
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        return '{"type":"fact","content":"should not be extracted"}';
      },
    });

    await handlers.session_end?.(
      { sessionId: "session-sub", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-sub" },
    );

    const state = await readState(join(logDir, "state.json"));
    expect(llmCalls).toBe(0);
    expect(state.extractedSessions["session-sub"]).toBeUndefined();
    expect(state.failedSessions["session-sub"]).toBeUndefined();
  });

  test("auto-created subject types use enum validation with topic fallback", async () => {
    await seedMainSession(openclawHome, "agent-1", "session-types");
    const transcriptPath = join(openclawHome, "agents", "agent-1", "sessions", "session-types.jsonl");
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-types","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"user","content":"Remember people and projects"}}',
        '{"type":"message","timestamp":"2026-02-20T00:02:00.000Z","message":{"role":"assistant","content":"Noted"}}',
      ].join("\n"),
      "utf8",
    );

    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    await writeRegistry(join(logDir, "subjects.json"), {
      "auth-migration": { display: "Auth Migration", type: "project" },
    });

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () =>
        [
          '{"type":"fact","content":"Auth migration moved under platform systems","subject":"auth-migration","subjectType":"system"}',
          '{"type":"fact","content":"Pairing with Alice on rollout","subject":"alice-chen","subjectType":"person"}',
          '{"type":"fact","content":"Ops audit is queued","subject":"ops-audit","subjectType":"invalid"}',
        ].join("\n"),
    });

    await handlers.session_end?.(
      { sessionId: "session-types", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-types" },
    );

    const registry = await readRegistry(join(logDir, "subjects.json"));
    expect(registry["auth-migration"]?.type).toBe("system");
    expect(registry["alice-chen"]?.type).toBe("person");
    expect(registry["ops-audit"]?.type).toBe("topic");
  });

  test("accepts transcript-cited event ids without generating linkage fields", async () => {
    await seedLogEntry(logDir, {
      id: "opentask0001",
      timestamp: "2026-02-11T00:00:00.000Z",
      type: "task",
      content: "Backfill failed jobs",
      status: "open",
      subject: "auth-migration",
      session: "seed-1",
    });

    await seedMainSession(openclawHome, "agent-1", "session-cited-id");
    const transcriptPath = join(openclawHome, "agents", "agent-1", "sessions", "session-cited-id.jsonl");
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-cited-id","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"user","content":"According to [opentask0001], backfill failed jobs is done now."}}',
        '{"type":"message","timestamp":"2026-02-20T00:02:00.000Z","message":{"role":"assistant","content":"I will mark it complete."}}',
      ].join("\n"),
      "utf8",
    );

    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);
    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () =>
        '{"type":"task","content":"Backfill failed jobs","status":"done","subject":"auth-migration"}',
    });

    await handlers.session_end?.(
      { sessionId: "session-cited-id", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-cited-id" },
    );

    const entries = await readLog(join(logDir, "log.jsonl"));
    const doneTask = entries.find((entry) => entry.type === "task" && entry.session === "session-cited-id");
    expect(doneTask?.type).toBe("task");
    if (doneTask?.type === "task") {
      expect(doneTask.status).toBe("done");
    }
  });

  test("citation usage is recorded against cited event id", async () => {
    await seedLogEntry(logDir, {
      id: "old000000001",
      timestamp: "2026-02-11T00:00:00.000Z",
      type: "decision",
      content: "Old decision",
      subject: "auth-migration",
      session: "seed-1",
    });

    await seedMainSession(openclawHome, "agent-1", "session-cite-usage");
    const transcriptPath = join(openclawHome, "agents", "agent-1", "sessions", "session-cite-usage.jsonl");
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-cite-usage","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"user","content":"Based on [old000000001], proceed with rollout."}}',
        '{"type":"message","timestamp":"2026-02-20T00:02:00.000Z","message":{"role":"assistant","content":"Proceeding."}}',
      ].join("\n"),
      "utf8",
    );

    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);
    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () =>
        '{"type":"fact","content":"Rollout proceeding","subject":"auth-migration"}',
    });

    await handlers.session_end?.(
      { sessionId: "session-cite-usage", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-cite-usage" },
    );

    const state = await readState(join(logDir, "state.json"));
    expect(state.eventUsage["old000000001"]?.citationCount).toBe(1);
  });

  test("appends updated entries without replacement linking", async () => {
    await seedLogEntry(logDir, {
      id: "dec000000001",
      timestamp: "2026-02-11T00:00:00.000Z",
      type: "decision",
      content: "Queue retries for webhook failures",
      detail: "Initial approach before rollout findings",
      subject: "auth-migration",
      session: "seed-1",
    });

    await seedMainSession(openclawHome, "agent-1", "session-search-link");
    const transcriptPath = join(openclawHome, "agents", "agent-1", "sessions", "session-search-link.jsonl");
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-search-link","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"user","content":"Update auth-migration decision: queue retries should use exponential backoff and a dead-letter queue."}}',
        '{"type":"message","timestamp":"2026-02-20T00:02:00.000Z","message":{"role":"assistant","content":"Acknowledged."}}',
      ].join("\n"),
      "utf8",
    );

    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);
    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () =>
        '{"type":"decision","content":"Queue retries for webhook failures","detail":"Now using exponential backoff and dead-letter queue","subject":"auth-migration"}',
    });

    await handlers.session_end?.(
      { sessionId: "session-search-link", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-search-link" },
    );

    const entries = await readLog(join(logDir, "log.jsonl"));
    const decision = entries.find((entry) => entry.type === "decision" && entry.session === "session-search-link");
    expect(decision?.type).toBe("decision");
  });

  test("before_reset skips scoped session types", async () => {
    let llmCalls = 0;
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        return '{"type":"fact","content":"should not run"}';
      },
    });

    await handlers.before_reset?.(
      {
        messages: [
          {
            role: "user",
            content: "hello",
          },
        ],
      },
      { sessionId: "session-2", sessionKey: "cron:daily" },
    );

    const state = await readState(join(logDir, "state.json"));
    expect(llmCalls).toBe(0);
    expect(state.extractedSessions["session-2"]).toBeUndefined();
  });

  test("before_reset falls back to sessionFile transcript when messages are missing", async () => {
    const workspaceDir = join(tempDir, "workspace-reset-fallback");
    await mkdir(workspaceDir, { recursive: true });

    const transcriptPath = join(openclawHome, "agents", "agent-1", "sessions", "session-reset.jsonl");
    await mkdir(join(openclawHome, "agents", "agent-1", "sessions"), { recursive: true });
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-reset","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"user","content":"remember this fallback"}}',
        '{"type":"message","timestamp":"2026-02-20T00:02:00.000Z","message":{"role":"assistant","content":"saved"}}',
      ].join("\n"),
      "utf8",
    );

    let llmCalls = 0;
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        return '{"type":"fact","content":"Loaded from sessionFile fallback","subject":"auth-migration"}';
      },
    });

    await handlers.before_reset?.(
      {
        sessionFile: transcriptPath,
      },
      { agentId: "agent-1", sessionId: "session-reset", sessionKey: "agent:main", workspaceDir },
    );

    const entries = await readLog(join(logDir, "log.jsonl"));
    expect(llmCalls).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toContain("sessionFile fallback");
  });

  test("after_compaction is registered, uses sessionFile, and writes handoff state", async () => {
    const workspaceDir = join(tempDir, "workspace-after-compaction");
    const memoryPath = join(workspaceDir, "MEMORY.md");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(memoryPath, "## Memory\n", "utf8");

    const transcriptPath = join(tempDir, "compaction-session.jsonl");
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-compaction-1","timestamp":"2026-02-22T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-22T00:01:00.000Z","message":{"role":"user","content":"Please remember this handoff."}}',
        '{"type":"message","timestamp":"2026-02-22T00:02:00.000Z","message":{"role":"assistant","content":"Captured."}}',
      ].join("\n"),
      "utf8",
    );

    let llmCalls = 0;
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        return '{"type":"handoff","content":"Compaction handoff saved","detail":"Use sessionFile transcript","subject":"auth-migration"}';
      },
    });

    expect(handlers.after_compaction).toBeDefined();

    await handlers.after_compaction?.(
      {
        messageCount: 3,
        compactedCount: 2,
        sessionFile: transcriptPath,
      },
      {
        agentId: "missing-agent",
        sessionId: "session-compaction-1",
        sessionKey: "agent:main",
        workspaceDir,
      },
    );

    const entries = await readLog(join(logDir, "log.jsonl"));
    const state = await readState(join(logDir, "state.json"));
    const memory = await readFile(memoryPath, "utf8");

    expect(llmCalls).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("handoff");
    expect(entries[0]?.session).toBe("session-compaction-1");
    expect(state.extractedSessions["session-compaction-1"]?.entries).toBe(1);
    expect(state.compactionSessions["session-compaction-1"]?.status).toBe("extracted");
    expect(state.compactionSessions["session-compaction-1"]?.entries).toBe(1);
    expect(memory).toContain("## Previous Session Handoff (agent:main)");
    expect(memory).toContain("Compaction handoff saved");
    expect(memory).toContain("### Details");
  });

  test("after_compaction is idempotent for repeated compactions on one session", async () => {
    const sessionsDir = join(openclawHome, "agents", "agent-1", "sessions");
    const transcriptPath = join(sessionsDir, "session-compaction-2.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-compaction-2","timestamp":"2026-02-22T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-22T00:01:00.000Z","message":{"role":"user","content":"Capture this once."}}',
        '{"type":"message","timestamp":"2026-02-22T00:02:00.000Z","message":{"role":"assistant","content":"Done."}}',
      ].join("\n"),
      "utf8",
    );

    let llmCalls = 0;
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        return '{"type":"fact","content":"Compaction extraction ran","subject":"auth-migration"}';
      },
    });

    const event = {
      messageCount: 2,
      compactedCount: 4,
      sessionFile: transcriptPath,
    };
    const ctx = {
      agentId: "agent-1",
      sessionId: "session-compaction-2",
      sessionKey: "agent:agent-1:main",
    };

    await handlers.after_compaction?.(event, ctx);
    await handlers.after_compaction?.(event, ctx);

    const entries = await readLog(join(logDir, "log.jsonl"));
    const state = await readState(join(logDir, "state.json"));

    expect(llmCalls).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.session).toBe("session-compaction-2");
    expect(state.extractedSessions["session-compaction-2"]?.entries).toBe(1);
  });

  test("after_compaction extracts only transcript delta after last extracted timestamp", async () => {
    const sessionsDir = join(openclawHome, "agents", "agent-1", "sessions");
    const transcriptPath = join(sessionsDir, "session-compaction-delta.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-compaction-delta","timestamp":"2026-02-22T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-22T00:01:00.000Z","message":{"role":"user","content":"Capture first update."}}',
        '{"type":"message","timestamp":"2026-02-22T00:02:00.000Z","message":{"role":"assistant","content":"Captured first."}}',
      ].join("\n"),
      "utf8",
    );

    let llmCalls = 0;
    const transcripts: string[] = [];
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async (opts) => {
        llmCalls += 1;
        transcripts.push(opts.transcript);
        return llmCalls === 1
          ? '{"type":"fact","content":"First compaction extraction","subject":"auth-migration"}'
          : '{"type":"fact","content":"Second compaction extraction","subject":"auth-migration"}';
      },
    });

    const event = {
      messageCount: 2,
      compactedCount: 4,
      sessionFile: transcriptPath,
    };
    const ctx = {
      agentId: "agent-1",
      sessionId: "session-compaction-delta",
      sessionKey: "agent:agent-1:main",
    };

    await handlers.after_compaction?.(event, ctx);

    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-compaction-delta","timestamp":"2026-02-22T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-22T00:01:00.000Z","message":{"role":"user","content":"Capture first update."}}',
        '{"type":"message","timestamp":"2026-02-22T00:02:00.000Z","message":{"role":"assistant","content":"Captured first."}}',
        '{"type":"message","timestamp":"2026-02-22T00:03:00.000Z","message":{"role":"user","content":"Capture second update."}}',
        '{"type":"message","timestamp":"2026-02-22T00:04:00.000Z","message":{"role":"assistant","content":"Captured second."}}',
      ].join("\n"),
      "utf8",
    );
    await handlers.after_compaction?.(event, ctx);

    const entries = await readLog(join(logDir, "log.jsonl"));
    const state = await readState(join(logDir, "state.json"));

    expect(llmCalls).toBe(2);
    expect(entries).toHaveLength(2);
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0]).toContain("Capture first update.");
    expect(transcripts[1]).toContain("Capture second update.");
    expect(transcripts[1]).not.toContain("Capture first update.");
    expect(state.extractedSessions["session-compaction-delta"]?.lastMessageAt).toBe("2026-02-22T00:04:00.000Z");
  });


  test("after_compaction resolves session fallback when context is empty", async () => {
    const sessionsDir = join(openclawHome, "agents", "main", "sessions");
    const transcriptPath = join(sessionsDir, "session-compaction-fallback.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-compaction-fallback","timestamp":"2026-02-22T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-22T00:01:00.000Z","message":{"role":"user","content":"Fallback extraction should run."}}',
        '{"type":"message","timestamp":"2026-02-22T00:02:00.000Z","message":{"role":"assistant","content":"Done."}}',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "session-compaction-fallback",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    let llmCalls = 0;
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        return '{"type":"fact","content":"Fallback compaction extraction ran","subject":"auth-migration"}';
      },
    });

    await handlers.after_compaction?.(
      {
        messageCount: 1,
        compactedCount: 1,
      },
      {},
    );

    const entries = await readLog(join(logDir, "log.jsonl"));
    const state = await readState(join(logDir, "state.json"));

    expect(llmCalls).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.session).toBe("session-compaction-fallback");
    expect(state.extractedSessions["session-compaction-fallback"]?.entries).toBe(1);
    expect(state.compactionSessions["session-compaction-fallback"]?.status).toBe("extracted");
    expect(state.compactionSessions["session-compaction-fallback"]?.sessionFile).toBe(transcriptPath);
  });

  test("after_compaction skips scoped session types", async () => {
    const transcriptPath = join(tempDir, "compaction-skipped-session.jsonl");
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-compaction-skip","timestamp":"2026-02-22T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-22T00:01:00.000Z","message":{"role":"user","content":"Skip this extraction."}}',
        '{"type":"message","timestamp":"2026-02-22T00:02:00.000Z","message":{"role":"assistant","content":"Skipped."}}',
      ].join("\n"),
      "utf8",
    );

    let llmCalls = 0;
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        return '{"type":"fact","content":"should not run"}';
      },
    });

    await handlers.after_compaction?.(
      {
        messageCount: 1,
        compactedCount: 2,
        sessionFile: transcriptPath,
      },
      {
        agentId: "agent-1",
        sessionId: "session-compaction-skip",
        sessionKey: "cron:daily",
      },
    );

    const state = await readState(join(logDir, "state.json"));

    expect(llmCalls).toBe(0);
    expect(state.extractedSessions["session-compaction-skip"]).toBeUndefined();
    expect(state.compactionSessions["session-compaction-skip"]?.status).toBe("skipped");
    expect(state.compactionSessions["session-compaction-skip"]?.reason).toContain("session type excluded");
  });

  test("failed extraction is marked once and not retried after limit", async () => {
    let llmCalls = 0;
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        throw new Error("LLM timeout");
      },
    });

    const resetEvent = {
      messages: [
        {
          role: "user",
          content: "Need memory extraction",
        },
      ],
    };

    // First attempt: fails, retries=1, shouldRetry=true
    await handlers.before_reset?.(resetEvent, { sessionId: "session-fail", sessionKey: "agent:main" });
    // Second attempt: retries (shouldRetry still true), fails again, retries=2, shouldRetry=false
    await handlers.before_reset?.(resetEvent, { sessionId: "session-fail", sessionKey: "agent:main" });
    // Third attempt: permanently failed, skipped
    await handlers.before_reset?.(resetEvent, { sessionId: "session-fail", sessionKey: "agent:main" });

    const state = await readState(join(logDir, "state.json"));

    expect(llmCalls).toBe(2);
    expect(state.failedSessions["session-fail"]?.retries).toBe(2);
    expect(state.extractedSessions["session-fail"]).toBeUndefined();
  });

  test("non-empty invalid extraction output is treated as failure", async () => {
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => ({
        output: "not-json\nalso-not-json",
        workerSessionId: "worker-invalid-session-id",
        workerSessionKey: "agent:main:cron:job-7:run:worker-invalid-session-id",
      }),
    });

    await handlers.before_reset?.(
      {
        messages: [
          { role: "user", content: "store this please" },
          { role: "assistant", content: "ok" },
        ],
      },
      { sessionId: "session-invalid-output", sessionKey: "agent:main" },
    );

    const state = await readState(join(logDir, "state.json"));
    expect(state.extractedSessions["session-invalid-output"]).toBeUndefined();
    expect(state.failedSessions["session-invalid-output"]?.retries).toBe(1);
    expect(state.failedSessions["session-invalid-output"]?.sourceSessionKey).toBe("agent:main");
    expect(state.failedSessions["session-invalid-output"]?.workerSessionId).toBe("worker-invalid-session-id");
    expect(state.failedSessions["session-invalid-output"]?.workerSessionKey).toBe(
      "agent:main:cron:job-7:run:worker-invalid-session-id",
    );
  });

  test("passes transcript-relevant existing entries and open items to extraction model", async () => {
    await seedLogEntry(logDir, {
      id: "factold0001a",
      timestamp: "2026-02-10T00:00:00.000Z",
      type: "fact",
      content: "Retries are sync",
      subject: "auth-migration",
      session: "seed-1",
    });
    await seedLogEntry(logDir, {
      id: "opentask0001",
      timestamp: "2026-02-11T00:00:00.000Z",
      type: "task",
      content: "Backfill failed jobs",
      status: "open",
      subject: "other-project",
      session: "seed-2",
    });
    await seedLogEntry(logDir, {
      id: "openques0001",
      timestamp: "2026-02-12T00:00:00.000Z",
      type: "question",
      content: "Do we need load tests?",
      subject: "other-project",
      session: "seed-3",
    });
    await seedLogEntry(logDir, {
      id: "oldfact0001b",
      timestamp: "2026-02-01T00:00:00.000Z",
      type: "fact",
      content: "Unrelated archived note",
      subject: "infra",
      session: "seed-4",
    });
    await writeRegistry(join(logDir, "subjects.json"), {
      "auth-migration": { display: "Auth Migration", type: "project" },
      "other-project": { display: "Other Project", type: "project" },
      infra: { display: "Infra", type: "system" },
    });

    await seedMainSession(openclawHome, "agent-1", "session-context");
    const transcriptPath = join(openclawHome, "agents", "agent-1", "sessions", "session-context.jsonl");
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-context","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"user","content":"auth-migration update: backfill failed jobs is done"}}',
        '{"type":"message","timestamp":"2026-02-20T00:02:00.000Z","message":{"role":"assistant","content":"great, closing it"}}',
      ].join("\n"),
      "utf8",
    );

    let existingIds: string[] = [];
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async (opts) => {
        existingIds = (opts.existingEntries ?? []).map((entry) => entry.id);
        return '{"type":"task","content":"Backfill failed jobs","status":"done","subject":"other-project"}';
      },
    });

    await handlers.session_end?.(
      { sessionId: "session-context", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-context" },
    );

    expect(existingIds).toContain("factold0001a");
    expect(existingIds).toContain("opentask0001");
    expect(existingIds).toContain("openques0001");
    expect(existingIds).not.toContain("oldfact0001b");

    const entries = await readLog(join(logDir, "log.jsonl"));
    const completed = entries.find((entry) => entry.session === "session-context" && entry.type === "task");
    expect(completed?.type).toBe("task");
    if (completed?.type === "task") {
      expect(completed.status).toBe("done");
    }
  });

  test("does not append duplicate fact when extraction model returns no changes", async () => {
    await seedLogEntry(logDir, {
      id: "factdup00001",
      timestamp: "2026-02-15T00:00:00.000Z",
      type: "fact",
      content: "Queue retries enabled",
      subject: "auth-migration",
      session: "seed-1",
    });
    await writeRegistry(join(logDir, "subjects.json"), {
      "auth-migration": { display: "Auth Migration", type: "project" },
    });

    await seedMainSession(openclawHome, "agent-1", "session-dup");
    const transcriptPath = join(openclawHome, "agents", "agent-1", "sessions", "session-dup.jsonl");
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-dup","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"user","content":"auth-migration still has queue retries enabled"}}',
        '{"type":"message","timestamp":"2026-02-20T00:02:00.000Z","message":{"role":"assistant","content":"ack"}}',
      ].join("\n"),
      "utf8",
    );

    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);
    let existingIds: string[] = [];

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async (opts) => {
        existingIds = (opts.existingEntries ?? []).map((entry) => entry.id);
        return "";
      },
    });

    await handlers.session_end?.(
      { sessionId: "session-dup", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-dup" },
    );

    const entries = await readLog(join(logDir, "log.jsonl"));
    expect(existingIds).toContain("factdup00001");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("factdup00001");
  });

  test("session_end skips transcripts without user messages", async () => {
    const transcriptPath = join(openclawHome, "agents", "agent-1", "sessions", "session-no-user.jsonl");
    await mkdir(join(openclawHome, "agents", "agent-1", "sessions"), { recursive: true });
    await writeFile(
      transcriptPath,
      [
        '{"type":"session","id":"session-no-user","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"assistant","content":"internal note"}}',
      ].join("\n"),
      "utf8",
    );

    let llmCalls = 0;
    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);
    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        return '{"type":"fact","content":"should not happen"}';
      },
    });

    await handlers.session_end?.(
      { sessionId: "session-no-user", messageCount: 2 },
      { agentId: "agent-1", sessionId: "session-no-user" },
    );

    const state = await readState(join(logDir, "state.json"));
    expect(llmCalls).toBe(0);
    expect(state.extractedSessions["session-no-user"]).toBeUndefined();
  });

  test("writes handoff to MEMORY.md markers and overwrites previous handoff", async () => {
    const workspaceDir = join(tempDir, "workspace");
    const memoryPath = join(workspaceDir, "MEMORY.md");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      memoryPath,
      [
        "## Goals",
        "- Ship V3",
        "",
        BRIEFING_BEGIN_MARKER,
        "## Active",
        "- auth-migration — old briefing",
        BRIEFING_END_MARKER,
        "",
        LAST_HANDOFF_BEGIN_MARKER,
        "Session: old-session (2026-02-01T00:00:00.000Z)",
        "Old handoff text",
        LAST_HANDOFF_END_MARKER,
        "",
        "## Notes",
        "Keep this note.",
      ].join("\n"),
      "utf8",
    );

    await seedMainSession(openclawHome, "agent-1", "session-h1");
    await seedMainSession(openclawHome, "agent-1", "session-h2");
    const sessionsDir = join(openclawHome, "agents", "agent-1", "sessions");
    await writeFile(
      join(sessionsDir, "session-h1.jsonl"),
      [
        '{"type":"session","id":"session-h1","timestamp":"2026-02-20T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-20T00:01:00.000Z","message":{"role":"user","content":"handoff one"}}',
        '{"type":"message","timestamp":"2026-02-20T00:02:00.000Z","message":{"role":"assistant","content":"noted"}}',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(sessionsDir, "session-h2.jsonl"),
      [
        '{"type":"session","id":"session-h2","timestamp":"2026-02-21T00:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-02-21T00:01:00.000Z","message":{"role":"user","content":"handoff two"}}',
        '{"type":"message","timestamp":"2026-02-21T00:02:00.000Z","message":{"role":"assistant","content":"noted"}}',
      ].join("\n"),
      "utf8",
    );

    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);
    let llmCalls = 0;

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () => {
        llmCalls += 1;
        if (llmCalls === 1) {
          return '{"type":"handoff","content":"Auth migration in progress","detail":"Backfill remains","subject":"auth-migration"}';
        }
        return '{"type":"handoff","content":"Auth migration complete","detail":"Backfill done","subject":"auth-migration"}';
      },
    });

    await handlers.session_end?.(
      { sessionId: "session-h1", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-h1", workspaceDir },
    );

    const firstMemory = await readFile(memoryPath, "utf8");
    expect(firstMemory).toContain("## Previous Session Handoff (agent:agent-1:main:session-h1)");
    expect(firstMemory).toContain("Auth migration in progress");
    expect(firstMemory).toContain("### Details");
    expect(firstMemory).toContain("Backfill remains");
    expect(firstMemory).not.toContain("Old handoff text");

    await handlers.session_end?.(
      { sessionId: "session-h2", messageCount: 5 },
      { agentId: "agent-1", sessionId: "session-h2", workspaceDir },
    );

    const secondMemory = await readFile(memoryPath, "utf8");
    expect(secondMemory).toContain("## Previous Session Handoff (agent:agent-1:main:session-h2)");
    expect(secondMemory).toContain("Auth migration complete");
    expect(secondMemory).toContain("### Details");
    expect(secondMemory).toContain("Backfill done");
    expect(secondMemory).not.toContain("agent:agent-1:main:session-h1");
    expect(secondMemory).toContain("## Goals");
    expect(secondMemory).toContain("## Notes");
    expect(secondMemory).toContain(BRIEFING_BEGIN_MARKER);
    expect(secondMemory).toContain(BRIEFING_END_MARKER);
  });

  test("creates handoff markers in MEMORY.md when missing", async () => {
    const workspaceDir = join(tempDir, "workspace-no-markers");
    const memoryPath = join(workspaceDir, "MEMORY.md");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(memoryPath, "## Goals\n- Keep velocity\n", "utf8");

    const handlers: HookHandlers = {};
    const api = createMockApi({}, handlers);

    registerExtractionHooks(api, createPluginConfig(logDir), {
      extractFromTranscript: async () =>
        '{"type":"handoff","content":"Queue retries stable","detail":"Monitoring next 24h","subject":"auth-migration"}',
    });

    await handlers.before_reset?.(
      {
        messages: [
          { role: "user", content: "Summarize handoff" },
          { role: "assistant", content: "Done" },
        ],
      },
      { sessionId: "session-reset-handoff", sessionKey: "agent:main", workspaceDir },
    );

    const memoryContent = await readFile(memoryPath, "utf8");
    expect(memoryContent).toContain(LAST_HANDOFF_BEGIN_MARKER);
    expect(memoryContent).toContain(LAST_HANDOFF_END_MARKER);
    expect(memoryContent).toContain("## Previous Session Handoff (agent:main)");
    expect(memoryContent).toContain("Queue retries stable");
    expect(memoryContent).toContain("### Details");
    expect(memoryContent).toContain("Monitoring next 24h");
    expect(memoryContent).toContain("## Goals");
  });
});
