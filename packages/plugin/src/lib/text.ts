export function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

export interface ExtractTextContentOptions {
  collapseWhitespace?: boolean;
}

function normalizeExtractedText(value: string, collapseWhitespace: boolean): string {
  return collapseWhitespace ? normalizeWhitespace(value) : value.trim();
}

export function extractTextContent(
  content: unknown,
  options: ExtractTextContentOptions = {},
): string {
  const collapseWhitespace = options.collapseWhitespace ?? true;

  if (typeof content === "string") {
    return normalizeExtractedText(content, collapseWhitespace);
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if ((type === "text" || type === "input_text" || type === "output_text") && typeof record.text === "string") {
      const normalized = normalizeExtractedText(record.text, collapseWhitespace);
      if (normalized) {
        parts.push(normalized);
      }
      continue;
    }

    if (typeof record.output_text === "string") {
      const normalized = normalizeExtractedText(record.output_text, collapseWhitespace);
      if (normalized) {
        parts.push(normalized);
      }
      continue;
    }

    if (typeof record.input_text === "string") {
      const normalized = normalizeExtractedText(record.input_text, collapseWhitespace);
      if (normalized) {
        parts.push(normalized);
      }
      continue;
    }

    if (typeof record.text === "string") {
      const normalized = normalizeExtractedText(record.text, collapseWhitespace);
      if (normalized) {
        parts.push(normalized);
      }
    }
  }

  return parts.join("\n");
}
