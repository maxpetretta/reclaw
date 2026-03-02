import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import {
  DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
  findMentionedSubjects,
  parseExtractionJsonl,
  type ParsedExtractionEntry,
} from "../extraction/shared";
import { isObject } from "../lib/guards";
import { extractTextContent } from "../lib/text";
import { queryExtractionContext, queryLog } from "../log/query";
import {
  appendEntry,
  finalizeEntry,
  type LogEntry,
} from "../log/schema";
import { extractFromTranscript } from "../lib/llm";
import {
  readGatewayToken,
  resolveApiBaseUrlFromConfig,
  resolveOpenClawHome,
} from "../lib/runtime-env";
import { applyLastHandoffBlock } from "../memory/handoff";
import {
  findTranscriptFile,
  formatTranscript,
  parseSessionIdFromTranscriptFileName,
  readTranscript,
  type TranscriptMessage,
} from "../lib/transcript";
import {
  isExtracted,
  incrementEventUsage,
  markExtracted,
  markFailed,
  pruneState,
  readState,
  shouldRetry,
} from "../state";
import {
  readRegistry,
  upsertSubjectFromExtraction,
} from "../subjects/registry";

interface ZettelclawPaths {
  logPath: string;
  subjectsPath: string;
  statePath: string;
}

interface SessionCandidate {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
}

export interface ExtractionHookDeps {
  extractFromTranscript: typeof extractFromTranscript;
  readMemoryFile: (path: string) => Promise<string>;
  writeMemoryFile: (path: string, content: string) => Promise<void>;
}

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

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseSessionStoreCandidates(
  rawStore: unknown,
  agentId: string,
): Array<{ sessionId: string; sessionKey: string }> {
  if (!isObject(rawStore)) {
    return [];
  }

  const candidates: Array<{ sessionId: string; sessionKey: string }> = [];

  for (const [sessionKey, value] of Object.entries(rawStore)) {
    if (!isObject(value)) {
      continue;
    }

    const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
    if (!sessionId) {
      continue;
    }

    // Keep sessions keyed for the current agent directory.
    const normalizedKey = sessionKey.trim();
    if (normalizedKey.startsWith("agent:")) {
      const parts = normalizedKey.split(":");
      if (parts.length >= 2 && parts[1] && parts[1] !== agentId) {
        continue;
      }
    }

    candidates.push({
      sessionId,
      sessionKey: normalizedKey,
    });
  }

  return candidates;
}

export async function listSessionCandidates(
  openClawHome = resolveOpenClawHome(),
): Promise<SessionCandidate[]> {
  const agentsDir = join(openClawHome, "agents");

  let agentDirs: string[];
  try {
    agentDirs = await readdir(agentsDir);
  } catch {
    return [];
  }

  const discovered = new Set<string>();
  const candidatesByKey = new Map<string, SessionCandidate>();

  for (const agentId of agentDirs) {
    const sessionsDir = join(agentsDir, agentId, "sessions");
    const sessionsStorePath = join(sessionsDir, "sessions.json");

    try {
      const sessionsStoreRaw = await readFile(sessionsStorePath, "utf8");
      const sessionsStore = JSON.parse(sessionsStoreRaw) as unknown;
      const storeCandidates = parseSessionStoreCandidates(sessionsStore, agentId);

      for (const candidate of storeCandidates) {
        const dedupeKey = `${agentId}\u0000${candidate.sessionId}`;
        if (candidatesByKey.has(dedupeKey)) {
          continue;
        }

        candidatesByKey.set(dedupeKey, {
          agentId,
          sessionId: candidate.sessionId,
          sessionKey: candidate.sessionKey,
        });
      }
    } catch {
      // Fall back to transcript file discovery when sessions.json is missing or unreadable.
    }

    let files: string[];
    try {
      files = await readdir(sessionsDir);
    } catch {
      continue;
    }

    for (const fileName of files) {
      const sessionId = parseSessionIdFromTranscriptFileName(fileName);
      if (!sessionId) {
        continue;
      }

      discovered.add(`${agentId}\u0000${sessionId}`);
    }
  }

  const candidates: SessionCandidate[] = [];
  for (const value of discovered) {
    const [agentId, sessionId] = value.split("\u0000");
    if (!agentId || !sessionId) {
      continue;
    }

    const key = `${agentId}\u0000${sessionId}`;
    const fromStore = candidatesByKey.get(key);
    candidates.push(
      fromStore ?? {
        agentId,
        sessionId,
      },
    );
  }

  for (const [dedupeKey, candidate] of candidatesByKey.entries()) {
    if (discovered.has(dedupeKey)) {
      continue;
    }
    candidates.push(candidate);
  }

  return candidates.sort((left, right) => {
    if (left.agentId !== right.agentId) {
      return left.agentId.localeCompare(right.agentId);
    }

    return left.sessionId.localeCompare(right.sessionId);
  });
}

