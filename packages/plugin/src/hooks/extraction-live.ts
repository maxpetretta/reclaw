import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { normalizeError } from "../lib/guards";
import { resolveApiBaseUrlFromConfig } from "../lib/runtime-env";
import { findTranscriptFile, readTranscript } from "../lib/transcript";
import { appendEntry, finalizeEntry } from "../log/schema";
import { queryLog } from "../log/query";
import { applyLastSessionSummaryBlock } from "../memory/session-summary";
import { refreshSessionSummaryProjections } from "../projections/session-summaries";
import { refreshTranscriptProjectionSession, refreshTranscriptProjections } from "../projections/transcripts";
import { markFailed } from "../state";
import { findSessionKeyForSession, listSessionCandidates, shouldExtractSession } from "./session-discovery";
import { hasUserMessage, loadBeforeResetMessages } from "./transcript-utils";
import { runExtractionPipeline, type ExtractionPaths } from "./pipeline";
import {
  type ExtractionHookDeps,
  readTrimmedString,
  readWorkspaceDir,
  resolveMemoryMdPath,
} from "./extraction-common";

const ACTIVE_EXTRACTIONS = new Set<string>();

async function runExclusiveExtraction(
  sessionId: string,
  logger: OpenClawPluginApi["logger"],
  run: () => Promise<void>,
): Promise<void> {
  if (ACTIVE_EXTRACTIONS.has(sessionId)) {
    logger.info(`reclaw extraction skipped ${sessionId}: extraction already in progress`);
    return;
  }

  ACTIVE_EXTRACTIONS.add(sessionId);
  try {
    await run();
  } finally {
    ACTIVE_EXTRACTIONS.delete(sessionId);
  }
}

async function writeSessionSummary(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  paths: ExtractionPaths;
  runtimeDeps: ExtractionHookDeps;
  messages: Awaited<ReturnType<typeof readTranscript>>;
  sessionId: string;
  sessionKey?: string;
  memoryMdPath: string;
}): Promise<void> {
  const { api, config, paths, runtimeDeps, messages, sessionId, sessionKey, memoryMdPath } = params;
  const existingSummary = (await queryLog(paths.logPath, {
    type: "session_summary",
    session: sessionId,
  }))[0];
  let entry = existingSummary;
  if (!entry) {
    const draft = await runtimeDeps.generateSessionSummary({
      messages,
      sessionId,
      sessionKey,
      model: config.extraction.model,
    });
    const detailParts = [
      draft.detail?.trim(),
      `Use memory_get("session:${sessionId}") for the full transcript if implementation detail is needed.`,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    entry = finalizeEntry(
      {
        type: "session_summary",
        content: draft.content,
        ...(detailParts.length > 0 ? { detail: detailParts.join("\n\n") } : {}),
      },
      { sessionId },
    );
    await appendEntry(paths.logPath, entry);
  }

  try {
    const memoryContent = await runtimeDeps.readMemoryFile(memoryMdPath);
    const updatedMemory = applyLastSessionSummaryBlock(memoryContent, entry, {
      sessionKey,
    });
    await runtimeDeps.writeMemoryFile(memoryMdPath, updatedMemory);
  } catch (error) {
    api.logger.warn(`reclaw session summary write failed for ${sessionId}: ${normalizeError(error)}`);
  }

  try {
    await refreshSessionSummaryProjections({
      projectionDir: paths.sessionSummaryProjectionDir,
      logPath: paths.logPath,
      sessionIds: [sessionId],
    });
  } catch (error) {
    api.logger.warn(`reclaw session summary projection refresh failed for ${sessionId}: ${normalizeError(error)}`);
  }
}

async function refreshTranscriptProjectionBestEffort(params: {
  api: OpenClawPluginApi;
  projectionDir: string;
  agentId: string;
  sessionId: string;
  messages: Awaited<ReturnType<typeof readTranscript>>;
}): Promise<void> {
  try {
    await refreshTranscriptProjectionSession({
      projectionDir: params.projectionDir,
      agentId: params.agentId,
      sessionId: params.sessionId,
      messages: params.messages,
    });
  } catch (error) {
    params.api.logger.warn(
      `reclaw transcript projection refresh failed for ${params.sessionId}: ${normalizeError(error)}`,
    );
  }
}

export async function runSessionEndExtraction(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  paths: ExtractionPaths;
  runtimeDeps: ExtractionHookDeps;
  apiToken?: string;
  event: { sessionId: string; messageCount: number };
  ctx: { agentId?: string; sessionId: string; sessionKey?: string; workspaceDir?: string };
}): Promise<void> {
  const { api, config, paths, runtimeDeps, apiToken, event, ctx } = params;

  if (!ctx.agentId) {
    api.logger.warn(`reclaw extraction skipped ${event.sessionId}: missing agentId`);
    return;
  }

  const sessionKey =
    readTrimmedString(ctx.sessionKey) ??
    (await findSessionKeyForSession(ctx.agentId, event.sessionId));
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

  await refreshTranscriptProjectionBestEffort({
    api,
    projectionDir: paths.transcriptProjectionDir,
    agentId: ctx.agentId,
    sessionId: event.sessionId,
    messages,
  });

  await runExclusiveExtraction(event.sessionId, api.logger, async () => {
    await runExtractionPipeline({
      sessionId: event.sessionId,
      messages,
      paths,
      config,
      deps: runtimeDeps,
      logger: api.logger,
      apiBaseUrl: resolveApiBaseUrlFromConfig(api.config),
      apiToken,
      sourceSessionKey: sessionKey,
    });
  });
}

