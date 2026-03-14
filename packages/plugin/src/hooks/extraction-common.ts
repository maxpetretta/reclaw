import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isObject } from "../lib/guards";
import { extractFromTranscriptWithMeta, repairExtractionOutputWithMeta } from "../lib/llm";
import { generateSessionSummary } from "../session-summary/generate";
import { resolvePaths } from "../cli/paths";
import type { ExtractionPaths, ExtractionPipelineDeps } from "./pipeline";

export interface ExtractionHookDeps extends ExtractionPipelineDeps {
  readMemoryFile: (path: string) => Promise<string>;
  writeMemoryFile: (path: string, content: string) => Promise<void>;
  generateSessionSummary: typeof generateSessionSummary;
}

const DEFAULT_DEPS: ExtractionHookDeps = {
  extractFromTranscript: extractFromTranscriptWithMeta,
  repairExtractionOutput: repairExtractionOutputWithMeta,
  async readMemoryFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return "";
      }

      throw error;
    }
  },
  async writeMemoryFile(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  },
  generateSessionSummary,
};

export function createExtractionHookDeps(deps: Partial<ExtractionHookDeps>): ExtractionHookDeps {
  const runtimeDeps: ExtractionHookDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  if (deps.extractFromTranscript && !deps.repairExtractionOutput) {
    runtimeDeps.repairExtractionOutput = async (opts) =>
      deps.extractFromTranscript!({
        transcript: opts.transcript,
        subjects: opts.subjects,
        existingEntries: opts.existingEntries,
        model: opts.model,
        apiBaseUrl: opts.apiBaseUrl,
        apiToken: opts.apiToken,
      });
  }

  return runtimeDeps;
}

export function readWorkspaceDir(ctx: unknown): string | undefined {
  if (!isObject(ctx)) {
    return undefined;
  }

  return typeof ctx.workspaceDir === "string" && ctx.workspaceDir.trim().length > 0
    ? ctx.workspaceDir.trim()
    : undefined;
}

export function resolveMemoryMdPath(
  workspaceDir: string | undefined,
  resolvePath?: (input: string) => string,
): string {
  if (workspaceDir) {
    return join(workspaceDir, "MEMORY.md");
  }

  if (resolvePath) {
    return resolvePath("MEMORY.md");
  }

  return join(process.cwd(), "MEMORY.md");
}

export function resolveExtractionPaths(config: { logDir: string }): ExtractionPaths {
  const paths = resolvePaths(config);
  return {
    logPath: paths.logPath,
    subjectsPath: paths.subjectsPath,
    statePath: paths.statePath,
    projectionDir: paths.projectionDir,
    sessionSummaryProjectionDir: paths.sessionSummaryProjectionDir,
    transcriptProjectionDir: paths.transcriptProjectionDir,
  };
}

export function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
