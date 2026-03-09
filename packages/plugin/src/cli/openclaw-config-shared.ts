import { toObject } from "./parse";

export const RECLAW_OPENCLAW_MEMORY_SLOT = "reclaw";
export const RECLAW_OPENCLAW_PRUNE_AFTER = "36500d";
export const RECLAW_OPENCLAW_MAX_ENTRIES = 100_000;

export interface OpenClawConfigView {
  slotValue?: string;
  allow: string[];
  extraPaths: string[];
  memoryFlush: unknown;
  pruneAfter: unknown;
  maxEntries: unknown;
  resetArchiveRetention: unknown;
  sessionMemoryHook: Record<string, unknown>;
}

export function ensureNestedObject(root: Record<string, unknown>, ...path: string[]): Record<string, unknown> {
  let current = root;

  for (const key of path) {
    const next = toObject(current[key]);
    current[key] = next;
    current = next;
  }

  return current;
}

export function getNestedObject(root: Record<string, unknown>, ...path: string[]): Record<string, unknown> {
  let current = root;

  for (const key of path) {
    current = toObject(current[key]);
  }

  return current;
}

export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function readOpenClawConfigView(root: Record<string, unknown>): OpenClawConfigView {
  const plugins = getNestedObject(root, "plugins");
  const slots = getNestedObject(root, "plugins", "slots");
  const agentsDefaults = getNestedObject(root, "agents", "defaults");
  const memorySearch = getNestedObject(root, "agents", "defaults", "memorySearch");
  const compaction = getNestedObject(root, "agents", "defaults", "compaction");
  const maintenance = getNestedObject(root, "session", "maintenance");
  const sessionMemoryHook = getNestedObject(root, "hooks", "internal", "entries", "session-memory");

  return {
    slotValue: typeof slots.memory === "string" ? slots.memory : undefined,
    allow: readStringList(plugins.allow),
    extraPaths: readStringList(memorySearch.extraPaths),
    memoryFlush: compaction.memoryFlush,
    pruneAfter: maintenance.pruneAfter,
    maxEntries: maintenance.maxEntries,
    resetArchiveRetention: maintenance.resetArchiveRetention,
    sessionMemoryHook,
  };
}
