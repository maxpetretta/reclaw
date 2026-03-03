import type { PluginConfig } from "../config";
import { queryLog, searchLog } from "../log/query";
import { parseEntryType, parseEntryStatus, type LogEntry } from "../log/schema";
import { resolvePaths } from "./paths";
import type { CommandLike } from "./command-like";
import { parseIsoDateInput, readPositiveNumberOption, toObject } from "./parse";

interface TraceChain {
  subject: string;
  ids: string[];
}

interface TraceReport {
  chains: TraceChain[];
}

interface TraceRenderOptions {
  focusId?: string;
  limit?: number;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatEntry(entry: LogEntry): string {
  const subject = entry.subject ? ` (${entry.subject})` : "";
  const base = `[${formatTimestamp(entry.timestamp)}] [id=${entry.id}] [${entry.type}]${subject} ${entry.content}`;
  if (entry.detail) {
    return `${base}\n  ${entry.detail}`;
  }

  return base;
}

function printEntries(entries: LogEntry[], total?: number): void {
  if (entries.length === 0) {
    console.log("No entries.");
    return;
  }

  for (const entry of entries) {
    console.log(formatEntry(entry));
  }

  if (typeof total === "number" && total > entries.length) {
    console.log(`(showing ${entries.length} of ${total} entries)`);
  }
}

function readOptionalPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return undefined;
}

export function buildTraceReport(entries: LogEntry[]): TraceReport {
  const bySubject = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const subject = entry.subject?.trim() || "__unscoped__";
    const group = bySubject.get(subject) ?? [];
    group.push(entry);
    bySubject.set(subject, group);
  }

  const chains: TraceChain[] = [];
  for (const [subject, group] of bySubject.entries()) {
    const ids = [...group]
      .sort((left, right) => {
        const leftTs = Date.parse(left.timestamp);
        const rightTs = Date.parse(right.timestamp);
        if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
          return leftTs - rightTs;
        }
        return left.id.localeCompare(right.id);
      })
      .map((entry) => entry.id);
    chains.push({ subject, ids });
  }

  return {
    chains: chains.filter((chain) => chain.ids.length > 0),
  };
}

function selectTraceChains(report: TraceReport, focusId?: string): TraceChain[] {
  return typeof focusId === "string" && focusId.trim().length > 0
    ? report.chains.filter((chain) => chain.ids.includes(focusId.trim()))
    : report.chains;
}

function printTraceSummary(entries: LogEntry[], report: TraceReport, focusId?: string): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chainsToPrint = selectTraceChains(report, focusId);

  if (chainsToPrint.length === 0) {
    console.log("No chains found.");
    return;
  }

  for (const [chainIndex, chain] of chainsToPrint.entries()) {
    const subjectLabel = chain.subject === "__unscoped__" ? "unscoped" : chain.subject;
    const entriesInChain = chain.ids
      .map((id) => byId.get(id))
      .filter((entry): entry is LogEntry => Boolean(entry));
    const first = entriesInChain[0];
    const last = entriesInChain[entriesInChain.length - 1];

    if (!first || !last) {
      console.log(`Chain ${chainIndex + 1} (${subjectLabel}): entries=${chain.ids.length}`);
      continue;
    }

    console.log(
      `Chain ${chainIndex + 1} (${subjectLabel}): entries=${chain.ids.length} first=${formatTimestamp(first.timestamp)} last=${formatTimestamp(last.timestamp)} latestId=${last.id}`,
    );
  }
}

