import { homedir } from "node:os"
import { resolve } from "node:path"

export function resolveHomePath(value: string): string {
  if (value === "~") {
    return homedir()
  }

  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2))
  }

  return resolve(value)
}
