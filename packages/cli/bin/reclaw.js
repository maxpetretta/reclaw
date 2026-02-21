#!/usr/bin/env node

import("../dist/index.js").catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`reclaw failed to start: ${message}`)
  process.exit(1)
})
