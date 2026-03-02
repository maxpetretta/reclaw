import type { LogEntry } from "../log/schema";
import { replaceManagedBlock } from "./managed-block";
import { LAST_HANDOFF_BEGIN_MARKER, LAST_HANDOFF_END_MARKER } from "./markers";

export function formatLastHandoff(entry: LogEntry): string {
  const lines = [
    "## Zettelclaw Session Handoff",
    `Session: ${entry.session} (${entry.timestamp})`,
    entry.content,
  ];

  if (entry.detail) {
    lines.push(`Detail: ${entry.detail}`);
  }

  return lines.join("\n");
}

export function applyLastHandoffBlock(memoryContent: string, entry: LogEntry): string {
  return replaceManagedBlock(
    memoryContent,
    LAST_HANDOFF_BEGIN_MARKER,
    LAST_HANDOFF_END_MARKER,
    formatLastHandoff(entry),
  );
}
