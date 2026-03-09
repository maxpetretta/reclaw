import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { isEnoent } from "../lib/guards";
import { readLog, type LogEntry } from "../log/schema";

export const SESSION_SUMMARY_PROJECTION_DIRNAME = "sessions";

function normalizeProjectionDir(projectionDir: string): string {
  const normalized = projectionDir.trim();
  if (!normalized) {
    throw new Error("projectionDir must be a non-empty string");
  }

  return normalized;
}

function isSessionSummary(entry: LogEntry): boolean {
  return entry.type === "session_summary";
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

function renderSessionSummaryMarkdown(entry: LogEntry, generatedAt: string): string {
  return [
    `# Session ${entry.session}`,
    "",
    `- Session: \`${entry.session}\``,
    `- Event: \`${entry.id}\``,
    `- Timestamp: \`${entry.timestamp}\``,
    `- Type: \`${entry.type}\``,
    `- Generated: \`${generatedAt}\``,
    "",
    "## Summary",
    "",
    entry.content,
    ...(entry.detail
      ? [
          "",
          "## Details",
          "",
          entry.detail,
        ]
      : []),
    "",
  ].join("\n");
}

function resolveFilePath(projectionDir: string, sessionId: string): string {
  return join(normalizeProjectionDir(projectionDir), `${sessionId}.md`);
}

async function listProjectionSessionIds(projectionDir: string): Promise<string[]> {
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

export async function ensureSessionSummaryProjectionDir(projectionDir: string): Promise<string> {
  const normalizedProjectionDir = normalizeProjectionDir(projectionDir);
  await mkdir(normalizedProjectionDir, { recursive: true });
  return normalizedProjectionDir;
}

export async function refreshSessionSummaryProjections(params: {
  projectionDir: string;
  logPath: string;
  sessionIds?: string[];
}): Promise<void> {
  const normalizedProjectionDir = await ensureSessionSummaryProjectionDir(params.projectionDir);
  const allEntries = (await readLog(params.logPath)).filter(isSessionSummary);
  const latestBySession = new Map<string, LogEntry>();

  for (const entry of sortEntriesChronologically(allEntries)) {
    latestBySession.set(entry.session, entry);
  }

  const targetSessionIds = Array.isArray(params.sessionIds) && params.sessionIds.length > 0
    ? [...new Set(params.sessionIds.map((sessionId) => sessionId.trim()).filter((sessionId) => sessionId.length > 0))]
    : [...latestBySession.keys()].sort((left, right) => left.localeCompare(right));

  const generatedAt = new Date().toISOString();
  for (const sessionId of targetSessionIds) {
    const entry = latestBySession.get(sessionId);
    if (!entry) {
      try {
        await rm(resolveFilePath(normalizedProjectionDir, sessionId));
      } catch (error) {
        if (!isEnoent(error)) {
          throw error;
        }
      }
      continue;
    }

    await writeFile(
      resolveFilePath(normalizedProjectionDir, sessionId),
      renderSessionSummaryMarkdown(entry, generatedAt),
      "utf8",
    );
  }

  if (!Array.isArray(params.sessionIds) || params.sessionIds.length === 0) {
    const existingSessionIds = await listProjectionSessionIds(normalizedProjectionDir);
    const expected = new Set(latestBySession.keys());
    for (const sessionId of existingSessionIds) {
      if (expected.has(sessionId)) {
        continue;
      }

      await rm(resolveFilePath(normalizedProjectionDir, sessionId));
    }
  }
}
