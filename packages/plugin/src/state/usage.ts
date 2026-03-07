import { updateState } from "./store";
import type { EventUsageKind } from "./types";

export async function incrementEventUsage(
  path: string,
  eventIds: string[],
  kind: EventUsageKind,
): Promise<void> {
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return;
  }

  const normalizedIds = [...new Set(
    eventIds
      .map((eventId) => eventId.trim())
      .filter((eventId) => eventId.length > 0),
  )];
  if (normalizedIds.length === 0) {
    return;
  }

  await updateState(path, (state) => {
    const now = new Date().toISOString();

    for (const eventId of normalizedIds) {
      const existing = state.eventUsage[eventId] ?? {
        memoryGetCount: 0,
        memorySearchCount: 0,
        citationCount: 0,
        lastAccessAt: now,
      };

      if (kind === "memory_get") {
        existing.memoryGetCount += 1;
      } else if (kind === "memory_search") {
        existing.memorySearchCount += 1;
      } else {
        existing.citationCount += 1;
      }

      existing.lastAccessAt = now;
      state.eventUsage[eventId] = existing;
    }
  });
}
