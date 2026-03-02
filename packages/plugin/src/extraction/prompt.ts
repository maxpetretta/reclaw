import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LogEntry } from "../log/schema";
import type { SubjectRegistry } from "../subjects/registry";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const EXTRACTION_PROMPT_PATH = join(THIS_DIR, "../../prompts/extraction.md");

let extractionPromptCache: string | null = null;

function formatSubjects(subjects: SubjectRegistry): string {
  const sortedEntries = Object.entries(subjects).sort(([left], [right]) => left.localeCompare(right));
  const sortedSubjects = Object.fromEntries(sortedEntries);
  return JSON.stringify(sortedSubjects, null, 2);
}

export function formatExistingEntries(entries: LogEntry[] | undefined): string {
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

export async function loadExtractionPrompt(): Promise<string> {
  if (extractionPromptCache !== null) {
    return extractionPromptCache;
  }

  extractionPromptCache = await readFile(EXTRACTION_PROMPT_PATH, "utf8");
  return extractionPromptCache;
}

export function buildExtractionUserPrompt(opts: {
  transcript: string;
  subjects: SubjectRegistry;
  existingEntries?: LogEntry[];
  sections?: Array<{ heading: string; body: string }>;
}): string {
  const blocks: string[] = [];

  if (Array.isArray(opts.sections)) {
    for (const section of opts.sections) {
      const heading = section.heading.trim();
      const body = section.body.trim();
      if (!heading || !body) {
        continue;
      }

      blocks.push(`## ${heading}`, body, "");
    }
  }

  blocks.push(
    "## Known subjects",
    formatSubjects(opts.subjects),
    "",
    "## Existing Entries",
    formatExistingEntries(opts.existingEntries),
    "",
    "## Transcript",
    opts.transcript,
  );

  return blocks.join("\n");
}
