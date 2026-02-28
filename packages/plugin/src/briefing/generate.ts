import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginConfig } from "../config";
import { callGatewayChatCompletion } from "../lib/chat-completions";
import { resolveGatewayBaseUrl } from "../lib/gateway";
import { replaceManagedBlock } from "../memory/managed-block";
import { filterReplaced } from "../log/resolve";
import { readLog, type LogEntry } from "../log/schema";

export const BRIEFING_BEGIN_MARKER = "<!-- BEGIN GENERATED BRIEFING -->";
export const BRIEFING_END_MARKER = "<!-- END GENERATED BRIEFING -->";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const BRIEFING_PROMPT_PATH = join(THIS_DIR, "../../prompts/briefing.md");
const DAY_MS = 24 * 60 * 60 * 1000;

interface BriefingDeps {
  callBriefingModel: (opts: {
    prompt: string;
    model: string;
    apiBaseUrl?: string;
    apiToken?: string;
    userInput: string;
  }) => Promise<string>;
  readMemoryFile: (path: string) => Promise<string>;
  writeMemoryFile: (path: string, content: string) => Promise<void>;
}

interface BriefingBuckets {
  activeEntries: LogEntry[];
  recentDecisions: LogEntry[];
  openItems: LogEntry[];
  staleSubjects: LogEntry[];
  selectedEntries: LogEntry[];
}

let promptCache: string | null = null;

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function loadPrompt(): Promise<string> {
  if (promptCache !== null) {
    return promptCache;
  }

  promptCache = await readFile(BRIEFING_PROMPT_PATH, "utf8");
  return promptCache;
}

function formatEntry(entry: LogEntry): string {
  const parts = [`[${entry.timestamp}]`, entry.type];

  if (entry.subject) {
    parts.push(`subject=${entry.subject}`);
  }

  if (entry.type === "task") {
    parts.push(`status=${entry.status}`);
  }

  parts.push(`content=${entry.content}`);

  if (entry.detail) {
    parts.push(`detail=${entry.detail}`);
  }

  parts.push(`session=${entry.session}`);

  return `- ${parts.join(" | ")}`;
}

function formatEntryWithId(entry: LogEntry): string {
  return `- id=${entry.id} | ${formatEntry(entry).slice(2)}`;
}

function toTimestampMs(timestamp: string): number | null {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

function isWithinDays(entry: LogEntry, nowMs: number, days: number): boolean {
  const timestampMs = toTimestampMs(entry.timestamp);
  if (timestampMs === null) {
    return false;
  }

  const cutoff = nowMs - days * DAY_MS;
  return timestampMs >= cutoff;
}

function isOpenItem(entry: LogEntry): boolean {
  return (entry.type === "task" && entry.status === "open") || entry.type === "question";
}

function getMostRecentBySubject(entries: LogEntry[]): Map<string, LogEntry> {
  const latest = new Map<string, LogEntry>();

  for (const entry of entries) {
    if (!entry.subject) {
      continue;
    }

    const current = latest.get(entry.subject);
    if (!current) {
      latest.set(entry.subject, entry);
      continue;
    }

    const currentMs = toTimestampMs(current.timestamp);
    const nextMs = toTimestampMs(entry.timestamp);

    if (nextMs === null) {
      continue;
    }

    if (currentMs === null || nextMs >= currentMs) {
      latest.set(entry.subject, entry);
    }
  }

  return latest;
}

function buildBriefingBuckets(
  entries: LogEntry[],
  config: PluginConfig["briefing"],
  nowMs: number,
): BriefingBuckets {
  const activeEntries = entries.filter((entry) => isWithinDays(entry, nowMs, config.activeWindow));
  const recentDecisions = entries.filter(
    (entry) => entry.type === "decision" && isWithinDays(entry, nowMs, config.decisionWindow),
  );
  const openItems = entries.filter(isOpenItem);

  const recentSubjects = new Set<string>();
  for (const entry of entries) {
    if (!entry.subject) {
      continue;
    }

    if (isWithinDays(entry, nowMs, 7)) {
      recentSubjects.add(entry.subject);
    }
  }

  const latestBySubject = getMostRecentBySubject(entries);
  const staleSubjectIds = new Set<string>();
  const staleCutoff = nowMs - config.staleThreshold * DAY_MS;

  for (const subject of recentSubjects) {
    const latestEntry = latestBySubject.get(subject);
    if (!latestEntry) {
      continue;
    }

    const latestTimestampMs = toTimestampMs(latestEntry.timestamp);
    if (latestTimestampMs !== null && latestTimestampMs < staleCutoff) {
      staleSubjectIds.add(latestEntry.id);
    }
  }

  const staleSubjects = entries.filter((entry) => staleSubjectIds.has(entry.id));

  const selectedIds = new Set<string>();
  for (const entry of activeEntries) {
    selectedIds.add(entry.id);
  }
  for (const entry of recentDecisions) {
    selectedIds.add(entry.id);
  }
  for (const entry of openItems) {
    selectedIds.add(entry.id);
  }
  for (const entry of staleSubjects) {
    selectedIds.add(entry.id);
  }

  const selectedEntries = entries.filter((entry) => selectedIds.has(entry.id));

  return {
    activeEntries,
    recentDecisions,
    openItems,
    staleSubjects,
    selectedEntries,
  };
}

function formatBucketIds(entries: LogEntry[]): string {
  return entries.length > 0 ? entries.map((entry) => `- ${entry.id}`).join("\n") : "- n/a";
}

function extractGeneratedBlock(memoryContent: string): string {
  const start = memoryContent.indexOf(BRIEFING_BEGIN_MARKER);
  const end = memoryContent.indexOf(BRIEFING_END_MARKER);

  if (start < 0 || end < 0 || end <= start) {
    return "";
  }

  const from = start + BRIEFING_BEGIN_MARKER.length;
  return memoryContent.slice(from, end).trim();
}

function limitLines(content: string, maxLines: number): string {
  const lines = content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 || line === "");

  return lines.slice(0, maxLines).join("\n").trim();
}

