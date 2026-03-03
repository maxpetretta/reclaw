import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { isObject, normalizeError } from "../lib/guards";
import { extractFromTranscript } from "../lib/llm";
import {
  readGatewayToken,
  resolveApiBaseUrlFromConfig,
} from "../lib/runtime-env";
import {
  findTranscriptFile,
  parseSessionIdFromTranscriptFileName,
  readTranscript,
} from "../lib/transcript";
import {
  isExtracted,
  markCompactionObserved,
  markCompactionStatus,
  markFailed,
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
} from "./transcript-utils";
import {
  runExtractionPipeline,
  type ExtractionPaths,
  type ExtractionPipelineDeps,
} from "./pipeline";

export interface ExtractionHookDeps extends ExtractionPipelineDeps {}

const COMPACTION_FALLBACK_WINDOW_MS = 10 * 60 * 1000;

const DEFAULT_DEPS: ExtractionHookDeps = {
  extractFromTranscript,
  async readMemoryFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return "";
      }

      throw error;
    }
  },
  async writeMemoryFile(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  },
};

function readWorkspaceDir(ctx: unknown): string | undefined {
  if (!isObject(ctx)) {
    return undefined;
  }

  return typeof ctx.workspaceDir === "string" && ctx.workspaceDir.trim().length > 0
    ? ctx.workspaceDir.trim()
    : undefined;
}

function resolveMemoryMdPath(
  workspaceDir: string | undefined,
  resolvePath?: (input: string) => string,
): string {
  if (workspaceDir) {
    return join(workspaceDir, "MEMORY.md");
  }

  if (resolvePath) {
    return resolvePath("MEMORY.md");
  }

  return join(process.cwd(), "MEMORY.md");
}

