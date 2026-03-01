import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { queryExtractionContext, queryLog, searchLog } from "../log/query";
import { getLatestVersionId } from "../log/resolve";
import {
  appendEntry,
  finalizeEntry,
  GENERAL_SUBJECT_SLUG,
  parseSubjectType,
  validateLlmOutput,
  type LogEntry,
} from "../log/schema";
import { extractFromTranscript } from "../lib/llm";
import { applyLastHandoffBlock } from "../memory/handoff";
import {
  findTranscriptFile,
  formatTranscript,
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
  type SubjectRegistry,
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
  findTranscriptFile: typeof findTranscriptFile;
  findSessionKeyForSession: typeof findSessionKeyForSession;
  queryLog: typeof queryLog;
  searchLog: typeof searchLog;
  readTranscript: typeof readTranscript;
  formatTranscript: typeof formatTranscript;
  listSessionCandidates: typeof listSessionCandidates;
  readMemoryFile: (path: string) => Promise<string>;
  writeMemoryFile: (path: string, content: string) => Promise<void>;
}

const DEFAULT_DEPS: ExtractionHookDeps = {
  extractFromTranscript,
  findTranscriptFile,
  findSessionKeyForSession,
  queryLog,
  searchLog,
  readTranscript,
  formatTranscript,
  listSessionCandidates,
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

const EXTRACTION_CONTEXT_MAX_PER_SUBJECT = 50;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMentionedSubjects(transcript: string, subjects: SubjectRegistry): string[] {
  if (!transcript.trim()) {
    return [];
  }

  const transcriptLower = transcript.toLowerCase();
  const slugs = Object.keys(subjects);
  const matched: string[] = [];

  for (const slug of slugs) {
    const normalizedSlug = slug.trim().toLowerCase();
    if (!normalizedSlug) {
      continue;
    }

    const pattern = new RegExp(`(^|[^a-z0-9-])${escapeRegex(normalizedSlug)}([^a-z0-9-]|$)`, "u");
    if (pattern.test(transcriptLower)) {
      matched.push(slug);
    }
  }

  return matched;
}

function readSubjectTypeHint(raw: unknown): string | undefined {
  if (!isObject(raw)) {
    return undefined;
  }

  return parseSubjectType(raw.subjectType ?? raw.subject_type);
}

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

function stripSubjectTypeHint(raw: unknown): unknown {
  if (!isObject(raw)) {
    return raw;
  }

  const candidate = { ...raw };
  delete candidate.subjectType;
  delete candidate.subject_type;
  return candidate;
}

function applyRequiredSubjectFallback(raw: unknown): unknown {
  if (!isObject(raw)) {
    return raw;
  }

  const candidate: Record<string, unknown> = { ...raw };
  const type = typeof candidate.type === "string" ? candidate.type : undefined;
  const subject = typeof candidate.subject === "string" ? candidate.subject.trim() : "";

  if (type !== "handoff" && subject.length === 0) {
    candidate.subject = GENERAL_SUBJECT_SLUG;
    return candidate;
  }

  if (subject.length > 0) {
    candidate.subject = subject;
  }

  return candidate;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function resolveOpenClawHome(): string {
  const override = process.env.OPENCLAW_HOME?.trim();
  if (override) {
    return override;
  }

  return join(homedir(), ".openclaw");
}

function parseSessionIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(".jsonl") && !fileName.includes(".jsonl.reset.")) {
    return null;
  }

  const jsonlResetIndex = fileName.indexOf(".jsonl.reset.");
  if (jsonlResetIndex > 0) {
    return fileName.slice(0, jsonlResetIndex);
  }

  const resetIndex = fileName.indexOf(".reset.");
  if (resetIndex > 0 && fileName.endsWith(".jsonl")) {
    return fileName.slice(0, resetIndex);
  }

  if (fileName.endsWith(".jsonl") && !fileName.includes(".reset.")) {
    return fileName.slice(0, -6);
  }

  return null;
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
      const sessionId = parseSessionIdFromFileName(fileName);
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

type LlmEntry = Omit<LogEntry, "id" | "timestamp" | "session">;

interface ParsedLlmEntry {
  entry: LlmEntry;
  subjectTypeHint?: string;
}

const EVENT_ID_LENGTH = 12;
const TRANSCRIPT_EVENT_ID_PATTERN = /\[([A-Za-z0-9_-]{12})\]/gu;
const MAX_REPLACEMENT_KEYWORDS = 6;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "an",
  "and",
  "are",
  "because",
  "before",
  "being",
  "between",
  "but",
  "can",
  "could",
  "did",
  "does",
  "done",
  "for",
  "from",
  "had",
  "has",
  "have",
  "here",
  "how",
  "into",
  "its",
  "just",
  "more",
  "need",
  "new",
  "not",
  "now",
  "our",
  "out",
  "over",
  "same",
  "should",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function tokenizeComparableText(value: string): string[] {
  return normalizeComparableText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function entryComparableText(entry: Pick<LogEntry, "content" | "detail"> | Pick<LlmEntry, "content" | "detail">): string {
  return `${entry.content} ${entry.detail ?? ""}`.trim();
}

function tokenOverlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }

  const denominator = Math.min(leftSet.size, rightSet.size);
  return denominator > 0 ? intersection / denominator : 0;
}

