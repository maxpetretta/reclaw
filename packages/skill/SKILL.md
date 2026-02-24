---
name: reclaw
description: "Use reclaw to extract and summarize ChatGPT, Claude, and Grok history exports into OpenClaw memory or a Zettelclaw vault."
read_when:
  - You need to bootstrap memory from existing AI chat history
  - You are importing ChatGPT, Claude, or Grok conversation exports
  - You want to generate durable memory files for OpenClaw
  - You want to generate journal-based imports for a Zettelclaw vault
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
  - `## Decisions`
  - `## Facts`
  - `## Interests`
  - `## Open`
- Optional footer (only when legacy session import is enabled via hidden CLI flag):
  - `---`
  - `## Sessions` (bullets as `provider:conversationId — timestamp`)
- Legacy session import is **off by default**. Enable explicitly with `--legacy-sessions on` (or `required`).
- Updates `MEMORY.md` and `USER.md` via a main synthesis agent run.

### `--mode zettelclaw`
- Writes daily journals to `03 Journal/YYYY-MM-DD.md`.
- Journal format matches Zettelclaw journal template:
  - `## Done` (preserved if already present from session hooks)
  - `## Decisions`
  - `## Facts` (includes interests and other user-specific signals)
  - `## Open`
  - Optional footer (only when legacy session import is enabled):
    - `---`
    - `## Sessions` (bullets as `provider:conversationId — HH:MM`)
- Preserves existing journal content (append-only). Legacy `## Interests` sections are migrated into `## Facts`.
- Does not write inbox notes or typed notes — those are handled by Zettelclaw's nightly maintenance or supervised sessions.
- Legacy session import is **off by default**; enable with `--legacy-sessions on` (or `required`) using `--workspace` or `~/.openclaw/workspace`.
- Updates `MEMORY.md` and `USER.md` in the OpenClaw workspace via a main synthesis agent run.

## 4) Subagent Model

- Default is **one merged subagent task per day** (all same-day conversations grouped together).
- `--subagent-batch-size` is deprecated and ignored.
- Subagent jobs run in parallel by default (`--parallel-jobs 8`).
- Individual batch failures do not stop the run; successful batches continue and failed batches are reported at the end.
- Subagents return strict JSON with one field:
  - `summary`
- The main process synthesizes structured memory signals from those summaries.

## 5) `MEMORY.md` / `USER.md` Safety

Before updates, Reclaw writes backups:
- `MEMORY.md.bak`
- `USER.md.bak`

Then a dedicated main synthesis agent updates `MEMORY.md` and `USER.md` using its own tools.

For repeated test runs, use:
- `--timestamped-backups` to write `.bak.<timestamp>` files instead of overwriting `.bak`.
- `--state-path <path>` to isolate resumability state per run.

## 6) Model Choice

Preferred profile:
- fast,
- low cost,
- reliable long-context behavior.

Recommended models: **Claude Haiku** or **Gemini Flash**.

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
3. Explain day-grouped extraction and parallel job controls.
4. Recommend a fast model.
5. Mention resume behavior and `.bak` safety copies for `MEMORY.md`/`USER.md`.
6. For test loops, recommend `--state-path` + `--timestamped-backups`.

## 9) Quick Command Reference

```bash
# Interactive
npx reclaw

# Day-grouped extraction default
npx reclaw --provider chatgpt --input ./conversations.json

# Increase parallel subagent jobs
npx reclaw --provider chatgpt --input ./conversations.json --parallel-jobs 8

# Test-safe repeated runs (isolated state + timestamped backups)
npx reclaw --provider chatgpt --input ./conversations.json --state-path ./tmp/reclaw-run-1.json --timestamped-backups

# Explicit mode/model
npx reclaw --mode openclaw --model anthropic/claude-3.5-haiku
npx reclaw --mode zettelclaw --model openrouter/google/gemini-3-flash-preview
```

## 10) Content Quality

Reclaw's subagent extraction applies a hard memory filter:
- **Keep:** User-specific decisions, preferences, project details, relationships, and explored interests.
- **Drop:** General knowledge, textbook facts, trivia, and anything a general-purpose LLM could answer without user context.
- **Test:** "Would I need to know this person to know this?" If no, don't keep it.

In zettelclaw mode, output journals are compatible with the Zettelclaw nightly maintenance pass, which promotes durable knowledge into typed notes (`01 Notes/`).

## 11) What Reclaw Produces

OpenClaw mode:
- `memory/YYYY-MM-DD.md`
- updated `MEMORY.md` (+ `MEMORY.md.bak`)
- updated `USER.md` (+ `USER.md.bak`)

Zettelclaw mode:
- `03 Journal/YYYY-MM-DD.md` (template-compatible journals)
- updated `MEMORY.md` (+ `MEMORY.md.bak`)
- updated `USER.md` (+ `USER.md.bak`)

Core goal: convert transient chat history into durable, reusable memory.
