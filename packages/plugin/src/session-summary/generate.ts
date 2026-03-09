import type { TranscriptMessage } from "../lib/transcript";

export interface SessionSummaryDraft {
  content: string;
  detail?: string;
}

function normalizeText(value: string | undefined, maxLength = 220): string | undefined {
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

function pickLatest(messages: TranscriptMessage[], role: TranscriptMessage["role"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === role) {
      return normalizeText(candidate.content);
    }
  }

  return undefined;
}

function pickFirst(messages: TranscriptMessage[], role: TranscriptMessage["role"]): string | undefined {
  for (const candidate of messages) {
    if (candidate.role === role) {
      return normalizeText(candidate.content);
    }
  }

  return undefined;
}

export async function generateSessionSummary(opts: {
  messages: TranscriptMessage[];
  sessionId: string;
  sessionKey?: string;
  model: string;
}): Promise<SessionSummaryDraft> {
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
    ...(detailParts.length > 0 ? { detail: detailParts.join("\n\n") } : {}),
  };
}
