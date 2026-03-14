import { runIsolatedModelTaskWithMeta } from "../lib/isolated-model-task";
import type { TranscriptMessage } from "../lib/transcript";
import { sanitizeTranscriptMessageForProjection } from "../projections/transcripts";

export interface SessionSummaryDraft {
  content: string;
  detail?: string;
  source: "model" | "fallback";
  fallbackReason?: "empty_transcript" | "model_error" | "invalid_model_output";
}

interface SessionSummaryModelDeps {
  callModel: typeof runIsolatedModelTaskWithMeta;
}

const SESSION_SUMMARY_MODEL_SESSION_NAME = "reclaw-session-summary-model";
const SESSION_SUMMARY_MODEL_TIMEOUT_SECONDS = 900;
const SESSION_SUMMARY_MODEL_WAIT_TIMEOUT_MS = 960_000;

const SESSION_SUMMARY_SYSTEM_PROMPT = [
  "You write concise, high-signal session summaries for Reclaw.",
  "Your job is to summarize what actually mattered in the conversation so it can be recalled later.",
  "",
  "Return exactly one JSON object with this shape:",
  '{"content":"...", "detail":"..."}',
  "",
  "Rules:",
  "- `content` is required. Write 1-3 tight sentences describing the main accomplishment, decision, or unresolved thread of the session.",
  "- `detail` is optional. Use it only when extra context materially improves future recall.",
  "- Prefer specific outcomes, decisions, follow-up items, and user-relevant context over generic phrasing.",
  "- Do not just echo the latest user message or latest assistant message.",
  "- Do not mention tool calls, hidden chain-of-thought, system scaffolding, or transcript formatting.",
  "- If the session was mostly exploration, summarize the concrete direction or open question that mattered.",
  "- Keep the output concise and durable.",
].join("\n");

const DEFAULT_DEPS: SessionSummaryModelDeps = {
  callModel: runIsolatedModelTaskWithMeta,
};

function normalizeSingleLine(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (!collapsed) {
    return undefined;
  }

  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return `${collapsed.slice(0, Math.max(1, maxLength - 1))}...`;
}

function normalizeMultiline(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxLength - 1))}...`;
}

function pickLatest(messages: TranscriptMessage[], role: TranscriptMessage["role"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === role) {
      return normalizeSingleLine(candidate.content, 220);
    }
  }

  return undefined;
}

function pickFirst(messages: TranscriptMessage[], role: TranscriptMessage["role"]): string | undefined {
  for (const candidate of messages) {
    if (candidate.role === role) {
      return normalizeSingleLine(candidate.content, 220);
    }
  }

  return undefined;
}

function fallbackSessionSummary(opts: {
  messages: TranscriptMessage[];
  sessionId: string;
  reason: SessionSummaryDraft["fallbackReason"];
}): SessionSummaryDraft {
  const latestUser = pickLatest(opts.messages, "user");
  const firstUser = pickFirst(opts.messages, "user");
  const latestAssistant = pickLatest(opts.messages, "assistant");

  const content = latestUser ??
    latestAssistant ??
    `Review the previous session transcript for session ${opts.sessionId}.`;

  const detailParts = [
    firstUser && firstUser !== latestUser ? `Earlier focus: ${firstUser}` : undefined,
    latestAssistant ? `Latest assistant response: ${latestAssistant}` : undefined,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return {
    content,
    source: "fallback",
    fallbackReason: opts.reason,
    ...(detailParts.length > 0 ? { detail: detailParts.join("\n\n") } : {}),
  };
}

function formatTranscript(messages: TranscriptMessage[]): string {
  return messages
    .map((message) => `[${message.timestamp}] ${message.role}: ${message.content}`)
    .join("\n\n");
}

function buildUserPrompt(opts: {
  messages: TranscriptMessage[];
  sessionId: string;
  sessionKey?: string;
}): string {
  const blocks = [
    "## Session",
    `sessionId: ${opts.sessionId}`,
    `sessionKey: ${opts.sessionKey ?? "n/a"}`,
    "",
    "## Transcript",
    formatTranscript(opts.messages),
  ];

  return blocks.join("\n");
}

function parseModelOutput(output: string): SessionSummaryDraft | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  const objectMatch = /\{[\s\S]*\}/u.exec(trimmed);
  if (objectMatch && objectMatch[0] !== trimmed) {
    candidates.push(objectMatch[0]);
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const content = normalizeSingleLine(record.content, 400);
    const detail = normalizeMultiline(record.detail, 2_000);
    if (!content) {
      continue;
    }

    return {
      content,
      source: "model",
      ...(detail ? { detail } : {}),
    };
  }

  return null;
}

function sanitizeMessagesForSummary(
  messages: TranscriptMessage[],
  sessionId: string,
): TranscriptMessage[] {
  return messages
    .map((message) => sanitizeTranscriptMessageForProjection(message, { sessionId }))
    .filter((message): message is TranscriptMessage => message !== null);
}

export async function generateSessionSummary(
  opts: {
    messages: TranscriptMessage[];
    sessionId: string;
    sessionKey?: string;
    model: string;
  },
  deps: Partial<SessionSummaryModelDeps> = {},
): Promise<SessionSummaryDraft> {
  const runtimeDeps: SessionSummaryModelDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };
  const cleanedMessages = sanitizeMessagesForSummary(opts.messages, opts.sessionId);

  if (cleanedMessages.length === 0) {
    return fallbackSessionSummary({
      ...opts,
      reason: "empty_transcript",
    });
  }

  try {
    const result = await runtimeDeps.callModel({
      model: opts.model,
      sessionName: SESSION_SUMMARY_MODEL_SESSION_NAME,
      timeoutSeconds: SESSION_SUMMARY_MODEL_TIMEOUT_SECONDS,
      waitTimeoutMs: SESSION_SUMMARY_MODEL_WAIT_TIMEOUT_MS,
      systemPrompt: SESSION_SUMMARY_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt({
        messages: cleanedMessages,
        sessionId: opts.sessionId,
        sessionKey: opts.sessionKey,
      }),
      errorPrefix: "session summary LLM call failed",
      outputReminder: 'Return a JSON object only: {"content":"...", "detail":"..."}',
    });
    const parsed = parseModelOutput(result.output);
    if (parsed) {
      return parsed;
    }
  } catch {
    // Fall through to the deterministic fallback so summary generation failures
    // do not block extraction or transcript-import repair flows.
    return fallbackSessionSummary({
      messages: cleanedMessages,
      sessionId: opts.sessionId,
      reason: "model_error",
    });
  }

  return fallbackSessionSummary({
    messages: cleanedMessages,
    sessionId: opts.sessionId,
    reason: "invalid_model_output",
  });
}
