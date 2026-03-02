import {
  buildExtractionUserPrompt,
  loadExtractionPrompt,
} from "../extraction/prompt";
import {
  DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
  findMentionedSubjects,
  parseExtractionJsonl,
  type ParsedExtractionEntry,
} from "../extraction/shared";
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
  type LogEntry,
} from "../log/schema";
import {
  readRegistry,
  upsertSubjectFromExtraction,
  type SubjectRegistry,
} from "../subjects/registry";
import { normalizeWhitespace } from "../lib/text";
import type { ImportedConversation } from "./types";
const HISTORICAL_SYSTEM_PREFIX = [
  "Historical import mode:",
  "- The transcript is archived historical data imported from another platform.",
  "- Extract durable memory exactly as written, without assuming current status.",
  "- Apply a strict durability filter: only keep details likely to matter in future sessions.",
  "- Prefer long-lived user context: projects, workflows, preferences, health patterns, and unresolved questions.",
  "- Prefer subject slugs for the thing discussed (`project`, `topic`, `system`) rather than the user as a catch-all person subject.",
  "- Use `person` subjects only when the memory is explicitly about that person (identity, relationship, preference, health, biography).",
  "- For health/medical topics use a `health` subject, for investing use `investing`, for hobbies use the hobby name, etc.",
  "- Match extraction density to transcript complexity; longer transcripts should usually yield multiple durable entries.",
  "- Skip one-off lookup results unless they reveal a durable pattern or preference.",
  "- Examples to skip: menus, store addresses/hours, trivia/song ID requests, generic explainers, transient shopping lookups, and codebase architecture details (database schemas, contract patterns, dependency lists) discoverable from project source code.",
  "- Do not extract the act of researching or asking about something. Only extract the durable conclusion or preference that resulted. 'User researched X' or 'User asked about X' entries are not durable.",
  "- Do not emit speculative questions. Only emit `question` entries for things the user explicitly left unresolved.",
  "- Do not emit handoff entries in historical import mode.",
  "- You may include an optional `timestamp` field per entry for historical placement.",
  "- Prefer exact timestamps from transcript messages when available.",
  "- If confidence is low, emit a `question` instead of an uncertain `fact`.",
  "- If only a date is known, use that date at noon (12:00:00).",
  "- If omitted, timestamp defaults to the conversation's historical updatedAt time.",
].join("\n");
const IMPORT_CRON_SESSION_NAME = "zettelclaw-import-extract";
const IMPORT_CRON_TIMEOUT_SECONDS = 1_800;
const IMPORT_CRON_WAIT_TIMEOUT_MS = 1_900_000;
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

export interface ExtractedImportedEntry {
  entry: LogEntry;
  subjectTypeHint?: string;
}

export interface ImportExtractionDeps {
  callModel: (params: CallModelParams) => Promise<string>;
}

interface ImportTimestampHint {
  iso: string;
  dateOnly?: string;
}

type QualityIssueSeverity = "moderate" | "severe";

interface QualityIssue {
  severity: QualityIssueSeverity;
  message: string;
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
    .map((message) => `[${message.createdAt}] ${message.role}: ${message.content}`)
    .join("\n");
}

export function resolveHistoricalTimestamp(conversation: ImportedConversation): string {
  const parsed = Date.parse(conversation.updatedAt);
  if (!Number.isFinite(parsed)) {
    throw new Error(`conversation ${conversation.conversationId} is missing a valid updatedAt timestamp`);
  }

  return new Date(parsed).toISOString();
}


function parseImportTimestampHint(raw: unknown): ImportTimestampHint | undefined {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  if (!candidate) {
    return undefined;
  }

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(candidate);
  if (dateOnlyMatch) {
    const dateOnly = `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}`;
    const noonIso = `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}T12:00:00.000Z`;
    if (!Number.isFinite(Date.parse(noonIso))) {
      return undefined;
    }

    return {
      iso: noonIso,
      dateOnly,
    };
  }

  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return {
    iso: new Date(parsed).toISOString(),
  };
}


