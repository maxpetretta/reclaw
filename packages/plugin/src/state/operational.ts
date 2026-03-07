import { updateState } from "./store";
import type { CompactionExtractionStatus, SnapshotRunStatus } from "./types";

const MAX_SNAPSHOT_RUNS = 50;

export async function appendSnapshotRun(
  path: string,
  run: {
    status: SnapshotRunStatus;
    memoryMdPath: string;
    error?: string;
    workerSessionId?: string;
    workerSessionKey?: string;
  },
): Promise<void> {
  await updateState(path, (state) => {
    const nextRun = {
      at: new Date().toISOString(),
      status: run.status,
      memoryMdPath: run.memoryMdPath,
      ...(run.error ? { error: run.error } : {}),
      ...(run.workerSessionId ? { workerSessionId: run.workerSessionId } : {}),
      ...(run.workerSessionKey ? { workerSessionKey: run.workerSessionKey } : {}),
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
