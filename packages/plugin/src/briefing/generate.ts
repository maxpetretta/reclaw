import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginConfig } from "../config";
import { isEnoent } from "../lib/guards";
import { runIsolatedModelTaskWithMeta } from "../lib/isolated-model-task";
import { replaceManagedBlock } from "../memory/managed-block";
import { BRIEFING_BEGIN_MARKER, BRIEFING_END_MARKER } from "../memory/markers";
import { isOpenItem } from "../log/query";
import { readLog, type LogEntry } from "../log/schema";
import { readState, type EventUsageState } from "../state";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const BRIEFING_PROMPT_PATH = join(THIS_DIR, "../../prompts/snapshot.md");
const DAY_MS = 24 * 60 * 60 * 1000;
const BRIEFING_MODEL_SESSION_NAME = "reclaw-memory-snapshot-model";
const BRIEFING_MODEL_TIMEOUT_SECONDS = 1_800;
const BRIEFING_MODEL_WAIT_TIMEOUT_MS = 1_900_000;
const ACTIVE_ENTRY_LIMIT = 25;
const OPEN_ITEM_LIMIT = 20;
const DURABLE_ENTRY_LIMIT = 10;
const STALE_SUBJECT_LIMIT = 5;
const ACTIVE_PER_SUBJECT_LIMIT = 3;
const OPEN_PER_SUBJECT_LIMIT = 3;
const DURABLE_PER_SUBJECT_LIMIT = 2;
const OPEN_ITEM_RECENCY_DAYS = 45;
const ACTIVE_FACT_RECENCY_DAYS = 3;

interface BriefingDeps {
  callBriefingModel: (opts: {
    prompt: string;
    model: string;
    apiBaseUrl?: string;
    apiToken?: string;
    userInput: string;
  }) => Promise<
    string | {
      output: string;
      workerSessionId?: string;
      workerSessionKey?: string;
    }
  >;
  readMemoryFile: (path: string) => Promise<string>;
  writeMemoryFile: (path: string, content: string) => Promise<void>;
}

