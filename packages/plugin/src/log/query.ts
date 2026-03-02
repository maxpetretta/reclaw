import { open, readFile } from "node:fs/promises";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk";
import { isEnoent } from "../lib/guards";
import { readLog, type EntryType, type LogEntry, validateEntry } from "./schema";

export interface LogQueryFilter {
  type?: EntryType;
  subject?: string;
  status?: "open" | "done";
  session?: string;
  from?: string;
  to?: string;
}


function matchesKeyword(entry: LogEntry, keyword: string): boolean {
  const normalized = keyword.toLowerCase();
  return (
    entry.content.toLowerCase().includes(normalized) ||
    (entry.detail ? entry.detail.toLowerCase().includes(normalized) : false)
  );
}

function matchesFilter(entry: LogEntry, filter: LogQueryFilter): boolean {
  if (filter.type && entry.type !== filter.type) {
    return false;
  }

  if (filter.subject && entry.subject !== filter.subject) {
    return false;
  }

  if (filter.session && entry.session !== filter.session) {
    return false;
  }

  const entryTimestamp = Date.parse(entry.timestamp);
  if (filter.from) {
    const from = Date.parse(filter.from);
    if (Number.isFinite(from) && Number.isFinite(entryTimestamp) && entryTimestamp < from) {
      return false;
    }
  }

  if (filter.to) {
    const to = Date.parse(filter.to);
    if (Number.isFinite(to) && Number.isFinite(entryTimestamp) && entryTimestamp > to) {
      return false;
    }
  }

  if (filter.status) {
    if (entry.type !== "task") {
      return false;
    }

    if (entry.status !== filter.status) {
      return false;
    }
  }

  return true;
}

function sortByTimestampDesc(a: LogEntry, b: LogEntry): number {
  return Date.parse(b.timestamp) - Date.parse(a.timestamp);
}

function getCurrentEntries(allEntries: LogEntry[]): LogEntry[] {
  return [...allEntries].sort(sortByTimestampDesc);
}

function normalizeSubjectList(subjects: string[]): Set<string> {
  const normalized = subjects
    .map((subject) => subject.trim())
    .filter((subject) => subject.length > 0);
  return new Set(normalized);
}

export function isOpenItem(entry: LogEntry): boolean {
  return (entry.type === "task" && entry.status === "open") || entry.type === "question";
}

function selectSubjectEntries(entries: LogEntry[], subjects: Set<string>): LogEntry[] {
  if (subjects.size === 0) {
    return [];
  }

  return entries.filter((entry) => entry.subject && subjects.has(entry.subject));
}

function selectOpenItems(entries: LogEntry[]): LogEntry[] {
  return entries.filter(isOpenItem);
}

function capPerSubject(entries: LogEntry[], maxPerSubject: number): LogEntry[] {
  if (!Number.isFinite(maxPerSubject) || maxPerSubject <= 0) {
    return [];
  }

  const counts = new Map<string, number>();
  const limited: LogEntry[] = [];

  for (const entry of entries) {
    if (!entry.subject) {
      continue;
    }

    const current = counts.get(entry.subject) ?? 0;
    if (current >= maxPerSubject) {
      continue;
    }

    counts.set(entry.subject, current + 1);
    limited.push(entry);
  }

  return limited;
}

function unionById(...groups: LogEntry[][]): LogEntry[] {
  const byId = new Map<string, LogEntry>();

  for (const group of groups) {
    for (const entry of group) {
      byId.set(entry.id, entry);
    }
  }

  return [...byId.values()].sort(sortByTimestampDesc);
}

async function ripgrepSearch(logPath: string, keyword: string): Promise<Set<string> | null> {
  const result = await runPluginCommandWithTimeout({
    argv: ["rg", "--fixed-strings", "--ignore-case", "--line-number", "--no-heading", keyword, logPath],
    timeoutMs: 2000,
  });

  if (result.code !== 0 && result.code !== 1) {
    return null;
  }

  // rg uses exit code 1 for no matches; treat stderr as "command failed" for fallback.
  if (result.code === 1 && result.stderr.trim().length > 0) {
    return null;
  }

  if (result.stdout.trim().length === 0) {
    return new Set();
  }

  const ids = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }

    const jsonLine = line.slice(separatorIndex + 1).trim();
    if (!jsonLine) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonLine);
    } catch {
      continue;
    }

    const validated = validateEntry(parsed);
    if (!validated.ok) {
      continue;
    }

    if (matchesKeyword(validated.entry, keyword)) {
      ids.add(validated.entry.id);
    }
  }

  return ids;
}

function fallbackKeywordSearch(entries: LogEntry[], keyword: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (matchesKeyword(entry, keyword)) {
      ids.add(entry.id);
    }
  }
  return ids;
}

