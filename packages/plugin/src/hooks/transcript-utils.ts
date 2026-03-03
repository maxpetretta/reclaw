import { extractTextContent } from "../lib/text";
import {
  findTranscriptFile,
  readTranscript,
  type TranscriptMessage,
} from "../lib/transcript";
import { isObject } from "../lib/guards";

export function hasUserMessage(messages: TranscriptMessage[]): boolean {
  return messages.some((message) => message.role === "user");
}

export function selectMessagesAfterTimestamp(
  messages: TranscriptMessage[],
  afterTimestamp: string | undefined,
): TranscriptMessage[] {
  if (!afterTimestamp) {
    return messages;
  }

  const cutoffMs = Date.parse(afterTimestamp);
  if (!Number.isFinite(cutoffMs)) {
    return messages;
  }

  return messages.filter((message) => {
    const messageTimestampMs = Date.parse(message.timestamp);
    // Keep undated/invalid messages to avoid dropping potentially new content.
    if (!Number.isFinite(messageTimestampMs)) {
      return true;
    }
    return messageTimestampMs > cutoffMs;
  });
}

function extractBeforeResetMessages(rawMessages: unknown[] | undefined): TranscriptMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const extracted: TranscriptMessage[] = [];

  for (const rawMessage of rawMessages) {
    if (!isObject(rawMessage)) {
      continue;
    }

    const topLevelRole = rawMessage.role;
    const nestedMessage = isObject(rawMessage.message) ? rawMessage.message : null;

    const role =
      topLevelRole === "user" || topLevelRole === "assistant"
        ? topLevelRole
        : nestedMessage?.role === "user" || nestedMessage?.role === "assistant"
          ? nestedMessage.role
          : null;

    if (!role) {
      continue;
    }

    const contentValue = nestedMessage?.content ?? rawMessage.content ?? rawMessage.body;
    const content = extractTextContent(contentValue, { collapseWhitespace: false });
    if (!content) {
      continue;
    }

    const timestampValue =
      typeof rawMessage.timestamp === "string"
        ? rawMessage.timestamp
        : typeof nestedMessage?.timestamp === "string"
          ? nestedMessage.timestamp
          : new Date().toISOString();

    extracted.push({
      role,
      content,
      timestamp: timestampValue,
    });
  }

  return extracted;
}

export async function loadBeforeResetMessages(
  params: {
    event: { messages?: unknown[]; sessionFile?: string };
    ctx: { agentId?: string; sessionId?: string };
  },
): Promise<TranscriptMessage[]> {
  const fromEvent = extractBeforeResetMessages(params.event.messages);
  if (fromEvent.length > 0) {
    return fromEvent;
  }

  const sessionFile =
    typeof params.event.sessionFile === "string" && params.event.sessionFile.trim().length > 0
      ? params.event.sessionFile.trim()
      : undefined;

  if (sessionFile) {
    try {
      return await readTranscript(sessionFile);
    } catch {
      // Fall through to lookup by session id.
    }
  }

  if (params.ctx.agentId && params.ctx.sessionId) {
    const transcriptFile = await findTranscriptFile(params.ctx.agentId, params.ctx.sessionId);
    if (transcriptFile) {
      try {
        return await readTranscript(transcriptFile);
      } catch {
        return [];
      }
    }
  }

  return [];
}