export async function findSessionKeyForSession(
  agentId: string,
  sessionId: string,
  openClawHome = resolveOpenClawHome(),
): Promise<string | undefined> {
  const sessionsStorePath = join(openClawHome, "agents", agentId, "sessions", "sessions.json");

  let sessionsStoreRaw: string;
  try {
    sessionsStoreRaw = await readFile(sessionsStorePath, "utf8");
  } catch {
    return undefined;
  }

  let parsedStore: unknown;
  try {
    parsedStore = JSON.parse(sessionsStoreRaw);
  } catch {
    return undefined;
  }

  if (!isObject(parsedStore)) {
    return undefined;
  }

  for (const [sessionKey, value] of Object.entries(parsedStore)) {
    if (!isObject(value)) {
      continue;
    }

    if (typeof value.sessionId !== "string" || value.sessionId !== sessionId) {
      continue;
    }

    const normalizedKey = sessionKey.trim();
    return normalizedKey.length > 0 ? normalizedKey : undefined;
  }

  return undefined;
}

function resolvePaths(config: PluginConfig): ZettelclawPaths {
  return {
    logPath: join(config.logDir, "log.jsonl"),
    subjectsPath: join(config.logDir, "subjects.json"),
    statePath: join(config.logDir, "state.json"),
  };
}

function shouldSkipSessionKey(sessionKey: string | undefined, skipPrefixes: string[]): boolean {
  if (!sessionKey) {
    return false;
  }

  return skipPrefixes.some((prefix) => sessionKey.startsWith(prefix));
}

function isMainSessionKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) {
    return false;
  }

  // Supports common key shapes:
  // - agent:<agentId>:main
  // - agent:<agentId> (legacy shorthand)
  // - dm:* (direct-message interactive variants)
  if (/^agent:[^:]+:main(?:$|:)/u.test(sessionKey)) {
    return true;
  }

  if (/^agent:[^:]+$/u.test(sessionKey)) {
    return true;
  }

  if (sessionKey.startsWith("dm:")) {
    return true;
  }

  return false;
}

function shouldExtractSession(
  sessionKey: string | undefined,
  skipPrefixes: string[],
): boolean {
  if (!sessionKey) {
    return false;
  }

  if (shouldSkipSessionKey(sessionKey, skipPrefixes)) {
    return false;
  }

  return isMainSessionKey(sessionKey);
}

function hasUserMessage(messages: TranscriptMessage[]): boolean {
  return messages.some((message) => message.role === "user");
}

const EVENT_ID_LENGTH = 12;
const TRANSCRIPT_EVENT_ID_PATTERN = /\[([A-Za-z0-9_-]{12})\]/gu;

