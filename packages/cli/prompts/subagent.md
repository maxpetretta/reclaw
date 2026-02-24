Goal:
- Distill only durable, high-signal memory from these conversations.
- Focus on information about this specific user and their personal/project context.

Requirements:
- {{output_instruction}}
- Avoid raw transcript dumps.
- Merge and deduplicate across ALL conversations in this date batch.
- Prefer concise, high-signal statements.
- Prioritize durable signal over transient details.

Hard memory filter (must apply to every line):
- Keep only information that is about the user or specific to the user's context.
- Ask: "Would I need to know this person to know this?"
- If a general-purpose LLM could answer it without user context, do NOT keep it.

Save:
- Personal decisions.
- Personal preferences.
- Personal facts and relationships.
- Project-specific architecture and decisions tied to the user's work.
- Interest signals stated briefly (what they explored), not encyclopedia content.
- Conclusions and outcomes, not the reasoning process.

Never save:
- General knowledge, definitions, or textbook facts.
- Nutrition/unit conversion/weather/store-hours/product-spec trivia.
- Historical/background facts anyone can look up.
- Any content that is broadly true and not specific to this user.
- One-off questions as interests. Only keep interests when repeated, explored in depth, or explicitly important to the user.
- Technology facts true for all users (for example, standard default schemas/features of a platform).
- Step-by-step process descriptions. Save the decision/outcome, not the journey.
- Benchmark data or comparison tables unless the user made a selection based on them.

Zettelclaw note quality (apply when output feeds into vault notes):
- Each summary line should map to exactly one atomic **claim** — a statement someone can learn from without further context.
- Prefer statements that could be note titles: "Selected SQLite because it eliminates connection pooling complexity", not "Uses SQLite for database."
- Avoid topic summaries ("Discussed tech stack options") — extract the decision or insight instead.
- Avoid compound lines that pack multiple unrelated facts together.
- When a decision was made, state what was chosen AND what was rejected (briefly).
- Do NOT produce dependency lists, version inventories, or architecture overviews — extract the decisions and reasoning behind them.

Return STRICT JSON only (no markdown fences, no extra prose) with exactly this key:
{
  "summary": "string"
}

Summary format guidance:
- 3-8 short lines separated by newline characters.
- Prefix lines with tags when possible: `Decision:`, `Fact:`, `Preference:`, `Person:`, `Project:`, `Interest:`, `Todo:`.
- Include only top-priority user-specific information.
- Do not include duplicate lines.
- Priority order when cutting for space: Decisions > Projects > Facts > Preferences > Interests > Todo.

Date batch metadata:
- providers: {{providers}}
- date: {{date}}
- batch: {{batch_index}}/{{batch_total}}
- conversations: {{conversation_count}}

Conversations:
{{conversations_markdown}}
