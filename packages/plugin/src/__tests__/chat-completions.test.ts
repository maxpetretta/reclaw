import { afterEach, describe, expect, test } from "bun:test";
import { callGatewayChatCompletion } from "../lib/chat-completions";

const ORIGINAL_FETCH = globalThis.fetch;

function toUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

describe("callGatewayChatCompletion", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("extracts text from chat completions response", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      calls.push({
        url: toUrl(input),
        body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
      });

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "extracted memory" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const text = await callGatewayChatCompletion({
      baseUrl: "http://127.0.0.1:18789",
      model: "anthropic/claude-haiku-4-5",
      systemPrompt: "sys",
      userPrompt: "user",
    });

    expect(text).toBe("extracted memory");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:18789/v1/chat/completions");

    expect(calls[0]?.body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
  });

  test("throws on non-ok status codes", async () => {
    let callCount = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      callCount += 1;
      return new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
    }) as typeof fetch;

    await expect(
      callGatewayChatCompletion({
        baseUrl: "http://127.0.0.1:18789",
        model: "anthropic/claude-haiku-4-5",
        systemPrompt: "sys",
        userPrompt: "user",
      }),
    ).rejects.toThrow("401 Unauthorized");

    expect(callCount).toBe(1);
  });
});
