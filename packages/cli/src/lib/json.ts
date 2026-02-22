export function parseJson<T>(value: string, onError: (message: string) => Error): T {
  try {
    return JSON.parse(value) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw onError(message)
  }
}
