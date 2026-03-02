import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  readTranscript,
} from "../lib/transcript";
import { markFailed } from "../state";
import {
  findSessionKeyForSession,
  listSessionCandidates,
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

  api.registerHook("session_end", async (event, ctx) => {
    if (!ctx.agentId) {
      api.logger.warn(`reclaw extraction skipped ${event.sessionId}: missing agentId`);
      return;
    }

    const sessionKey = await findSessionKeyForSession(ctx.agentId, event.sessionId);
    if (sessionKey && !shouldExtractSession(sessionKey, config.extraction.skipSessionTypes)) {
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

  api.registerHook("before_reset", async (event, ctx) => {
    if (!ctx.sessionId) {
      return;
    }

    if (ctx.sessionKey && !shouldExtractSession(ctx.sessionKey, config.extraction.skipSessionTypes)) {
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

  api.registerHook("gateway_start", async (event) => {
    const candidates = await listSessionCandidates();

    for (const candidate of candidates) {
      const resolvedSessionKey =
        candidate.sessionKey ??
        (await findSessionKeyForSession(candidate.agentId, candidate.sessionId));
      if (resolvedSessionKey && !shouldExtractSession(resolvedSessionKey, config.extraction.skipSessionTypes)) {
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
