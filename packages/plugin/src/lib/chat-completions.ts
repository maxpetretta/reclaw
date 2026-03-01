export interface GatewayChatCompletionOptions {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  apiToken?: string;
  errorPrefix?: string;
}

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const RESPONSES_PATH = "/v1/responses";
const FALLBACK_STATUSES = new Set([404, 405]);

function extractTextFromContentParts(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if ((type === "text" || type === "input_text" || type === "output_text") && typeof record.text === "string") {
      textParts.push(record.text);
      continue;
    }

    if (typeof record.output_text === "string") {
      textParts.push(record.output_text);
      continue;
    }

    if (typeof record.input_text === "string") {
      textParts.push(record.input_text);
    }
  }

  return textParts.join("\n");
}

function extractChatCompletionsText(raw: Record<string, unknown>): string {
  const choices = raw.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("LLM response missing choices");
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    throw new Error("LLM response contained an invalid choice");
  }

  const message = (firstChoice as Record<string, unknown>).message;
  if (!message || typeof message !== "object") {
    throw new Error("LLM response choice missing message");
  }

  const content = (message as Record<string, unknown>).content;
  const text = extractTextFromContentParts(content).trim();
  if (!text) {
    throw new Error("LLM response did not include text content");
  }

  return text;
}

function extractResponsesText(raw: Record<string, unknown>): string {
  if (typeof raw.output_text === "string" && raw.output_text.trim()) {
    return raw.output_text.trim();
  }

  const output = raw.output;
  if (!Array.isArray(output) || output.length === 0) {
    throw new Error("LLM response missing output");
  }

  const textParts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const contentText = extractTextFromContentParts(record.content).trim();
    if (contentText) {
      textParts.push(contentText);
      continue;
    }

    const directText = extractTextFromContentParts([record]).trim();
    if (directText) {
      textParts.push(directText);
    }
  }

  const text = textParts.join("\n").trim();
  if (!text) {
    throw new Error("LLM response did not include text content");
  }

  return text;
}

function extractCompletionText(raw: unknown, endpointPath: string): string {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid LLM response payload");
  }

  const payload = raw as Record<string, unknown>;
  if (endpointPath === RESPONSES_PATH || Object.hasOwn(payload, "output")) {
    return extractResponsesText(payload);
  }

  return extractChatCompletionsText(payload);
}

async function parseErrorBody(response: Response): Promise<string> {
  const text = await response.text();
  if (!text.trim()) {
    return `${response.status} ${response.statusText}`;
  }

  return `${response.status} ${response.statusText}: ${text}`;
}

async function postChatCompletions(opts: GatewayChatCompletionOptions, headers: Record<string, string>): Promise<Response> {
  return await fetch(`${opts.baseUrl}${CHAT_COMPLETIONS_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: opts.model,
      temperature: 0,
      stream: false,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userPrompt },
      ],
    }),
  });
}

async function postResponses(opts: GatewayChatCompletionOptions, headers: Record<string, string>): Promise<Response> {
  return await fetch(`${opts.baseUrl}${RESPONSES_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: opts.model,
      temperature: 0,
      stream: false,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: opts.systemPrompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: opts.userPrompt }],
        },
      ],
    }),
  });
}

export async function callGatewayChatCompletion(opts: GatewayChatCompletionOptions): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (opts.apiToken) {
    headers.authorization = `Bearer ${opts.apiToken}`;
  }

  const response = await postChatCompletions(opts, headers);

  if (response.ok) {
    return extractCompletionText((await response.json()) as unknown, CHAT_COMPLETIONS_PATH);
  }

  if (!FALLBACK_STATUSES.has(response.status)) {
    throw new Error(`${opts.errorPrefix ?? "LLM call failed"}: ${await parseErrorBody(response)}`);
  }

  const fallbackResponse = await postResponses(opts, headers);
  if (!fallbackResponse.ok) {
    throw new Error(
      `${opts.errorPrefix ?? "LLM call failed"}: ${await parseErrorBody(fallbackResponse)} (fallback from ${CHAT_COMPLETIONS_PATH})`,
    );
  }

  return extractCompletionText((await fallbackResponse.json()) as unknown, RESPONSES_PATH);
}
