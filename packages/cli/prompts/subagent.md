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

Never save:
- General knowledge, definitions, or textbook facts.
- Nutrition/unit conversion/weather/store-hours/product-spec trivia.
- Historical/background facts anyone can look up.
- Any content that is broadly true and not specific to this user.
- One-off questions as interests. Only keep interests when repeated, explored in depth, or explicitly important to the user.
- Technology facts true for all users (for example, standard default schemas/features of a platform).

Return STRICT JSON only (no markdown fences, no extra prose) with exactly this key:
{
  "summary": "string"
}

Summary format guidance:
- 3-8 short lines separated by newline characters.
- Prefix lines with tags when possible: `Decision:`, `Fact:`, `Preference:`, `Person:`, `Project:`, `Interest:`, `Open:`.
- Include only top-priority user-specific information.
- Do not include duplicate lines.

Date batch metadata:
- providers: {{providers}}
- date: {{date}}
- batch: {{batch_index}}/{{batch_total}}
- conversations: {{conversation_count}}

Conversations:
{{conversations_markdown}}
