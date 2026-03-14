import { readFile, writeFile } from "node:fs/promises";
import { isEnoent } from "../lib/guards";
import { appendEntry, finalizeEntry, readLog } from "../log/schema";
import { listSessionCandidates } from "../hooks/session-discovery";
import { refreshSessionSummaryProjections } from "../projections/session-summaries";
import {
  shouldProjectTranscriptTarget,
  type TranscriptProjectionTarget,
} from "../projections/transcripts";
import { resolveOpenClawHome } from "../lib/runtime-env";
import { findTranscriptFileForHome, readTranscript } from "../lib/transcript";
import { generateSessionSummary } from "./generate";

export interface SessionSummaryBackfillTarget extends TranscriptProjectionTarget {}
interface PreparedSessionSummaryTarget extends SessionSummaryBackfillTarget {
  transcriptFile: string;
}

export type SessionSummaryBackfillMode = "imported" | "projected";

export interface SessionSummaryBackfillProgress {
  total: number;
  processed: number;
  written: number;
  existing: number;
  skippedNoTranscript: number;
  skippedNoConversation: number;
  skippedFallback: number;
  cleared: number;
  currentSessionId?: string;
  completedSessionId?: string;
  wroteSessionId?: string;
}

export interface SessionSummaryBackfillResult extends SessionSummaryBackfillProgress {
  scanned: number;
}

interface SessionSummaryBackfillDeps {
  generateSessionSummary: typeof generateSessionSummary;
}

const DEFAULT_DEPS: SessionSummaryBackfillDeps = {
  generateSessionSummary,
};

const DEFAULT_SESSION_SUMMARY_CONCURRENCY = 1;

function isImportedSessionTarget(target: SessionSummaryBackfillTarget): boolean {
  if (/^reclaw:(chatgpt|claude|grok):/u.test(target.sessionId)) {
    return true;
  }

  if (!target.sessionKey) {
    return false;
  }

  return /^agent:[^:]+:reclaw:(chatgpt|claude|grok):/u.test(target.sessionKey);
}

function resolveSummaryTimestamp(messages: Awaited<ReturnType<typeof readTranscript>>): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const timestamp = messages[index]?.timestamp;
    if (typeof timestamp !== "string" || timestamp.trim().length === 0) {
      continue;
    }

    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) {
      continue;
    }

    return new Date(parsed).toISOString();
  }

  return undefined;
}

function createEmptyProgress(total: number, cleared = 0): SessionSummaryBackfillResult {
  return {
    scanned: 0,
    total,
    processed: 0,
    written: 0,
    existing: 0,
    skippedNoTranscript: 0,
    skippedNoConversation: 0,
    skippedFallback: 0,
    cleared,
  };
}

function createResumedProgress(
  total: number,
  seed: {
    processed?: number;
    written?: number;
    cleared?: number;
    scanned?: number;
    existing?: number;
    skippedNoTranscript?: number;
    skippedNoConversation?: number;
  },
): SessionSummaryBackfillResult {
  const result = createEmptyProgress(total, seed.cleared);
  result.processed = Math.max(0, Math.min(total, Math.floor(seed.processed ?? 0)));
  result.written = Math.max(0, Math.min(total, Math.floor(seed.written ?? 0)));
  result.scanned = Math.max(total, Math.floor(seed.scanned ?? total));
  result.existing = Math.max(0, Math.floor(seed.existing ?? 0));
  result.skippedNoTranscript = Math.max(0, Math.floor(seed.skippedNoTranscript ?? 0));
  result.skippedNoConversation = Math.max(0, Math.floor(seed.skippedNoConversation ?? 0));
  return result;
}

function normalizeSessionSummaryConcurrency(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_SESSION_SUMMARY_CONCURRENCY;
  }

  const normalized = Math.floor(raw);
  return normalized >= 1 ? normalized : DEFAULT_SESSION_SUMMARY_CONCURRENCY;
}

async function emitProgress(
  callback: ((progress: SessionSummaryBackfillProgress) => void | Promise<void>) | undefined,
  progress: SessionSummaryBackfillProgress,
): Promise<void> {
  if (!callback) {
    return;
  }

  await callback(progress);
}