function printTraceReport(entries: LogEntry[], report: TraceReport, options: TraceRenderOptions = {}): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chainsToPrint = selectTraceChains(report, options.focusId);

  if (chainsToPrint.length === 0) {
    console.log("No chains found.");
    return;
  }

  chainsToPrint.forEach((chain, chainIndex) => {
    const subjectLabel = chain.subject === "__unscoped__" ? "unscoped" : chain.subject;
    console.log(`Chain ${chainIndex + 1} (${subjectLabel}):`);

    const displayIds =
      typeof options.limit === "number" && options.limit > 0 && chain.ids.length > options.limit
        ? chain.ids.slice(chain.ids.length - options.limit)
        : chain.ids;

    if (displayIds.length < chain.ids.length) {
      console.log(`  ... (showing most recent ${displayIds.length} of ${chain.ids.length})`);
    }

    displayIds.forEach((id, index) => {
      const entry = byId.get(id);
      const prefix = index === 0 ? "  " : "  -> ";
      if (!entry) {
        console.log(`${prefix}[id=${id}] (missing entry)`);
        return;
      }
      console.log(`${prefix}${formatEntry(entry)}`);
    });
  });
}

export function registerLogCommands(
  reclaw: CommandLike,
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
): void {
  reclaw
    .command("log")
    .description("Print recent log entries")
    .option("--limit <n>", "Max number of entries", 20)
    .option("--type <type>", "Entry type")
    .option("--subject <slug>", "Subject slug")
    .action(async (opts: unknown) => {
      const options = toObject(opts);
      const paths = resolvePaths(params.config, params.workspaceDir);
      const limit = readPositiveNumberOption(options.limit, 20);

      const entries = await queryLog(paths.logPath, {
        ...(parseEntryType(options.type) ? { type: parseEntryType(options.type) } : {}),
        ...(typeof options.subject === "string" && options.subject.trim()
          ? { subject: options.subject.trim() }
          : {}),
      });

      printEntries(entries.slice(0, limit), entries.length);
    });

  reclaw
    .command("search [query]")
    .description("Search log entries")
    .option("--type <type>", "Entry type")
    .option("--subject <slug>", "Subject slug")
    .option("--status <status>", "Task status")
    .option("--from <date>", "Start date/time (ISO-8601 or date string)")
    .option("--to <date>", "End date/time (ISO-8601 or date string)")
    .action(async (query: unknown, opts: unknown) => {
      const options = toObject(opts);
      const paths = resolvePaths(params.config, params.workspaceDir);
      const from = parseIsoDateInput(options.from);
      const to = parseIsoDateInput(options.to);

      const filter = {
        ...(parseEntryType(options.type) ? { type: parseEntryType(options.type) } : {}),
        ...(typeof options.subject === "string" && options.subject.trim()
          ? { subject: options.subject.trim() }
          : {}),
        ...(parseEntryStatus(options.status) ? { status: parseEntryStatus(options.status) } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      };

      const entries =
        typeof query === "string" && query.trim().length > 0
          ? await searchLog(paths.logPath, query.trim(), filter)
          : await queryLog(paths.logPath, filter);

      printEntries(entries);
    });

  reclaw
    .command("trace [id]")
    .description("Trace chronological event sequences by subject")
    .option("--subject <slug>", "Filter by subject slug")
    .option("--from <date>", "Start date/time (ISO-8601 or date string)")
    .option("--to <date>", "End date/time (ISO-8601 or date string)")
    .option("--limit <n>", "Max entries to print per chain")
    .option("--summary", "Show one-line summary per chain", false)
    .action(async (id: unknown, opts: unknown) => {
      const options = toObject(opts);
      const paths = resolvePaths(params.config, params.workspaceDir);
      const subject =
        typeof options.subject === "string" && options.subject.trim().length > 0
          ? options.subject.trim()
          : undefined;
      const from = parseIsoDateInput(options.from);
      const to = parseIsoDateInput(options.to);
      const limit = readOptionalPositiveNumber(options.limit);
      const summary = options.summary === true || options.summary === "true";

      const entries = await queryLog(paths.logPath, {
        ...(subject ? { subject } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      });

      if (entries.length === 0) {
        console.log("No entries.");
        return;
      }

      const report = buildTraceReport(entries);
      const focusId = typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
      if (summary) {
        printTraceSummary(entries, report, focusId);
        return;
      }

      printTraceReport(entries, report, {
        focusId,
        limit,
      });
    });
}
