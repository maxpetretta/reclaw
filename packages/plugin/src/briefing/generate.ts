import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginConfig } from "../config";
import { isEnoent } from "../lib/guards";
import { runIsolatedModelTask } from "../lib/isolated-model-task";
import { replaceManagedBlock } from "../memory/managed-block";
import { BRIEFING_BEGIN_MARKER, BRIEFING_END_MARKER } from "../memory/markers";
import { isOpenItem } from "../log/query";
import { readLog, type LogEntry } from "../log/schema";
import { readState, type EventUsageState } from "../state";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const BRIEFING_PROMPT_PATH = join(THIS_DIR, "../../prompts/briefing.md");
const DAY_MS = 24 * 60 * 60 * 1000;
const BRIEFING_MODEL_SESSION_NAME = "zettelclaw-memory-snapshot-model";
const BRIEFING_MODEL_TIMEOUT_SECONDS = 1_800;
const BRIEFING_MODEL_WAIT_TIMEOUT_MS = 1_900_000;

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
  openItems: LogEntry[];
  staleSubjects: LogEntry[];
  durableEntries: LogEntry[];
  selectedEntries: LogEntry[];
}

interface SubjectActivity {
  subject: string;
  entries: number;
  latestTimestamp: string;
  typeCounts: Partial<Record<LogEntry["type"], number>>;
}

let promptCache: string | null = null;


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

function parseTimestamp(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isWithinDays(entry: LogEntry, nowMs: number, days: number): boolean {
  const timestampMs = parseTimestamp(entry.timestamp);
  if (timestampMs === null) {
    return false;
  }

  const cutoff = nowMs - days * DAY_MS;
  return timestampMs >= cutoff;
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

    const currentMs = parseTimestamp(current.timestamp);
    const nextMs = parseTimestamp(entry.timestamp);

    if (nextMs === null) {
      continue;
    }

    if (currentMs === null || nextMs >= currentMs) {
      latest.set(entry.subject, entry);
    }
  }

  return latest;
}

function computeDurableScore(entry: LogEntry, usage: EventUsageState | undefined): number {
  if (!usage) {
    return 0;
  }

  return usage.citationCount * 2 + usage.memoryGetCount + usage.memorySearchCount * 0.25;
}