function applyGeneratedBlock(memoryContent: string, generated: string): string {
  return replaceManagedBlock(memoryContent, BRIEFING_BEGIN_MARKER, BRIEFING_END_MARKER, generated);
}

const DEFAULT_DEPS: BriefingDeps = {
  async callBriefingModel(opts) {
    const baseUrl = resolveGatewayBaseUrl(opts.apiBaseUrl);
    return await callGatewayChatCompletion({
      baseUrl,
      model: opts.model,
      systemPrompt: opts.prompt,
      userPrompt: opts.userInput,
      apiToken: opts.apiToken,
      errorPrefix: "briefing LLM call failed",
    });
  },
  async readMemoryFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
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

export async function generateBriefing(
  opts: {
    logPath: string;
    memoryMdPath: string;
    config: PluginConfig;
    apiBaseUrl?: string;
    apiToken?: string;
    now?: number;
  },
  deps: Partial<BriefingDeps> = {},
): Promise<void> {
  const resolvedDeps: BriefingDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  const prompt = await loadPrompt();
  const allEntries = await readLog(opts.logPath);
  const entries = filterReplaced(allEntries);
  const nowMs = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const buckets = buildBriefingBuckets(entries, opts.config.briefing, nowMs);
  const memoryContent = await resolvedDeps.readMemoryFile(opts.memoryMdPath);
  const currentGenerated = extractGeneratedBlock(memoryContent);

  const userInput = [
    "## Current Generated Block",
    currentGenerated || "(empty)",
    "",
    "## Active Entries",
    formatBucketIds(buckets.activeEntries),
    "",
    "## Recent Decisions",
    formatBucketIds(buckets.recentDecisions),
    "",
    "## Open Items",
    formatBucketIds(buckets.openItems),
    "",
    "## Stale Subjects",
    formatBucketIds(buckets.staleSubjects),
    "",
    "## Included Entries (Deduped Union)",
    buckets.selectedEntries.length > 0
      ? buckets.selectedEntries.map(formatEntryWithId).join("\n")
      : "- n/a",
    "",
    `Constraints: activeWindow=${opts.config.briefing.activeWindow}, decisionWindow=${opts.config.briefing.decisionWindow}, staleThreshold=${opts.config.briefing.staleThreshold}, maxLines=${opts.config.briefing.maxLines}`,
  ].join("\n");

  const rawGenerated = await resolvedDeps.callBriefingModel({
    prompt,
    model: opts.config.briefing.model,
    apiBaseUrl: opts.apiBaseUrl,
    apiToken: opts.apiToken,
    userInput,
  });

  const generated = limitLines(rawGenerated, opts.config.briefing.maxLines);
  const updatedMemory = applyGeneratedBlock(memoryContent, generated);

  await resolvedDeps.writeMemoryFile(opts.memoryMdPath, updatedMemory);
}

export const __briefingTestExports = {
  applyGeneratedBlock,
  buildBriefingBuckets,
  extractGeneratedBlock,
  limitLines,
};
