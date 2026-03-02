import { readdir, stat } from "node:fs/promises";
import { isCancel as clackIsCancel, intro as clackIntro, select as clackSelect, spinner as clackSpinner, text as clackText } from "@clack/prompts";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk";
import { join } from "node:path";
import type { ImportPlatform } from "../import/types";
import { isDailyMemoryFile } from "../lib/path";
import { detectImportSources, resolveImportPathForPlatform } from "./import-detect";

export const INTERACTIVE_IMPORT_JOBS_MIN = 1;
export const INTERACTIVE_IMPORT_JOBS_MAX = 10;

export interface ImportSelection {
  platform: ImportPlatform;
  filePath: string;
  interactive: boolean;
}

export interface ImportModelInfo {
  key: string;
  name: string;
  alias?: string;
  isDefault: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseImportPlatform(raw: unknown): ImportPlatform | undefined {
  if (raw === "chatgpt" || raw === "claude" || raw === "grok" || raw === "openclaw") {
    return raw;
  }

  return undefined;
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function normalizeModelOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseImportModelsJson(json: string): ImportModelInfo[] {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(json) as unknown;
  } catch {
    return [];
  }

  const root = isObject(parsedValue) ? parsedValue : {};
  const rawModels = Array.isArray(root.models) ? root.models : [];
  const models: ImportModelInfo[] = [];

  for (const rawModel of rawModels) {
    const model = isObject(rawModel) ? rawModel : {};
    const key = typeof model.key === "string" ? model.key.trim() : "";
    if (!key) {
      continue;
    }

    const name = typeof model.name === "string" && model.name.trim().length > 0 ? model.name.trim() : key;
    const tags = Array.isArray(model.tags)
      ? model.tags
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    const aliasTag = tags.find((tag) => tag.startsWith("alias:"));

    models.push({
      key,
      name,
      isDefault: tags.includes("default"),
      ...(typeof aliasTag === "string" && aliasTag.slice(6).trim().length > 0
        ? { alias: aliasTag.slice(6).trim() }
        : {}),
    });
  }

  return models;
}

export async function listImportModels(): Promise<ImportModelInfo[]> {
  let result;
  try {
    result = await runPluginCommandWithTimeout({
      argv: ["openclaw", "models", "list", "--json"],
      timeoutMs: 10_000,
    });
  } catch {
    return [];
  }

  if (result.code !== 0 || result.stdout.trim().length === 0) {
    return [];
  }

  return parseImportModelsJson(result.stdout);
}

export function formatImportModelLabel(model: ImportModelInfo): string {
  return model.alias ? `${model.name} (${model.alias})` : `${model.name} (${model.key})`;
}

export function resolveModelByQuery(models: ImportModelInfo[], query: string): ImportModelInfo | undefined {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return undefined;
  }

  return models.find((model) => {
    const candidates = [model.key, model.name, model.alias]
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.toLowerCase());
    return candidates.includes(normalizedQuery);
  });
}

function unwrapPromptValue<T>(value: T | symbol): T {
  if (clackIsCancel(value)) {
    throw new Error("Import canceled");
  }
  return value;
}

export function platformLabel(platform: ImportPlatform): string {
  if (platform === "chatgpt") {
    return "ChatGPT export";
  }
  if (platform === "claude") {
    return "Claude export";
  }
  if (platform === "grok") {
    return "Grok export";
  }
  return "OpenClaw legacy memory";
}

export function parseInteractiveImportJobs(value: unknown): number | undefined {
  let parsed: number | undefined;

  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/u.test(trimmed)) {
      return undefined;
    }

    parsed = Number.parseInt(trimmed, 10);
  } else {
    return undefined;
  }

  if (parsed < INTERACTIVE_IMPORT_JOBS_MIN || parsed > INTERACTIVE_IMPORT_JOBS_MAX) {
    return undefined;
  }

  return parsed;
}

