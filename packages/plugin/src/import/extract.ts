import {
  buildExtractionUserPrompt,
  loadExtractionPrompt,
} from "../extraction/prompt";
import {
  DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
  findMentionedSubjects,
  parseExtractionJsonl,
} from "../extraction/shared";
import { runIsolatedModelTask } from "../lib/isolated-model-task";
import { queryExtractionContext } from "../log/query";
import {
  finalizeEntry,
  type LogEntry,
} from "../log/schema";
import {
  readRegistry,
  upsertSubjectFromExtraction,
} from "../subjects/registry";
import type { ImportedConversation } from "./types";
import {
  buildInvalidOutputRepairPrompt,
  buildQualityRepairPrompt,
  dedupeParsedEntries,
  evaluateImportExtractionQuality,
  shouldRunImportQualityRepair,
} from "./extract-quality";
import {
  formatImportConversationMetadata,
  formatImportTranscript,
  HISTORICAL_IMPORT_SYSTEM_PREFIX,
} from "./extract-policy";
import { resolveHistoricalTimestamp, resolveImportedEntryTimestamp } from "./extract-timestamp";
export { resolveHistoricalTimestamp } from "./extract-timestamp";

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
}

export interface ExtractedImportedEntry {
  entry: LogEntry;
  subjectTypeHint?: string;
}

export interface ImportExtractionDeps {
  callModel: (params: CallModelParams) => Promise<string>;
}

async function defaultCallModel(params: CallModelParams): Promise<string> {
  return await runIsolatedModelTask({
    model: params.model,
    sessionName: IMPORT_CRON_SESSION_NAME,
    timeoutSeconds: IMPORT_CRON_TIMEOUT_SECONDS,
    waitTimeoutMs: IMPORT_CRON_WAIT_TIMEOUT_MS,
    errorPrefix: "extraction LLM call failed",
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
    outputReminder: "Return JSONL only, one object per line, no markdown fences or commentary.",
  });
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
  const transcript = formatImportTranscript(options.conversation);
  const transcriptSubjects = findMentionedSubjects(transcript, subjects);
  const existingEntries = await queryExtractionContext(options.logPath, transcriptSubjects, {
    maxPerSubject: DEFAULT_EXTRACTION_CONTEXT_MAX_PER_SUBJECT,
  });

  const systemPrompt = `${HISTORICAL_IMPORT_SYSTEM_PREFIX}\n\n${prompt.trim()}`;
  const userPrompt = buildExtractionUserPrompt({
    transcript,
    subjects,
    existingEntries,
    sections: [
      {
        heading: "Conversation Metadata",
        body: formatImportConversationMetadata(options.conversation),
      },
    ],
  });

  const parseOptions = {
    includeTimestampHint: true,
    dropHandoff: true,
  } as const;
  const strategyPrompts: Array<{ stage: "initial" | "repair" | "quality"; prompt: string }> = [
    { stage: "initial", prompt: userPrompt },
  ];
  let parsed = parseExtractionJsonl("", parseOptions);
  let latestOutput = "";

  while (strategyPrompts.length > 0) {
    const current = strategyPrompts.shift();
    if (!current) {
      break;
    }

    latestOutput = await runtimeDeps.callModel({
      model: options.model,
      systemPrompt,
      userPrompt: current.prompt,
    });

    parsed = parseExtractionJsonl(latestOutput, parseOptions);
    if (parsed.entries.length > 0) {
      parsed = {
        ...parsed,
        entries: dedupeParsedEntries(parsed.entries),
      };
    }

    if (parsed.processableLines > 0 && parsed.entries.length === 0) {
      if (current.stage === "initial") {
        strategyPrompts.push({
          stage: "repair",
          prompt: buildInvalidOutputRepairPrompt(userPrompt, latestOutput),
        });
        continue;
      }
      break;
    }

    const qualityIssues = evaluateImportExtractionQuality({
      parsedEntries: parsed.entries,
      conversation: options.conversation,
      subjects,
    });

    if (
      parsed.entries.length > 0 &&
      shouldRunImportQualityRepair(qualityIssues) &&
      current.stage !== "quality"
    ) {
      strategyPrompts.push({
        stage: "quality",
        prompt: buildQualityRepairPrompt(userPrompt, latestOutput, qualityIssues),
      });
      continue;
    }

    break;
  }

  if (parsed.processableLines > 0 && parsed.entries.length === 0) {
    throw new Error("extraction output did not contain any valid JSONL entries");
  }

  const historicalTimestamp = resolveHistoricalTimestamp(options.conversation);
  const entries: ExtractedImportedEntry[] = [];

  for (const parsedEntry of parsed.entries) {
    const finalized = finalizeEntry(parsedEntry.entry, {
      sessionId: options.sessionId,
      timestamp: resolveImportedEntryTimestamp(
        parsedEntry.timestampHint,
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
