import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VALID_SUBJECT_TYPES,
  appendEntry,
  generateId,
  injectMeta,
  normalizeSubjectType,
  parseSubjectType,
  readLog,
  validateEntry,
  validateLlmOutput,
  type LogEntry,
} from "../log/schema";

describe("schema", () => {
  let tempDir = "";
  let logPath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zettelclaw-schema-"));
    logPath = join(tempDir, "log.jsonl");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("generateId creates a 12-character id", () => {
    expect(generateId()).toHaveLength(12);
  });

  test("validateEntry accepts a valid task entry", () => {
    const raw: LogEntry = {
      id: "abcdefghijkl",
      timestamp: new Date().toISOString(),
      type: "task",
      content: "Ship plugin",
      subject: "release",
      session: "session-1",
      status: "open",
    };

    const validated = validateEntry(raw);
    expect(validated.ok).toBe(true);
  });

  test("validateLlmOutput rejects meta fields", () => {
    const validated = validateLlmOutput({
      id: "abcdefghijkl",
      type: "fact",
      content: "bad",
    });

    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.error).toContain("must not include id, timestamp, or session");
    }
  });

  test("validateLlmOutput requires subject for non-handoff entries", () => {
    const validated = validateLlmOutput({
      type: "fact",
      content: "bad",
    });

    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.error).toContain("subject must be a non-empty string");
    }
  });

  test("validateLlmOutput allows handoff without subject", () => {
    const validated = validateLlmOutput({
      type: "handoff",
      content: "Need follow-up",
    });

    expect(validated.ok).toBe(true);
  });

  test("subject type helpers enforce enum values", () => {
    expect(VALID_SUBJECT_TYPES).toEqual(["project", "person", "system", "topic"]);
    expect(parseSubjectType("person")).toBe("person");
    expect(parseSubjectType("invalid")).toBeUndefined();
    expect(normalizeSubjectType("invalid")).toBe("topic");
  });

  test("injectMeta adds id, timestamp, and session", () => {
    const entry = injectMeta(
      {
        type: "decision",
        content: "Use JSONL",
        detail: "Simple append-only log",
        subject: "storage",
      },
      "session-2",
    );

    expect(entry.id).toHaveLength(12);
    expect(entry.session).toBe("session-2");
    expect(entry.timestamp).toContain("T");
  });

  test("appendEntry/readLog round trip", async () => {
    const first = injectMeta(
      {
        type: "task",
        content: "Write tests",
        status: "open",
        subject: "testing",
      },
      "session-3",
    );

    const second = injectMeta(
      {
        type: "fact",
        content: "Tests use bun:test",
        subject: "testing",
      },
      "session-3",
    );

    await appendEntry(logPath, first);
    await appendEntry(logPath, second);

    const entries = await readLog(logPath);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.id).toBe(first.id);
    expect(entries[1]?.id).toBe(second.id);
  });

  test("writes timestamp first and session last in JSONL", async () => {
    const entry = injectMeta(
      {
        type: "task",
        content: "Keep key order stable",
        status: "open",
        subject: "formatting",
      },
      "session-order",
    );

    await appendEntry(logPath, entry);
    const line = (await readFile(logPath, "utf8")).trim();

    expect(line).toContain(`"id":"${entry.id}"`);
    expect(line).toContain(`"timestamp":"${entry.timestamp}"`);
    expect(line).toContain(`"session":"${entry.session}"`);
    expect(line.indexOf('"timestamp"')).toBeLessThan(line.indexOf('"id"'));
    expect(line.indexOf('"id"')).toBeLessThan(line.indexOf('"type"'));
    expect(line.indexOf('"type"')).toBeLessThan(line.indexOf('"status"'));
    expect(line.indexOf('"status"')).toBeLessThan(line.indexOf('"subject"'));
    expect(line.indexOf('"subject"')).toBeLessThan(line.indexOf('"content"'));
    expect(line.lastIndexOf('"session"')).toBeGreaterThan(line.lastIndexOf('"status"'));
  });
});
