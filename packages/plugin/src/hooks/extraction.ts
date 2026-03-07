import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "../config";
import { readGatewayToken } from "../lib/runtime-env";
import { findSessionKeyForSession, listSessionCandidates } from "./session-discovery";
import { createExtractionHookDeps, type ExtractionHookDeps, resolveExtractionPaths } from "./extraction-common";
import { runCompactionExtraction } from "./extraction-compaction";
import {
  runBeforeResetExtraction,
  runGatewayStartSweep,
  runSessionEndExtraction,
} from "./extraction-live";

export { listSessionCandidates, findSessionKeyForSession };

export function registerExtractionHooks(
  api: OpenClawPluginApi,
  config: PluginConfig,
  deps: Partial<ExtractionHookDeps> = {},
): void {
  const paths = resolveExtractionPaths(config);
  const runtimeDeps = createExtractionHookDeps(deps);
  const apiToken = readGatewayToken(api.config);

  api.on("session_end", async (event, ctx) => {
    await runSessionEndExtraction({
      api,
      config,
      paths,
      runtimeDeps,
      apiToken,
      event,
      ctx,
    });
  });

  api.on("before_reset", async (event, ctx) => {
    await runBeforeResetExtraction({
      api,
      config,
      paths,
      runtimeDeps,
      apiToken,
      event,
      ctx,
    });
  });

  api.on("before_compaction", async (event, ctx) => {
    await runCompactionExtraction({
      hookName: "before_compaction",
      event,
      ctx,
      api,
      config,
      paths,
      runtimeDeps,
      apiToken,
    });
  });

  api.on("after_compaction", async (event, ctx) => {
    await runCompactionExtraction({
      hookName: "after_compaction",
      event,
      ctx,
      api,
      config,
      paths,
      runtimeDeps,
      apiToken,
    });
  });

  api.on("gateway_start", async (event) => {
    await runGatewayStartSweep({
      api,
      config,
      paths,
      runtimeDeps,
      apiToken,
      event,
    });
  });
}
