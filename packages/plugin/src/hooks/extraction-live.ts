import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { normalizeError } from "../lib/guards";
import { resolveApiBaseUrlFromConfig } from "../lib/runtime-env";
import { findTranscriptFile, readTranscript } from "../lib/transcript";
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
    sourceSessionKey: sessionKey,
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
    sourceSessionKey: readTrimmedString(ctx.sessionKey),
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
      sourceSessionKey: resolvedSessionKey,
    });
  }
}