export interface BriefingGenerationResult {
  workerSessionId?: string;
  workerSessionKey?: string;
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

function ageInDays(entry: LogEntry, nowMs: number): number {
  const timestampMs = parseTimestamp(entry.timestamp);
  if (timestampMs === null) {
    return Number.POSITIVE_INFINITY;
  }

  const delta = nowMs - timestampMs;
  if (!Number.isFinite(delta)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, delta / DAY_MS);
}

function isWithinDays(entry: LogEntry, nowMs: number, days: number): boolean {
  const timestampMs = parseTimestamp(entry.timestamp);
  if (timestampMs === null) {
    return false;
  }

  const cutoff = nowMs - days * DAY_MS;
  return timestampMs >= cutoff;
}

function computeUsageScore(usage: EventUsageState | undefined): number {
  if (!usage) {
    return 0;
  }

  return usage.citationCount * 2 + usage.memoryGetCount + usage.memorySearchCount * 0.25;
}

function typeScore(entry: LogEntry): number {
  switch (entry.type) {
    case "task":
    case "question":
      return 4;
    case "decision":
      return 3;
    case "fact":
      return 2;
    default:
      return 0;
  }
}

function recencyScore(entry: LogEntry, nowMs: number): number {
  const days = ageInDays(entry, nowMs);
  if (!Number.isFinite(days)) {
    return 0;
  }

  return Math.max(0, 5 - days / 7);
}

function entrySignalScore(entry: LogEntry, nowMs: number, usage: EventUsageState | undefined, openBonus = 0): number {
  return typeScore(entry) + recencyScore(entry, nowMs) + computeUsageScore(usage) + openBonus;
}

function sortBySignalThenTimestamp(
  left: {
    entry: LogEntry;
    score: number;
  },
  right: {
    entry: LogEntry;
    score: number;
  },
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  return (parseTimestamp(right.entry.timestamp) ?? 0) - (parseTimestamp(left.entry.timestamp) ?? 0);
}

function applyPerSubjectCap(entries: LogEntry[], maxPerSubject: number): LogEntry[] {
  if (!Number.isFinite(maxPerSubject) || maxPerSubject <= 0) {
    return [];
  }

  const counts = new Map<string, number>();
  const selected: LogEntry[] = [];

  for (const entry of entries) {
    const key = entry.subject ?? "__none__";
    const current = counts.get(key) ?? 0;
    if (current >= maxPerSubject) {
      continue;
    }

    counts.set(key, current + 1);
    selected.push(entry);
  }

  return selected;
}

function rankEntries(
  entries: LogEntry[],
  nowMs: number,
  eventUsage: Record<string, EventUsageState>,
  opts: {
    limit: number;
    perSubjectLimit: number;
    openBonus?: number;
  },
): LogEntry[] {
  return applyPerSubjectCap(
    entries
      .map((entry) => ({
        entry,
        score: entrySignalScore(entry, nowMs, eventUsage[entry.id], opts.openBonus ?? 0),
      }))
      .sort(sortBySignalThenTimestamp)
      .map((candidate) => candidate.entry),
    opts.perSubjectLimit,
  ).slice(0, Math.max(1, opts.limit));
}

function buildDurableEntries(
  entries: LogEntry[],
  activeEntries: LogEntry[],
  config: PluginConfig["briefing"],
  nowMs: number,
  eventUsage: Record<string, EventUsageState>,
): LogEntry[] {
  const activeIds = new Set(activeEntries.map((entry) => entry.id));

  return applyPerSubjectCap(
    entries
      .filter((entry) => !activeIds.has(entry.id))
      .filter((entry) => !isWithinDays(entry, nowMs, config.activeWindow))
      .filter((entry) => entry.type === "decision" || entry.type === "fact")
      .map((entry) => ({
        entry,
        score: computeUsageScore(eventUsage[entry.id]),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(sortBySignalThenTimestamp)
      .map((candidate) => candidate.entry),
    DURABLE_PER_SUBJECT_LIMIT,
  ).slice(0, DURABLE_ENTRY_LIMIT);
}

function buildStaleSubjectEntries(
  entries: LogEntry[],
  config: PluginConfig["briefing"],
  nowMs: number,
  eventUsage: Record<string, EventUsageState>,
): LogEntry[] {
  const staleCutoff = nowMs - config.staleThreshold * DAY_MS;

  const statsBySubject = new Map<string, {
    latestEntry: LogEntry;
    latestTimestampMs: number;
    entryCount: number;
    usageScore: number;
  }>();

  for (const entry of entries) {
    if (!entry.subject) {
      continue;
    }

    const timestampMs = parseTimestamp(entry.timestamp) ?? 0;
    const usageScore = computeUsageScore(eventUsage[entry.id]);
    const current = statsBySubject.get(entry.subject);

    if (!current) {
      statsBySubject.set(entry.subject, {
        latestEntry: entry,
        latestTimestampMs: timestampMs,
        entryCount: 1,
        usageScore,
      });
      continue;
    }

    current.entryCount += 1;
    current.usageScore += usageScore;

    if (timestampMs >= current.latestTimestampMs) {
      current.latestEntry = entry;
      current.latestTimestampMs = timestampMs;
    }
  }

  return [...statsBySubject.values()]
    .filter((subject) => subject.latestTimestampMs < staleCutoff)
    .filter((subject) => subject.entryCount >= 3 || subject.usageScore > 0)
    .sort((left, right) => {
      const leftScore = left.usageScore + Math.min(left.entryCount, 10) * 0.5;
      const rightScore = right.usageScore + Math.min(right.entryCount, 10) * 0.5;
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }

      return right.latestTimestampMs - left.latestTimestampMs;
    })
    .slice(0, STALE_SUBJECT_LIMIT)
    .map((subject) => subject.latestEntry);
}

function buildBriefingBuckets(
  entries: LogEntry[],
  config: PluginConfig["briefing"],
  nowMs: number,
  eventUsage: Record<string, EventUsageState>,
): BriefingBuckets {
  const activeEntries = rankEntries(
    entries
      .filter((entry) => isWithinDays(entry, nowMs, config.activeWindow))
      .filter((entry) => entry.type !== "handoff")
      .filter((entry) =>
        entry.type !== "fact" ||
        computeUsageScore(eventUsage[entry.id]) > 0 ||
        ageInDays(entry, nowMs) <= ACTIVE_FACT_RECENCY_DAYS
      ),
    nowMs,
    eventUsage,
    {
      limit: ACTIVE_ENTRY_LIMIT,
      perSubjectLimit: ACTIVE_PER_SUBJECT_LIMIT,
    },
  );
  const activeSubjects = new Set(
    activeEntries
      .map((entry) => entry.subject)
      .filter((subject): subject is string => typeof subject === "string" && subject.length > 0),
  );

  const openItems = rankEntries(
    entries
      .filter(isOpenItem)
      .filter((entry) =>
        isWithinDays(entry, nowMs, OPEN_ITEM_RECENCY_DAYS) ||
        computeUsageScore(eventUsage[entry.id]) > 0 ||
        (entry.subject ? activeSubjects.has(entry.subject) : false)
      ),
    nowMs,
    eventUsage,
    {
      limit: OPEN_ITEM_LIMIT,
      perSubjectLimit: OPEN_PER_SUBJECT_LIMIT,
      openBonus: 2,
    },
  );

  const staleSubjects = buildStaleSubjectEntries(entries, config, nowMs, eventUsage);
  const durableEntries = buildDurableEntries(entries, activeEntries, config, nowMs, eventUsage);

  const selectedById = new Map<string, LogEntry>();
  for (const entry of [...activeEntries, ...openItems, ...staleSubjects, ...durableEntries]) {
    selectedById.set(entry.id, entry);
  }
  const selectedEntries = [...selectedById.values()].sort((left, right) =>
    (parseTimestamp(right.timestamp) ?? 0) - (parseTimestamp(left.timestamp) ?? 0)
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
  staleSubjects: LogEntry[];
  durableEntries: LogEntry[];
  selectedEntries: LogEntry[];
}): string {
  const activeCounts = countByType(params.activeEntries);
  const openCounts = countByType(params.openItems);
  const staleCounts = countByType(params.staleSubjects);
  const durableCounts = countByType(params.durableEntries);
  const selectedCounts = countByType(params.selectedEntries);

  return [
    `- active_entries=${params.activeEntries.length} | active_types=${formatTypeCounts(activeCounts) || "n/a"}`,
    `- open_items=${params.openItems.length} | open_types=${formatTypeCounts(openCounts) || "n/a"}`,
    `- stale_subjects=${params.staleSubjects.length} | stale_types=${formatTypeCounts(staleCounts) || "n/a"}`,
    `- durable_entries=${params.durableEntries.length} | durable_types=${formatTypeCounts(durableCounts) || "n/a"}`,
    `- selected_entries=${params.selectedEntries.length} | selected_types=${formatTypeCounts(selectedCounts) || "n/a"}`,
  ].join("\n");
}

function formatBucketEntries(entries: LogEntry[]): string {
  return entries.length > 0 ? entries.map(formatEntryWithId).join("\n") : "- n/a";
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
    const result = await runIsolatedModelTaskWithMeta({
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
    return {
      output: result.output,
      ...(result.sessionId ? { workerSessionId: result.sessionId } : {}),
      ...(result.sessionKey ? { workerSessionKey: result.sessionKey } : {}),
    };
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
): Promise<BriefingGenerationResult> {
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
    formatBucketEntries(buckets.activeEntries),
    "",
    "## Open Items",
    formatBucketEntries(buckets.openItems),
    "",
    "## Stale Subjects",
    formatBucketEntries(buckets.staleSubjects),
    "",
    "## Durable Entries",
    formatBucketEntries(buckets.durableEntries),
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
      staleSubjects: buckets.staleSubjects,
      durableEntries: buckets.durableEntries,
      selectedEntries: buckets.selectedEntries,
    }),
    "",
    `Constraints: activeWindow=${opts.config.briefing.activeWindow}, staleThreshold=${opts.config.briefing.staleThreshold}, maxLines=${opts.config.briefing.maxLines}`,
  ].join("\n");

  const modelResult = await resolvedDeps.callBriefingModel({
    prompt,
    model: opts.config.briefing.model,
    apiBaseUrl: opts.apiBaseUrl,
    apiToken: opts.apiToken,
    userInput,
  });
  const outputRecord =
    typeof modelResult === "string"
      ? { output: modelResult }
      : modelResult;
  const rawGenerated = outputRecord.output;

  const generated = limitLines(rawGenerated, opts.config.briefing.maxLines);
  const updatedMemory = applyGeneratedBlock(memoryContent, generated);

  await resolvedDeps.writeMemoryFile(opts.memoryMdPath, updatedMemory);

  return {
    ...(outputRecord.workerSessionId ? { workerSessionId: outputRecord.workerSessionId } : {}),
    ...(outputRecord.workerSessionKey ? { workerSessionKey: outputRecord.workerSessionKey } : {}),
  };
}

export const __briefingTestExports = {
  applyGeneratedBlock,
  buildBriefingBuckets,
  extractGeneratedBlock,
  limitLines,
};
