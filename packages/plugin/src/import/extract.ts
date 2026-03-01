import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpenClawCronError,
  removeCronJob,
  runCronJobNow,
  scheduleSubagentCronJob,
  waitForCronSummary,
} from "../lib/openclaw-cron";
import { queryExtractionContext, queryLog, searchLog } from "../log/query";
import { getLatestVersionId } from "../log/resolve";
import {
  finalizeEntry,
  GENERAL_SUBJECT_SLUG,
  parseSubjectType,
  validateLlmOutput,
  type LogEntry,
} from "../log/schema";
import {
  readRegistry,
  upsertSubjectFromExtraction,
  type SubjectRegistry,
} from "../subjects/registry";
import type { ImportedConversation } from "./types";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const EXTRACTION_PROMPT_PATH = join(THIS_DIR, "../../prompts/extraction.md");
const HISTORICAL_SYSTEM_PREFIX = [
  "Historical import mode:",
  "- The transcript is archived historical data imported from another platform.",
  "- Extract durable memory exactly as written, without assuming current status.",
  "- You may include an optional `timestamp` field per entry for historical placement.",
  "- If only a date is known, use that date at noon (12:00:00).",
  "- If omitted, timestamp defaults to the conversation's historical updatedAt time.",
].join("\n");
const IMPORT_CRON_SESSION_NAME = "zettelclaw-import-extract";
const IMPORT_CRON_TIMEOUT_SECONDS = 1_800;
const IMPORT_CRON_WAIT_TIMEOUT_MS = 1_900_000;
const EXTRACTION_CONTEXT_MAX_PER_SUBJECT = 50;
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

let extractionPromptCache: string | null = null;

export interface ImportExtractionOptions {
  conversation: ImportedConversation;
  sessionId: string;
  subjectsPath: string;
  logPath: string;
  model: string;
  apiBaseUrl?: string;
  apiToken?: string;
  ensureSubjects?: boolean;
}

interface CallModelParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  apiBaseUrl?: string;
  apiToken?: string;
}

interface ParsedLlmEntry {
  entry: Omit<LogEntry, "id" | "timestamp" | "session">;
  subjectTypeHint?: string;
  timestampHint?: string;
}

export interface ExtractedImportedEntry {
  entry: LogEntry;
  subjectTypeHint?: string;
}

