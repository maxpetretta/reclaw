import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractImportedConversation } from "../import/extract";
import type { ImportedConversation } from "../import/types";
import { readRegistry } from "../subjects/registry";

function makeConversation(updatedAt: string): ImportedConversation {
  return {
    platform: "chatgpt",
    conversationId: "conv-1",
    title: "Imported conversation",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt,
    messages: [
      {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: "2024-01-01T00:00:10.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "world",
        createdAt: "2024-01-01T00:00:20.000Z",
      },
    ],
  };
}

describe("import extraction", () => {
  let tempDir = "";
  let subjectsPath = "";
  let logPath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zettelclaw-import-extract-"));
    subjectsPath = join(tempDir, "subjects.json");
    logPath = join(tempDir, "log.jsonl");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("defaults extracted timestamps to conversation updatedAt", async () => {
    const updatedAt = "2024-01-02T12:34:56.000Z";
    const sessionId = "reclaw:chatgpt:conv-1";
    const entries = await extractImportedConversation(
      {
        conversation: makeConversation(updatedAt),
        sessionId,
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async () =>
          '{"type":"fact","content":"User prefers short answers","subject":"user-preferences"}',
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.session).toBe(sessionId);
    expect(entries[0]?.entry.timestamp).toBe(updatedAt);

    const registry = await readRegistry(subjectsPath);
    expect(registry["user-preferences"]).toBeDefined();
  });

  test("uses import-provided date-only timestamp at noon", async () => {
    const entries = await extractImportedConversation(
      {
        conversation: makeConversation("2024-01-02T12:34:56.000Z"),
        sessionId: "reclaw:chatgpt:conv-1",
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async () =>
          '{"type":"fact","content":"Known by day only","subject":"history","timestamp":"2024-01-05"}',
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.timestamp).toBe("2024-01-05T12:00:00.000Z");
  });

  test("falls back to unknown subject when model omits subject on non-handoff entries", async () => {
    const entries = await extractImportedConversation(
      {
        conversation: makeConversation("2024-01-02T12:34:56.000Z"),
        sessionId: "reclaw:chatgpt:conv-1",
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async () => '{"type":"fact","content":"General update"}',
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.subject).toBe("unknown");

    const registry = await readRegistry(subjectsPath);
    expect(registry.unknown).toBeDefined();
  });

  test("captures subjectType hint and upserts subject registry type", async () => {
    const entries = await extractImportedConversation(
      {
        conversation: makeConversation("2024-01-02T12:34:56.000Z"),
        sessionId: "reclaw:chatgpt:conv-1",
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async () =>
          '{"type":"fact","content":"Max is the owner","subject":"max","subjectType":"person"}',
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.subjectTypeHint).toBe("person");

    const registry = await readRegistry(subjectsPath);
    expect(registry.max?.type).toBe("person");
  });

  test("resolves replaces from transcript-cited event id", async () => {
    await writeFile(
      logPath,
      `${JSON.stringify({
        id: "abc123def456",
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "fact",
        content: "Original deployment detail",
        subject: "deployments",
        session: "reclaw:chatgpt:old",
      })}\n`,
      "utf8",
    );

    const conversation = makeConversation("2024-01-02T12:34:56.000Z");
    conversation.messages[0] = {
      ...conversation.messages[0],
      content: "According to [abc123def456], we changed rollout criteria",
    };

    const entries = await extractImportedConversation(
      {
        conversation,
        sessionId: "reclaw:chatgpt:conv-1",
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async () =>
          '{"type":"fact","content":"Rollout criteria updated","subject":"deployments"}',
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.replaces).toBe("abc123def456");
  });

  test("retries once when first output is non-empty and invalid", async () => {
    let calls = 0;
    const entries = await extractImportedConversation(
      {
        conversation: makeConversation("2024-01-02T12:34:56.000Z"),
        sessionId: "reclaw:chatgpt:conv-1",
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async () => {
          calls += 1;
          if (calls === 1) {
            return "not-json";
          }

          return '{"type":"fact","content":"Recovered on repair pass","subject":"repair-test"}';
        },
      },
    );

    expect(calls).toBe(2);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.content).toContain("Recovered");
  });

  test("returns an empty list when the model emits no entries", async () => {
    const entries = await extractImportedConversation(
      {
        conversation: makeConversation("2024-01-02T12:34:56.000Z"),
        sessionId: "reclaw:chatgpt:conv-1",
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async () => "\n  \n",
      },
    );

    expect(entries).toEqual([]);
  });

  test("throws when model output is non-empty but contains no valid JSONL entries", async () => {
    await expect(
      extractImportedConversation(
        {
          conversation: makeConversation("2024-01-02T12:34:56.000Z"),
          sessionId: "reclaw:chatgpt:conv-1",
          subjectsPath,
          logPath,
          model: "anthropic/claude-haiku-4-5",
        },
        {
          callModel: async () => "not-json\n{\"type\":\"fact\"}",
        },
      ),
    ).rejects.toThrow("did not contain any valid JSONL entries");
  });
});
