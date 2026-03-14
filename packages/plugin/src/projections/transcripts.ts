import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { SessionCandidate } from "../hooks/session-discovery";
import { listSessionCandidates, shouldExtractSession } from "../hooks/session-discovery";
import { isEnoent } from "../lib/guards";
import {
  findTranscriptFileForHome,
  readTranscript,
  type TranscriptMessage,
} from "../lib/transcript";
import { resolveOpenClawHome } from "../lib/runtime-env";

export const TRANSCRIPT_PROJECTION_DIRNAME = "transcripts";
const MIN_IMPORTED_TRANSCRIPT_TURNS = 4;

const SEARCH_ARTIFACT_KEYS = new Set([
  "queries",
  "source_filter",
  "search_query",
  "image_query",
  "open",
  "click",
  "find",
  "screenshot",
  "finance",
  "weather",
  "sports",
  "time",
]);

export interface TranscriptProjectionTarget {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: string;
  transcriptFile?: string;
}

function normalizeProjectionDir(projectionDir: string): string {
  const normalized = projectionDir.trim();
  if (!normalized) {
    throw new Error("projectionDir must be a non-empty string");
  }

  return normalized;
}

function resolveSessionPath(projectionDir: string, sessionId: string): string {
  return join(normalizeProjectionDir(projectionDir), `${sessionId}.md`);
}

function stripTransportMetadata(text: string): string {
  let next = text.trim();
  const prefixPatterns = [
    /^\s*\[[^\]\n]+\]\s*/u,
    /^\s*Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/u,
    /^\s*Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/u,
  ];

  while (true) {
    const previous = next;
    for (const pattern of prefixPatterns) {
      next = next.replace(pattern, "");
    }
    if (next === previous) {
      break;
    }
  }

  return next.trim();
}

function isImportedSession(sessionId: string): boolean {
  return sessionId.startsWith("reclaw:");
}

function isImportedUserSession(sessionKey: string | undefined, sessionId: string): boolean {
  if (/^reclaw:(chatgpt|claude|grok):/u.test(sessionId)) {
    return true;
  }

  if (!sessionKey) {
    return false;
  }

  return /^agent:[^:]+:reclaw:(chatgpt|claude|grok):/u.test(sessionKey);
}

function isDirectMainSessionCandidate(candidate: TranscriptProjectionTarget): boolean {
  if (candidate.agentId !== "main" || isImportedSession(candidate.sessionId)) {
    return false;
  }

  if (candidate.sessionKey?.includes(":cron:")) {
    return false;
  }

  if (candidate.surface === "reclaw-import") {
    return false;
  }

  if (candidate.chatType && candidate.chatType !== "direct") {
    return false;
  }

  return true;
}

function isSearchArtifactPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }

    return Object.keys(parsed).some((key) => SEARCH_ARTIFACT_KEYS.has(key));
  } catch {
    return false;
  }
}

function isLikelyScratchpadCode(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("```")) {
    return false;
  }

  const lines = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > 20) {
    return false;
  }

  const codeLinePatterns = [
    /^(?:import|from)\s+\w+/u,
    /^\w+\s*=\s*.+/u,
    /^(?:for|if|while|with)\b.+:\s*$/u,
    /^(?:print|return)\(.+\)\s*$/u,
    /^\w+\.\w+\(.+\)\s*$/u,
  ];
  const codeLikeLines = lines.filter((line) => codeLinePatterns.some((pattern) => pattern.test(line))).length;
  const proseLikeLines = lines.filter((line) => /[.!?]$/.test(line) || /^#{1,6}\s/u.test(line) || /^[-*]\s/u.test(line))
    .length;

  if (lines.length === 1) {
    return codeLikeLines === 1 && proseLikeLines === 0;
  }

  return codeLikeLines >= Math.max(2, Math.ceil(lines.length / 2)) && proseLikeLines === 0;
}

function isGeneratedPromptScaffolding(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith("[System Message] [sessionId:")) {
    return true;
  }

  if (trimmed.startsWith("You are running an isolated one-shot task.")) {
    return true;
  }

  if (trimmed.includes("## System Prompt") && trimmed.includes("## User Prompt")) {
    return true;
  }

  return false;
}