function resolveDateOnlyTimestampHint(
  dateOnly: string,
  conversation: ImportedConversation,
): string | undefined {
  const targetNoon = Date.parse(`${dateOnly}T12:00:00.000Z`);
  if (!Number.isFinite(targetNoon)) {
    return undefined;
  }

  let bestIso: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const message of conversation.messages) {
    if (typeof message.createdAt !== "string" || !message.createdAt.startsWith(`${dateOnly}T`)) {
      continue;
    }

    const parsed = Date.parse(message.createdAt);
    if (!Number.isFinite(parsed)) {
      continue;
    }

    const iso = new Date(parsed).toISOString();
    const distance = Math.abs(parsed - targetNoon);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIso = iso;
    }
  }

  return bestIso;
}

function resolveEntryTimestampHint(
  hint: ImportTimestampHint | undefined,
  conversation: ImportedConversation,
  fallback: string,
): string {
  if (!hint) {
    return fallback;
  }

  if (!hint.dateOnly) {
    return hint.iso;
  }

  return resolveDateOnlyTimestampHint(hint.dateOnly, conversation) ?? hint.iso;
}

function dedupeParsedEntries(entries: ParsedExtractionEntry[]): ParsedExtractionEntry[] {
  const seen = new Set<string>();
  const deduped: ParsedExtractionEntry[] = [];

  for (const parsedEntry of entries) {
    const statusText =
      parsedEntry.entry.type === "task" ? `:${parsedEntry.entry.status}` : "";
    const subjectText = "subject" in parsedEntry.entry ? parsedEntry.entry.subject : "";
    const detailText = typeof parsedEntry.entry.detail === "string" ? parsedEntry.entry.detail : "";
    const key = [
      parsedEntry.entry.type,
      statusText,
      normalizeWhitespace(subjectText).toLowerCase(),
      normalizeWhitespace(parsedEntry.entry.content).toLowerCase(),
      normalizeWhitespace(detailText).toLowerCase(),
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(parsedEntry);
  }

  return deduped;
}

function estimateCoverageTarget(conversation: ImportedConversation): number {
  const substantiveMessageCount = conversation.messages.filter((message) => {
    if (message.role === "system") {
      return false;
    }

    return message.content.trim().length >= 24;
  }).length;

  if (substantiveMessageCount >= 20) {
    return 4;
  }
  if (substantiveMessageCount >= 8) {
    return 2;
  }

  return 1;
}

function evaluateQualityIssues(params: {
  parsedEntries: ParsedExtractionEntry[];
  conversation: ImportedConversation;
  subjects: SubjectRegistry;
}): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const { parsedEntries, conversation, subjects } = params;

  if (parsedEntries.length === 0) {
    return issues;
  }

  const coverageTarget = estimateCoverageTarget(conversation);
  const coverageDeficit = coverageTarget - parsedEntries.length;
  if (coverageDeficit >= 2 || (coverageDeficit >= 1 && coverageTarget >= 4)) {
    issues.push({
      severity: "severe",
      message: `Coverage is too sparse for this transcript. Produce around ${coverageTarget} durable entries when justified.`,
    });
  } else if (coverageDeficit === 1 && coverageTarget >= 2) {
    issues.push({
      severity: "moderate",
      message: `Coverage is slightly sparse. Target about ${coverageTarget} durable entries when supported by transcript evidence.`,
    });
  }

  if (parsedEntries.length >= 3) {
    const subjectHintBySlug = new Map<string, string>();
    for (const parsedEntry of parsedEntries) {
      if (parsedEntry.subjectTypeHint && "subject" in parsedEntry.entry) {
        subjectHintBySlug.set(parsedEntry.entry.subject, parsedEntry.subjectTypeHint);
      }
    }

    const subjectCounts = new Map<string, number>();
    for (const parsedEntry of parsedEntries) {
      if (!("subject" in parsedEntry.entry)) {
        continue;
      }
      const current = subjectCounts.get(parsedEntry.entry.subject) ?? 0;
      subjectCounts.set(parsedEntry.entry.subject, current + 1);
    }

    let dominantSubject: string | undefined;
    let dominantCount = 0;
    for (const [subject, count] of subjectCounts.entries()) {
      if (count > dominantCount) {
        dominantSubject = subject;
        dominantCount = count;
      }
    }

    if (dominantSubject && dominantCount / parsedEntries.length >= 0.75) {
      const hintedType = subjectHintBySlug.get(dominantSubject);
      const dominantIsPerson =
        hintedType === "person" || subjects[dominantSubject]?.type === "person";

      if (dominantIsPerson) {
        issues.push({
          severity: "severe",
          message:
            "Too many entries use a person subject as a catch-all. Split entries across topical subjects that describe what was discussed (health, investing, golf, nutrition, career, etc.) — person subjects are only for facts about the person themselves (identity, location, biography).",
        });
      }
    }
  }

  return issues;
}