export async function resolveImportSelection(input: {
  platformArg: unknown;
  fileArg: unknown;
  workspaceDir?: string;
}): Promise<ImportSelection> {
  const parsedPlatform = parseImportPlatform(input.platformArg);
  const fileArg = typeof input.fileArg === "string" && input.fileArg.trim().length > 0 ? input.fileArg.trim() : null;

  if (parsedPlatform && fileArg) {
    return {
      platform: parsedPlatform,
      filePath: await resolveImportPathForPlatform(parsedPlatform, fileArg),
      interactive: false,
    };
  }

  if (input.platformArg !== undefined && parsedPlatform === undefined) {
    throw new Error('platform must be one of: "chatgpt", "claude", "grok", "openclaw"');
  }

  if (!isInteractiveTerminal()) {
    throw new Error("Import requires interactive TTY when platform/file args are omitted.");
  }

  clackIntro("🦞 Reclaw - Reclaim your AI conversations");
  const detectSpin = clackSpinner();
  detectSpin.start("Auto-detecting import sources");
  const detections = await detectImportSources(input.workspaceDir);
  detectSpin.stop("Auto-detection complete");

  const platform =
    parsedPlatform ??
    unwrapPromptValue(
      await clackSelect({
        message: "Which source do you want to import?",
        options: (["openclaw", "chatgpt", "claude", "grok"] as const).map((value) => {
          const top = detections[value][0];
          return {
            value,
            label: top ? `${platformLabel(value)} (detected)` : platformLabel(value),
            hint: top ? `${top.path} • ${top.detail}` : "No source auto-detected",
          };
        }),
      }),
    );

  const platformDetections = detections[platform];

  let selectedPath = fileArg;
  if (!selectedPath) {
    if (platformDetections.length > 0) {
      const selectedCandidate = unwrapPromptValue(
        await clackSelect({
          message: `Choose ${platformLabel(platform)} source`,
          options: [
            ...platformDetections.slice(0, 6).map((detection) => ({
              value: detection.path,
              label: detection.path,
              hint: detection.detail,
            })),
            {
              value: "__manual__",
              label: "Enter a path manually",
              hint: "Use this if your source was not auto-detected",
            },
          ],
        }),
      );

      if (selectedCandidate === "__manual__") {
        selectedPath = unwrapPromptValue(
          await clackText({
            message:
              platform === "openclaw"
                ? "Path to legacy OpenClaw memory directory"
                : `Path to ${platformLabel(platform)} JSON export (file or directory)`,
            placeholder: platform === "openclaw" ? "./memory" : "./export.json",
          }),
        );
      } else {
        selectedPath = selectedCandidate;
      }
    } else {
      selectedPath = unwrapPromptValue(
        await clackText({
          message:
            platform === "openclaw"
              ? "Path to legacy OpenClaw memory directory"
              : `Path to ${platformLabel(platform)} JSON export (file or directory)`,
          placeholder: platform === "openclaw" ? "./memory" : "./export.json",
        }),
      );
    }
  }

  const resolvedPath = await resolveImportPathForPlatform(platform, selectedPath.trim());

  return {
    platform,
    filePath: resolvedPath,
    interactive: true,
  };
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"] as const;
  let remaining = value;
  let unitIndex = 0;
  while (remaining >= 1024 && unitIndex < units.length - 1) {
    remaining /= 1024;
    unitIndex += 1;
  }

  const formatted = unitIndex === 0 ? `${Math.floor(remaining)}` : remaining.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

export interface OpenClawMemoryPreflight {
  markdownFiles: number;
  dailyFiles: number;
  otherFiles: number;
  dateRange: string;
  sourceSizeBytes: number;
}

export async function readOpenClawMemoryPreflight(memoryPath: string): Promise<OpenClawMemoryPreflight> {
  const stack = [memoryPath];
  let markdownFiles = 0;
  let dailyFiles = 0;
  let sourceSizeBytes = 0;
  const dailyDates: string[] = [];

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

      markdownFiles += 1;
      const metadata = await stat(absolutePath);
      sourceSizeBytes += metadata.size;

      if (isDailyMemoryFile(entry.name)) {
        dailyFiles += 1;
        dailyDates.push(entry.name.slice(0, 10));
      }
    }
  }

  dailyDates.sort((left, right) => left.localeCompare(right));
  const dateRange =
    dailyDates.length > 0 ? `${dailyDates[0]} -> ${dailyDates[dailyDates.length - 1]}` : "n/a";
  const otherFiles = markdownFiles - dailyFiles;

  return {
    markdownFiles,
    dailyFiles,
    otherFiles,
    dateRange,
    sourceSizeBytes,
  };
}