export interface ImportExtractionDeps {
  callModel: (params: CallModelParams) => Promise<string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function formatSubjects(subjects: SubjectRegistry): string {
  const sortedEntries = Object.entries(subjects).sort(([left], [right]) => left.localeCompare(right));
  const sortedSubjects = Object.fromEntries(sortedEntries);
  return JSON.stringify(sortedSubjects, null, 2);
}

function formatExistingEntries(entries: LogEntry[] | undefined): string {
  if (!entries || entries.length === 0) {
    return "- n/a";
  }

  const sorted = [...entries].sort((left, right) => {
    const leftTime = Date.parse(left.timestamp);
    const rightTime = Date.parse(right.timestamp);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.id.localeCompare(right.id);
  });

  return sorted
    .map((entry) => {
      const detailText = entry.detail ?? "-";
      const statusText = entry.type === "task" ? ` status=${entry.status};` : "";
      return `[id=${entry.id}] ${entry.type} | subject=${entry.subject ?? "n/a"} | ${entry.content} |${statusText} detail=${detailText}`;
    })
    .join("\n");
}

function formatTranscript(conversation: ImportedConversation): string {
  return conversation.messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
}

function resolveHistoricalTimestamp(conversation: ImportedConversation): string {
  const parsed = Date.parse(conversation.updatedAt);
  if (!Number.isFinite(parsed)) {
    throw new Error(`conversation ${conversation.conversationId} is missing a valid updatedAt timestamp`);
  }

  return new Date(parsed).toISOString();
}

function readSubjectTypeHint(raw: unknown): string | undefined {
  if (!isObject(raw)) {
    return undefined;
  }

  return parseSubjectType(raw.subjectType ?? raw.subject_type);
}

function stripSubjectTypeHint(raw: unknown): unknown {
  if (!isObject(raw)) {
    return raw;
  }

  const candidate = { ...raw };
  delete candidate.subjectType;
  delete candidate.subject_type;
  delete candidate.timestamp;
  delete candidate.date;
  delete candidate.dateHint;
  delete candidate.date_hint;
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

function parseImportTimestampHint(raw: unknown): string | undefined {
  if (!isObject(raw)) {
    return undefined;
  }

  const candidate = typeof raw.timestamp === "string" ? raw.timestamp.trim() : "";
  if (!candidate) {
    return undefined;
  }

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(candidate);
  if (dateOnlyMatch) {
    const noonIso = `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}T12:00:00.000Z`;
    return Number.isFinite(Date.parse(noonIso)) ? noonIso : undefined;
  }

  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function parseLlmOutput(rawOutput: string): {
  parsedEntries: ParsedLlmEntry[];
  nonEmptyLines: number;
  invalidLineCount: number;
} {
  const parsedEntries: ParsedLlmEntry[] = [];
  let nonEmptyLines = 0;
  let invalidLineCount = 0;

  for (const line of rawOutput.split("\n")) {
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
    const timestampHint = parseImportTimestampHint(parsed);
    const normalizedCandidate = applyRequiredSubjectFallback(stripSubjectTypeHint(parsed));
    const validated = validateLlmOutput(normalizedCandidate);
    if (!validated.ok) {
      invalidLineCount += 1;
      continue;
    }

    parsedEntries.push({
      entry: validated.entry,
      ...(subjectTypeHint ? { subjectTypeHint } : {}),
      ...(timestampHint ? { timestampHint } : {}),
    });
  }

  return {
    parsedEntries,
    nonEmptyLines,
    invalidLineCount,
  };
}

function buildExtractionUserPrompt(opts: {
  transcript: string;
  subjects: SubjectRegistry;
  existingEntries: LogEntry[];
}): string {
  return [
    "## Known subjects",
    formatSubjects(opts.subjects),
    "",
    "## Existing Entries",
    formatExistingEntries(opts.existingEntries),
    "",
    "## Transcript",
    opts.transcript,
  ].join("\n");
}

function buildRepairUserPrompt(baseUserPrompt: string, invalidOutput: string): string {
  return [
    baseUserPrompt,
    "",
    "## Previous Invalid Output",
    invalidOutput,
    "",
    "Rewrite the output as strict JSONL entries only.",
    "Do not add explanations, markdown, or code fences.",
    "Each line must be one JSON object that matches the extraction schema.",
  ].join("\n");
}

function buildCronExtractionMessage(params: CallModelParams): string {
  return [
    "You are running an isolated one-shot extraction task.",
    "Follow the instructions exactly and return only JSONL entries.",
    "",
    "## System Prompt",
    params.systemPrompt.trim(),
    "",
    "## User Prompt",
    params.userPrompt.trim(),
    "",
    "Reminder: Return JSONL only, one object per line, no markdown fences or commentary.",
  ].join("\n");
}

async function defaultCallModel(params: CallModelParams): Promise<string> {
  const message = buildCronExtractionMessage(params);
  const scheduled = await scheduleSubagentCronJob({
    message,
    model: params.model,
    sessionName: IMPORT_CRON_SESSION_NAME,
    timeoutSeconds: IMPORT_CRON_TIMEOUT_SECONDS,
    disabled: true,
  });

  try {
    await runCronJobNow(scheduled.jobId, IMPORT_CRON_WAIT_TIMEOUT_MS);
    return await waitForCronSummary(scheduled.jobId, 60_000);
  } catch (error) {
    if (error instanceof OpenClawCronError && error.details && error.details.trim().length > 0) {
      throw new Error(`extraction LLM call failed: ${error.message} (${error.details})`);
    }

    throw new Error(
      `extraction LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    removeCronJob(scheduled.jobId);
  }
}

const DEFAULT_DEPS: ImportExtractionDeps = {
  callModel: defaultCallModel,
};

async function loadExtractionPrompt(): Promise<string> {
  if (extractionPromptCache !== null) {
    return extractionPromptCache;
  }

  extractionPromptCache = await readFile(EXTRACTION_PROMPT_PATH, "utf8");
  return extractionPromptCache;
}

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

function entryComparableText(
  entry: Pick<LogEntry, "content" | "detail"> | Pick<Omit<LogEntry, "id" | "timestamp" | "session">, "content" | "detail">,
): string {
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

function buildReplacementKeywordQueries(entry: Omit<LogEntry, "id" | "timestamp" | "session">): string[] {
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

function isCompatibleReplacement(
  entry: Omit<LogEntry, "id" | "timestamp" | "session">,
  candidate: LogEntry,
): boolean {
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

  return candidate.status === "open";
}

function computeReplacementScore(
  entry: Omit<LogEntry, "id" | "timestamp" | "session">,
  candidate: LogEntry,
): number {
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

async function collectReplacementCandidates(params: {
  entry: Omit<LogEntry, "id" | "timestamp" | "session">;
  logPath: string;
}): Promise<LogEntry[]> {
  const filter = {
    type: params.entry.type,
    ...(params.entry.subject ? { subject: params.entry.subject } : {}),
    includeReplaced: false as const,
  };

  const [typedCandidates, keywordGroups] = await Promise.all([
    queryLog(params.logPath, filter),
    Promise.all(
      buildReplacementKeywordQueries(params.entry).map((keyword) =>
        searchLog(params.logPath, keyword, filter),
      ),
    ),
  ]);

  return dedupeEntriesById([
    ...typedCandidates,
    ...keywordGroups.flat(),
  ]);
}

async function resolveReplacementForEntry(params: {
  entry: Omit<LogEntry, "id" | "timestamp" | "session">;
  transcriptEventIds: string[];
  logPath: string;
}): Promise<string | undefined> {
  if (params.entry.replaces || params.entry.type === "handoff") {
    return params.entry.replaces;
  }

  const [allEntries, candidates] = await Promise.all([
    queryLog(params.logPath, { includeReplaced: true }),
    collectReplacementCandidates({
      entry: params.entry,
      logPath: params.logPath,
    }),
  ]);

  if (allEntries.length === 0 || candidates.length === 0) {
    return undefined;
  }

  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const transcriptId of params.transcriptEventIds) {
    const latestId = getLatestVersionId(allEntries, transcriptId);
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

export async function extractImportedConversation(
  options: ImportExtractionOptions,
  deps: Partial<ImportExtractionDeps> = {},
): Promise<ExtractedImportedEntry[]> {
  const runtimeDeps: ImportExtractionDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  const prompt = await loadExtractionPrompt();
  const subjects = await readRegistry(options.subjectsPath);
  const transcript = formatTranscript(options.conversation);
  const transcriptSubjects = findMentionedSubjects(transcript, subjects);
  const existingEntries = await queryExtractionContext(options.logPath, transcriptSubjects, {
    maxPerSubject: EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
  });

  const systemPrompt = `${HISTORICAL_SYSTEM_PREFIX}\n\n${prompt.trim()}`;
  const userPrompt = buildExtractionUserPrompt({
    transcript,
    subjects,
    existingEntries,
  });

  const firstOutput = await runtimeDeps.callModel({
    model: options.model,
    systemPrompt,
    userPrompt,
    apiBaseUrl: options.apiBaseUrl,
    apiToken: options.apiToken,
  });

  let parsed = parseLlmOutput(firstOutput);
  if (parsed.nonEmptyLines > 0 && parsed.parsedEntries.length === 0) {
    const repairedOutput = await runtimeDeps.callModel({
      model: options.model,
      systemPrompt,
      userPrompt: buildRepairUserPrompt(userPrompt, firstOutput),
      apiBaseUrl: options.apiBaseUrl,
      apiToken: options.apiToken,
    });
    parsed = parseLlmOutput(repairedOutput);
  }

  if (parsed.nonEmptyLines > 0 && parsed.parsedEntries.length === 0) {
    throw new Error("extraction output did not contain any valid JSONL entries");
  }

  const historicalTimestamp = resolveHistoricalTimestamp(options.conversation);
  const transcriptEventIds = extractReferencedEventIds(transcript);
  const entries: ExtractedImportedEntry[] = [];

  for (const parsedEntry of parsed.parsedEntries) {
    const resolvedReplaces =
      parsedEntry.entry.replaces ??
      (await resolveReplacementForEntry({
        entry: parsedEntry.entry,
        transcriptEventIds,
        logPath: options.logPath,
      }));

    const finalizedInput =
      resolvedReplaces && !parsedEntry.entry.replaces
        ? {
            ...parsedEntry.entry,
            replaces: resolvedReplaces,
          }
        : parsedEntry.entry;

    const finalized = finalizeEntry(finalizedInput, {
      sessionId: options.sessionId,
      timestamp: parsedEntry.timestampHint ?? historicalTimestamp,
    });

    if (finalized.subject && options.ensureSubjects !== false) {
      await upsertSubjectFromExtraction(
        options.subjectsPath,
        finalized.subject,
        parsedEntry.subjectTypeHint,
      );
    }

    entries.push({
      entry: finalized,
      ...(parsedEntry.subjectTypeHint ? { subjectTypeHint: parsedEntry.subjectTypeHint } : {}),
    });
  }

  return entries;
}
