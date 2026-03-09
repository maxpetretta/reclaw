import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { resolveApiBaseUrlFromConfig } from "../lib/runtime-env";
import {
  findTranscriptFile,
  parseSessionIdFromTranscriptFileName,
  readTranscript,
} from "../lib/transcript";
import {
  getExtractedSessionWatermark,
  hasTranscriptAdvanced,
  markCompactionObserved,
  markCompactionStatus,
  readState,
} from "../state";
import {
  findSessionKeyForSession,
  listSessionCandidates,
  type SessionCandidate,
  shouldExtractSession,
} from "./session-discovery";
import {
  hasUserMessage,
  loadBeforeResetMessages,
  selectMessagesAfterTimestamp,
} from "./transcript-utils";
import { runExtractionPipeline, type ExtractionPaths } from "./pipeline";
import {
  type ExtractionHookDeps,
  readTrimmedString,
} from "./extraction-common";

const COMPACTION_FALLBACK_WINDOW_MS = 10 * 60 * 1000;
const ACTIVE_COMPACTION_EXTRACTIONS = new Set<string>();

interface CandidateWithTranscript {
  candidate: SessionCandidate;
  transcriptFile: string;
  mtimeMs: number;
}

async function resolveCandidateTranscript(candidate: SessionCandidate): Promise<CandidateWithTranscript | undefined> {
  const transcriptFile = await findTranscriptFile(candidate.agentId, candidate.sessionId);
  if (!transcriptFile) {
    return undefined;
  }

  try {
    const fileStat = await stat(transcriptFile);
    return {
      candidate,
      transcriptFile,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

async function pickMostRecentCandidate(candidates: SessionCandidate[]): Promise<CandidateWithTranscript | undefined> {
  let mostRecent: CandidateWithTranscript | undefined;

  for (const candidate of candidates) {
    const withTranscript = await resolveCandidateTranscript(candidate);
    if (!withTranscript) {
      continue;
    }

    if (!mostRecent || withTranscript.mtimeMs > mostRecent.mtimeMs) {
      mostRecent = withTranscript;
    }
  }

  return mostRecent;
}

async function resolveCandidateBySessionId(sessionId: string): Promise<SessionCandidate | undefined> {
  const matches = (await listSessionCandidates()).filter((candidate) => candidate.sessionId === sessionId);
  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length === 1) {
    return matches[0];
  }

  return (await pickMostRecentCandidate(matches))?.candidate;
}

async function findFallbackMainCompactionSession(skipPrefixes: string[]): Promise<CandidateWithTranscript | undefined> {
  const extractableCandidates = (await listSessionCandidates()).filter(
    (candidate) =>
      typeof candidate.sessionKey === "string" &&
      shouldExtractSession(candidate.sessionKey, skipPrefixes),
  );
  if (extractableCandidates.length === 0) {
    return undefined;
  }

  const mostRecent = await pickMostRecentCandidate(extractableCandidates);
  if (!mostRecent) {
    return undefined;
  }

  if (extractableCandidates.length === 1) {
    return mostRecent;
  }

  const isRecentEnough = Date.now() - mostRecent.mtimeMs <= COMPACTION_FALLBACK_WINDOW_MS;
  return isRecentEnough ? mostRecent : undefined;
}

function findLatestMessageTimestamp(messages: Awaited<ReturnType<typeof readTranscript>>): string | undefined {
  let latestTimestampMs = Number.NEGATIVE_INFINITY;

  for (const message of messages) {
    const timestampMs = Date.parse(message.timestamp);
    if (Number.isFinite(timestampMs) && timestampMs > latestTimestampMs) {
      latestTimestampMs = timestampMs;
    }
  }

  return Number.isFinite(latestTimestampMs) ? new Date(latestTimestampMs).toISOString() : undefined;
}

export interface CompactionHookEvent {
  messages?: unknown[];
  messageCount: number;
  compactedCount: number;
  tokenCount?: number;
  sessionFile?: string;
}

export interface CompactionHookContext {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
}

export async function runCompactionExtraction(params: {
  hookName: "after_compaction";
  event: CompactionHookEvent;
  ctx: CompactionHookContext;
  api: OpenClawPluginApi;
  config: PluginConfig;
  paths: ExtractionPaths;
  runtimeDeps: ExtractionHookDeps;
  apiToken?: string;
}): Promise<void> {
  const { hookName, event, ctx, api, config, paths, runtimeDeps, apiToken } = params;
  const sessionFile = readTrimmedString(event.sessionFile);
  let sessionId = readTrimmedString(ctx.sessionId);
  let agentId = readTrimmedString(ctx.agentId);
  let sessionKey = readTrimmedString(ctx.sessionKey);
  let transcriptFileHint = sessionFile;

  api.logger.info(
    `reclaw ${hookName} received: sessionId=${sessionId ?? "none"} agentId=${agentId ?? "none"} ` +
    `sessionKey=${sessionKey ?? "none"} sessionFile=${sessionFile ?? "none"} ` +
    `compacted=${event.compactedCount} remaining=${event.messageCount}`,
  );

  if (!sessionId && sessionFile) {
    const parsedSessionId = parseSessionIdFromTranscriptFileName(basename(sessionFile));
    if (parsedSessionId) {
      sessionId = parsedSessionId;
    }
  }

  if (sessionId && (!agentId || !sessionKey)) {
    const matchingCandidate = await resolveCandidateBySessionId(sessionId);
    if (matchingCandidate) {
      agentId ??= matchingCandidate.agentId;
      sessionKey ??= matchingCandidate.sessionKey;
    }
  }

  if (!sessionId || !agentId) {
    const fallbackCandidate = await findFallbackMainCompactionSession(config.extraction.skipSessionTypes);
    if (fallbackCandidate) {
      sessionId ??= fallbackCandidate.candidate.sessionId;
      agentId ??= fallbackCandidate.candidate.agentId;
      sessionKey ??= fallbackCandidate.candidate.sessionKey;
      transcriptFileHint ??= fallbackCandidate.transcriptFile;
      api.logger.info(
        `reclaw ${hookName} fallback resolved: sessionId=${sessionId ?? "none"} ` +
        `agentId=${agentId ?? "none"} sessionKey=${sessionKey ?? "none"} ` +
        `sessionFile=${transcriptFileHint ?? "none"}`,
      );
    }
  }

  if (!sessionId) {
    api.logger.warn(
      `reclaw extraction skipped ${hookName}: missing sessionId and no fallback ` +
      `(ctx.sessionId=${readTrimmedString(ctx.sessionId) ?? "none"}, sessionFile=${sessionFile ?? "none"})`,
    );
    return;
  }

  await markCompactionObserved(paths.statePath, sessionId, {
    messageCount: event.messageCount,
    compactedCount: event.compactedCount,
    ...(typeof event.tokenCount === "number" && Number.isFinite(event.tokenCount)
      ? { tokenCount: event.tokenCount }
      : {}),
    ...(transcriptFileHint ? { sessionFile: transcriptFileHint } : {}),
  });

  if (ACTIVE_COMPACTION_EXTRACTIONS.has(sessionId)) {
    api.logger.info(`reclaw ${hookName} skipped ${sessionId}: extraction already in progress`);
    await markCompactionStatus(paths.statePath, sessionId, "skipped", {
      reason: "extraction already in progress",
    });
    return;
  }

  ACTIVE_COMPACTION_EXTRACTIONS.add(sessionId);

  try {
    if (!agentId) {
      api.logger.warn(`reclaw extraction skipped ${sessionId}: missing agentId`);
      await markCompactionStatus(paths.statePath, sessionId, "skipped", {
        reason: "missing agentId",
      });
      return;
    }

    const resolvedSessionKey =
      sessionKey ??
      (await findSessionKeyForSession(agentId, sessionId));
    if (!shouldExtractSession(resolvedSessionKey, config.extraction.skipSessionTypes)) {
      await markCompactionStatus(paths.statePath, sessionId, "skipped", {
        reason: resolvedSessionKey
          ? `session type excluded (${resolvedSessionKey})`
          : "session key not resolvable",
      });
      return;
    }

    const allMessages = await loadBeforeResetMessages({
      event: {
        messages: event.messages,
        sessionFile: transcriptFileHint,
      },
      ctx: {
        agentId,
        sessionId,
      },
    });
    if (!hasUserMessage(allMessages)) {
      await markCompactionStatus(paths.statePath, sessionId, "skipped", {
        reason: "no user messages",
      });
      return;
    }

    const state = await readState(paths.statePath);
    const previousSuccessWatermark = getExtractedSessionWatermark(state, sessionId);
    const currentWatermark = {
      ...(findLatestMessageTimestamp(allMessages) ? { lastMessageAt: findLatestMessageTimestamp(allMessages) } : {}),
      messageCount: allMessages.length,
    };

    if (!hasTranscriptAdvanced(currentWatermark, previousSuccessWatermark)) {
      await markCompactionStatus(paths.statePath, sessionId, "skipped", {
        reason: "no new messages since last extraction",
      });
      return;
    }

    const deltaMessages = selectMessagesAfterTimestamp(allMessages, previousSuccessWatermark?.lastMessageAt);
    if (!hasUserMessage(deltaMessages)) {
      await markCompactionStatus(paths.statePath, sessionId, "skipped", {
        reason: "no new user messages since last extraction",
      });
      return;
    }

    const result = await runExtractionPipeline({
      sessionId,
      messages: deltaMessages,
      transcriptMessageCount: allMessages.length,
      paths,
      config,
      deps: runtimeDeps,
      logger: api.logger,
      apiBaseUrl: resolveApiBaseUrlFromConfig(api.config),
      apiToken,
      sourceSessionKey: resolvedSessionKey,
    });

    if (result.status === "extracted") {
      api.logger.info(`reclaw ${hookName} extracted ${sessionId}: entries=${result.entries}`);
      await markCompactionStatus(paths.statePath, sessionId, "extracted", {
        entries: result.entries,
      });
      return;
    }

    if (result.status === "failed") {
      api.logger.warn(`reclaw ${hookName} failed ${sessionId}: ${result.error}`);
      await markCompactionStatus(paths.statePath, sessionId, "failed", {
        error: result.error,
      });
      return;
    }

    await markCompactionStatus(paths.statePath, sessionId, "skipped", {
      reason: result.reason === "retry_cap"
        ? "retry cap reached for current transcript watermark"
        : "no extraction changes",
    });
  } finally {
    ACTIVE_COMPACTION_EXTRACTIONS.delete(sessionId);
  }
}