async function purgeSessionSummaryEntries(logPath: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return 0;
    }

    throw error;
  }

  const keptLines: string[] = [];
  let cleared = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      keptLines.push(trimmed);
      continue;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      (parsed as { type?: unknown }).type === "session_summary"
    ) {
      cleared += 1;
      continue;
    }

    keptLines.push(trimmed);
  }

  await writeFile(logPath, keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "", "utf8");
  return cleared;
}

async function listSummaryTargets(params: {
  openClawHome: string;
  mode: SessionSummaryBackfillMode;
  sessions?: SessionSummaryBackfillTarget[];
}): Promise<SessionSummaryBackfillTarget[]> {
  const rawTargets =
    Array.isArray(params.sessions) && params.sessions.length > 0
      ? params.sessions
      : (await listSessionCandidates(params.openClawHome)).map((candidate) => ({
          agentId: candidate.agentId,
          sessionId: candidate.sessionId,
          sessionKey: candidate.sessionKey,
          label: candidate.label,
          provider: candidate.provider,
          surface: candidate.surface,
          chatType: candidate.chatType,
        }));

  const filteredTargets =
    params.mode === "imported" ? rawTargets.filter(isImportedSessionTarget) : rawTargets.filter((target) => !isImportedSessionTarget(target));

  return [...new Map(
    filteredTargets
      .filter((target) => target.agentId.trim().length > 0 && target.sessionId.trim().length > 0)
      .map((target) => [`${target.agentId}\u0000${target.sessionId}`, target]),
  ).values()].sort((left, right) => {
    const agentOrder = left.agentId.localeCompare(right.agentId);
    if (agentOrder !== 0) {
      return agentOrder;
    }

    return left.sessionId.localeCompare(right.sessionId);
  });
}

function buildExistingSummaryMap(entries: Awaited<ReturnType<typeof readLog>>): Map<string, (typeof entries)[number]> {
  return new Map(
    entries
      .filter((entry) => entry.type === "session_summary")
      .sort((left, right) => {
        const leftTime = Date.parse(left.timestamp);
        const rightTime = Date.parse(right.timestamp);
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return leftTime - rightTime;
        }

        return left.id.localeCompare(right.id);
      })
      .map((entry) => [entry.session, entry] as const),
  );
}

async function prepareEligibleTargets(params: {
  openClawHome: string;
  mode: SessionSummaryBackfillMode;
  targets: SessionSummaryBackfillTarget[];
}): Promise<{
  eligibleTargets: PreparedSessionSummaryTarget[];
  scanned: number;
  skippedNoTranscript: number;
  skippedNoConversation: number;
}> {
  const eligibleTargets: PreparedSessionSummaryTarget[] = [];
  let skippedNoTranscript = 0;
  let skippedNoConversation = 0;

  for (const target of params.targets) {
    const transcriptFile =
      target.transcriptFile ?? await findTranscriptFileForHome(params.openClawHome, target.agentId, target.sessionId);
    if (!transcriptFile) {
      skippedNoTranscript += 1;
      continue;
    }

    const messages = await readTranscript(transcriptFile);
    const shouldWrite =
      params.mode === "projected"
        ? shouldProjectTranscriptTarget(
            {
              ...target,
              transcriptFile,
            },
            messages,
          )
        : isImportedSessionTarget(target) && shouldProjectTranscriptTarget(
            {
              ...target,
              transcriptFile,
            },
            messages,
          );

    if (!shouldWrite) {
      skippedNoConversation += 1;
      continue;
    }

    eligibleTargets.push({
      ...target,
      transcriptFile,
    });
  }

  return {
    eligibleTargets,
    scanned: params.targets.length,
    skippedNoTranscript,
    skippedNoConversation,
  };
}