export function sanitizeTranscriptMessageForProjection(
  message: TranscriptMessage,
  options: { sessionId?: string } = {},
): TranscriptMessage | null {
  const imported = options.sessionId ? isImportedSession(options.sessionId) : false;
  const rawContent = message.content.trim();

  if (isGeneratedPromptScaffolding(rawContent)) {
    return null;
  }

  const content =
    message.role === "user"
      ? stripTransportMetadata(message.content)
      : message.content.trim();

  if (!content) {
    return null;
  }

  if (isGeneratedPromptScaffolding(content)) {
    return null;
  }

  if (message.role === "assistant") {
    if (isSearchArtifactPayload(content)) {
      return null;
    }

    if (imported && isLikelyScratchpadCode(content)) {
      return null;
    }
  }

  return {
    ...message,
    content,
  };
}

function countConversationalTurns(
  messages: TranscriptMessage[],
  sessionId: string,
): { turns: number; userCount: number; assistantCount: number } {
  let userCount = 0;
  let assistantCount = 0;
  let turns = 0;

  for (const message of messages) {
    const cleaned = sanitizeTranscriptMessageForProjection(message, { sessionId });
    if (!cleaned) {
      continue;
    }

    turns += 1;
    if (cleaned.role === "user") {
      userCount += 1;
    } else if (cleaned.role === "assistant") {
      assistantCount += 1;
    }
  }

  return { turns, userCount, assistantCount };
}

export function shouldProjectTranscriptTarget(
  target: TranscriptProjectionTarget,
  messages: TranscriptMessage[],
): boolean {
  const counts = countConversationalTurns(messages, target.sessionId);

  if (isImportedUserSession(target.sessionKey, target.sessionId)) {
    return counts.userCount > 0 && counts.assistantCount > 0 && counts.turns >= MIN_IMPORTED_TRANSCRIPT_TURNS;
  }

  if (shouldExtractSession(target.sessionKey, [])) {
    return counts.userCount > 0 && counts.assistantCount > 0;
  }

  if (!isDirectMainSessionCandidate(target)) {
    return false;
  }

  return counts.userCount > 0 && counts.assistantCount > 0;
}

function renderMessage(message: TranscriptMessage): string[] {
  const headingRole = message.role === "user" ? "User" : "Assistant";
  return [
    `### ${headingRole} | ${message.timestamp}`,
    "",
    message.content,
  ];
}

export function renderTranscriptProjectionMarkdown(params: {
  sessionId: string;
  agentId: string;
  messages: TranscriptMessage[];
  generatedAt?: string;
}): string {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const conversationLines = params.messages.flatMap((message, index) => {
    const block = renderMessage(message);
    if (index < params.messages.length - 1) {
      block.push("");
    }
    return block;
  });

  return [
    `# Transcript ${params.sessionId}`,
    "",
    `- Session: \`${params.sessionId}\``,
    `- Agent: \`${params.agentId}\``,
    `- Turns: \`${params.messages.length}\``,
    `- Generated: \`${generatedAt}\``,
    "",
    "## Conversation",
    "",
    ...conversationLines,
    "",
    "## Retrieval",
    "",
    `Use \`memory_get(\"session:${params.sessionId}\")\` for the raw transcript.`,
    "",
  ].join("\n");
}

async function listProjectionSessionIds(projectionDir: string): Promise<string[]> {
  try {
    const items = await readdir(projectionDir, { withFileTypes: true });
    return items
      .flatMap((item) => {
        if (item.isDirectory()) {
          return [item.name];
        }

        if (item.isFile() && extname(item.name) === ".md") {
          return [basename(item.name, ".md")];
        }

        return [];
      })
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }

    throw error;
  }
}

