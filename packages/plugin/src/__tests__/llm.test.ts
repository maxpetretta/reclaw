import { describe, expect, test } from "bun:test";
import { __llmTestExports } from "../lib/llm";
import type { LogEntry } from "../log/schema";

describe("llm extraction prompt", () => {
  test("buildExtractionUserPrompt includes existing entries with IDs", () => {
    const existingEntries: LogEntry[] = [
      {
        id: "factold0001a",
        timestamp: "2026-02-20T00:00:00.000Z",
        type: "fact",
        content: "Queue retries enabled",
        subject: "auth-migration",
        detail: "from outage review",
        session: "session-1",
      },
      {
        id: "opentask0001",
        timestamp: "2026-02-20T00:00:00.000Z",
        type: "task",
        content: "Backfill failed jobs",
        status: "open",
        subject: "auth-migration",
        session: "session-1",
      },
    ];

    const userPrompt = __llmTestExports.buildExtractionUserPrompt({
      transcript: "user: auth-migration update",
      subjects: {
        "auth-migration": { display: "Auth Migration", type: "project" },
      },
      existingEntries,
    });

    expect(userPrompt).toContain("## Existing Entries");
    expect(userPrompt).toContain("[id=factold0001a] fact | subject=auth-migration | Queue retries enabled");
    expect(userPrompt).toContain("[id=opentask0001] task | subject=auth-migration | Backfill failed jobs");
  });

  test("formats empty existing entries as n/a", () => {
    const userPrompt = __llmTestExports.buildExtractionUserPrompt({
      transcript: "user: no history",
      subjects: {},
      existingEntries: [],
    });

    expect(userPrompt).toContain("## Existing Entries");
    expect(userPrompt).toContain("- n/a");
  });
});
