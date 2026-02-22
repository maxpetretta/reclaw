export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return
  }

  const normalizedConcurrency = Math.max(1, Math.min(concurrency, items.length))
  let nextIndex = 0

  const consume = async (): Promise<void> => {
    while (true) {
      const current = nextIndex
      nextIndex += 1
      if (current >= items.length) {
        return
      }

      const item = items[current]
      if (item === undefined) {
        return
      }

      await worker(item, current)
    }
  }

  await Promise.all(Array.from({ length: normalizedConcurrency }, () => consume()))
}
