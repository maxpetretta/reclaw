import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseChatGptConversations } from "../import/adapters/chatgpt";
import { parseClaudeConversations } from "../import/adapters/claude";
import { parseGrokConversations } from "../import/adapters/grok";
import type { ImportPlatform } from "../import/types";
import { isDailyMemoryFile, normalizeCliInputPath } from "../lib/path";
import { resolveOpenClawHome } from "../lib/runtime-env";

interface ImportDetection {
  platform: ImportPlatform;
  path: string;
  detail: string;
  score: number;
}

export interface ImportDetections {
  chatgpt: ImportDetection[];
  claude: ImportDetection[];
  grok: ImportDetection[];
  openclaw: ImportDetection[];
}

const MAX_IMPORT_SCAN_JSON_BYTES = 250 * 1024 * 1024;

function createEmptyDetections(): ImportDetections {
  return {
    chatgpt: [],
    claude: [],
    grok: [],
    openclaw: [],
  };
}

function normalizePathList(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    output.push(trimmed);
  }

  return output;
}

function shouldSkipDirectory(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "node_modules" ||
    lower === ".git" ||
    lower === "dist" ||
    lower === "build" ||
    lower === ".next" ||
    lower === ".cache"
  );
}

async function pathType(path: string): Promise<"file" | "dir" | null> {
  try {
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      return "dir";
    }
    if (metadata.isFile()) {
      return "file";
    }

    return null;
  } catch {
    return null;
  }
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_IMPORT_SCAN_JSON_BYTES) {
      return null;
    }

    const rawText = await readFile(path, "utf8");
    return JSON.parse(rawText) as unknown;
  } catch {
    return null;
  }
}

function scorePathHint(platform: ImportPlatform, filePath: string): number {
  const normalizedPath = filePath.replaceAll("\\", "/").toLowerCase();
  const lowerName = basename(normalizedPath).toLowerCase();

  if (platform === "openclaw") {
    return normalizedPath.endsWith("/memory") ? 30 : normalizedPath.includes("/memory/") ? 20 : 0;
  }

  const platformKeywords: Record<Exclude<ImportPlatform, "openclaw">, string[]> = {
    chatgpt: ["chatgpt", "openai"],
    claude: ["claude", "anthropic"],
    grok: ["grok", "xai"],
  };
  const otherKeywords: Record<Exclude<ImportPlatform, "openclaw">, string[]> = {
    chatgpt: [...platformKeywords.claude, ...platformKeywords.grok],
    claude: [...platformKeywords.chatgpt, ...platformKeywords.grok],
    grok: [...platformKeywords.chatgpt, ...platformKeywords.claude],
  };

  const targetPlatform = platform as Exclude<ImportPlatform, "openclaw">;
  let score = 0;

  for (const keyword of platformKeywords[targetPlatform]) {
    if (normalizedPath.includes(keyword)) {
      score += 60;
    }
  }

  for (const keyword of otherKeywords[targetPlatform]) {
    if (normalizedPath.includes(keyword)) {
      score -= 30;
    }
  }

  if (lowerName === "conversations.json" || lowerName === "conversation.json") {
    score += 30;
  }
  if (targetPlatform === "grok" && lowerName === "prod-grok-backend.json") {
    score += 120;
  }

  return score;
}

function selectParsedConversations(platform: Exclude<ImportPlatform, "openclaw">, raw: unknown) {
  if (platform === "chatgpt") {
    return parseChatGptConversations(raw);
  }
  if (platform === "claude") {
    return parseClaudeConversations(raw);
  }

  return parseGrokConversations(raw);
}

function countExtractableConversations(platform: Exclude<ImportPlatform, "openclaw">, raw: unknown): number {
  const parsed = selectParsedConversations(platform, raw);
  return parsed.filter((conversation) => conversation.messages.length > 0).length;
}

interface ImportJsonCandidateScore {
  extractableConversations: number;
  score: number;
}

const IMPORT_JSON_PLATFORMS = ["chatgpt", "claude", "grok"] as const;

function scoreImportJsonCandidate(
  platform: Exclude<ImportPlatform, "openclaw">,
  filePath: string,
  parsed: unknown,
): ImportJsonCandidateScore | null {
  const extractableCount = countExtractableConversations(platform, parsed);
  if (extractableCount <= 0) {
    return null;
  }

  return {
    extractableConversations: extractableCount,
    score: extractableCount * 100 + scorePathHint(platform, filePath),
  };
}

function scoreBestImportJsonPlatform(filePath: string, parsed: unknown): {
  platform: Exclude<ImportPlatform, "openclaw">;
  extractableConversations: number;
  score: number;
} | null {
  let bestCandidate: {
    platform: Exclude<ImportPlatform, "openclaw">;
    extractableConversations: number;
    score: number;
  } | null = null;

  for (const platform of IMPORT_JSON_PLATFORMS) {
    const scored = scoreImportJsonCandidate(platform, filePath, parsed);
    if (!scored) {
      continue;
    }

    if (!bestCandidate || scored.score > bestCandidate.score) {
      bestCandidate = {
        platform,
        extractableConversations: scored.extractableConversations,
        score: scored.score,
      };
    }
  }

  return bestCandidate;
}

