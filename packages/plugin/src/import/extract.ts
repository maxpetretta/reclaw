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
import { queryExtractionContext } from "../log/query";
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
  "- Apply a strict durability filter: only keep details likely to matter in future sessions.",
  "- Prefer long-lived user context: projects, workflows, preferences, health patterns, and unresolved questions.",
  "- Skip one-off lookup results unless they reveal a durable pattern or preference.",
  "- Examples to skip: menus, store addresses/hours, trivia/song ID requests, generic explainers, and transient shopping lookups.",
  "- Do not emit handoff entries in historical import mode.",
  "- You may include an optional `timestamp` field per entry for historical placement.",
  "- If only a date is known, use that date at noon (12:00:00).",
  "- If omitted, timestamp defaults to the conversation's historical updatedAt time.",
].join("\n");
const IMPORT_CRON_SESSION_NAME = "zettelclaw-import-extract";
const IMPORT_CRON_TIMEOUT_SECONDS = 1_800;
const IMPORT_CRON_WAIT_TIMEOUT_MS = 1_900_000;
const EXTRACTION_CONTEXT_MAX_PER_SUBJECT = 50;

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

function formatConversationMetadata(conversation: ImportedConversation): string {
  return [
    `platform: ${conversation.platform}`,
    `conversationId: ${conversation.conversationId}`,
    `title: ${conversation.title}`,
    `sourcePath: ${conversation.sourcePath ?? "n/a"}`,
    `createdAt: ${conversation.createdAt}`,
    `updatedAt: ${conversation.updatedAt}`,
  ].join("\n");
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
  processableLines: number;
} {
  const parsedEntries: ParsedLlmEntry[] = [];
  let nonEmptyLines = 0;
  let invalidLineCount = 0;
  let processableLines = 0;

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
      processableLines += 1;
      continue;
    }

    const subjectTypeHint = readSubjectTypeHint(parsed);
    const timestampHint = parseImportTimestampHint(parsed);
    const normalizedCandidate = applyRequiredSubjectFallback(stripSubjectTypeHint(parsed));
    const validated = validateLlmOutput(normalizedCandidate);
    if (!validated.ok) {
      invalidLineCount += 1;
      processableLines += 1;
      continue;
    }

    // Imports should not create handoff entries; they are session-bound runtime state.
    if (validated.entry.type === "handoff") {
      continue;
    }

    processableLines += 1;

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
    processableLines,
  };
}

function buildExtractionUserPrompt(opts: {
  conversation: ImportedConversation;
  transcript: string;
  subjects: SubjectRegistry;
  existingEntries: LogEntry[];
}): string {
  return [
    "## Conversation Metadata",
    formatConversationMetadata(opts.conversation),
    "",
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
    conversation: options.conversation,
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
  if (parsed.processableLines > 0 && parsed.parsedEntries.length === 0) {
    const repairedOutput = await runtimeDeps.callModel({
      model: options.model,
      systemPrompt,
      userPrompt: buildRepairUserPrompt(userPrompt, firstOutput),
      apiBaseUrl: options.apiBaseUrl,
      apiToken: options.apiToken,
    });
    parsed = parseLlmOutput(repairedOutput);
  }

  if (parsed.processableLines > 0 && parsed.parsedEntries.length === 0) {
    throw new Error("extraction output did not contain any valid JSONL entries");
  }

  const historicalTimestamp = resolveHistoricalTimestamp(options.conversation);
  const entries: ExtractedImportedEntry[] = [];

  for (const parsedEntry of parsed.parsedEntries) {
    const finalized = finalizeEntry(parsedEntry.entry, {
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
