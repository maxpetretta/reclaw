import { isObject } from "../../lib/guards";
import type { ImportedConversation, ImportedMessage, ImportedRole } from "../types";
import {
  extractText,
  normalizeRole,
  readConversationList,
  readString,
  toIso,
} from "./shared";

const CLAUDE_ROLES: Record<string, ImportedRole> = {
  human: "user",
  user: "user",
  assistant: "assistant",
  claude: "assistant",
  ai: "assistant",
  model: "assistant",
  system: "system",
};

function claudeNormalizeRole(value: unknown): ImportedRole | null {
  return normalizeRole(value, CLAUDE_ROLES);
}

function readMessages(raw: Record<string, unknown>, fallbackMs: number): ImportedMessage[] {
  const source =
    (Array.isArray(raw.chat_messages) ? raw.chat_messages : undefined) ??
    (Array.isArray(raw.messages) ? raw.messages : undefined) ??
    (Array.isArray(raw.entries) ? raw.entries : undefined) ??
    [];

  const messages: ImportedMessage[] = [];
  const seen = new Set<string>();

  for (const [index, messageRaw] of source.entries()) {
    if (!isObject(messageRaw)) {
      continue;
    }

    const role = claudeNormalizeRole(
      messageRaw.sender ??
        messageRaw.role ??
        (isObject(messageRaw.author) ? messageRaw.author.role : undefined),
    );
    if (!role) {
      continue;
    }

    const content = extractText(messageRaw.text ?? messageRaw.content ?? messageRaw.message ?? messageRaw.body);
    if (!content) {
      continue;
    }

    const id =
      readString(messageRaw.uuid) ??
      readString(messageRaw.id) ??
      readString(messageRaw.message_uuid) ??
      `${role}-${index + 1}`;

    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    messages.push({
      id,
      role,
      content,
      createdAt: toIso(
        messageRaw.created_at ??
          messageRaw.createdAt ??
          messageRaw.updated_at ??
          messageRaw.updatedAt ??
          messageRaw.timestamp,
        fallbackMs,
      ),
    });
  }

  messages.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  return messages;
}

function parseConversation(raw: unknown, index: number): ImportedConversation | null {
  if (!isObject(raw)) {
    return null;
  }

  const now = Date.now();
  const messages = readMessages(raw, now);
  const firstMessageAt = messages.length > 0 ? Date.parse(messages[0].createdAt) : now;
  const lastMessageAt = messages.length > 0 ? Date.parse(messages[messages.length - 1].createdAt) : firstMessageAt;

  const conversationId =
    readString(raw.uuid) ?? readString(raw.id) ?? readString(raw.conversation_uuid) ?? `claude-${index + 1}`;

  const title = readString(raw.name) ?? readString(raw.title) ?? `Claude import ${index + 1}`;
  const createdAt = toIso(raw.created_at ?? raw.createdAt ?? firstMessageAt, firstMessageAt);
  const updatedAt = toIso(
    raw.updated_at ?? raw.updatedAt ?? raw.last_message_at ?? raw.lastMessageAt ?? lastMessageAt,
    lastMessageAt,
  );

  return {
    platform: "claude",
    conversationId,
    title,
    createdAt,
    updatedAt,
    messages,
  };
}

function looksLikeClaudeConversation(raw: unknown): boolean {
  if (!isObject(raw)) {
    return false;
  }

  if (Array.isArray(raw.chat_messages) || Array.isArray(raw.entries)) {
    return true;
  }

  if (Array.isArray(raw.messages)) {
    return raw.messages.some((message) => {
      if (!isObject(message)) {
        return false;
      }

      return (
        typeof message.sender === "string" ||
        typeof message.uuid === "string" ||
        typeof message.message_uuid === "string"
      );
    });
  }

  return false;
}

export function isLikelyClaudeExport(raw: unknown): boolean {
  const conversations = readConversationList(raw);
  if (conversations.length === 0) {
    return false;
  }

  const sample = conversations.slice(0, 5);
  return sample.some((conversation) => looksLikeClaudeConversation(conversation));
}

export function parseClaudeConversations(raw: unknown): ImportedConversation[] {
  const conversations: ImportedConversation[] = [];

  for (const [index, conversationRaw] of readConversationList(raw).entries()) {
    const parsed = parseConversation(conversationRaw, index);
    if (!parsed) {
      continue;
    }

    conversations.push(parsed);
  }

  return conversations;
}
