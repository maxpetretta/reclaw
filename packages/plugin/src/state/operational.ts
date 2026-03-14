import { updateState } from "./store";
import type {
  CompactionExtractionStatus,
  SessionSummaryRewriteStatus,
  SnapshotRunStatus,
} from "./types";
import { assignDefined } from "../lib/optional-fields";

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
    const nextRun: {
      at: string;
      status: SnapshotRunStatus;
      memoryMdPath: string;
      error?: string;
      workerSessionId?: string;
      workerSessionKey?: string;
    } = {
      at: new Date().toISOString(),
      status: run.status,
      memoryMdPath: run.memoryMdPath,
    };
    assignDefined(nextRun, "error", run.error);
    assignDefined(nextRun, "workerSessionId", run.workerSessionId);
    assignDefined(nextRun, "workerSessionKey", run.workerSessionKey);

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

export async function startSessionSummaryRewrite(
  path: string,
  params: {
    mode: "projected";
    total: number;
    cleared: number;
    processed?: number;
    written?: number;
    clearApplied?: boolean;
    completedSessionIds?: string[];
    writtenSessionIds?: string[];
    startedAt?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await updateState(path, (state) => {
    state.sessionSummaryRewrite = {
      status: "running",
      mode: params.mode,
      startedAt: params.startedAt ?? now,
      updatedAt: now,
      total: Math.max(0, Math.floor(params.total)),
      processed:
        typeof params.processed === "number" && Number.isFinite(params.processed)
          ? Math.max(0, Math.floor(params.processed))
          : 0,
      written:
        typeof params.written === "number" && Number.isFinite(params.written)
          ? Math.max(0, Math.floor(params.written))
          : 0,
      cleared: Math.max(0, Math.floor(params.cleared)),
      clearApplied: params.clearApplied === true,
      completedSessionIds:
        Array.isArray(params.completedSessionIds)
          ? [...new Set(
              params.completedSessionIds
                .filter((value): value is string => typeof value === "string")
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            )]
          : [],
      writtenSessionIds:
        Array.isArray(params.writtenSessionIds)
          ? [...new Set(
              params.writtenSessionIds
                .filter((value): value is string => typeof value === "string")
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            )]
          : [],
    };
  });
}

export async function updateSessionSummaryRewriteProgress(
  path: string,
  params: {
    processed: number;
    written: number;
    total?: number;
    cleared?: number;
    clearApplied?: boolean;
    currentSessionId?: string;
    completedSessionId?: string;
    wroteSessionId?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await updateState(path, (state) => {
    const existing = state.sessionSummaryRewrite;
    if (!existing) {
      return;
    }

    const next = {
      ...existing,
      updatedAt: now,
      processed: Math.max(0, Math.floor(params.processed)),
      written: Math.max(0, Math.floor(params.written)),
      total:
        typeof params.total === "number" && Number.isFinite(params.total)
          ? Math.max(0, Math.floor(params.total))
          : existing.total,
      cleared:
        typeof params.cleared === "number" && Number.isFinite(params.cleared)
          ? Math.max(0, Math.floor(params.cleared))
          : existing.cleared,
      clearApplied: params.clearApplied === true || existing.clearApplied === true,
    };

    if (typeof params.currentSessionId === "string" && params.currentSessionId.trim().length > 0) {
      next.currentSessionId = params.currentSessionId.trim();
    } else {
      delete next.currentSessionId;
    }

    if (typeof params.completedSessionId === "string" && params.completedSessionId.trim().length > 0) {
      next.completedSessionIds = [
        ...new Set([
          ...existing.completedSessionIds,
          params.completedSessionId.trim(),
        ]),
      ];
    }

    if (typeof params.wroteSessionId === "string" && params.wroteSessionId.trim().length > 0) {
      next.writtenSessionIds = [
        ...new Set([
          ...existing.writtenSessionIds,
          params.wroteSessionId.trim(),
        ]),
      ];
    }

    state.sessionSummaryRewrite = next;
  });
}

export async function finishSessionSummaryRewrite(
  path: string,
  params: {
    status: SessionSummaryRewriteStatus;
    total: number;
    processed: number;
    written: number;
    cleared: number;
    error?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await updateState(path, (state) => {
    const existing = state.sessionSummaryRewrite;
    const next = {
      status: params.status,
      mode: existing?.mode ?? "projected",
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      finishedAt: now,
      total: Math.max(0, Math.floor(params.total)),
      processed: Math.max(0, Math.floor(params.processed)),
      written: Math.max(0, Math.floor(params.written)),
      cleared: Math.max(0, Math.floor(params.cleared)),
      clearApplied: existing?.clearApplied === true,
      completedSessionIds: [...(existing?.completedSessionIds ?? [])],
      writtenSessionIds: [...(existing?.writtenSessionIds ?? [])],
    };

    assignDefined(next, "error", params.error);
    state.sessionSummaryRewrite = next;
  });
}
