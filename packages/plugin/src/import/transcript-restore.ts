import { readFile } from "node:fs/promises";
import { parseChatGptConversations } from "./adapters/chatgpt";
import { parseClaudeConversations } from "./adapters/claude";
import { parseGrokConversations } from "./adapters/grok";
import { DEFAULT_IMPORT_MIN_MESSAGES, buildSessionId } from "./run";
import { writeImportedSession } from "./sessions";
import type { ImportPlatform, ImportedConversation } from "./types";

export type TranscriptRestorePlatform = Exclude<ImportPlatform, "openclaw">;

export interface RestoreImportedTranscriptsOptions {
  platform: TranscriptRestorePlatform;
  filePath: string;
  dryRun?: boolean;
  after?: string;
  before?: string;
  minMessages?: number;
  openClawHome?: string;
  agentId?: string;
}

export interface RestoreImportedTranscriptsSummary {
  platform: TranscriptRestorePlatform;
  parsed: number;
  dedupedInInput: number;
  selected: number;
  skippedByDate: number;
  skippedByMinMessages: number;
  restored: number;
  dryRun: boolean;
}

export interface RestoreImportedTranscriptsResult {
  summary: RestoreImportedTranscriptsSummary;
  restoredSessions: Array<{ agentId: string; sessionId: string }>;
}

function parseBoundary(raw: string | undefined, optionName: "--after" | "--before"): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${optionName} value: ${raw}`);
  }

  return parsed;
}

function countExtractableMessages(conversation: ImportedConversation): number {
  return conversation.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  ).length;
}

function choosePreferredConversation(current: ImportedConversation, incoming: ImportedConversation): ImportedConversation {
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const incomingUpdatedAt = Date.parse(incoming.updatedAt);

  if (Number.isFinite(incomingUpdatedAt) && Number.isFinite(currentUpdatedAt)) {
    if (incomingUpdatedAt > currentUpdatedAt) {
      return incoming;
    }

    if (incomingUpdatedAt < currentUpdatedAt) {
      return current;
    }
  }

  if (countExtractableMessages(incoming) > countExtractableMessages(current)) {
    return incoming;
  }

  return current;
}

function dedupeInputConversations(
  platform: TranscriptRestorePlatform,
  conversations: ImportedConversation[],
): { conversations: ImportedConversation[]; duplicates: number } {
  const byKey = new Map<string, ImportedConversation>();
  let duplicates = 0;

  for (const conversation of conversations) {
    const key = `${platform}:${conversation.conversationId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, conversation);
      continue;
    }

    duplicates += 1;
    byKey.set(key, choosePreferredConversation(existing, conversation));
  }

  return {
    conversations: [...byKey.values()],
    duplicates,
  };
}

function parseConversations(platform: TranscriptRestorePlatform, raw: unknown): ImportedConversation[] {
  if (platform === "chatgpt") {
    return parseChatGptConversations(raw);
  }

  if (platform === "claude") {
    return parseClaudeConversations(raw);
  }

  return parseGrokConversations(raw);
}

async function readImportJson(filePath: string): Promise<unknown> {
  const rawText = await readFile(filePath, "utf8");
  try {
    return JSON.parse(rawText) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse import JSON: ${reason}`);
  }
}

export async function restoreImportedTranscripts(
  options: RestoreImportedTranscriptsOptions,
): Promise<RestoreImportedTranscriptsResult> {
  const rawImport = await readImportJson(options.filePath);
  const parsedRaw = parseConversations(options.platform, rawImport);
  const deduped = dedupeInputConversations(options.platform, parsedRaw);
  const afterMs = parseBoundary(options.after, "--after");
  const beforeMs = parseBoundary(options.before, "--before");
  const minMessages = Math.max(1, Math.floor(options.minMessages ?? DEFAULT_IMPORT_MIN_MESSAGES));
  const dryRun = options.dryRun === true;
  const agentId = options.agentId?.trim() || "main";

  const summary: RestoreImportedTranscriptsSummary = {
    platform: options.platform,
    parsed: parsedRaw.length,
    dedupedInInput: deduped.duplicates,
    selected: 0,
    skippedByDate: 0,
    skippedByMinMessages: 0,
    restored: 0,
    dryRun,
  };

  const selected: ImportedConversation[] = [];
  for (const conversation of deduped.conversations) {
    const updatedAtMs = Date.parse(conversation.updatedAt);

    if (afterMs !== undefined && Number.isFinite(updatedAtMs) && updatedAtMs < afterMs) {
      summary.skippedByDate += 1;
      continue;
    }

    if (beforeMs !== undefined && Number.isFinite(updatedAtMs) && updatedAtMs > beforeMs) {
      summary.skippedByDate += 1;
      continue;
    }

    if (countExtractableMessages(conversation) < minMessages) {
      summary.skippedByMinMessages += 1;
      continue;
    }

    selected.push(conversation);
  }

  summary.selected = selected.length;
  const restoredSessions: Array<{ agentId: string; sessionId: string }> = [];

  if (dryRun) {
    return {
      summary,
      restoredSessions,
    };
  }

  for (const conversation of selected) {
    const sessionId = buildSessionId(options.platform, conversation.conversationId);
    await writeImportedSession({
      conversation,
      sessionId,
      openClawHome: options.openClawHome,
      agentId,
    });
    restoredSessions.push({ agentId, sessionId });
    summary.restored += 1;
  }

  return {
    summary,
    restoredSessions,
  };
}