function dedupeEntriesById(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  const deduped: LogEntry[] = [];

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }

    seen.add(entry.id);
    deduped.push(entry);
  }

  return deduped;
}

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

function buildReplacementKeywordQueries(entry: LlmEntry): string[] {
  const keywords = tokenizeComparableText(entryComparableText(entry));
  if (entry.subject) {
    keywords.unshift(...tokenizeComparableText(entry.subject));
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const token of keywords) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    deduped.push(token);
    if (deduped.length >= MAX_REPLACEMENT_KEYWORDS) {
      break;
    }
  }

  return deduped;
}

function isCompatibleReplacement(entry: LlmEntry, candidate: LogEntry): boolean {
  if (entry.type !== candidate.type) {
    return false;
  }

  if (entry.subject && candidate.subject && entry.subject !== candidate.subject) {
    return false;
  }

  if (entry.type !== "task") {
    return true;
  }

  if (entry.status === "done") {
    return candidate.status === "open";
  }

  // Keep open->open transitions only.
  return candidate.status === "open";
}

function computeReplacementScore(entry: LlmEntry, candidate: LogEntry): number {
  if (!isCompatibleReplacement(entry, candidate)) {
    return 0;
  }

  const entryText = entryComparableText(entry);
  const candidateText = entryComparableText(candidate);
  const normalizedEntryContent = normalizeComparableText(entry.content);
  const normalizedCandidateContent = normalizeComparableText(candidate.content);
  const normalizedEntryText = normalizeComparableText(entryText);
  const normalizedCandidateText = normalizeComparableText(candidateText);
  const contentOverlap = tokenOverlapRatio(
    tokenizeComparableText(entry.content),
    tokenizeComparableText(candidate.content),
  );
  const overlap = tokenOverlapRatio(
    tokenizeComparableText(entryText),
    tokenizeComparableText(candidateText),
  );

  let score = overlap * 6 + contentOverlap * 6;
  if (normalizedEntryContent && normalizedEntryContent === normalizedCandidateContent) {
    score += 6;
  }

  if (normalizedEntryText && normalizedEntryText === normalizedCandidateText) {
    score += 4;
  }

  if (entry.subject && candidate.subject === entry.subject) {
    score += 2;
  }

  if (entry.type === "task" && entry.status === "done" && candidate.type === "task" && candidate.status === "open") {
    score += 2;
  }

  return score;
}

function resolveLatestReplacementId(startId: string, allEntries: LogEntry[]): string {
  const successorsById = new Map<string, LogEntry[]>();
  for (const entry of allEntries) {
    if (!entry.replaces) {
      continue;
    }

    const list = successorsById.get(entry.replaces) ?? [];
    list.push(entry);
    successorsById.set(entry.replaces, list);
  }

  let current = startId;
  const seen = new Set<string>([startId]);

  while (true) {
    const successors = successorsById.get(current);
    if (!successors || successors.length === 0) {
      return current;
    }

    const next = [...successors].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0];
    if (!next || seen.has(next.id)) {
      return current;
    }

    seen.add(next.id);
    current = next.id;
  }
}

