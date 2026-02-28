import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zettelclaw-import-extract-"));
    subjectsPath = join(tempDir, "subjects.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("pins extracted timestamps to conversation updatedAt", async () => {
    const updatedAt = "2024-01-02T12:34:56.000Z";
    const sessionId = "reclaw:chatgpt:conv-1";
    const entries = await extractImportedConversation(
      {
        conversation: makeConversation(updatedAt),
        sessionId,
        subjectsPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async () =>
          '{"type":"fact","content":"User prefers short answers","subject":"user-preferences"}',
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.session).toBe(sessionId);
    expect(entries[0]?.timestamp).toBe(updatedAt);

    const registry = await readRegistry(subjectsPath);
    expect(registry["user-preferences"]).toBeDefined();
  });

  test("returns an empty list when the model emits no entries", async () => {
    const entries = await extractImportedConversation(
      {
        conversation: makeConversation("2024-01-02T12:34:56.000Z"),
        sessionId: "reclaw:chatgpt:conv-1",
        subjectsPath,
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
          model: "anthropic/claude-haiku-4-5",
        },
        {
          callModel: async () => "not-json\n{\"type\":\"fact\"}",
        },
      ),
    ).rejects.toThrow("did not contain any valid JSONL entries");
  });
});