function shouldRunQualityRepair(issues: QualityIssue[]): boolean {
  return issues.some((issue) => issue.severity === "severe");
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

function buildQualityRepairUserPrompt(
  baseUserPrompt: string,
  priorOutput: string,
  issues: QualityIssue[],
): string {
  return [
    baseUserPrompt,
    "",
    "## Previous Output To Improve",
    priorOutput,
    "",
    "## Quality Issues To Fix",
    ...issues.map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.message}`),
    "",
    "Rewrite the output as strict JSONL entries only.",
    "Do not add explanations, markdown, or code fences.",
    "Each line must be one JSON object that matches the extraction schema.",
    "Keep subjects specific to the thing discussed and use `question` for uncertain statements.",
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
    maxPerSubject: DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
  });

  const systemPrompt = `${HISTORICAL_SYSTEM_PREFIX}\n\n${prompt.trim()}`;
  const userPrompt = buildExtractionUserPrompt({
    transcript,
    subjects,
    existingEntries,
    sections: [
      {
        heading: "Conversation Metadata",
        body: formatConversationMetadata(options.conversation),
      },
    ],
  });

  const firstOutput = await runtimeDeps.callModel({
    model: options.model,
    systemPrompt,
    userPrompt,
    apiBaseUrl: options.apiBaseUrl,
    apiToken: options.apiToken,
  });

  let latestOutput = firstOutput;
  let parsed = parseExtractionJsonl(latestOutput, {
    includeTimestampHint: true,
    dropHandoff: true,
  });
  if (parsed.processableLines > 0 && parsed.entries.length === 0) {
    const repairedOutput = await runtimeDeps.callModel({
      model: options.model,
      systemPrompt,
      userPrompt: buildRepairUserPrompt(userPrompt, latestOutput),
      apiBaseUrl: options.apiBaseUrl,
      apiToken: options.apiToken,
    });
    latestOutput = repairedOutput;
    parsed = parseExtractionJsonl(latestOutput, {
      includeTimestampHint: true,
      dropHandoff: true,
    });
  }

  if (parsed.entries.length > 0) {
    parsed = {
      ...parsed,
      entries: dedupeParsedEntries(parsed.entries),
    };
  }

  const qualityIssues = evaluateQualityIssues({
    parsedEntries: parsed.entries,
    conversation: options.conversation,
    subjects,
  });

  if (parsed.entries.length > 0 && shouldRunQualityRepair(qualityIssues)) {
    const qualityOutput = await runtimeDeps.callModel({
      model: options.model,
      systemPrompt,
      userPrompt: buildQualityRepairUserPrompt(userPrompt, latestOutput, qualityIssues),
      apiBaseUrl: options.apiBaseUrl,
      apiToken: options.apiToken,
    });
    const qualityParsed = parseExtractionJsonl(qualityOutput, {
      includeTimestampHint: true,
      dropHandoff: true,
    });
    if (qualityParsed.entries.length > 0) {
      parsed = {
        ...qualityParsed,
        entries: dedupeParsedEntries(qualityParsed.entries),
      };
      latestOutput = qualityOutput;
    }
  }

  if (parsed.processableLines > 0 && parsed.entries.length === 0) {
    throw new Error("extraction output did not contain any valid JSONL entries");
  }

  const historicalTimestamp = resolveHistoricalTimestamp(options.conversation);
  const entries: ExtractedImportedEntry[] = [];

  for (const parsedEntry of parsed.entries) {
    const timestampHint = parseImportTimestampHint(parsedEntry.timestampHint);
    const finalized = finalizeEntry(parsedEntry.entry, {
      sessionId: options.sessionId,
      timestamp: resolveEntryTimestampHint(
        timestampHint,
        options.conversation,
        historicalTimestamp,
      ),
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
