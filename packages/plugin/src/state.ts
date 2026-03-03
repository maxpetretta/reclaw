import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isEnoent } from "./lib/guards";
import { normalizeState } from "./state-normalize";

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

export interface EventUsageState {
  memoryGetCount: number;
  memorySearchCount: number;
  citationCount: number;
  lastAccessAt: string;
}

export type EventUsageKind = "memory_get" | "memory_search" | "citation";

export type ImportJobStatus = "queued" | "running" | "completed" | "failed";

export interface ImportJobOptionsState {
  after?: string;
  before?: string;
  minMessages?: number;
  jobs?: number;
  model?: string;
  force?: boolean;
  transcripts?: boolean;
  verbose?: boolean;
  keepSource?: boolean;
  backupMemoryDocs?: boolean;
}

export interface ImportJobSummaryState {
  platform: "chatgpt" | "claude" | "grok" | "openclaw";
  parsed: number;
  dedupedInInput: number;
  selected: number;
  skippedByDate: number;
  skippedByMinMessages: number;
  skippedAlreadyImported: number;
  imported: number;
  failed: number;
  entriesWritten: number;
  subjectsCreated: number;
  transcriptsWritten: number;
  dryRun: boolean;
}

export interface ImportJobProgressState {
  total: number;
  completed: number;
  imported: number;
  failed: number;
  entriesWritten: number;
  subjectsCreated: number;
}

export interface ImportJobState {
  id: string;
  status: ImportJobStatus;
  platform: "chatgpt" | "claude" | "grok" | "openclaw";
  filePath: string;
  options: ImportJobOptionsState;
  createdAt: string;
  updatedAt: string;
  queuedAt: string;
  attempts: number;
  workspaceDir?: string;
  startedAt?: string;
  finishedAt?: string;
  stopRequestedAt?: string;
  error?: string;
  summary?: ImportJobSummaryState;
  progress?: ImportJobProgressState;
  cronJobId?: string;
  cronJobName?: string;
}

export type CompactionExtractionStatus = "observed" | "extracted" | "failed" | "skipped";

export interface CompactionSessionState {
  at: string;
  messageCount: number;
  compactedCount: number;
  tokenCount?: number;
  sessionFile?: string;
  status: CompactionExtractionStatus;
  reason?: string;
  error?: string;
  extractedAt?: string;
  entries?: number;
}

export type SnapshotRunStatus = "success" | "failed";

export interface SnapshotRunState {
  at: string;
  status: SnapshotRunStatus;
  memoryMdPath: string;
  error?: string;
}

export interface ReclawState {
  extractedSessions: Record<string, ExtractedSession>;
  failedSessions: Record<string, FailedSession>;
  importedConversations: Record<string, ImportedConversationState>;
  eventUsage: Record<string, EventUsageState>;
  importJobs: Record<string, ImportJobState>;
  compactionSessions: Record<string, CompactionSessionState>;
  snapshotRuns: SnapshotRunState[];
}

export function createEmptyState(): ReclawState {
  return {
    extractedSessions: {},
    failedSessions: {},
    importedConversations: {},
    eventUsage: {},
    importJobs: {},
    compactionSessions: {},
    snapshotRuns: [],
  };
}

export async function readState(path: string): Promise<ReclawState> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return createEmptyState();
    }

    throw error;
  }

  return normalizeState(JSON.parse(raw), createEmptyState);
}

