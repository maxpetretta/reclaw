import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLog, finalizeEntry } from "../log/schema";
import { runReclawImport } from "../import/run";
import type { ImportedConversation, ImportedMessage } from "../import/types";
import { readState, writeState } from "../state";
import { readRegistry } from "../subjects/registry";

function makeMessages(count: number): ImportedMessage[] {
  const messages: ImportedMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push({
      id: `m-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index + 1}`,
      createdAt: new Date(Date.UTC(2024, 0, 1, 0, index, 0)).toISOString(),
    });
  }
  return messages;
}

function makeConversation(
  conversationId: string,
  updatedAt: string,
  messageCount: number,
  platform: ImportedConversation["platform"] = "chatgpt",
): ImportedConversation {
  return {
    platform,
    conversationId,
    title: `Title ${conversationId}`,
    createdAt: new Date(Date.parse(updatedAt) - 60_000).toISOString(),
    updatedAt,
    messages: makeMessages(messageCount),
  };
}

const silentLogger = {
  info() {},
  warn() {},
};

describe("import run", () => {
  let tempDir = "";
  let logDir = "";
  let logPath = "";
  let subjectsPath = "";
  let statePath = "";
  let openClawHome = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zettelclaw-import-run-"));
    logDir = join(tempDir, "zettelclaw");
    logPath = join(logDir, "log.jsonl");
    subjectsPath = join(logDir, "subjects.json");
    statePath = join(logDir, "state.json");
    openClawHome = join(tempDir, "openclaw");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("filters by date/min-messages and dedups via imported state", async () => {
    await writeState(statePath, {
      extractedSessions: {},
      failedSessions: {},
      importedConversations: {
        "chatgpt:already": {
          at: "2024-01-05T00:00:00.000Z",
          updatedAt: "2024-01-05T00:00:00.000Z",
          sessionId: "reclaw:chatgpt:already",
          entries: 2,
          title: "Already imported",
        },
      },
    });

    const conversations = [
      makeConversation("old", "2023-12-31T00:00:00.000Z", 6),
      makeConversation("short", "2024-01-02T00:00:00.000Z", 2),
      makeConversation("already", "2024-01-03T00:00:00.000Z", 6),
      makeConversation("keep", "2024-01-04T00:00:00.000Z", 6),
    ];

    const summary = await runReclawImport(
      {
        platform: "chatgpt",
        filePath: join(tempDir, "unused.json"),
        logPath,
        subjectsPath,
        statePath,
        after: "2024-01-01T00:00:00.000Z",
        minMessages: 4,
        model: "anthropic/claude-haiku-4-5",
        openClawHome,
      },
      {
        readImportFile: async () => ({}),
        parseConversations: () => conversations,
        extractConversation: async ({ conversation, sessionId }) => [
          finalizeEntry(
            {
              type: "fact",
              content: `Imported ${conversation.conversationId}`,
            },
            {
              sessionId,
              timestamp: conversation.updatedAt,
            },
          ),
        ],
      },
      silentLogger,
    );

    expect(summary.parsed).toBe(4);
    expect(summary.selected).toBe(1);
    expect(summary.skippedByDate).toBe(1);
    expect(summary.skippedByMinMessages).toBe(1);
    expect(summary.skippedAlreadyImported).toBe(1);
    expect(summary.imported).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.entriesWritten).toBe(1);

    const entries = await readLog(logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.session).toBe("reclaw:chatgpt:keep");
    expect(entries[0]?.timestamp).toBe("2024-01-04T00:00:00.000Z");

    const state = await readState(statePath);
    expect(state.importedConversations["chatgpt:already"]).toBeDefined();
    expect(state.importedConversations["chatgpt:keep"]?.sessionId).toBe("reclaw:chatgpt:keep");
  });

  test("dry-run does not call extraction or write artifacts", async () => {
    let extractionCalls = 0;

    const summary = await runReclawImport(
      {
        platform: "chatgpt",
        filePath: join(tempDir, "unused.json"),
        logPath,
        subjectsPath,
        statePath,
        dryRun: true,
        model: "anthropic/claude-haiku-4-5",
        openClawHome,
      },
      {
        readImportFile: async () => ({}),
        parseConversations: () => [makeConversation("dry-run", "2024-01-05T00:00:00.000Z", 6)],
        extractConversation: async () => {
          extractionCalls += 1;
          return [];
        },
      },
      silentLogger,
    );

    expect(summary.dryRun).toBe(true);
    expect(summary.selected).toBe(1);
    expect(summary.imported).toBe(0);
    expect(summary.entriesWritten).toBe(0);
    expect(extractionCalls).toBe(0);
    expect(await Bun.file(logPath).exists()).toBe(false);

    const state = await readState(statePath);
    expect(state.importedConversations["chatgpt:dry-run"]).toBeUndefined();
  });

  test("--force bypasses importedConversations dedupe", async () => {
    const updatedAt = "2024-01-07T00:00:00.000Z";
    const conversation = makeConversation("force-me", updatedAt, 6);

    await writeState(statePath, {
      extractedSessions: {},
      failedSessions: {},
      importedConversations: {
        "chatgpt:force-me": {
          at: "2024-01-07T01:00:00.000Z",
          updatedAt,
          sessionId: "reclaw:chatgpt:force-me",
          entries: 1,
        },
      },
    });

    const summary = await runReclawImport(
      {
        platform: "chatgpt",
        filePath: join(tempDir, "unused.json"),
        logPath,
        subjectsPath,
        statePath,
        model: "anthropic/claude-haiku-4-5",
        force: true,
        openClawHome,
      },
      {
        readImportFile: async () => ({}),
        parseConversations: () => [conversation],
        extractConversation: async ({ sessionId }) => [
          finalizeEntry(
            {
              type: "fact",
              content: "Forced import",
            },
            {
              sessionId,
              timestamp: updatedAt,
            },
          ),
        ],
      },
      silentLogger,
    );

    expect(summary.selected).toBe(1);
    expect(summary.imported).toBe(1);
    expect(summary.skippedAlreadyImported).toBe(0);
  });

  test("import run normalizes entry metadata for historical invariants", async () => {
    const conversation = makeConversation("normalize", "2024-01-08T00:00:00.000Z", 6);

    const summary = await runReclawImport(
      {
        platform: "chatgpt",
        filePath: join(tempDir, "unused.json"),
        logPath,
        subjectsPath,
        statePath,
        model: "anthropic/claude-haiku-4-5",
        openClawHome,
      },
      {
        readImportFile: async () => ({}),
        parseConversations: () => [conversation],
        extractConversation: async () => [
          finalizeEntry(
            {
              type: "fact",
              content: "Metadata gets normalized",
              subject: "  auth-migration  ",
            },
            {
              sessionId: "wrong-session",
              timestamp: "2025-01-01T00:00:00.000Z",
            },
          ),
        ],
      },
      silentLogger,
    );

    expect(summary.imported).toBe(1);
    expect(summary.entriesWritten).toBe(1);

    const entries = await readLog(logPath);
    expect(entries[0]?.session).toBe("reclaw:chatgpt:normalize");
    expect(entries[0]?.timestamp).toBe(conversation.updatedAt);
    expect(entries[0]?.subject).toBe("auth-migration");

    const registry = await readRegistry(subjectsPath);
    expect(registry["auth-migration"]).toBeDefined();
    expect(registry["  auth-migration  "]).toBeUndefined();
  });

  test("writes transcript session JSONL and registers in sessions.json", async () => {
    const conversation = makeConversation("transcript-1", "2024-01-06T00:00:00.000Z", 6);

    const summary = await runReclawImport(
      {
        platform: "chatgpt",
        filePath: join(tempDir, "unused.json"),
        logPath,
        subjectsPath,
        statePath,
        model: "anthropic/claude-haiku-4-5",
        openClawHome,
      },
      {
        readImportFile: async () => ({}),
        parseConversations: () => [conversation],
        extractConversation: async () => [],
      },
      silentLogger,
    );

    expect(summary.imported).toBe(1);
    expect(summary.transcriptsWritten).toBe(1);

    const sessionId = "reclaw:chatgpt:transcript-1";
    const sessionFile = join(openClawHome, "agents", "main", "sessions", `${sessionId}.jsonl`);
    const sessionsPath = join(openClawHome, "agents", "main", "sessions", "sessions.json");
    const sessionKey = `agent:main:${sessionId}`;

    expect(await Bun.file(sessionFile).exists()).toBe(true);
    expect(await Bun.file(sessionsPath).exists()).toBe(true);

    const transcript = await readFile(sessionFile, "utf8");
    expect(transcript).toContain('"type":"session"');
    expect(transcript).toContain('"type":"message"');
    const transcriptLines = transcript
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(transcriptLines[0]?.type).toBe("session");
    expect(transcriptLines[0]?.id).toBe(sessionId);
    expect(transcriptLines[0]?.timestamp).toBe(conversation.createdAt);
    expect(transcriptLines[1]?.id).toBe("reclaw-1");
    expect(transcriptLines[1]?.parentId).toBe(null);
    expect(transcriptLines[2]?.parentId).toBe("reclaw-1");

    const sessionsStore = JSON.parse(await readFile(sessionsPath, "utf8")) as Record<string, unknown>;
    const entry = sessionsStore[sessionKey] as Record<string, unknown>;
    const origin = entry.origin as Record<string, unknown>;

    expect(entry.sessionId).toBe(sessionId);
    expect(entry.archived).toBe(true);
    expect(origin.label).toBe(conversation.title);
  });
});