async function collectReplacementCandidates(params: {
  entry: LlmEntry;
  logPath: string;
  deps: ExtractionHookDeps;
}): Promise<LogEntry[]> {
  const filter = {
    type: params.entry.type,
    ...(params.entry.subject ? { subject: params.entry.subject } : {}),
    includeReplaced: false as const,
  };

  const [typedCandidates, keywordGroups] = await Promise.all([
    params.deps.queryLog(params.logPath, filter),
    Promise.all(
      buildReplacementKeywordQueries(params.entry).map((keyword) =>
        params.deps.searchLog(params.logPath, keyword, filter),
      ),
    ),
  ]);

  return dedupeEntriesById([
    ...typedCandidates,
    ...keywordGroups.flat(),
  ]);
}

async function resolveReplacementForEntry(params: {
  entry: LlmEntry;
  transcriptEventIds: string[];
  logPath: string;
  deps: ExtractionHookDeps;
}): Promise<string | undefined> {
  if (params.entry.replaces || params.entry.type === "handoff") {
    return params.entry.replaces;
  }

  const [allEntries, candidates] = await Promise.all([
    params.deps.queryLog(params.logPath, { includeReplaced: true }),
    collectReplacementCandidates({
      entry: params.entry,
      logPath: params.logPath,
      deps: params.deps,
    }),
  ]);

  if (allEntries.length === 0 || candidates.length === 0) {
    return undefined;
  }

  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const transcriptId of params.transcriptEventIds) {
    const latestId = resolveLatestReplacementId(transcriptId, allEntries);
    const matched = candidatesById.get(latestId);
    if (matched && isCompatibleReplacement(params.entry, matched)) {
      return matched.id;
    }
  }

  let bestCandidate: LogEntry | undefined;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = computeReplacementScore(params.entry, candidate);
    if (score <= bestScore) {
      continue;
    }

    bestScore = score;
    bestCandidate = candidate;
  }

  if (!bestCandidate) {
    return undefined;
  }

  const requiresStrictSubjectMatch = Boolean(params.entry.subject);
  const acceptThreshold = params.entry.type === "task" && params.entry.status === "done" ? 7 : 8;
  if (bestScore < acceptThreshold) {
    return undefined;
  }

  if (
    requiresStrictSubjectMatch &&
    bestCandidate.subject &&
    bestCandidate.subject !== params.entry.subject
  ) {
    return undefined;
  }

  return bestCandidate.id;
}

function readGatewayPort(config: unknown): number | null {
  if (!isObject(config)) {
    return null;
  }

  const gateway = config.gateway;
  if (!isObject(gateway)) {
    return null;
  }

  return typeof gateway.port === "number" && Number.isFinite(gateway.port) ? gateway.port : null;
}

function readGatewayToken(config: unknown): string | undefined {
  if (!isObject(config)) {
    return undefined;
  }

  const gateway = config.gateway;
  if (!isObject(gateway)) {
    return undefined;
  }

  const auth = gateway.auth;
  if (!isObject(auth)) {
    return undefined;
  }

  return typeof auth.token === "string" && auth.token.trim().length > 0 ? auth.token : undefined;
}