export async function writeState(path: string, state: ReclawState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function updateState(
  path: string,
  mutator: (state: ReclawState) => void | Promise<void>,
): Promise<ReclawState> {
  const state = await readState(path);
  await mutator(state);
  await writeState(path, state);
  return state;
}

export async function markExtracted(
  path: string,
  sessionId: string,
  entryCount: number,
): Promise<void> {
  await updateState(path, (state) => {
    state.extractedSessions[sessionId] = {
      at: new Date().toISOString(),
      entries: entryCount,
    };
    delete state.failedSessions[sessionId];
  });
}

export async function markFailed(path: string, sessionId: string, error: string): Promise<void> {
  await updateState(path, (state) => {
    const previous = state.failedSessions[sessionId];
    state.failedSessions[sessionId] = {
      at: new Date().toISOString(),
      error,
      retries: (previous?.retries ?? 0) + 1,
    };
  });
}

const MAX_SNAPSHOT_RUNS = 50;

export async function appendSnapshotRun(
  path: string,
  run: {
    status: SnapshotRunStatus;
    memoryMdPath: string;
    error?: string;
  },
): Promise<void> {
  await updateState(path, (state) => {
    const nextRun: SnapshotRunState = {
      at: new Date().toISOString(),
      status: run.status,
      memoryMdPath: run.memoryMdPath,
      ...(run.error ? { error: run.error } : {}),
    };

    state.snapshotRuns = [nextRun, ...state.snapshotRuns].slice(0, MAX_SNAPSHOT_RUNS);
  });
}

export async function markCompactionObserved(
  path: string,
  sessionId: string,
  event: {
    messageCount: number;
    compactedCount: number;
    tokenCount?: number;
    sessionFile?: string;
  },
): Promise<void> {
  await updateState(path, (state) => {
    state.compactionSessions[sessionId] = {
      at: new Date().toISOString(),
      messageCount: event.messageCount,
      compactedCount: event.compactedCount,
      ...(typeof event.tokenCount === "number" && Number.isFinite(event.tokenCount)
        ? { tokenCount: event.tokenCount }
        : {}),
      ...(typeof event.sessionFile === "string" && event.sessionFile.trim().length > 0
        ? { sessionFile: event.sessionFile.trim() }
        : {}),
      status: "observed",
    };
  });
}

export async function markCompactionStatus(
  path: string,
  sessionId: string,
  status: CompactionExtractionStatus,
  details: {
    reason?: string;
    error?: string;
    entries?: number;
  } = {},
): Promise<void> {
  await updateState(path, (state) => {
    const existing = state.compactionSessions[sessionId];
    if (!existing) {
      return;
    }

    state.compactionSessions[sessionId] = {
      ...existing,
      status,
      ...(details.reason ? { reason: details.reason } : {}),
      ...(details.error ? { error: details.error } : {}),
      ...(typeof details.entries === "number" && Number.isFinite(details.entries)
        ? { entries: Math.max(0, Math.floor(details.entries)) }
        : {}),
      ...(status === "extracted" ? { extractedAt: new Date().toISOString() } : {}),
    };
  });
}

export function isExtracted(state: ReclawState, sessionId: string): boolean {
  return Boolean(state.extractedSessions[sessionId]);
}

export function isImportedConversation(state: ReclawState, conversationKey: string): boolean {
  return Boolean(state.importedConversations[conversationKey]);
}

export function shouldRetry(state: ReclawState, sessionId: string): boolean {
  return (state.failedSessions[sessionId]?.retries ?? 0) < 2;
}

export async function incrementEventUsage(
  path: string,
  eventIds: string[],
  kind: EventUsageKind,
): Promise<void> {
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return;
  }

  const normalizedIds = [...new Set(
    eventIds
      .map((eventId) => eventId.trim())
      .filter((eventId) => eventId.length > 0),
  )];
  if (normalizedIds.length === 0) {
    return;
  }

  await updateState(path, (state) => {
    const now = new Date().toISOString();

    for (const eventId of normalizedIds) {
      const existing = state.eventUsage[eventId] ?? {
        memoryGetCount: 0,
        memorySearchCount: 0,
        citationCount: 0,
        lastAccessAt: now,
      };

      if (kind === "memory_get") {
        existing.memoryGetCount += 1;
      } else if (kind === "memory_search") {
        existing.memorySearchCount += 1;
      } else {
        existing.citationCount += 1;
      }

      existing.lastAccessAt = now;
      state.eventUsage[eventId] = existing;
    }
  });
}

export async function pruneState(path: string, maxAgeDays = 30): Promise<void> {
  await updateState(path, (state) => {
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

    for (const [sessionId, compaction] of Object.entries(state.compactionSessions)) {
      if (!Number.isFinite(Date.parse(compaction.at)) || Date.parse(compaction.at) < cutoff) {
        delete state.compactionSessions[sessionId];
      }
    }

    state.snapshotRuns = state.snapshotRuns.filter((run) =>
      Number.isFinite(Date.parse(run.at)) && Date.parse(run.at) >= cutoff,
    );
  });
}
