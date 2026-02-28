import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callGatewayChatCompletion } from "../lib/chat-completions";
import { resolveGatewayBaseUrl } from "../lib/gateway";
import { finalizeEntry, validateLlmOutput, type LogEntry } from "../log/schema";
import { ensureSubject, readRegistry, type SubjectRegistry } from "../subjects/registry";
import type { ImportedConversation } from "./types";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const EXTRACTION_PROMPT_PATH = join(THIS_DIR, "../../prompts/extraction.md");
const HISTORICAL_SYSTEM_PREFIX = [
  "Historical import mode:",
  "- The transcript is archived historical data imported from another platform.",
  "- Extract durable memory exactly as written, without assuming current status.",
  "- The hook will pin all entry timestamps to the conversation's historical updatedAt time.",
].join("\n");

let extractionPromptCache: string | null = null;

export interface ImportExtractionOptions {
  conversation: ImportedConversation;
  sessionId: string;
  subjectsPath: string;
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

export interface ImportExtractionDeps {
  callModel: (params: CallModelParams) => Promise<string>;
}

async function defaultCallModel(params: CallModelParams): Promise<string> {
  const baseUrl = resolveGatewayBaseUrl(params.apiBaseUrl);
  return await callGatewayChatCompletion({
    baseUrl,
    model: params.model,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
    apiToken: params.apiToken,
    errorPrefix: "extraction LLM call failed",
  });
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

function formatSubjects(subjects: SubjectRegistry): string {
  const sortedEntries = Object.entries(subjects).sort(([left], [right]) => left.localeCompare(right));
  const sortedSubjects = Object.fromEntries(sortedEntries);
  return JSON.stringify(sortedSubjects, null, 2);
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

export async function extractImportedConversation(
  options: ImportExtractionOptions,
  deps: Partial<ImportExtractionDeps> = {},
): Promise<LogEntry[]> {
  const runtimeDeps: ImportExtractionDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  const prompt = await loadExtractionPrompt();
  const subjects = await readRegistry(options.subjectsPath);
  const systemPrompt = `${HISTORICAL_SYSTEM_PREFIX}\n\n${prompt.trim()}`;
  const userPrompt = [
    "## Known subjects",
    formatSubjects(subjects),
    "",
    "## Existing Entries",
    "- n/a",
    "",
    "## Transcript",
    formatTranscript(options.conversation),
  ].join("\n");

  const rawOutput = await runtimeDeps.callModel({
    model: options.model,
    systemPrompt,
    userPrompt,
    apiBaseUrl: options.apiBaseUrl,
    apiToken: options.apiToken,
  });
  const historicalTimestamp = resolveHistoricalTimestamp(options.conversation);

  const entries: LogEntry[] = [];
  let nonEmptyLines = 0;
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
      continue;
    }

    const validated = validateLlmOutput(parsed);
    if (!validated.ok) {
      continue;
    }

    const finalized = finalizeEntry(validated.entry, {
      sessionId: options.sessionId,
      timestamp: historicalTimestamp,
    });

    if (finalized.subject && options.ensureSubjects !== false) {
      await ensureSubject(options.subjectsPath, finalized.subject);
    }

    entries.push(finalized);
  }

  if (nonEmptyLines > 0 && entries.length === 0) {
    throw new Error("extraction output did not contain any valid JSONL entries");
  }

  return entries;
}