async function removeSessionProjection(projectionDir: string, sessionId: string): Promise<void> {
  try {
    await rm(resolveSessionPath(projectionDir, sessionId));
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  try {
    await rm(join(normalizeProjectionDir(projectionDir), sessionId), { recursive: true });
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
}

async function removeLegacySessionDir(projectionDir: string, sessionId: string): Promise<void> {
  try {
    await rm(join(normalizeProjectionDir(projectionDir), sessionId), { recursive: true });
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
}

async function writeTranscriptProjectionSession(params: {
  projectionDir: string;
  agentId: string;
  sessionId: string;
  messages: TranscriptMessage[];
}): Promise<void> {
  const normalizedProjectionDir = normalizeProjectionDir(params.projectionDir);
  const cleanedMessages = params.messages
    .map((message) => sanitizeTranscriptMessageForProjection(message, { sessionId: params.sessionId }))
    .filter((message): message is TranscriptMessage => message !== null);

  if (cleanedMessages.length === 0) {
    await removeSessionProjection(normalizedProjectionDir, params.sessionId);
    return;
  }

  const generatedAt = new Date().toISOString();
  const markdown = renderTranscriptProjectionMarkdown({
    sessionId: params.sessionId,
    agentId: params.agentId,
    messages: cleanedMessages,
    generatedAt,
  });
  await removeLegacySessionDir(normalizedProjectionDir, params.sessionId);
  await writeFile(resolveSessionPath(normalizedProjectionDir, params.sessionId), markdown, "utf8");
}

export async function ensureTranscriptProjectionDir(projectionDir: string): Promise<string> {
  const normalizedProjectionDir = normalizeProjectionDir(projectionDir);
  await mkdir(normalizedProjectionDir, { recursive: true });
  return normalizedProjectionDir;
}

export async function refreshTranscriptProjectionSession(params: {
  projectionDir: string;
  agentId: string;
  sessionId: string;
  messages: TranscriptMessage[];
}): Promise<void> {
  const normalizedProjectionDir = await ensureTranscriptProjectionDir(params.projectionDir);
  await writeTranscriptProjectionSession({
    ...params,
    projectionDir: normalizedProjectionDir,
  });
}

export async function refreshTranscriptProjections(params: {
  projectionDir: string;
  openClawHome?: string;
  sessions?: TranscriptProjectionTarget[];
}): Promise<void> {
  const normalizedProjectionDir = await ensureTranscriptProjectionDir(params.projectionDir);
  const openClawHome = resolveOpenClawHome(params.openClawHome);
  const targets =
    Array.isArray(params.sessions) && params.sessions.length > 0
      ? [...new Map(
          params.sessions
            .filter((session) => session.agentId.trim().length > 0 && session.sessionId.trim().length > 0)
            .map((session) => [`${session.agentId}\u0000${session.sessionId}`, session]),
        ).values()]
      : (await listSessionCandidates(openClawHome)).map((candidate: SessionCandidate) => ({
          agentId: candidate.agentId,
          sessionId: candidate.sessionId,
          sessionKey: candidate.sessionKey,
          label: candidate.label,
          provider: candidate.provider,
          surface: candidate.surface,
          chatType: candidate.chatType,
        }));

  const expectedSessionIds = new Set<string>();
  for (const target of targets) {
    const transcriptFile =
      target.transcriptFile ?? await findTranscriptFileForHome(openClawHome, target.agentId, target.sessionId);
    if (!transcriptFile) {
      await removeSessionProjection(normalizedProjectionDir, target.sessionId);
      continue;
    }

    const messages = await readTranscript(transcriptFile);
    if (!shouldProjectTranscriptTarget(target, messages)) {
      await removeSessionProjection(normalizedProjectionDir, target.sessionId);
      continue;
    }

    await writeTranscriptProjectionSession({
      projectionDir: normalizedProjectionDir,
      agentId: target.agentId,
      sessionId: target.sessionId,
      messages,
    });
    expectedSessionIds.add(target.sessionId);
  }

  if (!Array.isArray(params.sessions) || params.sessions.length === 0) {
    const existingSessionIds = await listProjectionSessionIds(normalizedProjectionDir);
    for (const sessionId of existingSessionIds) {
      if (expectedSessionIds.has(sessionId)) {
        continue;
      }

      await removeSessionProjection(normalizedProjectionDir, sessionId);
    }
  }
}
