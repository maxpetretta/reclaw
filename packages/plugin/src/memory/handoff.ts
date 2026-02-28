import type { LogEntry } from "../log/schema";
import { replaceManagedBlock } from "./managed-block";

export const LAST_HANDOFF_BEGIN_MARKER = "<!-- BEGIN LAST HANDOFF -->";
export const LAST_HANDOFF_END_MARKER = "<!-- END LAST HANDOFF -->";

export function formatLastHandoff(entry: LogEntry): string {
  const lines = [
    "## Last Session Handoff",
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
