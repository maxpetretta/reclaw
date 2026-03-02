import type { ImportedConversation } from "./types";

export const HISTORICAL_IMPORT_SYSTEM_PREFIX = [
  "Historical import mode:",
  "- The transcript is archived historical data imported from another platform.",
  "- Extract durable memory exactly as written, without assuming current status.",
  "- Apply a strict durability filter: only keep details likely to matter in future sessions.",
  "- Prefer long-lived user context: projects, workflows, preferences, health patterns, and unresolved questions.",
  "- Prefer subject slugs for the thing discussed (`project`, `topic`, `system`) rather than the user as a catch-all person subject.",
  "- Use `person` subjects only when the memory is explicitly about that person (identity, relationship, preference, health, biography).",
  "- For health/medical topics use a `health` subject, for investing use `investing`, for hobbies use the hobby name, etc.",
  "- Match extraction density to transcript complexity; longer transcripts should usually yield multiple durable entries.",
  "- Skip one-off lookup results unless they reveal a durable pattern or preference.",
  "- Examples to skip: menus, store addresses/hours, trivia/song ID requests, generic explainers, transient shopping lookups, and codebase architecture details (database schemas, contract patterns, dependency lists) discoverable from project source code.",
  "- Do not extract the act of researching or asking about something. Only extract the durable conclusion or preference that resulted. 'User researched X' or 'User asked about X' entries are not durable.",
  "- Do not emit speculative questions. Only emit `question` entries for things the user explicitly left unresolved.",
  "- Do not emit handoff entries in historical import mode.",
  "- You may include an optional `timestamp` field per entry for historical placement.",
  "- Prefer exact timestamps from transcript messages when available.",
  "- If confidence is low, emit a `question` instead of an uncertain `fact`.",
  "- If only a date is known, use that date at noon (12:00:00).",
  "- If omitted, timestamp defaults to the conversation's historical updatedAt time.",
].join("\n");

export function formatImportConversationMetadata(conversation: ImportedConversation): string {
  return [
    `platform: ${conversation.platform}`,
    `conversationId: ${conversation.conversationId}`,
    `title: ${conversation.title}`,
    `sourcePath: ${conversation.sourcePath ?? "n/a"}`,
    `createdAt: ${conversation.createdAt}`,
    `updatedAt: ${conversation.updatedAt}`,
  ].join("\n");
}

export function formatImportTranscript(conversation: ImportedConversation): string {
  return conversation.messages
    .map((message) => `[${message.createdAt}] ${message.role}: ${message.content}`)
    .join("\n");
}
