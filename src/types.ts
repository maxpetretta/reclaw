export interface NormalizedMessage {
  role: "human" | "assistant" | "system"
  content: string
  timestamp?: string
  model?: string
}

export interface NormalizedConversation {
  id: string
  title: string
  source: "chatgpt" | "claude" | "grok"
  createdAt: string
  updatedAt?: string
  messageCount: number
  messages: NormalizedMessage[]
  model?: string
}
