import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { intro as clackIntro, log as clackLog, outro as clackOutro, spinner as clackSpinner } from "@clack/prompts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { generateBriefing } from "../briefing/generate";
import type { PluginConfig } from "../config";
import { isEnoent, isObject } from "../lib/guards";
import { getLastHandoff } from "../log/query";
import { applyLastHandoffBlock } from "../memory/handoff";
import { resolvePaths } from "./paths";
import type { CommandLike } from "./command-like";

interface SnapshotGenerateParams {
  config: PluginConfig;
  api: OpenClawPluginApi;
  workspaceDir?: string;
}

interface SessionHandoffRefreshParams {
  config: PluginConfig;
  workspaceDir?: string;
}

interface SessionHandoffRefreshResult {
  updated: boolean;
  memoryMdPath: string;
}

export async function runSnapshotGenerate(params: SnapshotGenerateParams): Promise<string> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const apiToken =
    isObject(params.api.config) &&
    isObject(params.api.config.gateway) &&
    isObject(params.api.config.gateway.auth) &&
    typeof params.api.config.gateway.auth.token === "string" &&
    params.api.config.gateway.auth.token.trim().length > 0
      ? params.api.config.gateway.auth.token
      : undefined;

  await generateBriefing({
    logPath: paths.logPath,
    memoryMdPath: paths.memoryMdPath,
    config: params.config,
    apiToken,
  });

  return paths.memoryMdPath;
}

export async function runSessionHandoffRefresh(
  params: SessionHandoffRefreshParams,
): Promise<SessionHandoffRefreshResult> {
  const paths = resolvePaths(params.config, params.workspaceDir);
  const latestHandoff = await getLastHandoff(paths.logPath);
  if (!latestHandoff) {
    return {
      updated: false,
      memoryMdPath: paths.memoryMdPath,
    };
  }

  let memoryContent = "";
  try {
    memoryContent = await readFile(paths.memoryMdPath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  const updatedMemory = applyLastHandoffBlock(memoryContent, latestHandoff);
  await mkdir(dirname(paths.memoryMdPath), { recursive: true });
  await writeFile(paths.memoryMdPath, updatedMemory, "utf8");

  return {
    updated: true,
    memoryMdPath: paths.memoryMdPath,
  };
}

export function registerBriefingCommands(
  reclaw: CommandLike,
  params: {
    config: PluginConfig;
    api: OpenClawPluginApi;
    workspaceDir?: string;
  },
): void {
  const BANNER = "🦞 Reclaw - Reclaim your AI conversations";

  const runSnapshotGenerateAction = async (): Promise<void> => {
    clackIntro(BANNER);
    const spin = clackSpinner();
    spin.start("Generating memory snapshot...");
    const memoryMdPath = await runSnapshotGenerate({
      config: params.config,
      api: params.api,
      workspaceDir: params.workspaceDir,
    });
    spin.stop(`Memory snapshot updated: ${memoryMdPath}`);
    clackOutro("MEMORY.md snapshot block rewritten.");
  };

  const runHandoffRefresh = async (): Promise<void> => {
    clackIntro(BANNER);
    const result = await runSessionHandoffRefresh({
      config: params.config,
      workspaceDir: params.workspaceDir,
    });

    if (result.updated) {
      clackLog.step("Session handoff refreshed");
      clackOutro("MEMORY.md handoff block updated.");
      return;
    }

    clackOutro("No handoff entries found. MEMORY.md unchanged.");
  };

  const snapshot = reclaw.command("snapshot").description("Memory snapshot generation helpers");
  snapshot
    .command("generate")
    .description("Generate and write MEMORY.md memory snapshot block")
    .action(runSnapshotGenerateAction);

  const handoff = reclaw.command("handoff").description("Reclaw session handoff helpers");
  handoff
    .command("refresh")
    .description("Force-refresh MEMORY.md session handoff block from latest handoff event")
    .action(runHandoffRefresh);
}
