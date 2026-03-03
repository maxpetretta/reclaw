import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isEnoent, isObject } from "../lib/guards";

function toObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function getOrCreateObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = toObject(parent[key]);
  parent[key] = next;
  return next;
}

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
  const plugins = getOrCreateObject(root, "plugins");
  const slots = getOrCreateObject(plugins, "slots");
  slots.memory = "reclaw";

  const allow = Array.isArray(plugins.allow)
    ? plugins.allow
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  if (!allow.includes("reclaw")) {
    allow.push("reclaw");
  }
  plugins.allow = allow;
}

function removePluginMemorySlot(root: Record<string, unknown>): void {
  const plugins = getOrCreateObject(root, "plugins");
  const slots = getOrCreateObject(plugins, "slots");
  delete slots.memory;
}

function ensureAgentMemoryFlushDisabled(root: Record<string, unknown>): void {
  const agents = getOrCreateObject(root, "agents");
  const defaults = getOrCreateObject(agents, "defaults");
  const compaction = getOrCreateObject(defaults, "compaction");
  compaction.memoryFlush = { enabled: false };
}

function removeAgentMemoryFlush(root: Record<string, unknown>): void {
  const agents = getOrCreateObject(root, "agents");
  const defaults = getOrCreateObject(agents, "defaults");
  const compaction = getOrCreateObject(defaults, "compaction");
  delete compaction.memoryFlush;
}

function ensureSessionRetentionForever(root: Record<string, unknown>): void {
  const session = getOrCreateObject(root, "session");
  const maintenance = getOrCreateObject(session, "maintenance");
  maintenance.pruneAfter = "36500d";
  maintenance.maxEntries = 100_000;
  maintenance.resetArchiveRetention = false;
}

function removeSessionRetention(root: Record<string, unknown>): void {
  const session = getOrCreateObject(root, "session");
  const maintenance = getOrCreateObject(session, "maintenance");
  delete maintenance.pruneAfter;
  delete maintenance.maxEntries;
  delete maintenance.resetArchiveRetention;
}

function ensureSessionMemoryHookDisabled(root: Record<string, unknown>): void {
  const hooks = getOrCreateObject(root, "hooks");
  const internalHooks = getOrCreateObject(hooks, "internal");
  const entries = getOrCreateObject(internalHooks, "entries");
  const sessionMemoryHook = getOrCreateObject(entries, "session-memory");
  sessionMemoryHook.enabled = false;
}

function removeSessionMemoryHook(root: Record<string, unknown>): void {
  const hooks = getOrCreateObject(root, "hooks");
  const internalHooks = getOrCreateObject(hooks, "internal");
  const entries = getOrCreateObject(internalHooks, "entries");
  delete entries["session-memory"];
}

export async function updateOpenClawConfigForInit(configPath: string): Promise<void> {
  const root = await readConfigObject(configPath);
  ensurePluginMemorySlot(root);
  ensureAgentMemoryFlushDisabled(root);
  ensureSessionRetentionForever(root);
  ensureSessionMemoryHookDisabled(root);
  await writeConfigObject(configPath, root);
}

export async function updateOpenClawConfigForUninstall(configPath: string): Promise<void> {
  const root = await readConfigObjectOrEmpty(configPath);
  if (!root) {
    return;
  }

  removePluginMemorySlot(root);
  removeAgentMemoryFlush(root);
  removeSessionRetention(root);
  removeSessionMemoryHook(root);
  await writeConfigObject(configPath, root);
}
