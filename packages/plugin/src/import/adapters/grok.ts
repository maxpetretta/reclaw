import { isObject } from "../../lib/guards";
import type { ImportedConversation, ImportedMessage, ImportedRole } from "../types";
import {
  extractText,
  normalizeRole,
  parseTimestampMs,
  readConversationList,
  readString,
  toIso as baseToIso,
} from "./shared";

const GROK_ROLES: Record<string, ImportedRole> = {
  user: "user",
  human: "user",
  prompt: "user",
  assistant: "assistant",
  grok: "assistant",
  ai: "assistant",
  model: "assistant",
  system: "system",
};

function grokNormalizeRole(value: unknown): ImportedRole | null {
  return normalizeRole(value, GROK_ROLES);
}

function readId(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  if (!isObject(value)) {
    return undefined;
  }

  if (typeof value.$oid === "string" && value.$oid.trim()) {
    return value.$oid.trim();
  }

  if (typeof value.id === "string" && value.id.trim()) {
    return value.id.trim();
  }

  return undefined;
}

function parseGrokTimestampMs(value: unknown): number | undefined {
  const base = parseTimestampMs(value);
  if (base !== undefined) {
    return base;
  }

  if (!isObject(value)) {
    return undefined;
  }

  if (Object.hasOwn(value, "$date")) {
    return parseGrokTimestampMs(value.$date);
  }

  if (Object.hasOwn(value, "$numberLong")) {
    return parseGrokTimestampMs(value.$numberLong);
  }

  if (Object.hasOwn(value, "value")) {
    return parseGrokTimestampMs(value.value);
  }

  if (typeof value.seconds === "number" && Number.isFinite(value.seconds)) {
    const millis = value.seconds * 1000;
    const nanos =
      typeof value.nanos === "number" && Number.isFinite(value.nanos)
        ? Math.floor(value.nanos / 1_000_000)
        : 0;
    return Math.floor(millis + nanos);
  }

  return undefined;
}

function toIso(value: unknown, fallbackMs: number): string {
  return new Date(parseGrokTimestampMs(value) ?? fallbackMs).toISOString();
}

function readMessageArray(raw: Record<string, unknown>): unknown[] {
  const direct =
    (Array.isArray(raw.messages) ? raw.messages : undefined) ??
    (Array.isArray(raw.turns) ? raw.turns : undefined) ??
    (Array.isArray(raw.chat_messages) ? raw.chat_messages : undefined) ??
    (Array.isArray(raw.entries) ? raw.entries : undefined);

  if (direct) {
    return direct;
  }

  // Grok backend export shape:
  // {
  //   conversation: { ...metadata },
  //   responses: [{ response: { ...message } }, ...]
  // }
  if (Array.isArray(raw.responses)) {
    return raw.responses
      .map((item) => {
        if (!isObject(item)) {
          return item;
        }

        return isObject(item.response) ? item.response : item;
      })
      .filter((item) => isObject(item));
  }

  if (isObject(raw.messagesById)) {
    return Object.values(raw.messagesById);
  }

  return [];
}

function readMessages(raw: Record<string, unknown>, fallbackMs: number): ImportedMessage[] {
  const source = readMessageArray(raw);
  const messages: ImportedMessage[] = [];
  const seen = new Set<string>();

  for (const [index, messageRaw] of source.entries()) {
    if (!isObject(messageRaw)) {
      continue;
    }

    const role = grokNormalizeRole(
      messageRaw.role ??
        messageRaw.sender ??
        (isObject(messageRaw.author) ? messageRaw.author.role : undefined),
    );
    if (!role) {
      continue;
    }

    const content = extractText(
      messageRaw.content ??
        messageRaw.text ??
        messageRaw.message ??
        messageRaw.body ??
        messageRaw.query ??
        messageRaw.response,
    );
    if (!content) {
      continue;
    }

    const id = readId(messageRaw._id) ?? readString(messageRaw.id) ?? `${role}-${index + 1}`;
    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    messages.push({
      id,
      role,
      content,
      createdAt: toIso(
        messageRaw.createdAt ??
          messageRaw.created_at ??
          messageRaw.create_time ??
          messageRaw.timestamp ??
          messageRaw.time ??
          messageRaw.updatedAt ??
          messageRaw.updated_at ??
          messageRaw.modify_time,
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

  const conversationMeta = isObject(raw.conversation) ? raw.conversation : raw;

  const now = Date.now();
  const messages = readMessages(raw, now);
  const firstMessageAt = messages.length > 0 ? Date.parse(messages[0].createdAt) : now;
  const lastMessageAt = messages.length > 0 ? Date.parse(messages[messages.length - 1].createdAt) : firstMessageAt;

  const conversationId =
    readId(conversationMeta._id) ??
    readString(conversationMeta.id) ??
    readString(conversationMeta.conversationId) ??
    readString(conversationMeta.uuid) ??
    `grok-${index + 1}`;

  const title = readString(conversationMeta.title) ?? readString(conversationMeta.name) ?? `Grok import ${index + 1}`;
  const createdAt = toIso(
    conversationMeta.createdAt ??
      conversationMeta.created_at ??
      conversationMeta.createTime ??
      conversationMeta.create_time ??
      conversationMeta.startTime ??
      firstMessageAt,
    firstMessageAt,
  );
  const updatedAt = toIso(
    conversationMeta.updatedAt ??
      conversationMeta.updated_at ??
      conversationMeta.updateTime ??
      conversationMeta.modify_time ??
      conversationMeta.lastUpdatedAt ??
      conversationMeta.last_message_at ??
      lastMessageAt,
    lastMessageAt,
  );

  return {
    platform: "grok",
    conversationId,
    title,
    createdAt,
    updatedAt,
    messages,
  };
}

function looksLikeGrokConversation(raw: unknown): boolean {
  if (!isObject(raw)) {
    return false;
  }

  if (Array.isArray(raw.responses) && isObject(raw.conversation)) {
    return true;
  }

  if (isObject(raw.messagesById)) {
    return true;
  }

  if (isObject(raw._id)) {
    return true;
  }

  if (isObject(raw.conversation)) {
    const conversation = raw.conversation;
    return isObject(conversation._id) || typeof conversation.id === "string";
  }

  return false;
}

export function isLikelyGrokExport(raw: unknown): boolean {
  const conversations = readConversationList(raw);
  if (conversations.length === 0) {
    return false;
  }

  const sample = conversations.slice(0, 5);
  return sample.some((conversation) => looksLikeGrokConversation(conversation));
}

export function parseGrokConversations(raw: unknown): ImportedConversation[] {
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
