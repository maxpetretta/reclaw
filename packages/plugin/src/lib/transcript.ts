import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawHome } from "./runtime-env";
import { extractTextContent } from "./text";

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

function isUserAssistantRole(value: unknown): value is "user" | "assistant" {
  return value === "user" || value === "assistant";
}

function parseMessageLine(line: string): TranscriptMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== "message") {
    return null;
  }

  const messageValue = record.message;
  if (!messageValue || typeof messageValue !== "object") {
    return null;
  }

  const message = messageValue as Record<string, unknown>;
  if (!isUserAssistantRole(message.role)) {
    return null;
  }

  const content = extractTextContent(message.content);
  if (!content) {
    return null;
  }

  const timestamp =
    typeof record.timestamp === "string"
      ? record.timestamp
      : typeof message.timestamp === "string"
        ? message.timestamp
        : new Date(0).toISOString();

  return {
    role: message.role,
    content,
    timestamp,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function isResetVariantSessionFile(name: string, sessionId: string): boolean {
  return (
    (name.startsWith(`${sessionId}.reset.`) && name.endsWith(".jsonl")) ||
    name.startsWith(`${sessionId}.jsonl.reset.`)
  );
}

export function parseSessionIdFromTranscriptFileName(fileName: string): string | null {
  if (!fileName.endsWith(".jsonl") && !fileName.includes(".jsonl.reset.")) {
    return null;
  }

  const jsonlResetIndex = fileName.indexOf(".jsonl.reset.");
  if (jsonlResetIndex > 0) {
    return fileName.slice(0, jsonlResetIndex);
  }

  const resetIndex = fileName.indexOf(".reset.");
  if (resetIndex > 0 && fileName.endsWith(".jsonl")) {
    return fileName.slice(0, resetIndex);
  }

  if (fileName.endsWith(".jsonl") && !fileName.includes(".reset.")) {
    return fileName.slice(0, -6);
  }

  return null;
}

export async function readTranscript(sessionFile: string): Promise<TranscriptMessage[]> {
  const content = await readFile(sessionFile, "utf8");
  const messages: TranscriptMessage[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const message = parseMessageLine(trimmed);
    if (message) {
      messages.push(message);
    }
  }

  return messages;
}

export async function findTranscriptFile(agentId: string, sessionId: string): Promise<string | null> {
  if (!agentId || !sessionId) {
    return null;
  }

  return await findTranscriptFileForHome(resolveOpenClawHome(), agentId, sessionId);
}

export async function findTranscriptFileForHome(
  openClawHome: string,
  agentId: string,
  sessionId: string,
): Promise<string | null> {
  if (!openClawHome || !agentId || !sessionId) {
    return null;
  }

  const sessionsDir = join(openClawHome, "agents", agentId, "sessions");
  const primaryPath = join(sessionsDir, `${sessionId}.jsonl`);

  if (await pathExists(primaryPath)) {
    return primaryPath;
  }

  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return null;
  }

  const candidates = files.filter((name) => isResetVariantSessionFile(name, sessionId));
  if (candidates.length === 0) {
    return null;
  }

  let latestPath: string | null = null;
  let latestMtime = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const candidatePath = join(sessionsDir, candidate);
    try {
      const fileStat = await stat(candidatePath);
      if (fileStat.mtimeMs > latestMtime) {
        latestMtime = fileStat.mtimeMs;
        latestPath = candidatePath;
      }
    } catch {
      // Ignore missing/deleted files while sweeping candidates.
    }
  }

  return latestPath;
}

export function formatTranscript(messages: TranscriptMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}
