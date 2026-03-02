import { isObject } from "../../lib/guards";
import type { ImportedConversation, ImportedMessage, ImportedRole } from "../types";
import {
  extractText,
  normalizeRole,
  readConversationList,
  readString,
  toIso,
} from "./shared";

const CHATGPT_ROLES: Record<string, ImportedRole> = {
  user: "user",
  human: "user",
  assistant: "assistant",
  ai: "assistant",
  model: "assistant",
  system: "system",
};

function chatgptNormalizeRole(value: unknown): ImportedRole | null {
  return normalizeRole(value, CHATGPT_ROLES);
}

function extractMessageFromNode(node: Record<string, unknown>, fallbackMs: number): ImportedMessage | null {
  const message = isObject(node.message) ? node.message : null;
  if (!message) {
    return null;
  }

  const author = isObject(message.author) ? message.author : null;
  const role = chatgptNormalizeRole(author?.role ?? node.role);
  if (!role) {
    return null;
  }

  const content = extractText(message.content ?? node.content);
  if (!content) {
    return null;
  }

  const id = readString(message.id) ?? readString(node.id) ?? `${role}-${fallbackMs}`;
  const createdAt = toIso(message.create_time ?? node.create_time ?? message.update_time ?? node.update_time, fallbackMs);

  return {
    id,
    role,
    content,
    createdAt,
  };
}

function readNodeIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ids: string[] = [];
  for (const item of value) {
    const id = readString(item);
    if (id) {
      ids.push(id);
    }
  }

  return ids;
}

function buildInferredParents(mapping: Record<string, unknown>): Map<string, string> {
  const inferredParents = new Map<string, string>();

  for (const [nodeId, nodeValue] of Object.entries(mapping)) {
    if (!isObject(nodeValue)) {
      continue;
    }

    for (const childId of readNodeIdArray(nodeValue.children)) {
      if (!isObject(mapping[childId]) || inferredParents.has(childId)) {
        continue;
      }

      inferredParents.set(childId, nodeId);
    }
  }

  return inferredParents;
}

function collectPathNodeIds(mapping: Record<string, unknown>, currentNode: string | undefined): string[] {
  if (!currentNode || !isObject(mapping[currentNode])) {
    return [];
  }

  const inferredParents = buildInferredParents(mapping);
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = currentNode;

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    path.push(cursor);

    const current = mapping[cursor];
    if (!isObject(current)) {
      break;
    }

    const explicitParent = readString(current.parent);
    if (explicitParent && isObject(mapping[explicitParent])) {
      cursor = explicitParent;
      continue;
    }

    const inferredParent = inferredParents.get(cursor);
    if (!inferredParent || !isObject(mapping[inferredParent])) {
      break;
    }

    cursor = inferredParent;
  }

  path.reverse();
  return path;
}

function parseMessagesFromMapping(
  mappingRaw: unknown,
  currentNodeRaw: unknown,
  fallbackMs: number,
): ImportedMessage[] {
  if (!isObject(mappingRaw)) {
    return [];
  }

  const mapping = mappingRaw;
  const currentNode = readString(currentNodeRaw);
  const preferredPath = collectPathNodeIds(mapping, currentNode);

  const seenIds = new Set<string>();
  const collected: ImportedMessage[] = [];

  const appendFromNodeId = (nodeId: string): void => {
    const nodeValue = mapping[nodeId];
    if (!isObject(nodeValue)) {
      return;
    }

    const parsed = extractMessageFromNode(nodeValue, fallbackMs);
    if (!parsed || seenIds.has(parsed.id)) {
      return;
    }

    seenIds.add(parsed.id);
    collected.push(parsed);
  };

  for (const nodeId of preferredPath) {
    appendFromNodeId(nodeId);
  }

  if (collected.length > 0) {
    return collected;
  }

  const nodes = Object.values(mapping)
    .filter(isObject)
    .map((node) => {
      const parsed = extractMessageFromNode(node, fallbackMs);
      return parsed
        ? {
            message: parsed,
            createdAtMs: Date.parse(parsed.createdAt),
          }
        : null;
    })
    .filter((item): item is { message: ImportedMessage; createdAtMs: number } => item !== null)
    .sort((left, right) => left.createdAtMs - right.createdAtMs);

  for (const node of nodes) {
    if (seenIds.has(node.message.id)) {
      continue;
    }

    seenIds.add(node.message.id);
    collected.push(node.message);
  }

  return collected;
}

function parseMessagesFallback(messagesRaw: unknown, fallbackMs: number): ImportedMessage[] {
  if (!Array.isArray(messagesRaw)) {
    return [];
  }

  const messages: ImportedMessage[] = [];
  const seenIds = new Set<string>();

  for (const raw of messagesRaw) {
    if (!isObject(raw)) {
      continue;
    }

    const role = chatgptNormalizeRole(raw.role ?? raw.author);
    if (!role) {
      continue;
    }

    const content = extractText(raw.content ?? raw.text ?? raw.message);
    if (!content) {
      continue;
    }

    const id = readString(raw.id) ?? `${role}-${messages.length + 1}`;
    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    messages.push({
      id,
      role,
      content,
      createdAt: toIso(raw.created_at ?? raw.create_time ?? raw.timestamp ?? raw.time, fallbackMs),
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
  const conversationId = readString(raw.id) ?? readString(raw.conversation_id) ?? `chatgpt-${index + 1}`;
  const title = readString(raw.title) ?? `ChatGPT import ${index + 1}`;

  const fromMapping = parseMessagesFromMapping(raw.mapping, raw.current_node, now);
  const fromArray = fromMapping.length > 0 ? fromMapping : parseMessagesFallback(raw.messages, now);
  const messages = fromArray.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

  const firstMessageAt = messages.length > 0 ? Date.parse(messages[0].createdAt) : now;
  const lastMessageAt = messages.length > 0 ? Date.parse(messages[messages.length - 1].createdAt) : firstMessageAt;

  const createdAt = toIso(raw.create_time ?? raw.created_at ?? firstMessageAt, firstMessageAt);
  const updatedAt = toIso(raw.update_time ?? raw.updated_at ?? lastMessageAt, lastMessageAt);

  return {
    platform: "chatgpt",
    conversationId,
    title,
    createdAt,
    updatedAt,
    messages,
  };
}

function looksLikeChatGptConversation(raw: unknown): boolean {
  if (!isObject(raw)) {
    return false;
  }

  if (isObject(raw.mapping)) {
    return true;
  }

  return false;
}

export function isLikelyChatGptExport(raw: unknown): boolean {
  const conversations = readConversationList(raw);
  if (conversations.length === 0) {
    return false;
  }

  const sample = conversations.slice(0, 5);
  return sample.some((conversation) => looksLikeChatGptConversation(conversation));
}


export function parseChatGptConversations(raw: unknown): ImportedConversation[] {
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
