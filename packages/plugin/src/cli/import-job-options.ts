import { randomUUID } from "node:crypto";
import type { ImportPlatform } from "../import/types";
import type { ImportJobOptionsState, ImportJobState } from "../state";
import {
  parseIsoDateInput,
  readPositiveNumberOption as readNumberOption,
  readTrimmedStringOption,
  toObject,
} from "./parse";
import { assignDefined } from "../lib/optional-fields";

export { toObject, readNumberOption };

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
  const options: ImportJobOptionsState = {};
  assignDefined(options, "after", parseIsoDateInput(raw.after));
  assignDefined(options, "before", parseIsoDateInput(raw.before));
  assignDefined(options, "minMessages", readPositiveIntOption(raw.minMessages));
  assignDefined(options, "jobs", readPositiveIntOption(raw.jobs));
  assignDefined(options, "model", readTrimmedStringOption(raw.model));
  assignDefined(options, "force", typeof raw.force === "boolean" ? raw.force : undefined);
  assignDefined(options, "transcripts", typeof raw.transcripts === "boolean" ? raw.transcripts : undefined);
  assignDefined(options, "verbose", typeof raw.verbose === "boolean" ? raw.verbose : undefined);
  assignDefined(options, "keepSource", typeof raw.keepSource === "boolean" ? raw.keepSource : undefined);
  assignDefined(
    options,
    "backupMemoryDocs",
    typeof raw.backupMemoryDocs === "boolean" ? raw.backupMemoryDocs : undefined,
  );
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
