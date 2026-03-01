import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { readTranscript } from "../../lib/transcript";
import type { ImportedConversation, ImportedMessage } from "../types";

export interface OpenClawTranscriptSource {
  sessionId: string;
  agentId: string;
  messages: ImportedMessage[];
}

export interface OpenClawFileSource {
  relativePath: string;
  absolutePath: string;
  createdAt: string;
  updatedAt: string;
  content: string;
  transcript?: OpenClawTranscriptSource;
}

export interface OpenClawImportSource {
  kind: "openclaw";
  rootDir: string;
  files: OpenClawFileSource[];
}

export interface LoadOpenClawImportSourceOptions {
  openClawHome?: string;
  preferredAgentId?: string;
}

function resolveOpenClawHome(override?: string): string {
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }

  const envOverride = process.env.OPENCLAW_HOME?.trim();
  if (envOverride) {
    return envOverride;
  }

  return join(homedir(), ".openclaw");
}

function normalizeText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function toIso(value: number, fallback: string): string {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return new Date(value).toISOString();
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) {
    return markdown;
  }

  const closingIndex = markdown.indexOf("\n---\n", 4);
  if (closingIndex < 0) {
    return markdown;
  }

  return markdown.slice(closingIndex + 5);
}

function extractSessionCandidates(content: string): string[] {
  const discovered: string[] = [];
  const seen = new Set<string>();

  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length < 3 || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    discovered.push(trimmed);
  };

  const patterns: RegExp[] = [
    /session:\s*([A-Za-z0-9:_-]{3,})/g,
    /sessionId[:=]\s*["']?([A-Za-z0-9:_-]{3,})["']?/gi,
    /"session"\s*:\s*"([A-Za-z0-9:_-]{3,})"/g,
    /agent:[A-Za-z0-9_-]+:([A-Za-z0-9:_-]{3,})/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const sessionId = match[1];
      if (sessionId) {
        add(sessionId);
      }
    }
  }

  const lines = content.split(/\r?\n/u);
  let inSessionsBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+sessions\b/iu.test(trimmed)) {
      inSessionsBlock = true;
      continue;
    }

    if (inSessionsBlock && /^##\s+/u.test(trimmed)) {
      inSessionsBlock = false;
      continue;
    }

    if (!inSessionsBlock) {
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+([A-Za-z0-9:_-]{3,})\b/u);
    if (bulletMatch && bulletMatch[1]) {
      add(bulletMatch[1]);
    }
  }

  return discovered;
}

async function listMarkdownFiles(rootDir: string): Promise<string[]> {
  const stack = [rootDir];
  const files: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!(entry.isFile() && entry.name.toLowerCase().endsWith(".md"))) {
        continue;
      }

      files.push(relative(rootDir, absolutePath));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function listAgentIds(openClawHome: string): Promise<string[]> {
  try {
    const agentsDir = join(openClawHome, "agents");
    const entries = await readdir(agentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function isResetVariant(name: string, sessionId: string): boolean {
  return (
    (name.startsWith(`${sessionId}.reset.`) && name.endsWith(".jsonl")) ||
    name.startsWith(`${sessionId}.jsonl.reset.`)
  );
}

async function findTranscriptAtOpenClawHome(
  openClawHome: string,
  agentId: string,
  sessionId: string,
): Promise<string | null> {
  const sessionsDir = join(openClawHome, "agents", agentId, "sessions");
  const primaryPath = join(sessionsDir, `${sessionId}.jsonl`);

  try {
    const primaryStat = await stat(primaryPath);
    if (primaryStat.isFile()) {
      return primaryPath;
    }
  } catch {
    // Continue searching reset variants.
  }

  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return null;
  }

  const candidates = files.filter((name) => isResetVariant(name, sessionId));
  if (candidates.length === 0) {
    return null;
  }

  let latestPath: string | null = null;
  let latestMtime = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const candidatePath = join(sessionsDir, candidate);
    try {
      const candidateStat = await stat(candidatePath);
      if (candidateStat.mtimeMs > latestMtime) {
        latestMtime = candidateStat.mtimeMs;
        latestPath = candidatePath;
      }
    } catch {
      // Ignore candidate errors and keep scanning.
    }
  }

  return latestPath;
}

function toImportedMessages(
  sessionId: string,
  fallbackIso: string,
  transcript: Awaited<ReturnType<typeof readTranscript>>,
): ImportedMessage[] {
  const messages: ImportedMessage[] = [];
  for (const [index, message] of transcript.entries()) {
    const content = normalizeText(message.content);
    if (!content) {
      continue;
    }

    messages.push({
      id: `${sessionId}-${index + 1}`,
      role: message.role,
      content,
      createdAt: toIso(Date.parse(message.timestamp), fallbackIso),
    });
  }

  return messages;
}

async function findPreferredTranscript(
  sessionCandidates: string[],
  fallbackIso: string,
  openClawHome: string,
  preferredAgentId?: string,
): Promise<OpenClawTranscriptSource | undefined> {
  if (sessionCandidates.length === 0) {
    return undefined;
  }

  const discoveredAgents = await listAgentIds(openClawHome);
  const preferred = typeof preferredAgentId === "string" && preferredAgentId.trim().length > 0 ? preferredAgentId.trim() : null;
  const agentOrder = [
    ...(preferred ? [preferred] : []),
    ...discoveredAgents.filter((agentId) => agentId !== preferred),
  ];

  for (const sessionId of sessionCandidates) {
    for (const agentId of agentOrder) {
      const transcriptPath = await findTranscriptAtOpenClawHome(openClawHome, agentId, sessionId);
      if (!transcriptPath) {
        continue;
      }

      try {
        const transcript = await readTranscript(transcriptPath);
        const messages = toImportedMessages(sessionId, fallbackIso, transcript);
        if (messages.length === 0) {
          continue;
        }

        return {
          sessionId,
          agentId,
          messages,
        };
      } catch {
        // Keep scanning other candidates if this transcript file was unreadable.
      }
    }
  }

  return undefined;
}

function buildFallbackMessages(markdown: string, updatedAt: string): ImportedMessage[] {
  const stripped = stripFrontmatter(markdown).trim();
  if (!stripped) {
    return [];
  }

  return [
    {
      id: "openclaw-1",
      role: "user",
      content: stripped,
      createdAt: updatedAt,
    },
  ];
}

function buildConversationId(relativePath: string): string {
  const digest = createHash("sha1").update(relativePath.toLowerCase()).digest("hex").slice(0, 12);
  return `memory-${digest}`;
}

function parseSource(raw: unknown): OpenClawImportSource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const source = raw as Record<string, unknown>;
  if (source.kind !== "openclaw" || typeof source.rootDir !== "string" || !Array.isArray(source.files)) {
    return null;
  }

  return raw as OpenClawImportSource;
}

