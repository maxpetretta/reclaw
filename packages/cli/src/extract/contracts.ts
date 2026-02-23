import type { NormalizedConversation } from "../types"

export type ExtractionMode = "openclaw" | "zettelclaw"
export type BackupMode = "overwrite" | "timestamped"

export interface ConversationBatch {
  id: string
  providers: NormalizedConversation["source"][]
  date: string
  index: number
  totalForDate: number
  conversations: NormalizedConversation[]
}

export interface SubagentExtraction {
  summary: string
}

export interface BatchConversationRef {
  provider: NormalizedConversation["source"]
  id: string
  timestamp?: string
}

export interface BatchExtractionResult {
  batchId: string
  providers: NormalizedConversation["source"][]
  date: string
  conversationIds: string[]
  conversationRefs: BatchConversationRef[]
  conversationCount: number
  extraction: SubagentExtraction
}

export interface AggregatedInsights {
  summary: string
  interests: string[]
  projects: string[]
  facts: string[]
  preferences: string[]
  people: string[]
  decisions: string[]
}

export interface ExtractionArtifacts {
  outputFiles: string[]
  memoryFilePath?: string
  userFilePath?: string
  insights: AggregatedInsights
}

export interface ReclawState {
  version: 1
  runKey: string
  mode: ExtractionMode
  model: string
  targetPath: string
  memoryWorkspacePath: string
  createdAt: string
  updatedAt: string
  completed: Record<string, BatchExtractionResult>
}
