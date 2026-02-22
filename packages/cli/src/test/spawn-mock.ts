import { mock } from "bun:test"

interface SpawnResult {
  status?: number | null
  stdout?: string | null
  stderr?: string | null
  error?: (Error & { code?: string }) | null
}

interface SpawnCall {
  command: string
  args: string[]
}

interface SpawnMockStore {
  queue: SpawnResult[]
  calls: SpawnCall[]
  hook: ((command: string, args: string[]) => void) | undefined
}

interface SpawnMockGlobal {
  __reclawSpawnMockStore?: SpawnMockStore
  __reclawSpawnMockInitialized?: boolean
}

const globalStore = globalThis as typeof globalThis & SpawnMockGlobal

function getStore(): SpawnMockStore {
  if (!globalStore.__reclawSpawnMockStore) {
    globalStore.__reclawSpawnMockStore = {
      queue: [],
      calls: [],
      hook: undefined,
    }
  }

  return globalStore.__reclawSpawnMockStore
}

if (!globalStore.__reclawSpawnMockInitialized) {
  mock.module("node:child_process", () => ({
    spawnSync(command: string, args: string[]) {
      const store = getStore()
      store.calls.push({ command, args })
      store.hook?.(command, args)

      const next = store.queue.shift()
      if (!next) {
        throw new Error(`No mocked spawnSync result available for command: ${command} ${args.join(" ")}`)
      }

      return next
    },
  }))

  globalStore.__reclawSpawnMockInitialized = true
}

export function enqueueSpawnResult(result: SpawnResult): void {
  getStore().queue.push(result)
}

export function getSpawnCalls(): SpawnCall[] {
  return [...getStore().calls]
}

export function setSpawnHook(hook: SpawnMockStore["hook"]): void {
  getStore().hook = hook
}

export function resetSpawnMock(): void {
  const store = getStore()
  store.queue.length = 0
  store.calls.length = 0
  store.hook = undefined
}
