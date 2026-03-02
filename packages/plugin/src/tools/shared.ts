export function textResult(
  text: string,
  details?: unknown,
): { content: Array<{ type: string; text: string }>; details?: unknown } {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
  };
}