export async function loadOpenClawImportSource(
  memoryPath: string,
  options: LoadOpenClawImportSourceOptions = {},
): Promise<OpenClawImportSource> {
  const resolvedPath = resolve(memoryPath);
  let metadata;
  try {
    metadata = await stat(resolvedPath);
  } catch {
    throw new Error(`openclaw import path does not exist: ${resolvedPath}`);
  }

  if (!metadata.isDirectory()) {
    throw new Error(`openclaw import path must be a directory: ${resolvedPath}`);
  }

  const openClawHome = resolveOpenClawHome(options.openClawHome);
  const relativeFiles = await listMarkdownFiles(resolvedPath);
  const files: OpenClawFileSource[] = [];

  for (const relativePath of relativeFiles) {
    const absolutePath = join(resolvedPath, relativePath);
    const [content, fileStat] = await Promise.all([
      readFile(absolutePath, "utf8"),
      stat(absolutePath),
    ]);
    const createdAt = toIso(fileStat.birthtimeMs, new Date(fileStat.mtimeMs).toISOString());
    const updatedAt = toIso(fileStat.mtimeMs, createdAt);
    const sessionCandidates = extractSessionCandidates(content);
    const transcript = await findPreferredTranscript(
      sessionCandidates,
      updatedAt,
      openClawHome,
      options.preferredAgentId,
    );

    files.push({
      relativePath,
      absolutePath,
      createdAt,
      updatedAt,
      content,
      ...(transcript ? { transcript } : {}),
    });
  }

  return {
    kind: "openclaw",
    rootDir: resolvedPath,
    files,
  };
}

export function parseOpenClawConversations(raw: unknown): ImportedConversation[] {
  const source = parseSource(raw);
  if (!source) {
    return [];
  }

  const conversations: ImportedConversation[] = [];
  for (const file of source.files) {
    const transcriptMessages = file.transcript?.messages ?? [];
    const messages = transcriptMessages.length > 0 ? transcriptMessages : buildFallbackMessages(file.content, file.updatedAt);

    if (messages.length === 0) {
      continue;
    }

    const firstMessageAt = Date.parse(messages[0]?.createdAt ?? "");
    const lastMessageAt = Date.parse(messages[messages.length - 1]?.createdAt ?? "");
    const fileCreatedAtMs = Date.parse(file.createdAt);
    const fileUpdatedAtMs = Date.parse(file.updatedAt);

    const createdAtMs = Number.isFinite(firstMessageAt) ? firstMessageAt : fileCreatedAtMs;
    const updatedAtMs = Number.isFinite(lastMessageAt)
      ? Math.max(lastMessageAt, fileUpdatedAtMs)
      : fileUpdatedAtMs;
    const fallbackCreatedAt = Number.isFinite(fileCreatedAtMs)
      ? new Date(fileCreatedAtMs).toISOString()
      : new Date().toISOString();
    const fallbackUpdatedAt = Number.isFinite(fileUpdatedAtMs) ? new Date(fileUpdatedAtMs).toISOString() : fallbackCreatedAt;
    const transcriptLabel = file.transcript
      ? ` (session ${file.transcript.sessionId})`
      : "";

    conversations.push({
      platform: "openclaw",
      conversationId: buildConversationId(file.relativePath),
      title: `OpenClaw memory: ${file.relativePath}${transcriptLabel}`,
      sourcePath: file.relativePath,
      createdAt: toIso(createdAtMs, fallbackCreatedAt),
      updatedAt: toIso(updatedAtMs, fallbackUpdatedAt),
      messages,
    });
  }

  return conversations;
}
