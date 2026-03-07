import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry } from "../log/schema";
import {
  listSubjectProjectionFiles,
  refreshSubjectProjections,
  resolveSubjectProjectionFilePath,
} from "../projections/subjects";
import { writeRegistry } from "../subjects/registry";

describe("subject projections", () => {
  let tempDir = "";
  let projectionDir = "";
  let logDir = "";
  let logPath = "";
  let subjectsPath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reclaw-projections-"));
    logDir = join(tempDir, "reclaw");
    logPath = join(logDir, "log.jsonl");
    subjectsPath = join(logDir, "subjects.json");
    projectionDir = join(logDir, "memory");
    await mkdir(logDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("refreshSubjectProjections writes subject markdown files and removes stale files on full refresh", async () => {
    await writeRegistry(subjectsPath, {
      "auth-migration": { display: "Auth Migration", type: "project" },
      "empty-subject": { display: "Empty Subject", type: "topic" },
    });
    await appendEntry(logPath, {
      id: "factauth0001",
      timestamp: "2026-03-01T00:00:00.000Z",
      type: "fact",
      subject: "auth-migration",
      content: "Queue retries are enabled",
      session: "session-1",
    });
    await appendEntry(logPath, {
      id: "taskauth0001",
      timestamp: "2026-03-02T00:00:00.000Z",
      type: "task",
      subject: "auth-migration",
      status: "open",
      content: "Run the canary",
      detail: "Watch error rates",
      session: "session-2",
    });

    const stalePath = resolveSubjectProjectionFilePath(projectionDir, "stale-subject");
    await mkdir(projectionDir, { recursive: true });
    await writeFile(stalePath, "# stale\n", "utf8");

    const result = await refreshSubjectProjections({
      projectionDir,
      logPath,
      subjectsPath,
    });

    expect(result.refreshedSubjects).toEqual(["auth-migration", "empty-subject"]);
    expect(result.removedSubjects).toEqual(["stale-subject"]);

    const authProjection = await readFile(resolveSubjectProjectionFilePath(projectionDir, "auth-migration"), "utf8");
    expect(authProjection).toContain("# Auth Migration");
    expect(authProjection).toContain("## Open Items");
    expect(authProjection).toContain("Run the canary");
    expect(authProjection).toContain("`taskauth0001`");
    expect(authProjection).toContain("## Timeline");

    const emptyProjection = await readFile(resolveSubjectProjectionFilePath(projectionDir, "empty-subject"), "utf8");
    expect(emptyProjection).toContain("# Empty Subject");
    expect(emptyProjection).toContain("No events recorded yet.");
  });

  test("listSubjectProjectionFiles returns generated markdown files", async () => {
    await writeRegistry(subjectsPath, {
      "auth-migration": { display: "Auth Migration", type: "project" },
    });
    await refreshSubjectProjections({
      projectionDir,
      logPath,
      subjectsPath,
    });

    const files = await listSubjectProjectionFiles(projectionDir);
    expect(files).toHaveLength(1);
    expect(files[0]?.slug).toBe("auth-migration");
    expect(files[0]?.path).toBe(resolveSubjectProjectionFilePath(projectionDir, "auth-migration"));
  });
});
