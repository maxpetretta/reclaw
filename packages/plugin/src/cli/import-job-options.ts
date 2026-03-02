import { randomUUID } from "node:crypto";
import type { ImportPlatform } from "../import/types";
import { isObject } from "../lib/guards";
import type { ImportJobOptionsState, ImportJobState } from "../state";

export function toObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

export function readNumberOption(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return fallback;
}

function parseIsoDateInput(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function readPositiveIntOption(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

export function sanitizeImportOptionsForJob(raw: Record<string, unknown>): ImportJobOptionsState {
  const after = parseIsoDateInput(raw.after);
  const before = parseIsoDateInput(raw.before);
  const minMessages = readPositiveIntOption(raw.minMessages);
  const jobs = readPositiveIntOption(raw.jobs);
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : undefined;

  const options: ImportJobOptionsState = {
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
    ...(minMessages !== undefined ? { minMessages } : {}),
    ...(jobs !== undefined ? { jobs } : {}),
    ...(model ? { model } : {}),
    ...(typeof raw.force === "boolean" ? { force: raw.force } : {}),
    ...(typeof raw.transcripts === "boolean" ? { transcripts: raw.transcripts } : {}),
    ...(typeof raw.verbose === "boolean" ? { verbose: raw.verbose } : {}),
    ...(typeof raw.keepSource === "boolean" ? { keepSource: raw.keepSource } : {}),
    ...(typeof raw.backupMemoryDocs === "boolean"
      ? { backupMemoryDocs: raw.backupMemoryDocs }
      : {}),
  };

  return options;
}

function createImportJobId(): string {
  return randomUUID().replace(/-/gu, "");
}

export function createImportJobRecord(input: {
  platform: ImportPlatform;
  filePath: string;
  options: ImportJobOptionsState;
  workspaceDir?: string;
  jobId?: string;
}): ImportJobState {
  const nowIso = new Date().toISOString();
  return {
    id: input.jobId ?? createImportJobId(),
    status: "queued",
    platform: input.platform,
    filePath: input.filePath,
    options: input.options,
    createdAt: nowIso,
    updatedAt: nowIso,
    queuedAt: nowIso,
    attempts: 0,
    ...(typeof input.workspaceDir === "string" && input.workspaceDir.trim().length > 0
      ? { workspaceDir: input.workspaceDir.trim() }
      : {}),
  };
}