function resolvePaths(config: PluginConfig): ExtractionPaths {
  return {
    logPath: join(config.logDir, "log.jsonl"),
    subjectsPath: join(config.logDir, "subjects.json"),
    statePath: join(config.logDir, "state.json"),
  };
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

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

export { listSessionCandidates, findSessionKeyForSession };

export function registerExtractionHooks(
  api: OpenClawPluginApi,
  config: PluginConfig,
  deps: Partial<ExtractionHookDeps> = {},
): void {
  const paths = resolvePaths(config);
  const runtimeDeps: ExtractionHookDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  const apiToken = readGatewayToken(api.config);

  api.on("session_end", async (event, ctx) => {
    if (!ctx.agentId) {
      api.logger.warn(`reclaw extraction skipped ${event.sessionId}: missing agentId`);
      return;
    }

    const sessionKey = await findSessionKeyForSession(ctx.agentId, event.sessionId);
    if (!shouldExtractSession(sessionKey, config.extraction.skipSessionTypes)) {
      return;
    }

    const transcriptFile = await findTranscriptFile(ctx.agentId, event.sessionId);
    if (!transcriptFile) {
      await markFailed(paths.statePath, event.sessionId, "transcript file not found");
      return;
    }

    let messages;
    try {
      messages = await readTranscript(transcriptFile);
    } catch (error) {
      await markFailed(paths.statePath, event.sessionId, normalizeError(error));
      return;
    }

    if (!hasUserMessage(messages)) {
      return;
    }

    await runExtractionPipeline({
      sessionId: event.sessionId,
      messages,
      paths,
      memoryMdPath: resolveMemoryMdPath(readWorkspaceDir(ctx), api.resolvePath),
      config,
      deps: runtimeDeps,
      logger: api.logger,
      apiBaseUrl: resolveApiBaseUrlFromConfig(api.config),
      apiToken,
    });
  });

  api.on("before_reset", async (event, ctx) => {
    if (!ctx.sessionId) {
      return;
    }

    if (!shouldExtractSession(ctx.sessionKey, config.extraction.skipSessionTypes)) {
      return;
    }

    const messages = await loadBeforeResetMessages({
      event,
      ctx,
    });
    if (!hasUserMessage(messages)) {
      return;
    }

    await runExtractionPipeline({
      sessionId: ctx.sessionId,
      messages,
      paths,
      memoryMdPath: resolveMemoryMdPath(readWorkspaceDir(ctx), api.resolvePath),
      config,
      deps: runtimeDeps,
      logger: api.logger,
      apiBaseUrl: resolveApiBaseUrlFromConfig(api.config),
      apiToken,
    });
  });

  api.on("after_compaction", async (event, ctx) => {
    const sessionFile = readTrimmedString(event.sessionFile);
    let sessionId = readTrimmedString(ctx.sessionId);
    let agentId = readTrimmedString(ctx.agentId);
    let sessionKey = readTrimmedString(ctx.sessionKey);
    let transcriptFileHint = sessionFile;
    api.logger.info(
      `reclaw after_compaction received: sessionId=${sessionId ?? "none"} agentId=${agentId ?? "none"} ` +
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
          `reclaw after_compaction fallback resolved: sessionId=${sessionId ?? "none"} ` +
          `agentId=${agentId ?? "none"} sessionKey=${sessionKey ?? "none"} ` +
          `sessionFile=${transcriptFileHint ?? "none"}`,
        );
      }
    }

    if (!sessionId) {
      api.logger.warn(
        `reclaw extraction skipped after_compaction: missing sessionId and no fallback ` +
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

    // Note: no isExtracted check here — compaction always produces new content
    // that should be extracted, even if the session was previously extracted.

    const transcriptFile = transcriptFileHint ?? (await findTranscriptFile(agentId, sessionId));
    if (!transcriptFile) {
      const message = "transcript file not found";
      api.logger.warn(`reclaw after_compaction failed ${sessionId}: ${message}`);
      await markFailed(paths.statePath, sessionId, message);
      await markCompactionStatus(paths.statePath, sessionId, "failed", {
        error: message,
      });
      return;
    }

    let messages;
    try {
      messages = await readTranscript(transcriptFile);
    } catch (error) {
      const message = normalizeError(error);
      api.logger.warn(`reclaw after_compaction failed ${sessionId}: unable to read transcript (${message})`);
      await markFailed(paths.statePath, sessionId, message);
      await markCompactionStatus(paths.statePath, sessionId, "failed", {
        error: message,
      });
      return;
    }

    if (!hasUserMessage(messages)) {
      await markCompactionStatus(paths.statePath, sessionId, "skipped", {
        reason: "no user messages",
      });
      return;
    }

    await runExtractionPipeline({
      sessionId,
      messages,
      paths,
      memoryMdPath: resolveMemoryMdPath(readWorkspaceDir(ctx), api.resolvePath),
      config,
      deps: runtimeDeps,
      logger: api.logger,
      apiBaseUrl: resolveApiBaseUrlFromConfig(api.config),
      apiToken,
    });

    const stateAfter = await readState(paths.statePath);
    if (isExtracted(stateAfter, sessionId)) {
      api.logger.info(
        `reclaw after_compaction extracted ${sessionId}: entries=${stateAfter.extractedSessions[sessionId]?.entries ?? 0}`,
      );
      await markCompactionStatus(paths.statePath, sessionId, "extracted", {
        entries: stateAfter.extractedSessions[sessionId]?.entries ?? 0,
      });
      return;
    }

    const failed = stateAfter.failedSessions[sessionId];
    if (failed) {
      api.logger.warn(`reclaw after_compaction failed ${sessionId}: ${failed.error}`);
      await markCompactionStatus(paths.statePath, sessionId, "failed", {
        error: failed.error,
      });
      return;
    }

    await markCompactionStatus(paths.statePath, sessionId, "skipped", {
      reason: "no extraction changes",
    });
  });

  api.on("gateway_start", async (event) => {
    const candidates = await listSessionCandidates();

    for (const candidate of candidates) {
      const resolvedSessionKey =
        candidate.sessionKey ??
        (await findSessionKeyForSession(candidate.agentId, candidate.sessionId));
      if (!shouldExtractSession(resolvedSessionKey, config.extraction.skipSessionTypes)) {
        continue;
      }

      const transcriptFile = await findTranscriptFile(candidate.agentId, candidate.sessionId);
      if (!transcriptFile) {
        continue;
      }

      let messages;
      try {
        messages = await readTranscript(transcriptFile);
      } catch (error) {
        await markFailed(paths.statePath, candidate.sessionId, normalizeError(error));
        continue;
      }

      if (!hasUserMessage(messages)) {
        continue;
      }

      await runExtractionPipeline({
        sessionId: candidate.sessionId,
        messages,
        paths,
        memoryMdPath: resolveMemoryMdPath(undefined, api.resolvePath),
        config,
        deps: runtimeDeps,
        logger: api.logger,
        apiBaseUrl: resolveApiBaseUrlFromConfig(api.config, event.port),
        apiToken,
      });
    }
  });
}
