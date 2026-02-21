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

Reclaw imports AI chat exports (ChatGPT, Claude, Grok) and builds durable memory artifacts for:
- OpenClaw native memory, or
- Zettelclaw vault workflows.

## 1) Export Data

### ChatGPT export
1. Open ChatGPT Settings.
2. Go to **Data Controls**.
3. Click **Export Data**.
4. Download and unzip the archive.
5. Locate `conversations.json`.

### Claude export
1. Open Claude Settings.
2. Go to **Account**.
3. Click **Export Data**.
4. Download and unzip the archive.
5. Locate `conversations.json` (keep `memories.json` alongside when present).

### Grok export
1. Open Grok Settings.
2. Go to **Account**.
3. Click **Download Your Data**.
4. Download and unzip the archive.
5. Locate conversation export files.

## 2) Run Reclaw

### Interactive mode

```bash
npx reclaw
# or
bunx reclaw
```

Canonical flags:

```bash
npx reclaw --help
```

### Direct mode examples

```bash
npx reclaw --provider chatgpt --input ./conversations.json
npx reclaw --provider claude --input ./path/to/claude-export/
npx reclaw --provider grok --input ./path/to/grok-export/
```

`--input` accepts:
- provider export directory, or
- direct export file path.

### Plan without writing

```bash
npx reclaw --dry-run --provider chatgpt --input ./conversations.json
npx reclaw --plan --provider claude --input ./path/to/claude-export/
```

## 3) Output Modes

### `--mode openclaw` (default)
- Writes daily files to `memory/YYYY-MM-DD.md`.
- Daily file format:
  - `## Done`
  - `## Decisions`
  - `## Facts`
  - `## Open`
  - `---`
  - `## Sessions` (bullets as `provider:conversationId — timestamp`)
- Imports legacy conversations into OpenClaw session history by default (`--legacy-sessions on`).
- Updates `MEMORY.md` and `USER.md` via a main synthesis agent run.

### `--mode zettelclaw`
- Writes daily journals to `03 Journal/YYYY-MM-DD.md`.
- Journal format is day-level recap with:
  - `## Done`
  - `## Decisions`
  - `## Facts`
  - `## Open`
  - `---`
  - `## Sessions` (bullets as `provider:conversationId — HH:MM`)
- Writes evergreen inbox drafts to `00 Inbox/`.
- Updates `MEMORY.md` and `USER.md` via a main synthesis agent run.

## 4) Subagent Model

- Default is **one conversation per subagent task**.
- Override with `--subagent-batch-size <n>` if you want larger groups.
- Subagents return strict JSON with one field:
  - `summary`
- The main process synthesizes structured memory signals from those summaries.

## 5) `MEMORY.md` / `USER.md` Safety

Before updates, Reclaw writes backups:
- `MEMORY.md.bak`
- `USER.md.bak`

Then a dedicated main synthesis agent updates `MEMORY.md` and `USER.md` using its own tools.

## 6) Model Choice

Preferred profile:
- fast,
- low cost,
- reliable long-context behavior.

Recommended default: **Gemini Flash**.

Set with:
- `--model <model-id>`, or
- interactive model selection.

## 7) Resumability

Runs are resumable via:
- `.reclaw-state.json`

If interrupted:
1. Re-run the same command.
2. Reclaw resumes completed progress.

## 8) Agent Workflow Guidance

When helping a user:
1. Confirm provider export and extracted path.
2. Recommend `--mode openclaw` unless user explicitly wants Zettelclaw vault output.
3. Explain default per-conversation subagent processing and optional `--subagent-batch-size`.
4. Recommend a fast model.
5. Mention resume behavior and `.bak` safety copies for `MEMORY.md`/`USER.md`.

## 9) Quick Command Reference

```bash
# Interactive
bunx reclaw

# Per-conversation subagent default
bunx reclaw --provider chatgpt --input ./conversations.json

# Increase conversations per subagent task
bunx reclaw --provider chatgpt --input ./conversations.json --subagent-batch-size 4

# Explicit mode/model
bunx reclaw --mode openclaw --model gemini-2.5-flash
bunx reclaw --mode zettelclaw --model gemini-2.5-flash
```

## 10) What Reclaw Produces

OpenClaw mode:
- `memory/YYYY-MM-DD.md`
- updated `MEMORY.md` (+ `MEMORY.md.bak`)
- updated `USER.md` (+ `USER.md.bak`)

Zettelclaw mode:
- `03 Journal/YYYY-MM-DD.md`
- inbox drafts in `00 Inbox/`
- updated `MEMORY.md` (+ `MEMORY.md.bak`)
- updated `USER.md` (+ `USER.md.bak`)

Core goal: convert transient chat history into durable, reusable memory.
