import { log as clackLog } from "@clack/prompts";
import type { PluginConfig } from "../config";
import { ensureSubject, readRegistry, renameSubject, writeRegistry } from "../subjects/registry";
import { resolvePaths } from "./paths";
import type { CommandLike } from "./command-like";
import { toObject } from "./parse";

function sortRegistryEntries(registry: Record<string, { display: string; type: string }>): Array<[string, { display: string; type: string }]> {
  return Object.entries(registry).sort(([left], [right]) => left.localeCompare(right));
}

export function registerSubjectCommands(
  reclaw: CommandLike,
  params: {
    config: PluginConfig;
    workspaceDir?: string;
  },
): void {
  const subjects = reclaw.command("subjects").description("Manage subject registry");

  subjects
    .command("list")
    .description("List subjects")
    .action(async () => {
      const paths = resolvePaths(params.config, params.workspaceDir);
      const registry = await readRegistry(paths.subjectsPath);
      const items = sortRegistryEntries(registry);

      if (items.length === 0) {
        console.log("No subjects.");
        return;
      }

      const slugWidth = Math.max(...items.map(([slug]) => slug.length));
      const displayWidth = Math.max(...items.map(([, subject]) => subject.display.length));
      for (const [slug, subject] of items) {
        console.log(`${slug.padEnd(slugWidth)}  ${subject.display.padEnd(displayWidth)}  ${subject.type}`);
      }
    });

  subjects
    .command("add <slug>")
    .description("Add a subject")
    .option("--type <type>", "Subject type", "topic")
    .option("--display <display>", "Display name")
    .action(async (slug: unknown, opts: unknown) => {
      if (typeof slug !== "string" || slug.trim().length === 0) {
        throw new Error("slug is required");
      }

      const options = toObject(opts);
      const paths = resolvePaths(params.config, params.workspaceDir);
      const normalizedSlug = slug.trim();
      const inferredType = typeof options.type === "string" && options.type.trim() ? options.type.trim() : "topic";

      await ensureSubject(paths.subjectsPath, normalizedSlug, inferredType);

      if (typeof options.display === "string" && options.display.trim()) {
        const registry = await readRegistry(paths.subjectsPath);
        const existing = registry[normalizedSlug];
        if (existing) {
          registry[normalizedSlug] = {
            ...existing,
            display: options.display.trim(),
          };
          await writeRegistry(paths.subjectsPath, registry);
        }
      }

      clackLog.success(`Added subject: ${normalizedSlug} (${inferredType})`);
    });

  subjects
    .command("rename <oldSlug> <newSlug>")
    .description("Rename a subject")
    .action(async (oldSlug: unknown, newSlug: unknown) => {
      if (
        typeof oldSlug !== "string" ||
        oldSlug.trim().length === 0 ||
        typeof newSlug !== "string" ||
        newSlug.trim().length === 0
      ) {
        throw new Error("oldSlug and newSlug are required");
      }

      const paths = resolvePaths(params.config, params.workspaceDir);
      await renameSubject(paths.subjectsPath, paths.logPath, oldSlug.trim(), newSlug.trim());
      clackLog.success(`Renamed subject: ${oldSlug.trim()} → ${newSlug.trim()}`);
    });
}
