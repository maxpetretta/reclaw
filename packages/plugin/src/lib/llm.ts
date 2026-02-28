import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callGatewayChatCompletion } from "./chat-completions";
import { resolveGatewayBaseUrl } from "./gateway";
import type { LogEntry } from "../log/schema";
import type { SubjectRegistry } from "../subjects/registry";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const EXTRACTION_PROMPT_PATH = join(THIS_DIR, "../../prompts/extraction.md");
let extractionPromptCache: string | null = null;

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

function formatExistingEntries(entries: LogEntry[] | undefined): string {
  if (!entries || entries.length === 0) {
    return "- n/a";
  }

  return entries
    .map((entry) => {
      const detailText = entry.detail ?? "-";
      const statusText = entry.type === "task" ? ` status=${entry.status};` : "";
      return `[id=${entry.id}] ${entry.type} | subject=${entry.subject ?? "n/a"} | ${entry.content} |${statusText} detail=${detailText}`;
    })
    .join("\n");
}

function buildExtractionUserPrompt(opts: {
  transcript: string;
  subjects: SubjectRegistry;
  existingEntries?: LogEntry[];
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

export async function extractFromTranscript(opts: {
  transcript: string;
  subjects: SubjectRegistry;
  existingEntries?: LogEntry[];
  model: string;
  apiBaseUrl?: string;
  apiToken?: string;
}): Promise<string> {
  const prompt = await loadExtractionPrompt();
  const baseUrl = resolveGatewayBaseUrl(opts.apiBaseUrl);
  const userPrompt = buildExtractionUserPrompt(opts);

  return await callGatewayChatCompletion({
    baseUrl,
    model: opts.model,
    systemPrompt: prompt,
    userPrompt,
    apiToken: opts.apiToken,
    errorPrefix: "extraction LLM call failed",
  });
}

export const __llmTestExports = {
  buildExtractionUserPrompt,
  formatExistingEntries,
};
