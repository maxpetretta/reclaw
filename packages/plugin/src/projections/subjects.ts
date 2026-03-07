import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { isEnoent } from "../lib/guards";
import { readLog, type LogEntry } from "../log/schema";
import { readRegistry, slugToDisplay, type SubjectRegistry } from "../subjects/registry";

export const SUBJECT_PROJECTION_DIRNAME = "memory";

export interface SubjectProjectionRefreshResult {
  projectionDir: string;
  refreshedSubjects: string[];
  removedSubjects: string[];
}

export interface SubjectProjectionFile {
  slug: string;
  path: string;
}

function normalizeProjectionDir(projectionDir: string): string {
  const normalized = projectionDir.trim();
  if (!normalized) {
    throw new Error("projectionDir must be a non-empty string");
  }

  return normalized;
}

function sortEntriesChronologically(entries: LogEntry[]): LogEntry[] {
  return [...entries].sort((left, right) => {
    const leftTimestamp = Date.parse(left.timestamp);
    const rightTimestamp = Date.parse(right.timestamp);
    if (Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp) && leftTimestamp !== rightTimestamp) {
      return leftTimestamp - rightTimestamp;
    }

    return left.id.localeCompare(right.id);
  });
}

function readSubjectHeading(slug: string, registry: SubjectRegistry): string {
  return registry[slug]?.display ?? slugToDisplay(slug);
}

function readSubjectType(slug: string, registry: SubjectRegistry): string {
  return registry[slug]?.type ?? "topic";
}

function formatProjectionEntryType(entry: LogEntry): string {
  if (entry.type === "task") {
    return entry.status === "done" ? "Task/Done" : "Task/Open";
  }

  return `${entry.type.charAt(0).toUpperCase()}${entry.type.slice(1)}`;
}

function formatProjectionEntryDate(timestamp: string): string {
  const parsedTimestamp = Date.parse(timestamp);
  if (!Number.isFinite(parsedTimestamp)) {
    return timestamp.trim();
  }

  return new Date(parsedTimestamp).toISOString().slice(0, 10);
}

function renderEventBlock(entry: LogEntry): string[] {
  const lines = [`### ${formatProjectionEntryType(entry)} | ${formatProjectionEntryDate(entry.timestamp)} | ${entry.id}`, ""];
  lines.push(entry.content);
  if (entry.detail) {
    lines.push("", `Detail: ${entry.detail}`);
  }
  return lines;
}

export function renderSubjectProjectionMarkdown(params: {
  slug: string;
  registry: SubjectRegistry;
  entries: LogEntry[];
  generatedAt?: string;
}): string {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const orderedEntries = sortEntriesChronologically(params.entries);
  const eventLines =
    orderedEntries.length > 0
      ? orderedEntries.flatMap((entry, index) => {
          const blockLines = renderEventBlock(entry);
          if (index < orderedEntries.length - 1) {
            blockLines.push("");
          }
          return blockLines;
        })
      : ["No events recorded yet."];

  return [
    `# ${readSubjectHeading(params.slug, params.registry)}`,
    "",
    `- Subject: \`${params.slug}\``,
    `- Type: \`${readSubjectType(params.slug, params.registry)}\``,
    `- Generated: \`${generatedAt}\``,
    "",
    "## Events",
    "",
    ...eventLines,
    "",
  ].join("\n");
}

function groupEntriesBySubject(entries: LogEntry[]): Map<string, LogEntry[]> {
  const grouped = new Map<string, LogEntry[]>();

  for (const entry of entries) {
    const subject = typeof entry.subject === "string" ? entry.subject.trim() : "";
    if (!subject) {
      continue;
    }

    const existing = grouped.get(subject) ?? [];
    existing.push(entry);
    grouped.set(subject, existing);
  }

  return grouped;
}

async function listProjectionSlugs(projectionDir: string): Promise<string[]> {
  try {
    const items = await readdir(projectionDir, { withFileTypes: true });
    return items
      .filter((item) => item.isFile() && extname(item.name) === ".md")
      .map((item) => basename(item.name, ".md"))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }

    throw error;
  }
}

export function resolveSubjectProjectionFilePath(projectionDir: string, slug: string): string {
  return join(normalizeProjectionDir(projectionDir), `${slug}.md`);
}

export async function ensureSubjectProjectionDir(projectionDir: string): Promise<string> {
  const normalizedProjectionDir = normalizeProjectionDir(projectionDir);
  await mkdir(normalizedProjectionDir, { recursive: true });
  return normalizedProjectionDir;
}

export async function removeSubjectProjection(projectionDir: string, slug: string): Promise<void> {
  try {
    await rm(resolveSubjectProjectionFilePath(projectionDir, slug));
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }

    throw error;
  }
}

export async function listSubjectProjectionFiles(projectionDir: string): Promise<SubjectProjectionFile[]> {
  const normalizedProjectionDir = normalizeProjectionDir(projectionDir);
  return (await listProjectionSlugs(normalizedProjectionDir)).map((slug) => ({
    slug,
    path: join(normalizedProjectionDir, `${slug}.md`),
  }));
}

export async function refreshSubjectProjections(params: {
  projectionDir: string;
  logPath: string;
  subjectsPath: string;
  subjects?: string[];
}): Promise<SubjectProjectionRefreshResult> {
  const normalizedProjectionDir = normalizeProjectionDir(params.projectionDir);
  await mkdir(normalizedProjectionDir, { recursive: true });

  const [registry, entries] = await Promise.all([
    readRegistry(params.subjectsPath),
    readLog(params.logPath),
  ]);
  const entriesBySubject = groupEntriesBySubject(entries);
  const allSubjects = new Set<string>([
    ...Object.keys(registry),
    ...entriesBySubject.keys(),
  ]);
  const targetSubjects = Array.isArray(params.subjects) && params.subjects.length > 0
    ? [...new Set(
        params.subjects
          .map((subject) => subject.trim())
          .filter((subject) => subject.length > 0),
      )].filter((subject) => allSubjects.has(subject))
    : [...allSubjects].sort((left, right) => left.localeCompare(right));

  const refreshedSubjects: string[] = [];
  const generatedAt = new Date().toISOString();

  for (const subject of targetSubjects) {
    const projection = renderSubjectProjectionMarkdown({
      slug: subject,
      registry,
      entries: entriesBySubject.get(subject) ?? [],
      generatedAt,
    });
    await writeFile(resolveSubjectProjectionFilePath(normalizedProjectionDir, subject), projection, "utf8");
    refreshedSubjects.push(subject);
  }

  const removedSubjects: string[] = [];
  if (!Array.isArray(params.subjects) || params.subjects.length === 0) {
    const existingProjectionSlugs = await listProjectionSlugs(normalizedProjectionDir);
    const expectedSubjects = new Set(targetSubjects);
    for (const slug of existingProjectionSlugs) {
      if (expectedSubjects.has(slug)) {
        continue;
      }

      await removeSubjectProjection(normalizedProjectionDir, slug);
      removedSubjects.push(slug);
    }
  }

  return {
    projectionDir: normalizedProjectionDir,
    refreshedSubjects,
    removedSubjects,
  };
}
