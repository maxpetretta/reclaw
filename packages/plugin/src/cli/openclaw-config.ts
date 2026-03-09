import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isEnoent } from "../lib/guards";
import {
  ensureNestedObject,
  readStringList,
  RECLAW_OPENCLAW_MAX_ENTRIES,
  RECLAW_OPENCLAW_MEMORY_SLOT,
  RECLAW_OPENCLAW_PRUNE_AFTER,
} from "./openclaw-config-shared";
import { toObject } from "./parse";

async function readConfigObject(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, "utf8");
    return toObject(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

async function readConfigObjectOrEmpty(configPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(configPath, "utf8");
    return toObject(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }

    return {};
  }
}

async function writeConfigObject(configPath: string, root: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

function ensurePluginMemorySlot(root: Record<string, unknown>): void {
  const plugins = ensureNestedObject(root, "plugins");
  const slots = ensureNestedObject(root, "plugins", "slots");
  slots.memory = RECLAW_OPENCLAW_MEMORY_SLOT;

  const allow = readStringList(plugins.allow);
  if (!allow.includes(RECLAW_OPENCLAW_MEMORY_SLOT)) {
    allow.push(RECLAW_OPENCLAW_MEMORY_SLOT);
  }
  plugins.allow = allow;
}

function removePluginMemorySlot(root: Record<string, unknown>): void {
  const slots = ensureNestedObject(root, "plugins", "slots");
  delete slots.memory;
}

function ensureAgentMemoryFlushDisabled(root: Record<string, unknown>): void {
  const compaction = ensureNestedObject(root, "agents", "defaults", "compaction");
  compaction.memoryFlush = { enabled: false };
}

function removeAgentMemoryFlush(root: Record<string, unknown>): void {
  const compaction = ensureNestedObject(root, "agents", "defaults", "compaction");
  delete compaction.memoryFlush;
}

function ensureSessionRetentionForever(root: Record<string, unknown>): void {
  const maintenance = ensureNestedObject(root, "session", "maintenance");
  maintenance.pruneAfter = RECLAW_OPENCLAW_PRUNE_AFTER;
  maintenance.maxEntries = RECLAW_OPENCLAW_MAX_ENTRIES;
  maintenance.resetArchiveRetention = false;
}

function removeSessionRetention(root: Record<string, unknown>): void {
  const maintenance = ensureNestedObject(root, "session", "maintenance");
  delete maintenance.pruneAfter;
  delete maintenance.maxEntries;
  delete maintenance.resetArchiveRetention;
}

function ensureSessionMemoryHookDisabled(root: Record<string, unknown>): void {
  const sessionMemoryHook = ensureNestedObject(root, "hooks", "internal", "entries", "session-memory");
  sessionMemoryHook.enabled = false;
}

function removeSessionMemoryHook(root: Record<string, unknown>): void {
  const entries = ensureNestedObject(root, "hooks", "internal", "entries");
  delete entries["session-memory"];
}

function ensureProjectionMemoryPath(root: Record<string, unknown>, projectionDir: string): void {
  const memorySearch = ensureNestedObject(root, "agents", "defaults", "memorySearch");
  const extraPaths = readStringList(memorySearch.extraPaths);

  if (!extraPaths.includes(projectionDir)) {
    extraPaths.push(projectionDir);
  }

  memorySearch.extraPaths = extraPaths;
}

function removeProjectionMemoryPath(root: Record<string, unknown>, projectionDir: string): void {
  const memorySearch = ensureNestedObject(root, "agents", "defaults", "memorySearch");
  const extraPaths = readStringList(memorySearch.extraPaths).filter((entry) => entry !== projectionDir);

  if (extraPaths.length > 0) {
    memorySearch.extraPaths = extraPaths;
  } else {
    delete memorySearch.extraPaths;
  }
}

export async function updateOpenClawConfigForInit(
  configPath: string,
  projectionDirs: string[],
): Promise<void> {
  const root = await readConfigObject(configPath);
  ensurePluginMemorySlot(root);
  ensureAgentMemoryFlushDisabled(root);
  ensureSessionRetentionForever(root);
  ensureSessionMemoryHookDisabled(root);
  for (const projectionDir of projectionDirs) {
    ensureProjectionMemoryPath(root, projectionDir);
  }
  await writeConfigObject(configPath, root);
}

export async function updateOpenClawConfigForUninstall(
  configPath: string,
  projectionDirs: string[],
): Promise<void> {
  const root = await readConfigObjectOrEmpty(configPath);
  if (!root) {
    return;
  }

  removePluginMemorySlot(root);
  removeAgentMemoryFlush(root);
  removeSessionRetention(root);
  removeSessionMemoryHook(root);
  for (const projectionDir of projectionDirs) {
    removeProjectionMemoryPath(root, projectionDir);
  }
  await writeConfigObject(configPath, root);
}
