import type { LogEntry } from "../log/schema";
import { replaceManagedBlock } from "./managed-block";
import { LAST_SESSION_SUMMARY_BEGIN_MARKER, LAST_SESSION_SUMMARY_END_MARKER } from "./markers";

interface LastSessionSummaryFormatOptions {
  sessionKey?: string;
}

export function formatLastSessionSummary(entry: LogEntry, options: LastSessionSummaryFormatOptions = {}): string {
  const sessionKey = options.sessionKey?.trim() || entry.session;
  const lines = [
    `## Previous Session Summary (${sessionKey})`,
    "",
    entry.content,
  ];

  if (entry.detail) {
    lines.push(
      "",
      "### Details",
      "",
      entry.detail,
    );
  }

  return lines.join("\n");
}

export function applyLastSessionSummaryBlock(
  memoryContent: string,
  entry: LogEntry,
  options: LastSessionSummaryFormatOptions = {},
): string {
  return replaceManagedBlock(
    memoryContent,
    LAST_SESSION_SUMMARY_BEGIN_MARKER,
    LAST_SESSION_SUMMARY_END_MARKER,
    formatLastSessionSummary(entry, options),
  );
}