export async function runBeforeResetExtraction(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  paths: ExtractionPaths;
  runtimeDeps: ExtractionHookDeps;
  apiToken?: string;
  event: { messages?: unknown[]; sessionFile?: string };
  ctx: { agentId?: string; sessionId?: string; sessionKey?: string; workspaceDir?: string };
}): Promise<void> {
  const { api, config, paths, runtimeDeps, apiToken, event, ctx } = params;

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

  const sourceSessionKey = readTrimmedString(ctx.sessionKey);
  const memoryMdPath = resolveMemoryMdPath(readWorkspaceDir(ctx), api.resolvePath);

  await writeSessionSummary({
    api,
    config,
    paths,
    runtimeDeps,
    messages,
    sessionId: ctx.sessionId,
    sessionKey: sourceSessionKey,
    memoryMdPath,
  });

  void runExclusiveExtraction(ctx.sessionId, api.logger, async () => {
    await runExtractionPipeline({
      sessionId: ctx.sessionId!,
      messages,
      paths,
      config,
      deps: runtimeDeps,
      logger: api.logger,
      apiBaseUrl: resolveApiBaseUrlFromConfig(api.config),
      apiToken,
      sourceSessionKey,
    });
  }).catch((error) => {
    api.logger.warn(`reclaw before_reset background extraction failed: ${normalizeError(error)}`);
  });
}

export async function runGatewayStartSweep(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
  paths: ExtractionPaths;
  runtimeDeps: ExtractionHookDeps;
  apiToken?: string;
  event: { port: number };
}): Promise<void> {
  const { api, config, paths, runtimeDeps, apiToken, event } = params;
  try {
    await refreshTranscriptProjections({
      projectionDir: paths.transcriptProjectionDir,
    });
  } catch (error) {
    api.logger.warn(`reclaw transcript projection refresh failed during gateway_start: ${normalizeError(error)}`);
  }

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

    await runExclusiveExtraction(candidate.sessionId, api.logger, async () => {
      await runExtractionPipeline({
        sessionId: candidate.sessionId,
        messages,
        paths,
        config,
        deps: runtimeDeps,
        logger: api.logger,
        apiBaseUrl: resolveApiBaseUrlFromConfig(api.config, event.port),
        apiToken,
        sourceSessionKey: resolvedSessionKey,
      });
    });
  }
}
