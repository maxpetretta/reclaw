import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { PluginConfig } from "../config";
import {
  AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER,
  AGENTS_MEMORY_GUIDANCE_END_MARKER,
  BRIEFING_BEGIN_MARKER,
  BRIEFING_END_MARKER,
  LAST_HANDOFF_BEGIN_MARKER,
  LAST_HANDOFF_END_MARKER,
  MEMORY_NOTICE_BEGIN_MARKER,
  MEMORY_NOTICE_END_MARKER,
} from "../memory/markers";
import {
  __cliTestExports,
  detectImportSources,
  queueImportJob,
  resumeImportJobs,
  stopImportJobs,
  runImportCommand,
  runImportWorker,
  buildPostInitSystemEventText,
  runInit,
  runUninstall,
  runVerify,
  verifySetup,
} from "../cli/commands";
import { IMPORT_STOP_REQUESTED_ERROR } from "../import/run";
import { readState, writeState } from "../state";

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
      maxLines: 120,
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
    tempDir = await mkdtemp(join(tmpdir(), "reclaw-cli-"));
    openClawHome = join(tempDir, "openclaw");
    workspaceDir = join(tempDir, "workspace");
    logDir = join(tempDir, "reclaw-store");

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
    expect((openClawConfig.plugins as { slots?: { memory?: string } }).slots?.memory).toBe("reclaw");
    expect((openClawConfig.plugins as { allow?: string[] }).allow).toContain("reclaw");
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
    expect(cronJobs.jobs?.some((job) => job.name === "reclaw-memory-snapshot")).toBe(true);
    expect(cronJobs.jobs?.some((job) => job.name === "reclaw-reset")).toBe(false);
    expect(cronJobs.jobs?.some((job) => job.name === "reclaw-nightly")).toBe(false);
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
        "## Memory System (Reclaw)",
        AGENTS_MEMORY_GUIDANCE_END_MARKER,
      ].join("\n"),
      "utf8",
    );

    const existingMemory = await readFile(memoryPath, "utf8");
    await writeFile(
      memoryPath,
      [
        MEMORY_NOTICE_BEGIN_MARKER,
        "## Reclaw Memory Mode",
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

  test("runVerify accepts legacy state.json without eventUsage", async () => {
    const agentsPath = join(workspaceDir, "AGENTS.md");
    const memoryPath = join(workspaceDir, "MEMORY.md");
    const statePath = join(logDir, "state.json");

    await runInit(createConfig(logDir), workspaceDir, {
      fireGuidanceEvent: fakeGuidanceEvent,
    });

    const stateRaw = await readFile(statePath, "utf8");
    const parsedState = JSON.parse(stateRaw) as Record<string, unknown>;
    delete parsedState.eventUsage;
    await writeFile(statePath, `${JSON.stringify(parsedState, null, 2)}\n`, "utf8");

    await writeFile(
      agentsPath,
      [
        "## Workspace Rules",
        "",
        AGENTS_MEMORY_GUIDANCE_BEGIN_MARKER,
        "## Memory System (Reclaw)",
        AGENTS_MEMORY_GUIDANCE_END_MARKER,
      ].join("\n"),
      "utf8",
    );

    const existingMemory = await readFile(memoryPath, "utf8");
    await writeFile(
      memoryPath,
      [
        MEMORY_NOTICE_BEGIN_MARKER,
        "## Reclaw Memory Mode",
        MEMORY_NOTICE_END_MARKER,
        "",
        existingMemory.trim(),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runVerify(createConfig(logDir), workspaceDir);
    expect(result.ok).toBe(true);
    const stateCheck = result.checks.find((check) => check.name === "state.json");
    expect(stateCheck?.ok).toBe(true);
    expect(stateCheck?.detail).toContain("legacy state");
  });

  test("verifySetup fails before initialization", async () => {
    const result = await verifySetup(createConfig(logDir), workspaceDir);
    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.ok === false)).toBe(true);
  });

  test("buildTraceReport groups entries by subject chronology", () => {
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
      },
      {
        id: "fork00000001",
        timestamp: "2026-02-22T00:00:00.000Z",
        type: "decision",
        content: "Competing update",
        subject: "auth-migration",
        session: "s3",
      },
      {
        id: "broken000001",
        timestamp: "2026-02-23T00:00:00.000Z",
        type: "fact",
        content: "Broken chain node",
        subject: "auth-migration",
        session: "s4",
      },
    ]);

    expect(report.chains).toHaveLength(1);
    expect(report.chains[0]?.subject).toBe("auth-migration");
    expect(report.chains[0]?.ids).toEqual([
      "root00000001",
      "next00000001",
      "fork00000001",
      "broken000001",
    ]);
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
            subjectsCreated: 1,
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
          subjectsCreated: 0,
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
            subjectsCreated: 1,
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

  test("detectImportSources keeps chatgpt/claude/grok detections scoped to matching exports", async () => {
    const chatgptDir = join(workspaceDir, "extracts", "chatgpt");
    const claudeDir = join(workspaceDir, "extracts", "claude");
    const grokDir = join(workspaceDir, "extracts", "grok", "30d", "export_data", "bundle-1");
    await mkdir(chatgptDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(grokDir, { recursive: true });

    const chatgptPath = join(chatgptDir, "conversations.json");
    await writeFile(
      chatgptPath,
      JSON.stringify([
        {
          id: "chatgpt-conv-1",
          title: "ChatGPT test",
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
                create_time: 1704067260,
                content: { content_type: "text", parts: ["world"] },
              },
            },
          },
        },
      ]),
      "utf8",
    );

    const claudePath = join(claudeDir, "conversations.json");
    await writeFile(
      claudePath,
      JSON.stringify([
        {
          uuid: "claude-conv-1",
          name: "Claude test",
          created_at: "2024-01-01T00:00:00.000Z",
          updated_at: "2024-01-01T00:01:00.000Z",
          account: { uuid: "acct-1" },
          chat_messages: [
            {
              uuid: "c1",
              sender: "human",
              text: "hello claude",
              created_at: "2024-01-01T00:00:01.000Z",
            },
            {
              uuid: "c2",
              sender: "assistant",
              text: "hi there",
              created_at: "2024-01-01T00:00:05.000Z",
            },
          ],
        },
      ]),
      "utf8",
    );

    const grokPath = join(grokDir, "prod-grok-backend.json");
    await writeFile(
      grokPath,
      JSON.stringify({
        conversations: [
          {
            conversation: {
              _id: { $oid: "grok-conv-1" },
              title: "Grok test",
              createdAt: 1704067200,
              updatedAt: 1704067260,
            },
            responses: [
              {
                response: {
                  _id: { $oid: "g1" },
                  role: "user",
                  content: "hello grok",
                  createdAt: 1704067200,
                },
              },
              {
                response: {
                  _id: { $oid: "g2" },
                  role: "assistant",
                  content: "hello user",
                  createdAt: 1704067260,
                },
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const detections = await detectImportSources(workspaceDir);
    const chatgptPaths = detections.chatgpt.map((detection) => detection.path);
    const claudePaths = detections.claude.map((detection) => detection.path);
    const grokPaths = detections.grok.map((detection) => detection.path);

    expect(chatgptPaths).toContain(chatgptPath);
    expect(chatgptPaths).not.toContain(claudePath);
    expect(chatgptPaths).not.toContain(grokPath);

    expect(claudePaths).toContain(claudePath);
    expect(claudePaths).not.toContain(chatgptPath);
    expect(claudePaths).not.toContain(grokPath);

    expect(grokPaths).toContain(grokPath);
    expect(grokPaths).not.toContain(chatgptPath);
    expect(grokPaths).not.toContain(claudePath);
  });

  test("normalizeCliInputPath expands tilde to home directory", () => {
    const resolved = __cliTestExports.normalizeCliInputPath("~/Desktop/extracts-mini/grok");
    expect(resolved).toBe(resolvePath(join(homedir(), "Desktop/extracts-mini/grok")));
  });

  test("parseInteractiveImportJobs accepts integers from 1 to 10", () => {
    expect(__cliTestExports.parseInteractiveImportJobs("1")).toBe(1);
    expect(__cliTestExports.parseInteractiveImportJobs("10")).toBe(10);
    expect(__cliTestExports.parseInteractiveImportJobs(3)).toBe(3);
  });

  test("parseInteractiveImportJobs rejects invalid or out-of-range values", () => {
    expect(__cliTestExports.parseInteractiveImportJobs("0")).toBeUndefined();
    expect(__cliTestExports.parseInteractiveImportJobs("11")).toBeUndefined();
    expect(__cliTestExports.parseInteractiveImportJobs("-1")).toBeUndefined();
    expect(__cliTestExports.parseInteractiveImportJobs("abc")).toBeUndefined();
    expect(__cliTestExports.parseInteractiveImportJobs("2.5")).toBeUndefined();
  });

  test("resolveImportPathForPlatform accepts grok directory input and resolves JSON export", async () => {
    const grokDir = join(workspaceDir, "grok-export");
    await mkdir(grokDir, { recursive: true });
    const grokExportPath = join(grokDir, "conversations.json");
    await writeFile(
      grokExportPath,
      JSON.stringify({
        conversations: [
          {
            _id: "grok-1",
            title: "Grok test",
            messages: [
              { id: "m1", role: "user", content: "hello", timestamp: 1704067200 },
              { id: "m2", role: "assistant", content: "world", timestamp: 1704067260 },
            ],
          },
        ],
      }),
      "utf8",
    );

    const resolved = await __cliTestExports.resolveImportPathForPlatform("grok", grokDir);
    expect(resolved).toBe(grokExportPath);
  });

  test("resolveImportPathForPlatform prefers chatgpt conversations over shared metadata JSON", async () => {
    const chatgptDir = join(workspaceDir, "chatgpt-export");
    await mkdir(chatgptDir, { recursive: true });

    const sharedPath = join(chatgptDir, "shared_conversations.json");
    await writeFile(
      sharedPath,
      JSON.stringify([
        {
          id: "shared-1",
          conversation_id: "shared-1",
          title: "Shared metadata",
          is_anonymous: false,
        },
      ]),
      "utf8",
    );

    const conversationsPath = join(chatgptDir, "conversations.json");
    await writeFile(
      conversationsPath,
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
                create_time: 1704067260,
                content: { content_type: "text", parts: ["world"] },
              },
            },
          },
        },
      ]),
      "utf8",
    );

    const resolved = await __cliTestExports.resolveImportPathForPlatform("chatgpt", chatgptDir);
    expect(resolved).toBe(conversationsPath);
  });

  test("queueImportJob persists async job and schedules one-shot cron worker", async () => {
    const sourcePath = join(workspaceDir, "chatgpt-export.json");
    await writeFile(sourcePath, "[]", "utf8");

    const queued = await queueImportJob({
      config: createConfig(logDir),
      workspaceDir,
      apiConfig: {},
      platform: "chatgpt",
      filePath: sourcePath,
      opts: {
        async: true,
        model: "anthropic/claude-haiku-4-5",
        jobs: 4,
      },
    });

    expect(queued.job.status).toBe("queued");
    expect(queued.job.platform).toBe("chatgpt");
    expect(queued.job.options.model).toBe("anthropic/claude-haiku-4-5");
    expect(queued.job.options.jobs).toBe(4);

    const state = await readState(join(logDir, "state.json"));
    const persisted = state.importJobs[queued.job.id];
    expect(persisted).toBeDefined();
    expect(persisted?.status).toBe("queued");

    const cronDoc = JSON.parse(await readFile(join(openClawHome, "cron", "jobs.json"), "utf8")) as {
      jobs?: Array<Record<string, unknown>>;
    };
    const workerJob = cronDoc.jobs?.find(
      (entry) => entry.name === `reclaw-import-worker-${queued.job.id}`,
    );
    expect(workerJob).toBeDefined();
    expect(workerJob?.deleteAfterRun).toBe(true);
    expect((workerJob?.schedule as { kind?: string }).kind).toBe("at");
    expect((workerJob?.payload as { message?: string }).message).toContain(
      `openclaw reclaw import run --job ${queued.job.id}`,
    );
  });

  test("stopImportJobs marks queued job failed and removes worker cron job", async () => {
    const sourcePath = join(workspaceDir, "chatgpt-export.json");
    await writeFile(sourcePath, "[]", "utf8");

    const queued = await queueImportJob({
      config: createConfig(logDir),
      workspaceDir,
      apiConfig: {},
      platform: "chatgpt",
      filePath: sourcePath,
      opts: {
        async: true,
      },
    });

    const stopped = await stopImportJobs({
      config: createConfig(logDir),
      workspaceDir,
      jobId: queued.job.id,
    });

    expect(stopped.stoppedJobIds).toContain(queued.job.id);
    expect(stopped.unscheduledJobIds).toContain(queued.job.id);
    expect(stopped.unscheduleErrors).toHaveLength(0);

    const state = await readState(join(logDir, "state.json"));
    const job = state.importJobs[queued.job.id];
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("Stopped by user");
    expect(job?.stopRequestedAt).toBeDefined();
    expect(job?.cronJobId).toBeUndefined();
    expect(job?.cronJobName).toBeUndefined();

    const cronDoc = JSON.parse(await readFile(join(openClawHome, "cron", "jobs.json"), "utf8")) as {
      jobs?: Array<Record<string, unknown>>;
    };
    const workerJob = cronDoc.jobs?.find(
      (entry) => entry.name === `reclaw-import-worker-${queued.job.id}`,
    );
    expect(workerJob).toBeUndefined();
  });

  test("stopImportJobs marks running job with stop request and leaves terminal update to worker", async () => {
    const sourcePath = join(workspaceDir, "chatgpt-export.json");
    await writeFile(sourcePath, "[]", "utf8");

    const queued = await queueImportJob({
      config: createConfig(logDir),
      workspaceDir,
      apiConfig: {},
      platform: "chatgpt",
      filePath: sourcePath,
      opts: {
        async: true,
      },
    });

    const statePath = join(logDir, "state.json");
    const state = await readState(statePath);
    const running = state.importJobs[queued.job.id];
    expect(running).toBeDefined();
    if (running) {
      running.status = "running";
      running.startedAt = new Date().toISOString();
      running.attempts = 1;
      state.importJobs[queued.job.id] = running;
      await writeState(statePath, state);
    }

    const stopped = await stopImportJobs({
      config: createConfig(logDir),
      workspaceDir,
      jobId: queued.job.id,
    });

    expect(stopped.stoppedJobIds).toContain(queued.job.id);
    expect(stopped.unscheduledJobIds).toContain(queued.job.id);

    const nextState = await readState(statePath);
    const job = nextState.importJobs[queued.job.id];
    expect(job?.status).toBe("running");
    expect(job?.error).toBe("Stop requested by user");
    expect(job?.stopRequestedAt).toBeDefined();
  });

  test("runImportWorker marks queued job completed with summary", async () => {
    const sourcePath = join(workspaceDir, "chatgpt-export.json");
    await writeFile(sourcePath, "[]", "utf8");

    const queued = await queueImportJob({
      config: createConfig(logDir),
      workspaceDir,
      apiConfig: {},
      platform: "chatgpt",
      filePath: sourcePath,
      opts: {
        async: true,
      },
    });

    const calls: Array<Record<string, unknown>> = [];
    const result = await runImportWorker(
      {
        config: createConfig(logDir),
        workspaceDir,
        apiConfig: {},
        jobId: queued.job.id,
      },
      {
        runImportCommand: async (input) => {
          calls.push({
            platform: input.platform,
            filePath: input.filePath,
            opts: input.opts,
          });
          return {
            summary: {
              platform: "chatgpt",
              parsed: 1,
              dedupedInInput: 0,
              selected: 1,
              skippedByDate: 0,
              skippedByMinMessages: 0,
              skippedAlreadyImported: 0,
              imported: 1,
              failed: 0,
              entriesWritten: 2,
              subjectsCreated: 1,
              transcriptsWritten: 1,
              dryRun: false,
            },
            statePath: join(logDir, "state.json"),
          };
        },
      },
    );

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.platform).toBe("chatgpt");
    expect(calls[0]?.filePath).toBe(sourcePath);
    expect((calls[0]?.opts as { jobs?: number } | undefined)?.jobs).toBe(1);

    const state = await readState(join(logDir, "state.json"));
    const finished = state.importJobs[queued.job.id];
    expect(finished?.status).toBe("completed");
    expect(finished?.attempts).toBe(1);
    expect(finished?.summary?.entriesWritten).toBe(2);
  });

  test("runImportWorker returns null when job was stopped before worker start", async () => {
    const sourcePath = join(workspaceDir, "chatgpt-export.json");
    await writeFile(sourcePath, "[]", "utf8");

    const queued = await queueImportJob({
      config: createConfig(logDir),
      workspaceDir,
      apiConfig: {},
      platform: "chatgpt",
      filePath: sourcePath,
      opts: {
        async: true,
      },
    });

    await stopImportJobs({
      config: createConfig(logDir),
      workspaceDir,
      jobId: queued.job.id,
    });

    let called = 0;
    const result = await runImportWorker(
      {
        config: createConfig(logDir),
        workspaceDir,
        apiConfig: {},
        jobId: queued.job.id,
      },
      {
        runImportCommand: async () => {
          called += 1;
          throw new Error("should not run");
        },
      },
    );

    expect(result).toBeNull();
    expect(called).toBe(0);

    const state = await readState(join(logDir, "state.json"));
    const job = state.importJobs[queued.job.id];
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("Stopped by user");
  });

  test("runImportWorker marks stop-requested failures with user-facing stopped message", async () => {
    const sourcePath = join(workspaceDir, "chatgpt-export.json");
    await writeFile(sourcePath, "[]", "utf8");

    const queued = await queueImportJob({
      config: createConfig(logDir),
      workspaceDir,
      apiConfig: {},
      platform: "chatgpt",
      filePath: sourcePath,
      opts: {
        async: true,
      },
    });

    const result = await runImportWorker(
      {
        config: createConfig(logDir),
        workspaceDir,
        apiConfig: {},
        jobId: queued.job.id,
      },
      {
        runImportCommand: async () => {
          throw new Error(IMPORT_STOP_REQUESTED_ERROR);
        },
      },
    );

    expect(result).toBeNull();
    const state = await readState(join(logDir, "state.json"));
    const job = state.importJobs[queued.job.id];
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("Stopped by user");
  });

  test("resumeImportJobs re-queues failed jobs and clears error", async () => {
    const sourcePath = join(workspaceDir, "chatgpt-export.json");
    await writeFile(sourcePath, "[]", "utf8");

    const queued = await queueImportJob({
      config: createConfig(logDir),
      workspaceDir,
      apiConfig: {},
      platform: "chatgpt",
      filePath: sourcePath,
      opts: {
        async: true,
      },
    });

    const statePath = join(logDir, "state.json");
    const state = await readState(statePath);
    const job = state.importJobs[queued.job.id];
    expect(job).toBeDefined();
    if (job) {
      job.status = "failed";
      job.error = "simulated failure";
      job.finishedAt = new Date().toISOString();
      state.importJobs[queued.job.id] = job;
      await writeState(statePath, state);
    }

    const resumed = await resumeImportJobs({
      config: createConfig(logDir),
      workspaceDir,
      jobId: queued.job.id,
    });

    expect(resumed.resumedJobIds).toContain(queued.job.id);
    expect(resumed.schedulingErrors).toHaveLength(0);

    const nextState = await readState(statePath);
    const resumedJob = nextState.importJobs[queued.job.id];
    expect(resumedJob?.status).toBe("queued");
    expect(resumedJob?.error).toBeUndefined();
  });
});