export async function backfillSessionSummaries(
  params: {
    logPath: string;
    projectionDir: string;
    model: string;
    openClawHome?: string;
    sessions?: SessionSummaryBackfillTarget[];
    mode?: SessionSummaryBackfillMode;
    force?: boolean;
    clearExisting?: boolean;
    concurrency?: number;
    resume?: {
      processed?: number;
      written?: number;
      cleared?: number;
      clearApplied?: boolean;
      completedSessionIds?: string[];
      writtenSessionIds?: string[];
      skipFirstProcessedCount?: number;
    };
    onProgress?: (progress: SessionSummaryBackfillProgress) => void | Promise<void>;
  },
  deps: Partial<SessionSummaryBackfillDeps> = {},
): Promise<SessionSummaryBackfillResult> {
  const runtimeDeps: SessionSummaryBackfillDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };
  const openClawHome = resolveOpenClawHome(params.openClawHome);
  const mode = params.mode ?? "imported";
  const targets = await listSummaryTargets({
    openClawHome,
    mode,
    sessions: params.sessions,
  });
  const prepared = await prepareEligibleTargets({
    openClawHome,
    mode,
    targets,
  });
  const eligibleTargets = prepared.eligibleTargets;
  const resumeCompletedIds = new Set(
    (params.resume?.completedSessionIds ?? [])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  const resumeWrittenIds = new Set(
    (params.resume?.writtenSessionIds ?? [])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  let cleared = 0;
  const shouldClearExisting = params.clearExisting === true && params.resume?.clearApplied !== true;
  if (shouldClearExisting) {
    cleared = await purgeSessionSummaryEntries(params.logPath);
    await refreshSessionSummaryProjections({
      projectionDir: params.projectionDir,
      logPath: params.logPath,
    });
  } else if (params.resume?.clearApplied === true) {
    cleared = Math.max(0, Math.floor(params.resume?.cleared ?? 0));
  }

  const latestSummaryBySession =
    shouldClearExisting ? new Map() : buildExistingSummaryMap(await readLog(params.logPath));
  const eligibleSessionIds = new Set(eligibleTargets.map((target) => target.sessionId));
  const existingEligibleSummaryIds = new Set(
    [...latestSummaryBySession.keys()].filter((sessionId) => eligibleSessionIds.has(sessionId)),
  );
  const includeExistingAsCompleted = params.force !== true || params.resume?.clearApplied === true;
  const resumedEligibleIds =
    params.resume?.clearApplied === true
      ? new Set([...resumeWrittenIds].filter((sessionId) => eligibleSessionIds.has(sessionId)))
      : new Set([...resumeCompletedIds].filter((sessionId) => eligibleSessionIds.has(sessionId)));
  const completedEligibleIds = new Set([
    ...resumedEligibleIds,
    ...(includeExistingAsCompleted ? [...existingEligibleSummaryIds] : []),
  ]);
  const pendingTargets = eligibleTargets.filter((target) => !completedEligibleIds.has(target.sessionId));

  const result =
    params.resume
      ? createResumedProgress(eligibleTargets.length, {
          processed: completedEligibleIds.size,
          written: existingEligibleSummaryIds.size,
          cleared,
          scanned: prepared.scanned,
          existing: existingEligibleSummaryIds.size,
          skippedNoTranscript: prepared.skippedNoTranscript,
          skippedNoConversation: prepared.skippedNoConversation,
        })
      : createResumedProgress(eligibleTargets.length, {
          processed: existingEligibleSummaryIds.size,
          written: existingEligibleSummaryIds.size,
          cleared,
          scanned: prepared.scanned,
          existing: existingEligibleSummaryIds.size,
          skippedNoTranscript: prepared.skippedNoTranscript,
          skippedNoConversation: prepared.skippedNoConversation,
        });
  const concurrency = Math.min(pendingTargets.length || 1, normalizeSessionSummaryConcurrency(params.concurrency));

  let progressChain = Promise.resolve();
  let writeChain = Promise.resolve();

  async function flushProgress(progress: SessionSummaryBackfillProgress): Promise<void> {
    const snapshot = {
      ...progress,
    };
    const currentTask = progressChain.then(
      async () => await emitProgress(params.onProgress, snapshot),
      async () => await emitProgress(params.onProgress, snapshot),
    );
    progressChain = currentTask.then(
      () => undefined,
      () => undefined,
    );
    await currentTask;
  }

  async function updateProgress(
    mutate?: () => void,
    currentSessionId?: string,
  ): Promise<void> {
    if (mutate) {
      mutate();
    }

    await flushProgress(
      currentSessionId
        ? {
            ...result,
            currentSessionId,
          }
        : result,
    );
  }

  async function queueWrite<T>(task: () => Promise<T>): Promise<T> {
    const currentTask = writeChain.then(task, task);
    writeChain = currentTask.then(
      () => undefined,
      () => undefined,
    );
    return await currentTask;
  }

  await updateProgress();

  const writtenSessionIds: string[] = [];

  let nextTargetIndex = 0;

  function takeNextTarget(): SessionSummaryBackfillTarget | undefined {
    if (nextTargetIndex >= pendingTargets.length) {
      return undefined;
    }

    const target = pendingTargets[nextTargetIndex];
    nextTargetIndex += 1;
    return target;
  }

  async function processTarget(target: SessionSummaryBackfillTarget): Promise<void> {
    await updateProgress(undefined, target.sessionId);

    const existingSummary = latestSummaryBySession.get(target.sessionId);
    if (params.resume?.clearApplied === true && existingSummary) {
      await markProcessedWithoutWrite(() => {
        result.existing += 1;
        result.processed += 1;
      }, target.sessionId);
      return;
    }

    if (existingSummary && params.force !== true && params.clearExisting !== true) {
      await markProcessedWithoutWrite(() => {
        result.existing += 1;
        result.processed += 1;
      }, target.sessionId);
      return;
    }

    const transcriptFile =
      target.transcriptFile;

    const messages = await readTranscript(transcriptFile);

    const draft = await runtimeDeps.generateSessionSummary({
      messages,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      model: params.model,
    });
    if (mode === "projected" && draft.source === "fallback") {
      await markProcessedWithoutWrite(() => {
        result.skippedFallback += 1;
        result.processed += 1;
      }, target.sessionId);
      return;
    }
    const detailParts = [
      draft.detail?.trim(),
      `Use memory_get("session:${target.sessionId}") for the full transcript if implementation detail is needed.`,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);

    const entry = finalizeEntry(
      {
        type: "session_summary",
        content: draft.content,
        ...(detailParts.length > 0 ? { detail: detailParts.join("\n\n") } : {}),
      },
      {
        sessionId: target.sessionId,
        timestamp: (() => {
          const summaryTimestamp = resolveSummaryTimestamp(messages);
          if (!summaryTimestamp || !existingSummary || params.force !== true) {
            return summaryTimestamp;
          }

          const existingTime = Date.parse(existingSummary.timestamp);
          const summaryTime = Date.parse(summaryTimestamp);
          if (Number.isFinite(existingTime) && Number.isFinite(summaryTime) && existingTime >= summaryTime) {
            return new Date(existingTime + 1).toISOString();
          }

          return summaryTimestamp;
        })(),
      },
    );
    await queueWrite(async () => {
      await appendEntry(params.logPath, entry);
      latestSummaryBySession.set(target.sessionId, entry);
      writtenSessionIds.push(target.sessionId);
    });
    result.written += 1;
    result.processed += 1;
    await flushProgress({
      ...result,
      completedSessionId: target.sessionId,
      wroteSessionId: target.sessionId,
    });
    return;
  }

  async function markProcessedWithoutWrite(
    mutate: () => void,
    sessionId: string,
  ): Promise<void> {
    mutate();
    await flushProgress({
      ...result,
      completedSessionId: sessionId,
    });
  }

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const target = takeNextTarget();
        if (!target) {
          return;
        }

        await processTarget(target);
      }
    }),
  );

  await writeChain;
  await progressChain;

  if (params.clearExisting === true || mode === "projected" || !Array.isArray(params.sessions) || params.sessions.length === 0) {
    await refreshSessionSummaryProjections({
      projectionDir: params.projectionDir,
      logPath: params.logPath,
    });
  } else if (writtenSessionIds.length > 0) {
    await refreshSessionSummaryProjections({
      projectionDir: params.projectionDir,
      logPath: params.logPath,
      sessionIds: writtenSessionIds,
    });
  }

  return result;
}

export async function backfillImportedSessionSummaries(
  params: {
    logPath: string;
    projectionDir: string;
    model: string;
    openClawHome?: string;
    sessions?: SessionSummaryBackfillTarget[];
    force?: boolean;
    onProgress?: (progress: SessionSummaryBackfillProgress) => void | Promise<void>;
  },
  deps: Partial<SessionSummaryBackfillDeps> = {},
): Promise<SessionSummaryBackfillResult> {
  return await backfillSessionSummaries(
    {
      ...params,
      mode: "imported",
    },
    deps,
  );
}
