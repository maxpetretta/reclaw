import type { NormalizedConversation } from "../types"

export type ExtractionMode = "openclaw" | "zettelclaw"

export interface ConversationBatch {
  id: string
  provider: NormalizedConversation["source"]
  date: string
  index: number
  totalForDate: number
  conversations: NormalizedConversation[]
}

export interface SubagentExtraction {
  summary: string
}

export interface BatchConversationRef {
  id: string
  timestamp?: string
}

export interface BatchExtractionResult {
  batchId: string
  provider: NormalizedConversation["source"]
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
  createdAt: string
  updatedAt: string
  completed: Record<string, BatchExtractionResult>
}
