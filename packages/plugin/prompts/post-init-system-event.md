[Zettelclaw init] Apply memory-guidance updates now.

Update the workspace files for this main session:
- AGENTS.md: `{{AGENTS_MD_PATH}}`
- MEMORY.md: `{{MEMORY_MD_PATH}}`

1. Update `AGENTS.md`.
- Insert the excerpt below exactly once (between its BEGIN/END markers).
- Replace default OpenClaw memory instructions, not random content.
- Keep unrelated AGENTS.md content unchanged.
- The managed block must be byte-for-byte equivalent to the excerpt (same markers, same lines, no extra bullets/sections added inside the block).

AGENTS replacement targets (be explicit):
- In `## Every Session`, replace the step that says:
  - `Read memory/YYYY-MM-DD.md (today + yesterday) for recent context`
  with Zettelclaw behavior (no daily memory file requirement).
- Replace the full `## Memory` section that currently describes:
  - `Daily notes: memory/YYYY-MM-DD.md`
  - `MEMORY.md - Your Long-Term Memory`
  - `Write It Down` bullet about updating `memory/YYYY-MM-DD.md`
- Replace the `### 🔄 Memory Maintenance (During Heartbeats)` block that says to read recent `memory/YYYY-MM-DD.md` files.
- Remove any remaining lines that instruct writing/reading `memory/YYYY-MM-DD.md`.
- If a previous `<!-- BEGIN ZETTELCLAW MEMORY GUIDANCE --> ... <!-- END ZETTELCLAW MEMORY GUIDANCE -->` block exists, replace that block in place (do not duplicate).
- Remove any mention of `replaces` chains from AGENTS.md memory guidance.

```markdown
{{AGENTS_EXCERPT}}
```

2. Update `MEMORY.md`.
- Insert the excerpt below near the top as persistent manual guidance (after any title/introduction).
- Keep existing manual content unless it conflicts with Zettelclaw mode.
- If a previous `<!-- BEGIN ZETTELCLAW MEMORY NOTICE --> ... <!-- END ZETTELCLAW MEMORY NOTICE -->` block exists, replace it in place (do not duplicate).
- Remove any lines that say to write/read `memory/YYYY-MM-DD.md` from MEMORY.md.
- Remove outdated documentation that says event corrections are handled via a `replaces` field.
- Preserve the generated memory snapshot markers and their managed block exactly:
  - `<!-- BEGIN GENERATED BRIEFING -->`
  - `<!-- END GENERATED BRIEFING -->`

```markdown
{{MEMORY_EXCERPT}}
```

After both files are updated, confirm completion in-session.
