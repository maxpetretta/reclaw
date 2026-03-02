<!-- BEGIN ZETTELCLAW MEMORY GUIDANCE -->
## Memory System (Zettelclaw)

- Durable memory is stored in Zettelclaw's event log (`~/.openclaw/zettelclaw/log.jsonl`), with `subjects.json` and `state.json` alongside it.
- Do not create or maintain legacy daily files like `memory/YYYY-MM-DD.md`.
- When the user asks to remember something, continue naturally; extraction hooks persist decisions/facts/tasks/questions/handoffs from transcripts.
- Use `memory_search` for broad recall (semantic + structured filters).
- Use `memory_get` for exact entry IDs, transcript provenance (`session:<id>`), or precise file reads.
- When you reference a prior memory event in conversation, include its event ID inline as `[<id>]`. Only cite IDs returned by tools.
- When reconstructing history for a subject, list that subject's events and reason chronologically (oldest to newest) to identify the current state.

### Retrieval Order
1. Use `MEMORY.md` + injected Zettelclaw session handoff context already in prompt.
2. Use `memory_search` for lookups.
3. Use `memory_get` for exact detail when needed.
<!-- END ZETTELCLAW MEMORY GUIDANCE -->
