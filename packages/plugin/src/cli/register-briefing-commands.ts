import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { generateBriefing } from "../briefing/generate";
import type { PluginConfig } from "../config";
import { isObject } from "../lib/guards";
import { resolvePaths } from "./paths";
import type { CommandLike } from "./command-like";

export function registerBriefingCommands(
  zettelclaw: CommandLike,
  params: {
    config: PluginConfig;
    api: OpenClawPluginApi;
    workspaceDir?: string;
  },
): void {
  const runSnapshotGenerate = async (): Promise<void> => {
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

    console.log(`Memory snapshot updated: ${paths.memoryMdPath}`);
  };

  const briefing = zettelclaw.command("briefing").description("Memory snapshot generation helpers");
  briefing
    .command("generate")
    .description("Generate and write MEMORY.md memory snapshot block")
    .action(runSnapshotGenerate);

  const snapshot = zettelclaw.command("snapshot").description("Memory snapshot generation helpers");
  snapshot
    .command("generate")
    .description("Generate and write MEMORY.md memory snapshot block")
    .action(runSnapshotGenerate);
}
