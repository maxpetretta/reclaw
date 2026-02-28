export function replaceManagedBlock(
  content: string,
  beginMarker: string,
  endMarker: string,
  generated: string,
): string {
  const start = content.indexOf(beginMarker);
  const end = content.indexOf(endMarker);

  if (start >= 0 && end >= 0 && end > start) {
    const before = content.slice(0, start + beginMarker.length).replace(/\s*$/u, "");
    const after = content.slice(end).replace(/^\s*/u, "");

    return `${before}\n${generated}\n${after}`.replace(/\n{3,}/gu, "\n\n");
  }

  const trimmed = content.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}${beginMarker}\n${generated}\n${endMarker}\n`;
}

export function ensureManagedBlock(content: string, beginMarker: string, endMarker: string): string {
  const hasBegin = content.includes(beginMarker);
  const hasEnd = content.includes(endMarker);
  if (hasBegin && hasEnd) {
    return content;
  }

  const trimmed = content.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}${beginMarker}\n${endMarker}\n`;
}
