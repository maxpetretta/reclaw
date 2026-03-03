import type { LogEntry } from "../log/schema";
import { replaceManagedBlock } from "./managed-block";
import { LAST_HANDOFF_BEGIN_MARKER, LAST_HANDOFF_END_MARKER } from "./markers";

interface LastHandoffFormatOptions {
  sessionKey?: string;
}

export function formatLastHandoff(entry: LogEntry, options: LastHandoffFormatOptions = {}): string {
  const sessionKey = options.sessionKey?.trim() || entry.session;
  const lines = [
    `## Previous Session Handoff (${sessionKey})`,
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

export function applyLastHandoffBlock(
  memoryContent: string,
  entry: LogEntry,
  options: LastHandoffFormatOptions = {},
): string {
  return replaceManagedBlock(
    memoryContent,
    LAST_HANDOFF_BEGIN_MARKER,
    LAST_HANDOFF_END_MARKER,
    formatLastHandoff(entry, options),
  );
}