function applyFilterAndResolution(
  allEntries: LogEntry[],
  candidateIds: Set<string> | null,
  filter: LogQueryFilter,
): LogEntry[] {
  return allEntries
    .filter((entry) => {
      if (candidateIds && !candidateIds.has(entry.id)) {
        return false;
      }

      return matchesFilter(entry, filter);
    })
    .sort(sortByTimestampDesc);
}

function parseLine(line: string): LogEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  const validated = validateEntry(parsed);
  return validated.ok ? validated.entry : undefined;
}

export async function queryLog(logPath: string, filter: LogQueryFilter): Promise<LogEntry[]> {
  const allEntries = await readLog(logPath);
  return applyFilterAndResolution(allEntries, null, filter);
}

export async function queryById(logPath: string, id: string): Promise<LogEntry | undefined> {
  if (!id.trim()) {
    return undefined;
  }

  let content: string;
  try {
    content = await readFile(logPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }

  for (const line of content.split("\n")) {
    const entry = parseLine(line);
    if (!entry) {
      continue;
    }

    if (entry.id === id) {
      return entry;
    }
  }

  return undefined;
}

export async function queryByIds(logPath: string, ids: string[]): Promise<LogEntry[]> {
  const normalizedIds = [...new Set(
    ids
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  )];
  if (normalizedIds.length === 0) {
    return [];
  }

  let content: string;
  try {
    content = await readFile(logPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }

  const idSet = new Set(normalizedIds);
  const entries: LogEntry[] = [];

  for (const line of content.split("\n")) {
    const entry = parseLine(line);
    if (!entry || !idSet.has(entry.id)) {
      continue;
    }
    entries.push(entry);
  }

  return entries.sort(sortByTimestampDesc);
}

export async function queryBySubjects(logPath: string, subjects: string[]): Promise<LogEntry[]> {
  const normalizedSubjects = normalizeSubjectList(subjects);
  if (normalizedSubjects.size === 0) {
    return [];
  }

  const allEntries = await readLog(logPath);
  const currentEntries = getCurrentEntries(allEntries);
  return selectSubjectEntries(currentEntries, normalizedSubjects);
}

export async function queryOpenItems(logPath: string): Promise<LogEntry[]> {
  const allEntries = await readLog(logPath);
  const currentEntries = getCurrentEntries(allEntries);
  return selectOpenItems(currentEntries);
}

export async function queryExtractionContext(
  logPath: string,
  subjects: string[],
  opts: { maxPerSubject?: number } = {},
): Promise<LogEntry[]> {
  const allEntries = await readLog(logPath);
  const currentEntries = getCurrentEntries(allEntries);
  const normalizedSubjects = normalizeSubjectList(subjects);
  const openItems = selectOpenItems(currentEntries);
  const subjectEntries = selectSubjectEntries(currentEntries, normalizedSubjects);

  // Keep extraction context bounded if subject history grows very large.
  const maxPerSubject =
    typeof opts.maxPerSubject === "number" && Number.isFinite(opts.maxPerSubject)
      ? Math.max(0, Math.floor(opts.maxPerSubject))
      : 50;

  const cappedSubjectEntries = capPerSubject(subjectEntries, maxPerSubject);
  return unionById(cappedSubjectEntries, openItems);
}

export async function searchLog(
  logPath: string,
  keyword: string,
  filter: LogQueryFilter = {},
): Promise<LogEntry[]> {
  const trimmedKeyword = keyword.trim();
  if (!trimmedKeyword) {
    return [];
  }

  const allEntries = await readLog(logPath);
  if (allEntries.length === 0) {
    return [];
  }

  const rgIds = await ripgrepSearch(logPath, trimmedKeyword);
  const candidateIds = rgIds ?? fallbackKeywordSearch(allEntries, trimmedKeyword);

  return applyFilterAndResolution(allEntries, candidateIds, filter);
}

export async function getLastHandoff(logPath: string): Promise<LogEntry | undefined> {
  let fileHandle: Awaited<ReturnType<typeof open>>;

  try {
    fileHandle = await open(logPath, "r");
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }

    throw error;
  }

  try {
    const { size } = await fileHandle.stat();
    if (size === 0) {
      return undefined;
    }

    const chunkSize = 64 * 1024;
    let position = size;
    let remainder = "";

    while (position > 0) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;

      const buffer = Buffer.alloc(readSize);
      await fileHandle.read(buffer, 0, readSize, position);

      const text = buffer.toString("utf8") + remainder;
      const lines = text.split("\n");
      remainder = lines.shift() ?? "";

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = parseLine(lines[index] ?? "");
        if (entry?.type === "handoff") {
          return entry;
        }
      }
    }

    const finalEntry = parseLine(remainder);
    if (finalEntry?.type === "handoff") {
      return finalEntry;
    }

    return undefined;
  } finally {
    await fileHandle.close();
  }
}