async function countMarkdownFiles(root: string, maxDepth = 3, maxFiles = 1_000): Promise<number> {
  let count = 0;
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

  while (stack.length > 0 && count < maxFiles) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        count += 1;
        if (count >= maxFiles) {
          break;
        }
      } else if (entry.isDirectory() && current.depth < maxDepth && !shouldSkipDirectory(entry.name)) {
        stack.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return count;
}

async function listJsonCandidates(root: string, maxDepth = 3, maxFiles = 300): Promise<string[]> {
  const candidates: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];

  while (stack.length > 0 && candidates.length < maxFiles) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = join(current.path, entry.name);

      if (entry.isDirectory() && current.depth < maxDepth && !shouldSkipDirectory(entry.name)) {
        stack.push({ path: absolutePath, depth: current.depth + 1 });
        continue;
      }

      if (!(entry.isFile() && entry.name.toLowerCase().endsWith(".json"))) {
        continue;
      }

      const hint = entry.name.toLowerCase();
      const hinted =
        hint.includes("chatgpt") ||
        hint.includes("claude") ||
        hint.includes("grok") ||
        hint.includes("openai") ||
        hint.includes("conversation") ||
        hint.includes("export");

      if (!hinted && current.depth > 1) {
        continue;
      }

      candidates.push(absolutePath);
      if (candidates.length >= maxFiles) {
        break;
      }
    }
  }

  return candidates;
}

function sortDetections(detections: ImportDetection[]): ImportDetection[] {
  return detections.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });
}

async function resolveImportJsonPathFromDirectory(
  directory: string,
  platform: Exclude<ImportPlatform, "openclaw">,
): Promise<string | null> {
  const candidates = await listJsonCandidates(directory, 6, 500);
  if (candidates.length === 0) {
    return null;
  }

  let bestParsedCandidate: { path: string; score: number } | null = null;
  for (const candidatePath of [...candidates].sort((left, right) => left.localeCompare(right))) {
    const parsed = await readJsonFile(candidatePath);
    if (parsed === null) {
      continue;
    }

    const candidateScore = scoreImportJsonCandidate(platform, candidatePath, parsed);
    if (!candidateScore) {
      continue;
    }

    if (!bestParsedCandidate || candidateScore.score > bestParsedCandidate.score) {
      bestParsedCandidate = {
        path: candidatePath,
        score: candidateScore.score,
      };
    }
  }

  if (bestParsedCandidate) {
    return bestParsedCandidate.path;
  }

  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export async function resolveImportPathForPlatform(platform: ImportPlatform, rawPath: string): Promise<string> {
  const normalizedPath = normalizeCliInputPath(rawPath);
  const detectedType = await pathType(normalizedPath);

  if (platform === "openclaw") {
    if (detectedType !== "dir") {
      throw new Error(`openclaw import path must be a directory: ${normalizedPath}`);
    }
    return normalizedPath;
  }

  if (detectedType === "file") {
    return normalizedPath;
  }

  if (detectedType === "dir") {
    const resolvedJson = await resolveImportJsonPathFromDirectory(
      normalizedPath,
      platform as Exclude<ImportPlatform, "openclaw">,
    );
    if (!resolvedJson) {
      throw new Error(`No ${platform} JSON export found under directory: ${normalizedPath}`);
    }
    return resolvedJson;
  }

  throw new Error(`Import file does not exist: ${normalizedPath}`);
}

export async function detectImportSources(workspaceDir?: string): Promise<ImportDetections> {
  const detections = createEmptyDetections();
  const roots = normalizePathList([
    workspaceDir,
    process.cwd(),
    join(resolveOpenClawHome(), "workspace"),
    join(homedir(), "Downloads"),
    join(homedir(), "Desktop"),
  ]);

  const jsonCandidates = new Set<string>();
  for (const root of roots) {
    if ((await pathType(root)) !== "dir") {
      continue;
    }

    const memoryPath = join(root, "memory");
    if ((await pathType(memoryPath)) === "dir") {
      const markdownCount = await countMarkdownFiles(memoryPath);
      if (markdownCount > 0) {
        const dailyCount = (await readdir(memoryPath)).filter(isDailyMemoryFile).length;
        detections.openclaw.push({
          platform: "openclaw",
          path: memoryPath,
          detail: `${markdownCount} markdown file${markdownCount === 1 ? "" : "s"}${dailyCount > 0 ? ` (${dailyCount} daily)` : ""}`,
          score: 50 + scorePathHint("openclaw", memoryPath) + Math.min(markdownCount, 50),
        });
      }
    }

    const discoveredJson = await listJsonCandidates(root, 6, 600);
    for (const candidate of discoveredJson) {
      jsonCandidates.add(candidate);
    }
  }

  for (const filePath of jsonCandidates) {
    const parsed = await readJsonFile(filePath);
    if (parsed === null) {
      continue;
    }

    const bestCandidate = scoreBestImportJsonPlatform(filePath, parsed);

    if (bestCandidate) {
      detections[bestCandidate.platform].push({
        platform: bestCandidate.platform,
        path: filePath,
        detail: `${bestCandidate.extractableConversations} conversation${
          bestCandidate.extractableConversations === 1 ? "" : "s"
        }`,
        score: bestCandidate.score,
      });
    }
  }

  detections.chatgpt = sortDetections(detections.chatgpt);
  detections.claude = sortDetections(detections.claude);
  detections.grok = sortDetections(detections.grok);
  detections.openclaw = sortDetections(detections.openclaw);

  return detections;
}
