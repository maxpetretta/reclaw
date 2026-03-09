import {
  intro as clackIntro,
  isCancel as clackIsCancel,
  log as clackLog,
  outro as clackOutro,
  select as clackSelect,
  spinner as clackSpinner,
} from "@clack/prompts";
import type { PluginConfig } from "../config";
import type {
  EnsureQmdCollectionResult,
  InstallQmdResult,
} from "../lib/qmd";
import type { CommandLike } from "./command-like";
import type { InitPaths } from "./paths";
import { isInteractiveTerminal, RECLAW_BANNER } from "./ui";

interface InitResult {
  paths: InitPaths;
  guidanceEvent: {
    sent: boolean;
    message?: string;
  };
  qmd: EnsureQmdCollectionResult;
}

async function promptInstallQmd(): Promise<boolean> {
  const selection = await clackSelect({
    message: "QMD is not installed. Install it globally now?",
    initialValue: "install",
    options: [
      { value: "install", label: "Install QMD now" },
      { value: "skip", label: "Skip for now" },
    ],
  });

  if (clackIsCancel(selection)) {
    return false;
  }

  return selection === "install";
}

export function registerSetupCommands(
  reclaw: CommandLike,
  params: {
    config: PluginConfig;
    workspaceDir?: string;
    runInit: (config: PluginConfig, workspaceDir?: string) => Promise<InitResult>;
    ensureQmdCollection: (projectionDir: string) => Promise<EnsureQmdCollectionResult> | EnsureQmdCollectionResult;
    installQmdGlobal: () => Promise<InstallQmdResult>;
    runUninstall: (config: PluginConfig, workspaceDir?: string) => Promise<InitPaths>;
    runVerify: (config: PluginConfig, workspaceDir?: string) => Promise<unknown>;
  },
): void {
  reclaw
    .command("init")
    .description("Initialize reclaw memory store and config")
    .action(async () => {
      clackIntro(RECLAW_BANNER);
      const initResult = await params.runInit(params.config, params.workspaceDir);
      const paths = initResult.paths;
      let qmdResult = initResult.qmd;
      let qmdMessageHandled = false;

      clackLog.step(`Created ${paths.logDir}`);
      clackLog.step(`Config updated: ${paths.openClawConfigPath}`);
      clackLog.step(`MEMORY.md markers added: ${paths.memoryMdPath}`);

      if (qmdResult.configured) {
        clackLog.step(`QMD collection configured: ${qmdResult.collection.name}`);
      } else if (qmdResult.skipped && qmdResult.missingBinary && isInteractiveTerminal()) {
        if (await promptInstallQmd()) {
          const spin = clackSpinner();
          spin.start("Installing QMD");
          const installResult = await params.installQmdGlobal();

          if (installResult.installed) {
            const command = installResult.command ? ` (${installResult.command})` : "";
            spin.stop(`QMD installed${command}`);
            spin.start("Configuring QMD collection");
            qmdResult = await params.ensureQmdCollection(paths.projectionDir);
            spin.stop(qmdResult.configured ? "QMD collection configured" : "QMD collection failed");
          } else {
            spin.stop("QMD install failed");
            if (installResult.message) {
              clackLog.warn(installResult.message);
              qmdMessageHandled = true;
            }
          }
        } else {
          clackLog.warn(
            "Skipped QMD installation. Install later with `bun install -g @tobilu/qmd` (or `npm install -g @tobilu/qmd`) and rerun `openclaw reclaw init`.",
          );
          qmdMessageHandled = true;
        }

        if (qmdResult.configured) {
          clackLog.step(`QMD collection ready: ${qmdResult.collection.name}`);
        }
      }

      if (!qmdResult.configured && qmdResult.message && !qmdMessageHandled) {
        clackLog.warn(qmdResult.message);
      }

      if (initResult.guidanceEvent.sent) {
        clackLog.step("Main session notified to update AGENTS.md and MEMORY.md guidance");
      } else {
        clackLog.warn(
          `Could not notify main session (${initResult.guidanceEvent.message ?? "unknown error"})`,
        );
      }
      clackOutro("Ready! Your next session will extract memory automatically.");
    });

  reclaw
    .command("uninstall")
    .description("Reverse init config and remove generated memory snapshot block")
    .action(async () => {
      clackIntro(RECLAW_BANNER);
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
      clackIntro(RECLAW_BANNER);
      try {
        await params.runVerify(params.config, params.workspaceDir);
        clackOutro("Verify passed.");
      } catch {
        clackOutro("Verify failed.");
        process.exitCode = 1;
      }
    });
}
