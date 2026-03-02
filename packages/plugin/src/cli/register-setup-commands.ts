import type { PluginConfig } from "../config";
import type { CommandLike } from "./command-like";
import type { InitPaths } from "./paths";

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
      const initResult = await params.runInit(params.config, params.workspaceDir);
      const paths = initResult.paths;
      console.log("Reclaw initialized.");
      console.log(`Log directory: ${paths.logDir}`);
      console.log(`Config updated: ${paths.openClawConfigPath}`);
      console.log(`MEMORY.md markers ensured: ${paths.memoryMdPath}`);
      if (initResult.guidanceEvent.sent) {
        console.log("Main session notified to update AGENTS.md and MEMORY.md guidance.");
      } else {
        console.log(
          `Warning: could not notify main session to update AGENTS.md/MEMORY.md guidance (${initResult.guidanceEvent.message ?? "unknown error"})`,
        );
      }
    });

  reclaw
    .command("uninstall")
    .description("Reverse init config and remove generated memory snapshot block")
    .action(async () => {
      const paths = await params.runUninstall(params.config, params.workspaceDir);
      console.log("Reclaw uninstalled.");
      console.log(`Config reverted: ${paths.openClawConfigPath}`);
      console.log(`Generated memory snapshot block removed: ${paths.memoryMdPath}`);
      console.log(`Log data preserved in: ${paths.logDir}`);
    });

  reclaw
    .command("verify")
    .description("Verify reclaw setup and required files")
    .action(async () => {
      await params.runVerify(params.config, params.workspaceDir);
    });
}