function extractReferencedEventIds(transcript: string): string[] {
  if (!transcript.trim()) {
    return [];
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const tryPush = (candidate: string): void => {
    if (candidate.length !== EVENT_ID_LENGTH || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    ids.push(candidate);
  };

  const bracketMatches = transcript.matchAll(TRANSCRIPT_EVENT_ID_PATTERN);
  for (const match of bracketMatches) {
    if (match[1]) {
      tryPush(match[1]);
    }
  }

  return ids;
}

function extractBeforeResetMessages(rawMessages: unknown[] | undefined): TranscriptMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const extracted: TranscriptMessage[] = [];

  for (const rawMessage of rawMessages) {
    if (!isObject(rawMessage)) {
      continue;
    }

    const topLevelRole = rawMessage.role;
    const nestedMessage = isObject(rawMessage.message) ? rawMessage.message : null;

    const role =
      topLevelRole === "user" || topLevelRole === "assistant"
        ? topLevelRole
        : nestedMessage?.role === "user" || nestedMessage?.role === "assistant"
          ? nestedMessage.role
          : null;

    if (!role) {
      continue;
    }

    const contentValue = nestedMessage?.content ?? rawMessage.content ?? rawMessage.body;
    const content = extractTextContent(contentValue);
    if (!content) {
      continue;
    }

    const timestampValue =
      typeof rawMessage.timestamp === "string"
        ? rawMessage.timestamp
        : typeof nestedMessage?.timestamp === "string"
          ? nestedMessage.timestamp
          : new Date().toISOString();

    extracted.push({
      role,
      content,
      timestamp: timestampValue,
    });
  }

  return extracted;
}

async function loadBeforeResetMessages(
  params: {
    event: { messages?: unknown[]; sessionFile?: string };
    ctx: { agentId?: string; sessionId?: string };
  },
): Promise<TranscriptMessage[]> {
  const fromEvent = extractBeforeResetMessages(params.event.messages);
  if (fromEvent.length > 0) {
    return fromEvent;
  }

  const sessionFile =
    typeof params.event.sessionFile === "string" && params.event.sessionFile.trim().length > 0
      ? params.event.sessionFile.trim()
      : undefined;

  if (sessionFile) {
    try {
      return await readTranscript(sessionFile);
    } catch {
      // Fall through to lookup by session id.
    }
  }

  if (params.ctx.agentId && params.ctx.sessionId) {
    const transcriptFile = await findTranscriptFile(params.ctx.agentId, params.ctx.sessionId);
    if (transcriptFile) {
      try {
        return await readTranscript(transcriptFile);
      } catch {
        return [];
      }
    }
  }

  return [];
}

async function runExtractionPipeline(params: {
  sessionId: string;
  messages: TranscriptMessage[];
  paths: ZettelclawPaths;
  memoryMdPath: string;
  config: PluginConfig;
  deps: ExtractionHookDeps;
  logger: OpenClawPluginApi["logger"];
  apiBaseUrl: string;
  apiToken?: string;
}): Promise<void> {
  const state = await readState(params.paths.statePath);

  if (isExtracted(state, params.sessionId)) {
    return;
  }

  if (state.failedSessions[params.sessionId] && !shouldRetry(state, params.sessionId)) {
    return;
  }

  const transcript = formatTranscript(params.messages);
  const transcriptEventIds = extractReferencedEventIds(transcript);
  if (!transcript.trim()) {
    await markExtracted(params.paths.statePath, params.sessionId, 0);
    await pruneState(params.paths.statePath);
    return;
  }

  try {
    if (transcriptEventIds.length > 0) {
      const allEntries = await queryLog(params.paths.logPath, {});
      if (allEntries.length > 0) {
        const byId = new Set(allEntries.map((entry) => entry.id));
        const citedIds = [...new Set(
          transcriptEventIds
            .filter((eventId) => byId.has(eventId))
        )];
        await incrementEventUsage(params.paths.statePath, citedIds, "citation");
      }
    }

    const subjects = await readRegistry(params.paths.subjectsPath);
    const transcriptSubjects = findMentionedSubjects(transcript, subjects);
    const existingEntries = await queryExtractionContext(params.paths.logPath, transcriptSubjects, {
      maxPerSubject: DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
    });
    const rawOutput = await params.deps.extractFromTranscript({
      transcript,
      subjects,
      existingEntries,
      model: params.config.extraction.model,
      apiBaseUrl: params.apiBaseUrl,
      apiToken: params.apiToken,
    });

    let appendedCount = 0;
    const appendedEntries: Array<ReturnType<typeof finalizeEntry>> = [];
    const parsed = parseExtractionJsonl(rawOutput);
    const parsedEntries: ParsedExtractionEntry[] = parsed.entries;

    if (parsed.nonEmptyLines > 0 && parsedEntries.length === 0) {
      throw new Error("extraction model returned non-empty output but no valid entries");
    }

    for (const parsedEntry of parsedEntries) {
      const entry = finalizeEntry(parsedEntry.entry, { sessionId: params.sessionId });
      if (entry.subject) {
        await upsertSubjectFromExtraction(params.paths.subjectsPath, entry.subject, parsedEntry.subjectTypeHint);
      }

      await appendEntry(params.paths.logPath, entry);
      appendedEntries.push(entry);
      appendedCount += 1;
    }

    if (parsed.invalidLineCount > 0) {
      params.logger.warn(
        `zettelclaw extraction for ${params.sessionId}: ignored ${parsed.invalidLineCount} invalid entry line(s)`,
      );
    }

    const latestHandoff = [...appendedEntries].reverse().find((entry) => entry.type === "handoff");
    if (latestHandoff) {
      try {
        const memoryContent = await params.deps.readMemoryFile(params.memoryMdPath);
        const updatedMemory = applyLastHandoffBlock(memoryContent, latestHandoff);
        await params.deps.writeMemoryFile(params.memoryMdPath, updatedMemory);
      } catch (error) {
        params.logger.warn(`zettelclaw handoff write failed for ${params.sessionId}: ${normalizeError(error)}`);
      }
    }

    await markExtracted(params.paths.statePath, params.sessionId, appendedCount);
    await pruneState(params.paths.statePath);
  } catch (error) {
    const message = normalizeError(error);
    params.logger.warn(`zettelclaw extraction failed for ${params.sessionId}: ${message}`);
    await markFailed(params.paths.statePath, params.sessionId, message);
    await pruneState(params.paths.statePath);
  }
}

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
      api.logger.warn(`zettelclaw extraction skipped ${event.sessionId}: missing agentId`);
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

    let messages: TranscriptMessage[];
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

      let messages: TranscriptMessage[];
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
