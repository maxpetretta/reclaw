export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []

  for (const value of values) {
    const normalized = value.trim()
    if (normalized.length === 0) {
      continue
    }

    const key = normalized.toLowerCase()
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    output.push(normalized)
  }

  return output
}
