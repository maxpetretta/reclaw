import { describe, expect, test } from "bun:test";
import { generateSessionSummary } from "../session-summary/generate";

describe("session summary generation", () => {
  test("uses model-written JSON summary when available", async () => {
    const draft = await generateSessionSummary(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:main:session-1",
        model: "anthropic/claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            timestamp: "2026-03-13T12:00:00.000Z",
            content: "We fixed the retry timeout and agreed to keep Perplexity as the default provider.",
          },
          {
            role: "assistant",
            timestamp: "2026-03-13T12:01:00.000Z",
            content: "I updated the config and left Brave and Exa as fallbacks.",
          },
        ],
      },
      {
        callModel: async () => ({
          output: JSON.stringify({
            content:
              "Configured the search stack to use Perplexity by default with Brave and Exa as fallbacks after fixing the retry-timeout issue.",
            detail:
              "The session ended with the provider order settled and the timeout problem addressed.",
          }),
        }),
      },
    );

    expect(draft.content).toContain("Configured the search stack");
    expect(draft.detail).toContain("provider order settled");
    expect(draft.source).toBe("model");
  });

  test("falls back to deterministic summary when model output is invalid", async () => {
    const draft = await generateSessionSummary(
      {
        sessionId: "session-2",
        sessionKey: "agent:main:main:session-2",
        model: "anthropic/claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            timestamp: "2026-03-13T12:00:00.000Z",
            content: "Need to finish the auth migration rollout.",
          },
          {
            role: "assistant",
            timestamp: "2026-03-13T12:01:00.000Z",
            content: "Retry validation is still open.",
          },
        ],
      },
      {
        callModel: async () => ({ output: "not-json" }),
      },
    );

    expect(draft.content).toBe("Need to finish the auth migration rollout.");
    expect(draft.detail).toContain("Latest assistant response: Retry validation is still open.");
    expect(draft.source).toBe("fallback");
    expect(draft.fallbackReason).toBe("invalid_model_output");
  });
});
