import { isObject } from "../../lib/guards";
import type { ImportedConversation, ImportedRole } from "../types";

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const magnitude = Math.abs(value);

    // Treat >=11-digit unix values as milliseconds and >=10-digit values as seconds.
    if (magnitude >= 1e11) {
      return Math.floor(value);
    }

    if (magnitude >= 1e9) {
      return Math.floor(value * 1000);
    }
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return parseTimestampMs(numeric);
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

export function toIso(value: unknown, fallbackMs: number): string {
  return new Date(parseTimestampMs(value) ?? fallbackMs).toISOString();
}

export function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value.replaceAll(/\s+/gu, " ").trim();
  }

  if (Array.isArray(value)) {
    const parts = value.map((part) => extractText(part)).filter((part) => part.length > 0);
    return parts.join("\n").trim();
  }

  if (!isObject(value)) {
    return "";
  }

  if (Array.isArray(value.parts)) {
    const parts = value.parts
      .map((part) => extractText(part))
      .filter((part: string) => part.length > 0);
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }

  if (Array.isArray(value.content)) {
    const parts = value.content
      .map((part) => extractText(part))
      .filter((part: string) => part.length > 0);
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }

  if (typeof value.text === "string") {
    return value.text.replaceAll(/\s+/gu, " ").trim();
  }

  if (typeof value.input_text === "string") {
    return value.input_text.replaceAll(/\s+/gu, " ").trim();
  }

  if (typeof value.result === "string") {
    return value.result.replaceAll(/\s+/gu, " ").trim();
  }

  if (typeof value.value === "string") {
    return value.value.replaceAll(/\s+/gu, " ").trim();
  }

  return "";
}

export function readConversationList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (!isObject(raw)) {
    return [];
  }

  if (Array.isArray(raw.conversations)) {
    return raw.conversations;
  }

  if (Array.isArray(raw.data)) {
    return raw.data;
  }

  return [];
}

export function normalizeRole(
  value: unknown,
  platformRoles: Record<string, ImportedRole>,
): ImportedRole | null {
  if (typeof value !== "string") {
    return null;
  }

  const role = value.trim().toLowerCase();
  if (role in platformRoles) {
    return platformRoles[role];
  }

  return null;
}

export function isLikelyExport(
  raw: unknown,
  looksLike: (value: unknown) => boolean,
): boolean {
  const conversations = readConversationList(raw);
  if (conversations.length === 0) {
    return false;
  }

  return conversations.slice(0, 5).some(looksLike);
}

export function parseConversations(
  raw: unknown,
  parse: (value: unknown, index: number) => ImportedConversation | null,
): ImportedConversation[] {
  const conversations: ImportedConversation[] = [];

  for (const [index, conversationRaw] of readConversationList(raw).entries()) {
    const parsed = parse(conversationRaw, index);
    if (parsed) {
      conversations.push(parsed);
    }
  }

  return conversations;
}
