import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { isEnoent } from "../lib/guards";
import { isOpenItem } from "../log/query";
import { readLog, type LogEntry } from "../log/schema";
import { readRegistry, slugToDisplay, type SubjectRegistry } from "../subjects/registry";

export const SUBJECT_PROJECTION_ROOT_DIRNAME = "reclaw-memory";
export const SUBJECT_PROJECTION_SUBDIR = "subjects";

export interface SubjectProjectionPaths {
  projectionRootDir: string;
  subjectProjectionDir: string;
}

export interface SubjectProjectionRefreshResult {
  subjectProjectionDir: string;
  refreshedSubjects: string[];
  removedSubjects: string[];
}

export interface SubjectProjectionFile {
  slug: string;
  path: string;
}

function normalizeWorkspaceDir(workspaceDir: string): string {
  const normalized = workspaceDir.trim();
  if (!normalized) {
    throw new Error("workspaceDir must be a non-empty string");
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

function renderOpenItems(entries: LogEntry[]): string[] {
  const openItems = sortEntriesChronologically(entries.filter(isOpenItem));
  if (openItems.length === 0) {
    return ["- No open items recorded."];
  }

  return openItems.map((entry) => {
    const typeLabel = entry.type === "task" ? `${entry.type}/${entry.status}` : entry.type;
    return `- [${typeLabel}] ${entry.content} (\`${entry.id}\`)`;
  });
}

function renderTimelineEntry(entry: LogEntry): string[] {
  const typeLabel = entry.type === "task" ? `${entry.type}/${entry.status}` : entry.type;
  const lines = [`- ${entry.timestamp} [${typeLabel}] ${entry.content} (\`${entry.id}\`)`];

  if (entry.detail) {
    lines.push(`  - Detail: ${entry.detail}`);
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
  const timelineLines =
    orderedEntries.length > 0
      ? orderedEntries.flatMap((entry) => renderTimelineEntry(entry))
      : ["- No events recorded yet."];

  return [
    `# ${readSubjectHeading(params.slug, params.registry)}`,
    "",
    `- Subject: \`${params.slug}\``,
    `- Type: \`${readSubjectType(params.slug, params.registry)}\``,
    `- Generated: \`${generatedAt}\``,
    "",
    "## Open Items",
    "",
    ...renderOpenItems(orderedEntries),
    "",
    "## Timeline",
    "",
    ...timelineLines,
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

async function listProjectionSlugs(subjectProjectionDir: string): Promise<string[]> {
  try {
    const items = await readdir(subjectProjectionDir, { withFileTypes: true });
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

export function resolveSubjectProjectionPaths(workspaceDir: string): SubjectProjectionPaths {
  const normalizedWorkspaceDir = normalizeWorkspaceDir(workspaceDir);
  const projectionRootDir = join(normalizedWorkspaceDir, SUBJECT_PROJECTION_ROOT_DIRNAME);
  return {
    projectionRootDir,
    subjectProjectionDir: join(projectionRootDir, SUBJECT_PROJECTION_SUBDIR),
  };
}

export function resolveSubjectProjectionFilePath(workspaceDir: string, slug: string): string {
  return join(resolveSubjectProjectionPaths(workspaceDir).subjectProjectionDir, `${slug}.md`);
}

export async function ensureSubjectProjectionDir(workspaceDir: string): Promise<string> {
  const { subjectProjectionDir } = resolveSubjectProjectionPaths(workspaceDir);
  await mkdir(subjectProjectionDir, { recursive: true });
  return subjectProjectionDir;
}

export async function removeSubjectProjection(workspaceDir: string, slug: string): Promise<void> {
  try {
    await rm(resolveSubjectProjectionFilePath(workspaceDir, slug));
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }

    throw error;
  }
}

export async function listSubjectProjectionFiles(workspaceDir: string): Promise<SubjectProjectionFile[]> {
  const { subjectProjectionDir } = resolveSubjectProjectionPaths(workspaceDir);
  return (await listProjectionSlugs(subjectProjectionDir)).map((slug) => ({
    slug,
    path: join(subjectProjectionDir, `${slug}.md`),
  }));
}

export async function refreshSubjectProjections(params: {
  workspaceDir: string;
  logPath: string;
  subjectsPath: string;
  subjects?: string[];
}): Promise<SubjectProjectionRefreshResult> {
  const normalizedWorkspaceDir = normalizeWorkspaceDir(params.workspaceDir);
  const { subjectProjectionDir } = resolveSubjectProjectionPaths(normalizedWorkspaceDir);
  await mkdir(subjectProjectionDir, { recursive: true });

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
    await writeFile(resolveSubjectProjectionFilePath(normalizedWorkspaceDir, subject), projection, "utf8");
    refreshedSubjects.push(subject);
  }

  const removedSubjects: string[] = [];
  if (!Array.isArray(params.subjects) || params.subjects.length === 0) {
    const existingProjectionSlugs = await listProjectionSlugs(subjectProjectionDir);
    const expectedSubjects = new Set(targetSubjects);
    for (const slug of existingProjectionSlugs) {
      if (expectedSubjects.has(slug)) {
        continue;
      }

      await removeSubjectProjection(normalizedWorkspaceDir, slug);
      removedSubjects.push(slug);
    }
  }

  return {
    subjectProjectionDir,
    refreshedSubjects,
    removedSubjects,
  };
}
