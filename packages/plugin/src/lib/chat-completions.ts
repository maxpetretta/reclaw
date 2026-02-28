export interface GatewayChatCompletionOptions {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  apiToken?: string;
  errorPrefix?: string;
}

function extractTextFromChatContent(content: unknown): string {
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

    if ((type === "text" || type === "input_text") && typeof record.text === "string") {
      textParts.push(record.text);
      continue;
    }

    if (typeof record.input_text === "string") {
      textParts.push(record.input_text);
    }
  }

  return textParts.join("\n");
}

function extractCompletionText(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid LLM response payload");
  }

  const payload = raw as Record<string, unknown>;
  const choices = payload.choices;
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
  const text = extractTextFromChatContent(content).trim();
  if (!text) {
    throw new Error("LLM response did not include text content");
  }

  return text;
}

async function parseErrorBody(response: Response): Promise<string> {
  const text = await response.text();
  if (!text.trim()) {
    return `${response.status} ${response.statusText}`;
  }

  return `${response.status} ${response.statusText}: ${text}`;
}

export async function callGatewayChatCompletion(opts: GatewayChatCompletionOptions): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (opts.apiToken) {
    headers.authorization = `Bearer ${opts.apiToken}`;
  }

  const response = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
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

  if (!response.ok) {
    throw new Error(`${opts.errorPrefix ?? "LLM call failed"}: ${await parseErrorBody(response)}`);
  }

  return extractCompletionText((await response.json()) as unknown);
}
