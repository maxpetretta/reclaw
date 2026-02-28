import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ExtractedSession {
  at: string;
  entries: number;
}

export interface FailedSession {
  at: string;
  error: string;
  retries: number;
}

export interface ImportedConversationState {
  at: string;
  updatedAt: string;
  sessionId: string;
  entries: number;
  title?: string;
}

export interface ZettelclawState {
  extractedSessions: Record<string, ExtractedSession>;
  failedSessions: Record<string, FailedSession>;
  importedConversations: Record<string, ImportedConversationState>;
}

function createEmptyState(): ZettelclawState {
  return {
    extractedSessions: {},
    failedSessions: {},
    importedConversations: {},
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

const IMPORTED_PLATFORM_SET = new Set(["chatgpt", "claude", "grok"]);

function parseConversationKey(value: string): { platform: string; conversationId: string } | null {
  const delimiterIndex = value.indexOf(":");
  if (delimiterIndex <= 0 || delimiterIndex >= value.length - 1) {
    return null;
  }

  return {
    platform: value.slice(0, delimiterIndex),
    conversationId: value.slice(delimiterIndex + 1),
  };
}

function hasValidImportedSessionId(conversationKey: string, sessionId: string): boolean {
  const parsedKey = parseConversationKey(conversationKey);
  if (!parsedKey || !IMPORTED_PLATFORM_SET.has(parsedKey.platform)) {
    return false;
  }

  return sessionId === `reclaw:${parsedKey.platform}:${parsedKey.conversationId}`;
}

function normalizeState(raw: unknown): ZettelclawState {
  if (!isObject(raw)) {
    return createEmptyState();
  }

  const extractedSessions: Record<string, ExtractedSession> = {};
  const failedSessions: Record<string, FailedSession> = {};
  const importedConversations: Record<string, ImportedConversationState> = {};

  const extractedRaw = isObject(raw.extractedSessions) ? raw.extractedSessions : {};
  const failedRaw = isObject(raw.failedSessions) ? raw.failedSessions : {};
  const importedRaw = isObject(raw.importedConversations) ? raw.importedConversations : {};

  for (const [sessionId, sessionValue] of Object.entries(extractedRaw)) {
    if (!isObject(sessionValue)) {
      continue;
    }

    if (
      typeof sessionValue.at !== "string" ||
      !Number.isFinite(Date.parse(sessionValue.at)) ||
      typeof sessionValue.entries !== "number"
    ) {
      continue;
    }

    extractedSessions[sessionId] = {
      at: sessionValue.at,
      entries: sessionValue.entries,
    };
  }

  for (const [sessionId, sessionValue] of Object.entries(failedRaw)) {
    if (!isObject(sessionValue)) {
      continue;
    }

    if (
      typeof sessionValue.at !== "string" ||
      !Number.isFinite(Date.parse(sessionValue.at)) ||
      typeof sessionValue.error !== "string" ||
      typeof sessionValue.retries !== "number"
    ) {
      continue;
    }

    failedSessions[sessionId] = {
      at: sessionValue.at,
      error: sessionValue.error,
      retries: sessionValue.retries,
    };
  }

  for (const [conversationKey, conversationValue] of Object.entries(importedRaw)) {
    if (!isObject(conversationValue)) {
      continue;
    }

    const sessionId =
      typeof conversationValue.sessionId === "string" ? conversationValue.sessionId.trim() : "";

    if (
      typeof conversationValue.at !== "string" ||
      !Number.isFinite(Date.parse(conversationValue.at)) ||
      typeof conversationValue.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(conversationValue.updatedAt)) ||
      sessionId.length === 0 ||
      !hasValidImportedSessionId(conversationKey, sessionId) ||
      typeof conversationValue.entries !== "number"
    ) {
      continue;
    }

    importedConversations[conversationKey] = {
      at: conversationValue.at,
      updatedAt: conversationValue.updatedAt,
      sessionId,
      entries: conversationValue.entries,
      ...(typeof conversationValue.title === "string" && conversationValue.title.trim().length > 0
        ? { title: conversationValue.title }
        : {}),
    };
  }

  return {
    extractedSessions,
    failedSessions,
    importedConversations,
  };
}

export async function readState(path: string): Promise<ZettelclawState> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return createEmptyState();
    }

    throw error;
  }

  return normalizeState(JSON.parse(raw));
}

export async function writeState(path: string, state: ZettelclawState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function markExtracted(
  path: string,
  sessionId: string,
  entryCount: number,
): Promise<void> {
  const state = await readState(path);

  state.extractedSessions[sessionId] = {
    at: new Date().toISOString(),
    entries: entryCount,
  };

  delete state.failedSessions[sessionId];
  await writeState(path, state);
}

export async function markFailed(path: string, sessionId: string, error: string): Promise<void> {
  const state = await readState(path);
  const previous = state.failedSessions[sessionId];

  state.failedSessions[sessionId] = {
    at: new Date().toISOString(),
    error,
    retries: (previous?.retries ?? 0) + 1,
  };

  await writeState(path, state);
}

export function isExtracted(state: ZettelclawState, sessionId: string): boolean {
  return Boolean(state.extractedSessions[sessionId]);
}

export function isImportedConversation(state: ZettelclawState, conversationKey: string): boolean {
  return Boolean(state.importedConversations[conversationKey]);
}

export function shouldRetry(state: ZettelclawState, sessionId: string): boolean {
  return (state.failedSessions[sessionId]?.retries ?? 0) < 2;
}

export async function pruneState(path: string, maxAgeDays = 30): Promise<void> {
  const state = await readState(path);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const [sessionId, extracted] of Object.entries(state.extractedSessions)) {
    if (!Number.isFinite(Date.parse(extracted.at)) || Date.parse(extracted.at) < cutoff) {
      delete state.extractedSessions[sessionId];
    }
  }

  for (const [sessionId, failed] of Object.entries(state.failedSessions)) {
    if (!Number.isFinite(Date.parse(failed.at)) || Date.parse(failed.at) < cutoff) {
      delete state.failedSessions[sessionId];
    }
  }

  await writeState(path, state);
}
