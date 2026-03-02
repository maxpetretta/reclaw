import type { ImportedConversation } from "./types";

interface ImportTimestampHint {
  iso: string;
  dateOnly?: string;
}

function parseImportTimestampHint(raw: unknown): ImportTimestampHint | undefined {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  if (!candidate) {
    return undefined;
  }

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(candidate);
  if (dateOnlyMatch) {
    const dateOnly = `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}`;
    const noonIso = `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}T12:00:00.000Z`;
    if (!Number.isFinite(Date.parse(noonIso))) {
      return undefined;
    }

    return {
      iso: noonIso,
      dateOnly,
    };
  }

  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return {
    iso: new Date(parsed).toISOString(),
  };
}

function resolveDateOnlyTimestampHint(
  dateOnly: string,
  conversation: ImportedConversation,
): string | undefined {
  const targetNoon = Date.parse(`${dateOnly}T12:00:00.000Z`);
  if (!Number.isFinite(targetNoon)) {
    return undefined;
  }

  let bestIso: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const message of conversation.messages) {
    if (typeof message.createdAt !== "string" || !message.createdAt.startsWith(`${dateOnly}T`)) {
      continue;
    }

    const parsed = Date.parse(message.createdAt);
    if (!Number.isFinite(parsed)) {
      continue;
    }

    const iso = new Date(parsed).toISOString();
    const distance = Math.abs(parsed - targetNoon);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIso = iso;
    }
  }

  return bestIso;
}

function resolveEntryTimestampHint(
  hint: ImportTimestampHint | undefined,
  conversation: ImportedConversation,
  fallback: string,
): string {
  if (!hint) {
    return fallback;
  }

  if (!hint.dateOnly) {
    return hint.iso;
  }

  return resolveDateOnlyTimestampHint(hint.dateOnly, conversation) ?? hint.iso;
}

export function resolveHistoricalTimestamp(conversation: ImportedConversation): string {
  const parsed = Date.parse(conversation.updatedAt);
  if (!Number.isFinite(parsed)) {
    throw new Error(`conversation ${conversation.conversationId} is missing a valid updatedAt timestamp`);
  }

  return new Date(parsed).toISOString();
}

export function resolveImportedEntryTimestamp(
  timestampHintRaw: unknown,
  conversation: ImportedConversation,
  fallback: string,
): string {
  const hint = parseImportTimestampHint(timestampHintRaw);
  return resolveEntryTimestampHint(hint, conversation, fallback);
}
