#!/usr/bin/env bun

import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"

import { cancel, intro, isCancel, log, multiselect, outro, spinner, text } from "@clack/prompts"

import { parseChatGptConversations } from "./providers/chatgpt"
import { parseClaudeConversations } from "./providers/claude"
import { parseGrokConversations } from "./providers/grok"
import type { NormalizedConversation } from "./types"

const providerLabels = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
} as const

type Provider = keyof typeof providerLabels

async function main() {
  intro("reclaw - Phase 1 scaffold + discovery")

  const selectedProviders = await multiselect({
    message: "Select providers to import",
    options: [
      { value: "chatgpt", label: providerLabels.chatgpt },
      { value: "claude", label: providerLabels.claude },
      { value: "grok", label: providerLabels.grok },
    ],
    required: true,
    initialValues: ["chatgpt", "claude", "grok"],
  })

  if (isCancel(selectedProviders)) {
    cancel("Cancelled")
    process.exit(0)
  }

  const extractsInput = await text({
    message: "Path to extracts directory",
    defaultValue: "~/Desktop/extracts",
    validate: (value) => {
      const normalizedValue = typeof value === "string" ? value : ""
      return normalizedValue.trim().length === 0 ? "Path is required" : undefined
    },
  })

  if (isCancel(extractsInput)) {
    cancel("Cancelled")
    process.exit(0)
  }

  const outputInput = await text({
    message: "Output directory for memories",
    defaultValue: "./output",
    validate: (value) => {
      const normalizedValue = typeof value === "string" ? value : ""
      return normalizedValue.trim().length === 0 ? "Path is required" : undefined
    },
  })

  if (isCancel(outputInput)) {
    cancel("Cancelled")
    process.exit(0)
  }

  const extractsDir = resolveHomePath(extractsInput)
  const outputDir = resolveHomePath(outputInput)

  await mkdir(outputDir, { recursive: true })
  log.info(`Extracts: ${extractsDir}`)
  log.info(`Output: ${outputDir}`)

  const selected = selectedProviders as Provider[]
  let totalConversations = 0
  let totalMessages = 0

  for (const provider of selected) {
    const parsed = await parseProvider(provider, extractsDir)
    if (!parsed) {
      continue
    }

    const providerMessages = parsed.reduce((sum, conversation) => sum + conversation.messageCount, 0)
    totalConversations += parsed.length
    totalMessages += providerMessages

    log.success(
      `Found ${parsed.length} conversations from ${providerLabels[provider]} (${providerMessages} messages total)`,
    )
    printConversationList(parsed)
  }

  outro(`Done. Parsed ${totalConversations} conversations (${totalMessages} messages).`)
}

async function parseProvider(provider: Provider, extractsDir: string): Promise<NormalizedConversation[] | null> {
  const spin = spinner()
  spin.start(`Parsing ${providerLabels[provider]} export...`)

  try {
    const result = await getProviderParser(provider)(extractsDir)
    spin.stop(`Parsed ${providerLabels[provider]} export`)
    return result
  } catch (error) {
    spin.stop(`Failed to parse ${providerLabels[provider]} export`)
    const message = error instanceof Error ? error.message : String(error)
    log.error(message)
    return null
  }
}

function getProviderParser(provider: Provider) {
  switch (provider) {
    case "chatgpt":
      return parseChatGptConversations
    case "claude":
      return parseClaudeConversations
    case "grok":
      return parseGrokConversations
  }
}

function printConversationList(conversations: NormalizedConversation[]) {
  for (const conversation of conversations) {
    const date = conversation.createdAt.slice(0, 10)
    const paddedCount = String(conversation.messageCount).padStart(4, " ")
    console.log(`${date} | ${paddedCount} msgs | ${conversation.title}`)
  }
}

function resolveHomePath(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2))
  }

  if (value === "~") {
    return homedir()
  }

  return resolve(value)
}

await main()