function resolveApiBaseUrl(config: unknown, portOverride?: number): string {
  const port = portOverride ?? readGatewayPort(config) ?? 18789;
  return `http://127.0.0.1:${port}`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.replaceAll(/\s+/gu, " ").trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    if ((record.type === "text" || record.type === "input_text") && typeof record.text === "string") {
      const normalized = record.text.replaceAll(/\s+/gu, " ").trim();
      if (normalized) {
        parts.push(normalized);
      }
      continue;
    }

    if (typeof record.input_text === "string") {
      const normalized = record.input_text.replaceAll(/\s+/gu, " ").trim();
      if (normalized) {
        parts.push(normalized);
      }
    }
  }

  return parts.join("\n");
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
    deps: ExtractionHookDeps;
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
      return await params.deps.readTranscript(sessionFile);
    } catch {
      // Fall through to lookup by session id.
    }
  }

  if (params.ctx.agentId && params.ctx.sessionId) {
    const transcriptFile = await params.deps.findTranscriptFile(params.ctx.agentId, params.ctx.sessionId);
    if (transcriptFile) {
      try {
        return await params.deps.readTranscript(transcriptFile);
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

  const transcript = params.deps.formatTranscript(params.messages);
  const transcriptEventIds = extractReferencedEventIds(transcript);
  if (!transcript.trim()) {
    await markExtracted(params.paths.statePath, params.sessionId, 0);
    await pruneState(params.paths.statePath);
    return;
  }

  try {
    if (transcriptEventIds.length > 0) {
      const allEntries = await params.deps.queryLog(params.paths.logPath, { includeReplaced: true });
      if (allEntries.length > 0) {
        const byId = new Set(allEntries.map((entry) => entry.id));
        const canonicalIds = [...new Set(
          transcriptEventIds
            .filter((eventId) => byId.has(eventId))
            .map((eventId) => getLatestVersionId(allEntries, eventId)),
        )];
        await incrementEventUsage(params.paths.statePath, canonicalIds, "citation");
      }
    }

    const subjects = await readRegistry(params.paths.subjectsPath);
    const transcriptSubjects = findMentionedSubjects(transcript, subjects);
    const existingEntries = await queryExtractionContext(params.paths.logPath, transcriptSubjects, {
      maxPerSubject: EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
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
    let nonEmptyLines = 0;
    let invalidLineCount = 0;
    const appendedEntries: Array<ReturnType<typeof finalizeEntry>> = [];
    const parsedEntries: ParsedLlmEntry[] = [];
    const lines = rawOutput.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      nonEmptyLines += 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        invalidLineCount += 1;
        continue;
      }

      const subjectTypeHint = readSubjectTypeHint(parsed);
      const normalizedCandidate = applyRequiredSubjectFallback(stripSubjectTypeHint(parsed));
      const validation = validateLlmOutput(normalizedCandidate);
      if (!validation.ok) {
        invalidLineCount += 1;
        continue;
      }

      parsedEntries.push({
        entry: validation.entry,
        ...(subjectTypeHint ? { subjectTypeHint } : {}),
      });
    }

    if (nonEmptyLines > 0 && parsedEntries.length === 0) {
      throw new Error("extraction model returned non-empty output but no valid entries");
    }

    for (const parsedEntry of parsedEntries) {
      const resolvedReplaces =
        parsedEntry.entry.replaces ??
        (await resolveReplacementForEntry({
          entry: parsedEntry.entry,
          transcriptEventIds,
          logPath: params.paths.logPath,
          deps: params.deps,
        }));

      const finalizedInput =
        resolvedReplaces && !parsedEntry.entry.replaces
          ? {
              ...parsedEntry.entry,
              replaces: resolvedReplaces,
            }
          : parsedEntry.entry;

      const entry = finalizeEntry(finalizedInput, { sessionId: params.sessionId });
      if (entry.subject) {
        await upsertSubjectFromExtraction(params.paths.subjectsPath, entry.subject, parsedEntry.subjectTypeHint);
      }

      await appendEntry(params.paths.logPath, entry);
      appendedEntries.push(entry);
      appendedCount += 1;
    }

    if (invalidLineCount > 0) {
      params.logger.warn(
        `zettelclaw extraction for ${params.sessionId}: ignored ${invalidLineCount} invalid entry line(s)`,
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

    const sessionKey = await runtimeDeps.findSessionKeyForSession(ctx.agentId, event.sessionId);
    if (sessionKey && !shouldExtractSession(sessionKey, config.extraction.skipSessionTypes)) {
      return;
    }

    const transcriptFile = await runtimeDeps.findTranscriptFile(ctx.agentId, event.sessionId);
    if (!transcriptFile) {
      await markFailed(paths.statePath, event.sessionId, "transcript file not found");
      return;
    }

    let messages: TranscriptMessage[];
    try {
      messages = await runtimeDeps.readTranscript(transcriptFile);
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
      apiBaseUrl: resolveApiBaseUrl(api.config),
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
      deps: runtimeDeps,
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
      apiBaseUrl: resolveApiBaseUrl(api.config),
      apiToken,
    });
  });

  api.registerHook("gateway_start", async (event) => {
    const candidates = await runtimeDeps.listSessionCandidates();

    for (const candidate of candidates) {
      const resolvedSessionKey =
        candidate.sessionKey ??
        (await runtimeDeps.findSessionKeyForSession(candidate.agentId, candidate.sessionId));
      if (resolvedSessionKey && !shouldExtractSession(resolvedSessionKey, config.extraction.skipSessionTypes)) {
        continue;
      }

      const transcriptFile = await runtimeDeps.findTranscriptFile(candidate.agentId, candidate.sessionId);
      if (!transcriptFile) {
        continue;
      }

      let messages: TranscriptMessage[];
      try {
        messages = await runtimeDeps.readTranscript(transcriptFile);
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
        apiBaseUrl: resolveApiBaseUrl(api.config, event.port),
        apiToken,
      });
    }
  });
}
