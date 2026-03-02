import { intro as clackIntro, log as clackLog, outro as clackOutro } from "@clack/prompts";
import type { PluginConfig } from "../config";
import type { CommandLike } from "./command-like";
import type { InitPaths } from "./paths";

const BANNER = "🦞 Reclaw - Reclaim your AI conversations";

interface InitResult {
  paths: InitPaths;
  guidanceEvent: {
    sent: boolean;
    message?: string;
  };
}

export function registerSetupCommands(
  reclaw: CommandLike,
  params: {
    config: PluginConfig;
    workspaceDir?: string;
    runInit: (config: PluginConfig, workspaceDir?: string) => Promise<InitResult>;
    runUninstall: (config: PluginConfig, workspaceDir?: string) => Promise<InitPaths>;
    runVerify: (config: PluginConfig, workspaceDir?: string) => Promise<unknown>;
  },
): void {
  reclaw
    .command("init")
    .description("Initialize reclaw memory store and config")
    .action(async () => {
      clackIntro(BANNER);
      const initResult = await params.runInit(params.config, params.workspaceDir);
      const paths = initResult.paths;
      clackLog.step(`Created ${paths.logDir}`);
      clackLog.step(`Config updated: ${paths.openClawConfigPath}`);
      clackLog.step(`MEMORY.md markers added: ${paths.memoryMdPath}`);
      if (initResult.guidanceEvent.sent) {
        clackLog.step("Main session notified to update AGENTS.md and MEMORY.md guidance");
      } else {
        clackLog.warn(
          `Could not notify main session (${initResult.guidanceEvent.message ?? "unknown error"})`,
        );
      }
      clackOutro("Ready. Your next session will extract memory automatically.");
    });

  reclaw
    .command("uninstall")
    .description("Reverse init config and remove generated memory snapshot block")
    .action(async () => {
      clackIntro(BANNER);
      const paths = await params.runUninstall(params.config, params.workspaceDir);
      clackLog.step(`Config reverted: ${paths.openClawConfigPath}`);
      clackLog.step(`Generated snapshot block removed: ${paths.memoryMdPath}`);
      clackLog.step(`Log data preserved in ${paths.logDir}`);
      clackOutro("Reclaw uninstalled.");
    });

  reclaw
    .command("verify")
    .description("Verify reclaw setup and required files")
    .action(async () => {
      clackIntro(BANNER);
      try {
        await params.runVerify(params.config, params.workspaceDir);
        clackOutro("Verify passed.");
      } catch {
        clackOutro("Verify failed.");
        process.exitCode = 1;
      }
    });
}
