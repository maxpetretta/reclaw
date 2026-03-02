import { join } from "node:path";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { isObject } from "../lib/guards";
import { extractTextContent } from "../lib/text";
import { queryLog, searchLog, type LogQueryFilter } from "../log/query";
import { parseEntryType, parseEntryStatus, type EntryType, type LogEntry } from "../log/schema";
import { incrementEventUsage } from "../state";
import { textResult } from "./shared";

interface SearchParams {
  query?: string;
  maxResults?: number;
  minScore?: number;
  type?: string;
  subject?: string;
  status?: string;
}

interface MemorySearchDeps {
  queryLog: typeof queryLog;
  searchLog: typeof searchLog;
  incrementEventUsage: typeof incrementEventUsage;
}

const DEFAULT_DEPS: MemorySearchDeps = {
  queryLog,
  searchLog,
  incrementEventUsage,
};


function normalizeQuery(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSubject(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractTextFromToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }

  if (isObject(result) && Array.isArray(result.content)) {
    return extractTextContent(result.content).trim();
  }

  return "";
}

function formatLogEntry(entry: LogEntry): string {
  const subject = entry.subject ?? "unknown";
  if (entry.type === "task") {
    return `[id=${entry.id}] [${entry.type}] ${subject} [status=${entry.status}] — ${entry.content} (${entry.timestamp})`;
  }

  return `[id=${entry.id}] [${entry.type}] ${subject} — ${entry.content} (${entry.timestamp})`;
}

function dedupeEntries(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  const output: LogEntry[] = [];

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }

    seen.add(entry.id);
    output.push(entry);
  }

  return output;
}

function buildStructuredFilter(params: SearchParams): { filter: LogQueryFilter; hasStructuredFilters: boolean } {
  const type = parseEntryType(params.type);
  const subject = normalizeSubject(params.subject);
  const status = parseEntryStatus(params.status);

  return {
    filter: {
      ...(type ? { type } : {}),
      ...(subject ? { subject } : {}),
      ...(status ? { status } : {}),
    },
    hasStructuredFilters: Boolean(type || subject || status),
  };
}

function buildParametersSchema(baseParameters: unknown): Record<string, unknown> {
  if (!isObject(baseParameters)) {
    return {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
        minScore: { type: "number" },
        type: { type: "string" },
        subject: { type: "string" },
        status: { type: "string", enum: ["open", "done"] },
      },
      anyOf: [
        { required: ["query"] },
        { required: ["type"] },
        { required: ["subject"] },
        { required: ["status"] },
      ],
      additionalProperties: false,
    };
  }

  const existingProperties = isObject(baseParameters.properties) ? baseParameters.properties : {};
  const existingRequired = Array.isArray(baseParameters.required)
    ? baseParameters.required.filter((value): value is string => typeof value === "string")
    : [];
  const requiredWithoutQuery = existingRequired.filter((value) => value !== "query");

  return {
    ...baseParameters,
    type: "object",
    properties: {
      ...existingProperties,
      type: { type: "string", enum: ["task", "fact", "decision", "question", "handoff"] },
      subject: { type: "string" },
      status: { type: "string", enum: ["open", "done"] },
    },
    required: requiredWithoutQuery,
    anyOf: [
      { required: ["query"] },
      { required: ["type"] },
      { required: ["subject"] },
      { required: ["status"] },
    ],
  };
}

export function createWrappedMemorySearchTool(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
  config: PluginConfig,
  deps: Partial<MemorySearchDeps> = {},
): AnyAgentTool {
  const resolvedDeps: MemorySearchDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  const builtin = api.runtime.tools.createMemorySearchTool({
    config: ctx.config,
    agentSessionKey: ctx.sessionKey,
  });

  const builtinExecute =
    builtin && typeof builtin.execute === "function"
      ? builtin.execute.bind(builtin)
      : null;

  const logPath = join(config.logDir, "log.jsonl");
  const statePath = join(config.logDir, "state.json");

  return {
    name: "memory_search",
    label: builtin?.label ?? "Memory Search",
    description:
      "Search memory with semantic query support and structured log filters (type, subject, task status).",
    parameters: buildParametersSchema(builtin?.parameters),
    async execute(
      toolCallId: string,
      rawParams: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      runtimeCtx?: unknown,
    ) {
      const params = rawParams as SearchParams;
      const query = normalizeQuery(params.query);
      const { filter, hasStructuredFilters } = buildStructuredFilter(params);

      if (!query && !hasStructuredFilters) {
        return textResult("No results.", { reason: "missing query and structured filters" });
      }

      const [structuredEntries, keywordEntries, builtinResult] = await Promise.all([
        hasStructuredFilters ? resolvedDeps.queryLog(logPath, filter) : Promise.resolve([]),
        query ? resolvedDeps.searchLog(logPath, query, filter) : Promise.resolve([]),
        query && builtinExecute
          ? builtinExecute(
              toolCallId,
              {
                query,
                ...(typeof params.maxResults === "number" ? { maxResults: params.maxResults } : {}),
                ...(typeof params.minScore === "number" ? { minScore: params.minScore } : {}),
              },
              signal,
              onUpdate,
              runtimeCtx,
            )
          : Promise.resolve(null),
      ]);

      const logEntries = dedupeEntries([...structuredEntries, ...keywordEntries]);
      if (logEntries.length > 0) {
        await resolvedDeps.incrementEventUsage(
          statePath,
          logEntries.map((entry) => entry.id),
          "memory_search",
        );
      }

      const logLines = logEntries.map(formatLogEntry);
      const builtinText = extractTextFromToolResult(builtinResult);

      if (logLines.length === 0 && !builtinText) {
        return textResult("No results.", {
          logMatches: logEntries.length,
          semanticMatches: builtinText ? 1 : 0,
        });
      }

      if (logLines.length === 0) {
        return textResult(builtinText, {
          logEntries,
        });
      }

      const combined = builtinText
        ? `${logLines.join("\n")}\n\nSemantic matches:\n${builtinText}`
        : logLines.join("\n");

      return textResult(combined, {
        logEntries,
      });
    },
  } as AnyAgentTool;
}
