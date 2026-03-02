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

  test("maps date-only timestamp to nearest transcript message time for the same day", async () => {
    const conversation = makeConversation("2024-01-02T12:34:56.000Z");
    conversation.messages = [
      {
        id: "m1",
        role: "user",
        content: "Imported context starts",
        createdAt: "2024-01-05T15:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "Imported context continues",
        createdAt: "2024-01-05T15:05:00.000Z",
      },
    ];

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
          '{"type":"fact","content":"Known by day only","subject":"history","timestamp":"2024-01-05"}',
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.timestamp).toBe("2024-01-05T15:00:00.000Z");
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

  test("defaults to topic subject type when subjectType is omitted", async () => {
    await extractImportedConversation(
      {
        conversation: makeConversation("2024-01-02T12:34:56.000Z"),
        sessionId: "reclaw:chatgpt:conv-1",
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async () =>
          '{"type":"fact","content":"Max uses Termius on his phone","subject":"max-petretta"}',
      },
    );

    const registry = await readRegistry(subjectsPath);
    expect(registry["max-petretta"]?.type).toBe("topic");
  });

  test("ignores transcript-cited event ids for linkage fields", async () => {
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
    expect(entries[0]?.entry.id).toHaveLength(12);
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

  test("passes conversation metadata (including source path) to extraction prompt", async () => {
    const conversation = makeConversation("2024-01-02T12:34:56.000Z");
    conversation.platform = "openclaw";
    conversation.title = "OpenClaw memory: 2026-02-12.md";
    conversation.sourcePath = "2026-02-12.md";

    let capturedUserPrompt = "";
    await extractImportedConversation(
      {
        conversation,
        sessionId: "reclaw:openclaw:conv-1",
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async (params) => {
          capturedUserPrompt = params.userPrompt;
          return '{"type":"fact","content":"Imported with metadata","subject":"imports"}';
        },
      },
    );

    expect(capturedUserPrompt).toContain("## Conversation Metadata");
    expect(capturedUserPrompt).toContain("platform: openclaw");
    expect(capturedUserPrompt).toContain("title: OpenClaw memory: 2026-02-12.md");
    expect(capturedUserPrompt).toContain("sourcePath: 2026-02-12.md");
    expect(capturedUserPrompt).toContain("updatedAt: 2024-01-02T12:34:56.000Z");
    expect(capturedUserPrompt).toContain("[2024-01-01T00:00:10.000Z] user: hello");
    expect(capturedUserPrompt).toContain("[2024-01-01T00:00:20.000Z] assistant: world");
  });

  test("historical import system prompt includes strict durability filter guidance", async () => {
    let capturedSystemPrompt = "";
    await extractImportedConversation(
      {
        conversation: makeConversation("2024-01-02T12:34:56.000Z"),
        sessionId: "reclaw:chatgpt:conv-1",
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async (params) => {
          capturedSystemPrompt = params.systemPrompt;
          return "";
        },
      },
    );

    expect(capturedSystemPrompt).toContain("Apply a strict durability filter");
    expect(capturedSystemPrompt).toContain("Skip one-off lookup results");
    expect(capturedSystemPrompt).toContain("menus, store addresses/hours");
  });

  test("drops handoff entries emitted by the extraction model", async () => {
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
          [
            '{"type":"handoff","content":"Import session complete","detail":"Should be ignored"}',
            '{"type":"fact","content":"Durable imported fact","subject":"imports"}',
          ].join("\n"),
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.type).toBe("fact");
    expect(entries[0]?.entry.content).toContain("Durable imported fact");
  });

  test("treats handoff-only output as empty import output", async () => {
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
          '{"type":"handoff","content":"Import handoff only","detail":"No durable events"}',
      },
    );

    expect(entries).toEqual([]);
  });

  test("runs a quality repair pass when severe quality issues are detected", async () => {
    const conversation = makeConversation("2024-01-02T12:34:56.000Z");
    conversation.messages = Array.from({ length: 12 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `We need to fix plugin import pipeline behavior and update API handling for job ${index}.`,
      createdAt: `2024-01-02T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));

    let calls = 0;
    const entries = await extractImportedConversation(
      {
        conversation,
        sessionId: "reclaw:chatgpt:conv-1",
        subjectsPath,
        logPath,
        model: "anthropic/claude-haiku-4-5",
      },
      {
        callModel: async () => {
          calls += 1;
          if (calls === 1) {
            return [
              '{"type":"fact","content":"Maybe Max should change the import flow","subject":"max-petretta","subjectType":"person"}',
              '{"type":"fact","content":"Possibly Max should update the plugin","subject":"max-petretta","subjectType":"person"}',
              '{"type":"fact","content":"Likely Max needs to patch the API","subject":"max-petretta","subjectType":"person"}',
              '{"type":"fact","content":"Perhaps Max should track import jobs better","subject":"max-petretta","subjectType":"person"}',
            ].join("\n");
          }

          return [
            '{"type":"decision","content":"Import processing should track worker job state per batch","subject":"import-pipeline","detail":"Improves visibility and retry behavior"}',
            '{"type":"task","content":"Add API error telemetry for import extraction failures","status":"open","subject":"import-observability"}',
            '{"type":"fact","content":"The plugin import path requires durable progress reporting","subject":"plugin-import"}',
          ].join("\n");
        },
      },
    );

    expect(calls).toBe(2);
    expect(entries).toHaveLength(3);
    expect(entries.some((entry) => entry.entry.subject === "plugin-import")).toBe(true);
  });
});
