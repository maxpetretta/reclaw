Goal:
- Distill core long-term memory signals instead of preserving raw chat transcript details.
- Focus on only the MOST IMPORTANT durable information.

Requirements:
- {{output_instruction}}
- Avoid raw transcript dumps.
- Prefer concise, high-signal statements.
- Prioritize durable signal over transient details.

Return STRICT JSON only (no markdown fences, no extra prose) with exactly this key:
{
  "summary": "string"
}

Summary format guidance:
- 3-8 short lines separated by newline characters.
- Prefix lines with tags when possible: `Decision:`, `Fact:`, `Preference:`, `Person:`, `Project:`, `Interest:`, `Open:`.
- Include only top-priority information.

Date batch metadata:
- provider: {{provider}}
- date: {{date}}
- batch: {{batch_index}}/{{batch_total}}
- conversations: {{conversation_count}}

Conversations:
{{conversations_markdown}}
