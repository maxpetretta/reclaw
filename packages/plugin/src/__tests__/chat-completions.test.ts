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

  test("falls back to /v1/responses when /v1/chat/completions returns 405", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      calls.push({
        url: toUrl(input),
        body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
      });

      if (calls.length === 1) {
        return new Response("Method Not Allowed", { status: 405, statusText: "Method Not Allowed" });
      }

      return new Response(JSON.stringify({ output_text: "extracted memory" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const text = await callGatewayChatCompletion({
      baseUrl: "http://127.0.0.1:18789",
      model: "anthropic/claude-haiku-4-5",
      systemPrompt: "sys",
      userPrompt: "user",
    });

    expect(text).toBe("extracted memory");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://127.0.0.1:18789/v1/chat/completions");
    expect(calls[1]?.url).toBe("http://127.0.0.1:18789/v1/responses");

    expect(calls[0]?.body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
    expect(calls[1]?.body.input).toEqual([
      { role: "system", content: [{ type: "input_text", text: "sys" }] },
      { role: "user", content: [{ type: "input_text", text: "user" }] },
    ]);
  });

  test("extracts text from responses output blocks", async () => {
    let callCount = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response("Method Not Allowed", { status: 405, statusText: "Method Not Allowed" });
      }

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "line one" },
                { type: "output_text", text: "line two" },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    await expect(
      callGatewayChatCompletion({
        baseUrl: "http://127.0.0.1:18789",
        model: "anthropic/claude-haiku-4-5",
        systemPrompt: "sys",
        userPrompt: "user",
      }),
    ).resolves.toBe("line one\nline two");
  });

  test("does not fallback for non-fallback status codes", async () => {
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
