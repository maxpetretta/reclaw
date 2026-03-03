import { describe, expect, test } from "bun:test";
import { runIsolatedModelTask, type IsolatedModelTaskDeps } from "../lib/isolated-model-task";
import type { TranscriptMessage } from "../lib/transcript";

const BASE_OPTIONS = {
  model: "anthropic/claude-sonnet-4-6",
  systemPrompt: "System instruction",
  userPrompt: "User instruction",
  sessionName: "isolated-test",
} as const;

function createDeps(overrides: Partial<IsolatedModelTaskDeps> = {}): IsolatedModelTaskDeps {
  return {
    scheduleSubagentCronJob: async () => ({ jobId: "job-1" }),
    runCronJobNow: async () => {},
    waitForCronResult: async () => ({
      summary: "TRUNCATED_SUMMARY",
      sessionId: "session-1",
      sessionKey: "agent:main:cron:job-1:run:session-1",
    }),
    removeCronJob: async () => {},
    findTranscriptFile: async () => "/tmp/session-1.jsonl",
    readTranscript: async () => [],
    ...overrides,
  };
}

describe("runIsolatedModelTask", () => {
  test("uses transcript assistant output when available", async () => {
    const transcriptMessages: TranscriptMessage[] = [
      {
        role: "user",
        content: "request",
        timestamp: "2026-03-03T00:00:00.000Z",
      },
      {
        role: "assistant",
        content: '{"type":"fact","content":"FULL_OUTPUT"}',
        timestamp: "2026-03-03T00:00:01.000Z",
      },
    ];

    const removed: string[] = [];
    const deps = createDeps({
      removeCronJob: async (jobId) => {
        removed.push(jobId);
      },
      readTranscript: async () => transcriptMessages,
    });

    const output = await runIsolatedModelTask(BASE_OPTIONS, deps);

    expect(output).toBe('{"type":"fact","content":"FULL_OUTPUT"}');
    expect(removed).toEqual(["job-1"]);
  });

  test("falls back to cron summary when transcript lookup/read fails", async () => {
    const removed: string[] = [];
    const deps = createDeps({
      removeCronJob: async (jobId) => {
        removed.push(jobId);
      },
      findTranscriptFile: async () => {
        throw new Error("lookup failed");
      },
    });

    const output = await runIsolatedModelTask(BASE_OPTIONS, deps);

    expect(output).toBe("TRUNCATED_SUMMARY");
    expect(removed).toEqual(["job-1"]);
  });
});
