import { dirname, join } from "node:path"

import { isFilePath, pathExists } from "../lib/fs"

export async function resolveConversationsFilePath(
  extractsDir: string,
  providerFolder: "chatgpt" | "claude",
  displayName: string,
): Promise<string> {
  if (await isFilePath(extractsDir)) {
    return extractsDir
  }

  const parentDir = dirname(extractsDir)
  const candidates = [
    join(extractsDir, providerFolder, "conversations.json"),
    join(extractsDir, "conversations.json"),
    join(parentDir, providerFolder, "conversations.json"),
  ]

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Could not find ${displayName} conversations.json. Tried: ${candidates.map((candidate) => `'${candidate}'`).join(", ")}`,
  )
}
