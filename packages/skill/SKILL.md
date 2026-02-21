---
name: reclaw
description: "Use reclaw to extract and summarize ChatGPT, Claude, and Grok history exports into OpenClaw memory or a Zettelclaw vault."
read_when:
  - You need to bootstrap memory from existing AI chat history
  - You are importing ChatGPT, Claude, or Grok conversation exports
  - You want to generate durable memory files for OpenClaw
  - You want to generate atomic notes for a Zettelclaw vault
---

# Reclaw

Reclaw extracts and summarizes conversations from AI chat history exports (ChatGPT, Claude, Grok) to bootstrap either:
- OpenClaw native memory (`memory/`, `MEMORY.md`, `USER.md`), or
- a Zettelclaw vault (`Inbox/` atomic notes).

Use reclaw when the user already has a lot of historical chats and wants durable memory fast.

## 1) Get Data Exports

### ChatGPT export
1. Open ChatGPT Settings.
2. Go to **Data Controls**.
3. Click **Export Data**.
4. Wait for the email.
5. Download and unzip the archive.
6. Locate `conversations.json`.

### Claude export
1. Open Claude Settings.
2. Go to **Account**.
3. Click **Export Data**.
4. Wait for the email.
5. Download and unzip the archive.
6. Locate `conversations.json` and `memories.json`.
7. For reclaw runs today, point to the export folder (reclaw reads `conversations.json`; keep `memories.json` alongside it).

### Grok export
1. Open Grok Settings.
2. Go to **Account**.
3. Click **Download Your Data**.
4. Wait for export completion.
5. Download and unzip the archive.
6. Locate the conversations export files.

## 2) Run Reclaw

### Interactive mode
Use this to choose provider(s), model, and output mode interactively:

```bash
npx reclaw
# or
bunx reclaw
```

Canonical flag reference:

```bash
npx reclaw --help
```

### Direct mode examples
Use direct flags when you already know provider and input path:

```bash
npx reclaw --provider chatgpt --input ./conversations.json
npx reclaw --provider claude --input ./path/to/claude-export/
npx reclaw --provider grok --input ./path/to/grok-export/
```

`--input` accepts either:
- a provider export directory, or
- a direct export file path (for providers that expose a single conversations file).

### Plan without writing
Preview what reclaw will process and where outputs will go, without scheduling extraction or writing files:

```bash
npx reclaw --dry-run --provider chatgpt --input ./conversations.json
# alias:
npx reclaw --plan --provider claude --input ./path/to/claude-export/
```

## 3) Output Modes

### `--mode openclaw` (default)
- Writes summarized memories into `memory/`.
- Updates `MEMORY.md` and `USER.md`.
- Best for OpenClaw's native memory system.

### `--mode zettelclaw`
- Creates atomic markdown notes with proper frontmatter.
- Writes notes into vault `Inbox/`.
- Best for bootstrapping a Zettelclaw vault.

## 4) Model Choice

Reclaw uses AI to summarize many conversations in batch.

Preferred profile:
- fast,
- low cost,
- large context window.

Recommended default: **Gemini Flash**.

Reason: batch extraction speed/cost usually matters more than maximum model intelligence for this workload.

Set model with:
- `--model <model-id>`, or
- the interactive model prompt.

## 5) Resumability

Long runs are resumable.

Reclaw persists state to:
- `.reclaw-state.json`

If the run is interrupted:
1. Re-run the same command.
2. Reclaw resumes completed progress instead of starting from scratch.

## 6) Agent Workflow Guidance

When helping a user run reclaw:
1. Confirm which provider export they have.
2. Confirm where files were extracted.
3. Recommend `--mode openclaw` unless the user explicitly wants a Zettelclaw vault import.
4. Recommend a fast/cheap large-context model (Gemini Flash).
5. Warn that initial imports can take time because processing is batched.
6. If interrupted, instruct to rerun with the same command to resume.

## 7) Quick Command Reference

```bash
# Interactive
bunx reclaw

# ChatGPT direct
bunx reclaw --provider chatgpt --input ./conversations.json

# Claude direct
bunx reclaw --provider claude --input ./path/to/claude-export/

# Grok direct
bunx reclaw --provider grok --input ./path/to/grok-export/

# Explicit mode/model
bunx reclaw --mode openclaw --model gemini-2.5-flash
bunx reclaw --mode zettelclaw --model gemini-2.5-flash
```

## 8) What Reclaw Produces

OpenClaw mode:
- `memory/reclaw-*.md` memory artifacts,
- updated `MEMORY.md`,
- updated `USER.md`.

Zettelclaw mode:
- generated atomic notes in `Inbox/` with frontmatter and source attribution.

The core goal in both modes is the same: convert transient chat logs into durable, reusable memory.
