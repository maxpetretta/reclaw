import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ensureQmdCollection,
  expectedQmdCollection,
  installQmdGlobal,
  listQmdCollections,
  RECLAW_TRANSCRIPT_QMD_COLLECTION_NAME,
} from "../lib/qmd";

async function withTempDir<T>(prefix: string, run: (path: string) => Promise<T>): Promise<T> {
  const path = await mkdtemp(join(tmpdir(), prefix));

  try {
    return await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function writeTextFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeTextFile(path, contents);
  await chmod(path, 0o755);
}

describe("qmd integration helpers", () => {
  test("builds the reclaw memory collection spec", () => {
    expect(expectedQmdCollection("/tmp/reclaw/memory")).toEqual({
      name: "reclaw-memory",
      path: "/tmp/reclaw/memory",
      mask: "**/*.md",
    });
    expect(expectedQmdCollection("/tmp/reclaw/transcripts", RECLAW_TRANSCRIPT_QMD_COLLECTION_NAME)).toEqual({
      name: "reclaw-transcripts",
      path: "/tmp/reclaw/transcripts",
      mask: "**/*.md",
    });
  });

  test("reports missing qmd binaries", async () => {
    await withTempDir("reclaw-qmd-empty-path-", async (binDir) => {
      await withEnv({ PATH: binDir }, () => {
        expect(listQmdCollections()).toMatchObject({
          ok: false,
          missingBinary: true,
        });
        expect(ensureQmdCollection("/tmp/reclaw/memory")).toMatchObject({
          skipped: true,
          missingBinary: true,
        });
        expect(ensureQmdCollection("/tmp/reclaw/transcripts", RECLAW_TRANSCRIPT_QMD_COLLECTION_NAME)).toMatchObject({
          skipped: true,
          missingBinary: true,
        });
      });
    });
  });

  test("parses qmd collection listings from the CLI", async () => {
    await withTempDir("reclaw-qmd-list-", async (dir) => {
      const binDir = join(dir, "bin");
      await writeExecutable(
        join(binDir, "qmd"),
        `#!/bin/sh
if [ "$1" = "collection" ] && [ "$2" = "list" ]; then
  printf 'reclaw-memory (qmd://reclaw/memory)\n'
  printf 'other-collection (qmd://other/collection)\n'
  exit 0
fi
if [ "$1" = "--help" ]; then
  exit 0
fi
exit 1
`,
      );

      await withEnv({ PATH: binDir }, () => {
        expect(listQmdCollections()).toEqual({
          ok: true,
          names: ["reclaw-memory", "other-collection"],
        });
      });
    });
  });

  test("ensures the reclaw memory collection", async () => {
    await withTempDir("reclaw-qmd-ensure-", async (dir) => {
      const binDir = join(dir, "bin");
      const logPath = join(dir, "qmd.log");

      await writeExecutable(
        join(binDir, "qmd"),
        `#!/bin/sh
if [ "$1" = "--help" ]; then
  exit 0
fi
if [ "$1" = "collection" ] && [ "$2" = "remove" ]; then
  exit 0
fi
if [ "$1" = "collection" ] && [ "$2" = "add" ]; then
  printf '%s\n' "$3|$5|$7" >> "$QMD_LOG"
  exit 0
fi
exit 1
`,
      );

      await withEnv({ PATH: binDir, QMD_LOG: logPath }, async () => {
        const result = ensureQmdCollection(join(dir, "memory"));
        const transcriptResult = ensureQmdCollection(
          join(dir, "transcripts"),
          RECLAW_TRANSCRIPT_QMD_COLLECTION_NAME,
        );

        expect(result).toEqual({
          collection: {
            name: "reclaw-memory",
            path: join(dir, "memory"),
            mask: "**/*.md",
          },
          configured: true,
          skipped: false,
        });
        expect(transcriptResult).toEqual({
          collection: {
            name: "reclaw-transcripts",
            path: join(dir, "transcripts"),
            mask: "**/*.md",
          },
          configured: true,
          skipped: false,
        });
        expect(await readFile(logPath, "utf8")).toBe(
          `${join(dir, "memory")}|reclaw-memory|**/*.md\n${join(dir, "transcripts")}|reclaw-transcripts|**/*.md\n`,
        );
      });
    });
  });

  test("installs qmd using the first available package manager", async () => {
    await withTempDir("reclaw-qmd-install-", async (dir) => {
      const binDir = join(dir, "bin");
      const installLog = join(dir, "install.log");

      await writeExecutable(
        join(binDir, "npm"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "10.0.0"
  exit 0
fi
if [ "$1" = "install" ]; then
  printf '%s\n' "$@" > "$INSTALL_LOG"
  exit 0
fi
exit 1
`,
      );

      await withEnv({ PATH: binDir, INSTALL_LOG: installLog }, async () => {
        await expect(installQmdGlobal()).resolves.toEqual({
          installed: true,
          command: "npm install -g @tobilu/qmd",
        });
        expect(await readFile(installLog, "utf8")).toContain("@tobilu/qmd");
      });
    });
  });
});
