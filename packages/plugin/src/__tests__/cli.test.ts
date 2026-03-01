import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../config";
import {
  __cliTestExports,
  AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER,
  AGENTS_MEMORY_GUIDANCE_END_MARKER,
  BRIEFING_BEGIN_MARKER,
  BRIEFING_END_MARKER,
  LAST_HANDOFF_BEGIN_MARKER,
  LAST_HANDOFF_END_MARKER,
  MEMORY_NOTICE_BEGIN_MARKER,
  MEMORY_NOTICE_END_MARKER,
  detectImportSources,
  runImportCommand,
  buildPostInitSystemEventText,
  runInit,
  runUninstall,
  runVerify,
  verifySetup,
} from "../cli/commands";

function createConfig(logDir: string): PluginConfig {
  return {
    logDir,
    extraction: {
      model: "anthropic/claude-sonnet-4-6",
      skipSessionTypes: ["cron:", "sub:", "hook:"],
    },
    briefing: {
      model: "anthropic/claude-sonnet-4-6",
      activeWindow: 14,
      staleThreshold: 30,
      maxLines: 80,
    },
    cron: {
      schedule: "0 3 * * *",
      timezone: "UTC",
    },
  };
}

describe("cli init helpers", () => {
  let tempDir = "";
  let openClawHome = "";
  let workspaceDir = "";
  let logDir = "";
  let originalOpenClawHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zettelclaw-cli-"));
    openClawHome = join(tempDir, "openclaw");
    workspaceDir = join(tempDir, "workspace");
    logDir = join(tempDir, "zettelclaw-store");

    await mkdir(openClawHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    originalOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openClawHome;
  });

  afterEach(async () => {
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  const fakeGuidanceEvent = async () => ({ sent: true as const });

  test("runInit creates log files, updates config, and adds MEMORY.md markers", async () => {
    const memoryPath = join(workspaceDir, "MEMORY.md");
    await writeFile(memoryPath, "## Goals\n- Keep tests green\n", "utf8");

    const initResult = await runInit(createConfig(logDir), workspaceDir, {
      fireGuidanceEvent: fakeGuidanceEvent,
    });

    const logExists = await Bun.file(join(logDir, "log.jsonl")).exists();
    const subjectsText = await readFile(join(logDir, "subjects.json"), "utf8");
    const stateText = await readFile(join(logDir, "state.json"), "utf8");
    const openClawConfig = JSON.parse(await readFile(join(openClawHome, "openclaw.json"), "utf8")) as Record<string, unknown>;
    const cronJobs = JSON.parse(await readFile(join(openClawHome, "cron", "jobs.json"), "utf8")) as {
      jobs?: Array<{ name?: string }>;
    };
    const memoryContent = await readFile(memoryPath, "utf8");

    expect(logExists).toBe(true);
    expect(subjectsText.trim()).toBe("{}");
    expect(stateText).toContain("extractedSessions");
    expect((openClawConfig.plugins as { slots?: { memory?: string } }).slots?.memory).toBe("zettelclaw");
    expect((openClawConfig.plugins as { allow?: string[] }).allow).toContain("zettelclaw");
    expect(
      (
        openClawConfig.agents as { defaults?: { compaction?: { memoryFlush?: { enabled?: unknown } } } }
      ).defaults?.compaction?.memoryFlush?.enabled,
    ).toBe(false);
    expect(
      (
        openClawConfig.hooks as {
          internal?: { entries?: { "session-memory"?: { enabled?: unknown } } };
        }
      ).internal?.entries?.["session-memory"]?.enabled,
    ).toBe(false);
    expect(cronJobs.jobs?.some((job) => job.name === "zettelclaw-briefing")).toBe(true);
    expect(cronJobs.jobs?.some((job) => job.name === "zettelclaw-reset")).toBe(false);
    expect(cronJobs.jobs?.some((job) => job.name === "zettelclaw-nightly")).toBe(false);
    expect(memoryContent).toContain(BRIEFING_BEGIN_MARKER);
    expect(memoryContent).toContain(BRIEFING_END_MARKER);
    expect(memoryContent).toContain(LAST_HANDOFF_BEGIN_MARKER);
    expect(memoryContent).toContain(LAST_HANDOFF_END_MARKER);
    expect(initResult.guidanceEvent.sent).toBe(true);
  });

  test("buildPostInitSystemEventText renders AGENTS/MEMORY excerpts and target paths", async () => {
    const paths = {
      logDir,
      logPath: join(logDir, "log.jsonl"),
      subjectsPath: join(logDir, "subjects.json"),
      statePath: join(logDir, "state.json"),
      cronJobsPath: join(openClawHome, "cron", "jobs.json"),
      openClawConfigPath: join(openClawHome, "openclaw.json"),
      agentsMdPath: join(workspaceDir, "AGENTS.md"),
      memoryMdPath: join(workspaceDir, "MEMORY.md"),
    };

    const eventText = await buildPostInitSystemEventText(paths);
    expect(eventText).toContain(paths.agentsMdPath);
    expect(eventText).toContain(paths.memoryMdPath);
    expect(eventText).toContain(AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER);
    expect(eventText).toContain(MEMORY_NOTICE_BEGIN_MARKER);
  });

  test("runUninstall reverses init config and removes generated briefing block without deleting log data", async () => {
    const memoryPath = join(workspaceDir, "MEMORY.md");
    await writeFile(memoryPath, "## Goals\n- Keep tests green\n", "utf8");

    await runInit(createConfig(logDir), workspaceDir, {
      fireGuidanceEvent: fakeGuidanceEvent,
    });

    await writeFile(
      memoryPath,
      [
        "## Goals",
        "- Keep tests green",
        "",
        BRIEFING_BEGIN_MARKER,
        "## Active",
        "- auth-migration — Queue retries enabled",
        BRIEFING_END_MARKER,
        "",
        "## Notes",
        "Still here",
      ].join("\n"),
      "utf8",
    );

    await runUninstall(createConfig(logDir), workspaceDir);

    const openClawConfig = JSON.parse(await readFile(join(openClawHome, "openclaw.json"), "utf8")) as {
      plugins?: { slots?: Record<string, unknown> };
      agents?: { defaults?: { compaction?: Record<string, unknown> } };
    };
    const memoryContent = await readFile(memoryPath, "utf8");
    const logExists = await Bun.file(join(logDir, "log.jsonl")).exists();
    const subjectsExists = await Bun.file(join(logDir, "subjects.json")).exists();
    const stateExists = await Bun.file(join(logDir, "state.json")).exists();

    expect(openClawConfig.plugins?.slots?.memory).toBeUndefined();
    expect(openClawConfig.agents?.defaults?.compaction?.memoryFlush).toBeUndefined();

    expect(memoryContent).not.toContain(BRIEFING_BEGIN_MARKER);
    expect(memoryContent).not.toContain(BRIEFING_END_MARKER);
    expect(memoryContent).toContain("## Goals");
    expect(memoryContent).toContain("## Notes");

    expect(logExists).toBe(true);
    expect(subjectsExists).toBe(true);
    expect(stateExists).toBe(true);
  });

  test("runVerify passes after runInit", async () => {
    const agentsPath = join(workspaceDir, "AGENTS.md");
    const memoryPath = join(workspaceDir, "MEMORY.md");

    await runInit(createConfig(logDir), workspaceDir, {
      fireGuidanceEvent: fakeGuidanceEvent,
    });
    await writeFile(
      agentsPath,
      [
        "## Workspace Rules",
        "",
        AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER,
        "## Memory System (Zettelclaw)",
        AGENTS_MEMORY_GUIDANCE_END_MARKER,
      ].join("\n"),
      "utf8",
    );

    const existingMemory = await readFile(memoryPath, "utf8");
    await writeFile(
      memoryPath,
      [
        MEMORY_NOTICE_BEGIN_MARKER,
        "## Zettelclaw Memory Mode",
        MEMORY_NOTICE_END_MARKER,
        "",
        existingMemory.trim(),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runVerify(createConfig(logDir), workspaceDir);
    expect(result.ok).toBe(true);
  });

  test("verifySetup fails before initialization", async () => {
    const result = await verifySetup(createConfig(logDir), workspaceDir);
    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.ok === false)).toBe(true);
  });

  test("buildTraceReport flags broken and branching chains", () => {
    const report = __cliTestExports.buildTraceReport([
      {
        id: "root00000001",
        timestamp: "2026-02-20T00:00:00.000Z",
        type: "decision",
        content: "Original decision",
        subject: "auth-migration",
        session: "s1",
      },
      {
        id: "next00000001",
        timestamp: "2026-02-21T00:00:00.000Z",
        type: "decision",
        content: "Updated decision",
        subject: "auth-migration",
        session: "s2",
        replaces: "root00000001",
      },
      {
        id: "fork00000001",
        timestamp: "2026-02-22T00:00:00.000Z",
        type: "decision",
        content: "Competing update",
        subject: "auth-migration",
        session: "s3",
        replaces: "root00000001",
      },
      {
        id: "broken000001",
        timestamp: "2026-02-23T00:00:00.000Z",
        type: "fact",
        content: "Broken chain node",
        subject: "auth-migration",
        session: "s4",
        replaces: "missing000001",
      },
    ]);

    expect(report.issues.some((issue) => issue.kind === "branching" && issue.id === "root00000001")).toBe(true);
    expect(report.issues.some((issue) => issue.kind === "broken" && issue.id === "broken000001")).toBe(true);
  });

  test("runImportCommand backs up and clears legacy memory dir after successful openclaw migration", async () => {
    const legacyMemoryDir = join(workspaceDir, "memory");
    const sourceFile = join(legacyMemoryDir, "2026-02-27.md");
    await mkdir(legacyMemoryDir, { recursive: true });
    await writeFile(sourceFile, "original legacy memory content", "utf8");

    const result = await runImportCommand(
      {
        config: createConfig(logDir),
        workspaceDir,
        apiConfig: {},
        platform: "openclaw",
        filePath: legacyMemoryDir,
        opts: {},
      },
      {
        runReclawImport: async () => {
          await writeFile(sourceFile, "migrated", "utf8");
          return {
            platform: "openclaw",
            parsed: 1,
            dedupedInInput: 0,
            selected: 1,
            skippedByDate: 0,
            skippedByMinMessages: 0,
            skippedAlreadyImported: 0,
            imported: 1,
            failed: 0,
            entriesWritten: 1,
            transcriptsWritten: 1,
            dryRun: false,
          };
        },
      },
    );

    expect(result.legacyBackupPath).toBeDefined();
    expect(result.legacyMemoryCleared).toBe(true);
    expect(result.statePath).toBe(join(logDir, "state.json"));

    const backupPath = result.legacyBackupPath as string;
    const backedUpContent = await readFile(join(backupPath, "2026-02-27.md"), "utf8");
    expect(backedUpContent).toBe("original legacy memory content");

    const remaining = await readdir(legacyMemoryDir);
    expect(remaining).toEqual([]);
  });

  test("runImportCommand dry-run for openclaw does not back up or clear memory dir", async () => {
    const legacyMemoryDir = join(workspaceDir, "memory");
    const sourceFile = join(legacyMemoryDir, "2026-02-28.md");
    await mkdir(legacyMemoryDir, { recursive: true });
    await writeFile(sourceFile, "keep me", "utf8");

    const result = await runImportCommand(
      {
        config: createConfig(logDir),
        workspaceDir,
        apiConfig: {},
        platform: "openclaw",
        filePath: legacyMemoryDir,
        opts: { dryRun: true },
      },
      {
        runReclawImport: async () => ({
          platform: "openclaw",
          parsed: 1,
          dedupedInInput: 0,
          selected: 1,
          skippedByDate: 0,
          skippedByMinMessages: 0,
          skippedAlreadyImported: 0,
          imported: 0,
          failed: 0,
          entriesWritten: 0,
          transcriptsWritten: 0,
          dryRun: true,
        }),
      },
    );

    expect(result.legacyBackupPath).toBeUndefined();
    expect(result.legacyMemoryCleared).toBe(false);
    expect(result.statePath).toBe(join(logDir, "state.json"));
    expect(await readFile(sourceFile, "utf8")).toBe("keep me");
    expect(await Bun.file(join(logDir, "log.jsonl")).exists()).toBe(false);
    expect(await Bun.file(join(logDir, "subjects.json")).exists()).toBe(false);
    expect(await Bun.file(join(logDir, "state.json")).exists()).toBe(false);
  });

  test("runImportCommand honors keep-source and optional MEMORY/USER backups", async () => {
    const legacyMemoryDir = join(workspaceDir, "memory");
    const sourceFile = join(legacyMemoryDir, "2026-02-28.md");
    await mkdir(legacyMemoryDir, { recursive: true });
    await writeFile(sourceFile, "legacy note", "utf8");

    const memoryMdPath = join(workspaceDir, "MEMORY.md");
    const userMdPath = join(workspaceDir, "USER.md");
    await writeFile(memoryMdPath, "memory doc", "utf8");
    await writeFile(userMdPath, "user doc", "utf8");

    let receivedStatePath = "";

    const result = await runImportCommand(
      {
        config: createConfig(logDir),
        workspaceDir,
        apiConfig: {},
        platform: "openclaw",
        filePath: legacyMemoryDir,
        opts: {
          keepSource: true,
          backupMemoryDocs: true,
        },
      },
      {
        runReclawImport: async (options) => {
          receivedStatePath = options.statePath;
          return {
            platform: "openclaw",
            parsed: 1,
            dedupedInInput: 0,
            selected: 1,
            skippedByDate: 0,
            skippedByMinMessages: 0,
            skippedAlreadyImported: 0,
            imported: 1,
            failed: 0,
            entriesWritten: 1,
            transcriptsWritten: 0,
            dryRun: false,
          };
        },
      },
    );

    const defaultStatePath = join(logDir, "state.json");
    expect(receivedStatePath).toBe(defaultStatePath);
    expect(result.statePath).toBe(defaultStatePath);
    expect(await Bun.file(defaultStatePath).exists()).toBe(true);
    expect(result.legacyMemoryCleared).toBe(false);
    expect(await readFile(sourceFile, "utf8")).toBe("legacy note");

    expect(result.memoryDocBackupPath).toBeDefined();
    expect(result.userDocBackupPath).toBeDefined();
    const memoryBackup = result.memoryDocBackupPath as string;
    const userBackup = result.userDocBackupPath as string;
    expect(await readFile(memoryBackup, "utf8")).toBe("memory doc");
    expect(await readFile(userBackup, "utf8")).toBe("user doc");
  });

  test("detectImportSources finds openclaw memory dir and chat export JSON", async () => {
    const memoryDir = join(workspaceDir, "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "2026-02-28.md"), "legacy memory note", "utf8");

    const chatgptExportPath = join(workspaceDir, "chatgpt-export.json");
    await writeFile(
      chatgptExportPath,
      JSON.stringify([
        {
          id: "chatgpt-conv-1",
          title: "Import test",
          create_time: 1704067200,
          update_time: 1704067500,
          current_node: "node-2",
          mapping: {
            "node-1": {
              id: "node-1",
              message: {
                id: "m1",
                author: { role: "user" },
                create_time: 1704067200,
                content: { content_type: "text", parts: ["hello"] },
              },
              children: ["node-2"],
            },
            "node-2": {
              id: "node-2",
              parent: "node-1",
              message: {
                id: "m2",
                author: { role: "assistant" },
                create_time: 1704067210,
                content: { content_type: "text", parts: ["world"] },
              },
            },
          },
        },
      ]),
      "utf8",
    );

    const detections = await detectImportSources(workspaceDir);
    expect(detections.openclaw.some((detection) => detection.path === memoryDir)).toBe(true);
    expect(detections.chatgpt.some((detection) => detection.path === chatgptExportPath)).toBe(true);
  });
});