function buildDurableEntries(
  entries: LogEntry[],
  activeEntries: LogEntry[],
  eventUsage: Record<string, EventUsageState>,
  limit = 10,
): LogEntry[] {
  const activeIds = new Set(activeEntries.map((entry) => entry.id));

  return entries
    .filter((entry) => !activeIds.has(entry.id))
    .filter((entry) => entry.type === "decision" || entry.type === "fact")
    .map((entry) => ({
      entry,
      score: computeDurableScore(entry, eventUsage[entry.id]),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      return (parseTimestamp(right.entry.timestamp) ?? 0) - (parseTimestamp(left.entry.timestamp) ?? 0);
    })
    .slice(0, Math.max(1, limit))
    .map((candidate) => candidate.entry);
}

function buildBriefingBuckets(
  entries: LogEntry[],
  config: PluginConfig["briefing"],
  nowMs: number,
  eventUsage: Record<string, EventUsageState>,
): BriefingBuckets {
  const activeEntries = entries.filter((entry) => isWithinDays(entry, nowMs, config.activeWindow));
  const openItems = entries.filter(isOpenItem);

  const recentSubjects = new Set<string>();
  for (const entry of activeEntries) {
    if (!entry.subject) {
      continue;
    }
    recentSubjects.add(entry.subject);
  }

  const latestBySubject = getMostRecentBySubject(entries);
  const staleSubjectIds = new Set<string>();
  const staleCutoff = nowMs - config.staleThreshold * DAY_MS;

  for (const subject of recentSubjects) {
    const latestEntry = latestBySubject.get(subject);
    if (!latestEntry) {
      continue;
    }

    const latestTimestampMs = parseTimestamp(latestEntry.timestamp);
    if (latestTimestampMs !== null && latestTimestampMs < staleCutoff) {
      staleSubjectIds.add(latestEntry.id);
    }
  }

  const staleSubjects = entries.filter((entry) => staleSubjectIds.has(entry.id));
  const durableEntries = buildDurableEntries(entries, activeEntries, eventUsage);

  const activeIds = new Set(activeEntries.map((entry) => entry.id));
  const openItemIds = new Set(openItems.map((entry) => entry.id));
  const durableIds = new Set(durableEntries.map((entry) => entry.id));

  const selectedEntries = entries.filter((entry) =>
    activeIds.has(entry.id) || openItemIds.has(entry.id) ||
    staleSubjectIds.has(entry.id) || durableIds.has(entry.id),
  );

  return {
    activeEntries,
    openItems,
    staleSubjects,
    durableEntries,
    selectedEntries,
  };
}

function buildSubjectActivity(entries: LogEntry[], limit = 12): SubjectActivity[] {
  const bySubject = new Map<string, SubjectActivity>();

  for (const entry of entries) {
    if (!entry.subject) {
      continue;
    }

    const existing = bySubject.get(entry.subject);
    if (!existing) {
      bySubject.set(entry.subject, {
        subject: entry.subject,
        entries: 1,
        latestTimestamp: entry.timestamp,
        typeCounts: {
          [entry.type]: 1,
        },
      });
      continue;
    }

    existing.entries += 1;
    if ((parseTimestamp(entry.timestamp) ?? 0) >= (parseTimestamp(existing.latestTimestamp) ?? 0)) {
      existing.latestTimestamp = entry.timestamp;
    }
    existing.typeCounts[entry.type] = (existing.typeCounts[entry.type] ?? 0) + 1;
  }

  return [...bySubject.values()]
    .sort((left, right) => {
      if (left.entries !== right.entries) {
        return right.entries - left.entries;
      }

      const rightTs = parseTimestamp(right.latestTimestamp) ?? 0;
      const leftTs = parseTimestamp(left.latestTimestamp) ?? 0;
      if (rightTs !== leftTs) {
        return rightTs - leftTs;
      }

      return left.subject.localeCompare(right.subject);
    })
    .slice(0, Math.max(1, limit));
}

function formatTypeCounts(typeCounts: Partial<Record<LogEntry["type"], number>>): string {
  const ordered: LogEntry["type"][] = ["task", "decision", "fact", "question", "handoff"];
  const parts: string[] = [];

  for (const type of ordered) {
    const count = typeCounts[type] ?? 0;
    if (count > 0) {
      parts.push(`${type}:${count}`);
    }
  }

  return parts.join(", ");
}

function formatSubjectActivity(activity: SubjectActivity[]): string {
  if (activity.length === 0) {
    return "- n/a";
  }

  return activity
    .map((entry) => {
      const types = formatTypeCounts(entry.typeCounts);
      return `- subject=${entry.subject} | entries=${entry.entries} | latest=${entry.latestTimestamp} | types=${types}`;
    })
    .join("\n");
}

function countByType(entries: LogEntry[]): Partial<Record<LogEntry["type"], number>> {
  const counts: Partial<Record<LogEntry["type"], number>> = {};
  for (const entry of entries) {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;
  }
  return counts;
}

function formatSignalSummary(params: {
  activeEntries: LogEntry[];
  openItems: LogEntry[];
  durableEntries: LogEntry[];
  selectedEntries: LogEntry[];
}): string {
  const activeCounts = countByType(params.activeEntries);
  const openCounts = countByType(params.openItems);
  const durableCounts = countByType(params.durableEntries);
  const selectedCounts = countByType(params.selectedEntries);

  return [
    `- active_entries=${params.activeEntries.length} | active_types=${formatTypeCounts(activeCounts) || "n/a"}`,
    `- open_items=${params.openItems.length} | open_types=${formatTypeCounts(openCounts) || "n/a"}`,
    `- durable_entries=${params.durableEntries.length} | durable_types=${formatTypeCounts(durableCounts) || "n/a"}`,
    `- selected_entries=${params.selectedEntries.length} | selected_types=${formatTypeCounts(selectedCounts) || "n/a"}`,
  ].join("\n");
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
    return await runIsolatedModelTask({
      model: opts.model,
      sessionName: BRIEFING_MODEL_SESSION_NAME,
      timeoutSeconds: BRIEFING_MODEL_TIMEOUT_SECONDS,
      waitTimeoutMs: BRIEFING_MODEL_WAIT_TIMEOUT_MS,
      systemPrompt: opts.prompt,
      userPrompt: opts.userInput,
      errorPrefix: "memory snapshot LLM call failed",
      outputReminder:
        "Return only the generated MEMORY.md block content in markdown. No fences. No commentary.",
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
  const entries = await readLog(opts.logPath);
  const state = await readState(join(opts.config.logDir, "state.json"));
  const nowMs = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const buckets = buildBriefingBuckets(entries, opts.config.briefing, nowMs, state.eventUsage);
  const activeSubjectActivity = buildSubjectActivity(buckets.activeEntries);
  const overallSubjectActivity = buildSubjectActivity(entries);
  const memoryContent = await resolvedDeps.readMemoryFile(opts.memoryMdPath);
  const currentGenerated = extractGeneratedBlock(memoryContent);

  const userInput = [
    "## Current Generated Block",
    currentGenerated || "(empty)",
    "",
    "## Active Entries",
    formatBucketIds(buckets.activeEntries),
    "",
    "## Open Items",
    formatBucketIds(buckets.openItems),
    "",
    "## Stale Subjects",
    formatBucketIds(buckets.staleSubjects),
    "",
    "## Durable Entries",
    formatBucketIds(buckets.durableEntries),
    "",
    "## Included Entries (Deduped Union)",
    buckets.selectedEntries.length > 0
      ? buckets.selectedEntries.map(formatEntryWithId).join("\n")
      : "- n/a",
    "",
    "## Subject Activity (Active Window)",
    formatSubjectActivity(activeSubjectActivity),
    "",
    "## Subject Activity (All Current Entries)",
    formatSubjectActivity(overallSubjectActivity),
    "",
    "## Signal Summary",
    formatSignalSummary({
      activeEntries: buckets.activeEntries,
      openItems: buckets.openItems,
      durableEntries: buckets.durableEntries,
      selectedEntries: buckets.selectedEntries,
    }),
    "",
    `Constraints: activeWindow=${opts.config.briefing.activeWindow}, staleThreshold=${opts.config.briefing.staleThreshold}, maxLines=${opts.config.briefing.maxLines}`,
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
