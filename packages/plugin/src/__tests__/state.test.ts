import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  incrementEventUsage,
  isExtracted,
  markExtracted,
  markFailed,
  pruneState,
  readState,
  shouldRetry,
  writeState,
} from "../state";

describe("state", () => {
  let tempDir = "";
  let statePath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zettelclaw-state-"));
    statePath = join(tempDir, "state.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("readState returns empty structure when missing", async () => {
    expect(await readState(statePath)).toEqual({
      extractedSessions: {},
      failedSessions: {},
      importedConversations: {},
      eventUsage: {},
      importJobs: {},
    });
  });

  test("markExtracted records extraction and clears failure", async () => {
    await markFailed(statePath, "session-1", "temporary");
    await markExtracted(statePath, "session-1", 3);

    const state = await readState(statePath);
    expect(isExtracted(state, "session-1")).toBe(true);
    expect(state.extractedSessions["session-1"]?.entries).toBe(3);
    expect(state.failedSessions["session-1"]).toBeUndefined();
  });

  test("readState ignores imported records with invalid sessionId format", async () => {
    const at = new Date().toISOString();
    await writeState(statePath, {
      extractedSessions: {},
      failedSessions: {},
      importedConversations: {
        "chatgpt:bad": {
          at,
          updatedAt: at,
          sessionId: "not-reclaw",
          entries: 1,
        },
      },
      eventUsage: {},
      importJobs: {},
    });

    const state = await readState(statePath);
    expect(state.importedConversations["chatgpt:bad"]).toBeUndefined();
  });

  test("markFailed increments retries and shouldRetry reflects retry policy", async () => {
    let state = await readState(statePath);
    expect(shouldRetry(state, "session-2")).toBe(true);

    await markFailed(statePath, "session-2", "first error");
    state = await readState(statePath);

    expect(state.failedSessions["session-2"]?.retries).toBe(1);
    expect(shouldRetry(state, "session-2")).toBe(true);

    await markFailed(statePath, "session-2", "second error");
    state = await readState(statePath);
    expect(state.failedSessions["session-2"]?.retries).toBe(2);
    expect(shouldRetry(state, "session-2")).toBe(false);
  });

  test("pruneState removes entries older than cutoff", async () => {
    const oldAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recentAt = new Date().toISOString();

    await writeState(statePath, {
      extractedSessions: {
        old: { at: oldAt, entries: 1 },
        recent: { at: recentAt, entries: 2 },
      },
      failedSessions: {
        old: { at: oldAt, error: "x", retries: 1 },
        recent: { at: recentAt, error: "y", retries: 1 },
      },
      importedConversations: {
        "chatgpt:old": {
          at: oldAt,
          updatedAt: oldAt,
          sessionId: "reclaw:chatgpt:old",
          entries: 1,
          title: "Old",
        },
      },
      eventUsage: {},
      importJobs: {},
    });

    await pruneState(statePath);

    const state = await readState(statePath);
    expect(state.extractedSessions.old).toBeUndefined();
    expect(state.failedSessions.old).toBeUndefined();
    expect(state.extractedSessions.recent).toBeDefined();
    expect(state.failedSessions.recent).toBeDefined();
    expect(state.importedConversations["chatgpt:old"]).toBeDefined();
  });

  test("incrementEventUsage tracks counters and last access", async () => {
    await incrementEventUsage(statePath, ["abc123def456"], "memory_get");
    await incrementEventUsage(statePath, ["abc123def456"], "memory_search");
    await incrementEventUsage(statePath, ["abc123def456"], "citation");
    await incrementEventUsage(statePath, ["abc123def456", "abc123def456"], "citation");

    const state = await readState(statePath);
    const usage = state.eventUsage["abc123def456"];

    expect(usage).toBeDefined();
    expect(usage?.memoryGetCount).toBe(1);
    expect(usage?.memorySearchCount).toBe(1);
    expect(usage?.citationCount).toBe(2);
    expect(typeof usage?.lastAccessAt).toBe("string");
  });
});
