interface MongoDateLike {
  $date?: unknown
  $numberLong?: unknown
}

export function toIsoTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  if (typeof value === "number") {
    return isoFromEpochNumber(value)
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      return undefined
    }

    const asNumber = Number(trimmed)
    if (!Number.isNaN(asNumber)) {
      return isoFromEpochNumber(asNumber)
    }

    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString()
    }

    return undefined
  }

  if (typeof value === "object") {
    const typed = value as MongoDateLike
    if (typed.$numberLong !== undefined) {
      return toIsoTimestamp(typed.$numberLong)
    }

    if (typed.$date !== undefined) {
      return toIsoTimestamp(typed.$date)
    }
  }

  return undefined
}

export function toLocalDateKey(isoLike: string): string {
  const parsed = Date.parse(isoLike)
  if (Number.isNaN(parsed)) {
    return isoLike.slice(0, 10)
  }

  return formatLocalDate(new Date(parsed))
}

export function formatLocalDate(now: Date): string {
  const year = now.getFullYear().toString().padStart(4, "0")
  const month = (now.getMonth() + 1).toString().padStart(2, "0")
  const day = now.getDate().toString().padStart(2, "0")
  return `${year}-${month}-${day}`
}

function isoFromEpochNumber(value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined
  }

  const absolute = Math.abs(value)
  const millis = absolute >= 1_000_000_000_000 ? value : value * 1000
  const date = new Date(Math.trunc(millis))
  if (Number.isNaN(date.getTime())) {
    return undefined
  }

  return date.toISOString()
}
