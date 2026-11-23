// Maximum layout-shift session window: <1 s gaps, <5 s duration.
export function createClsTracker() {
  let first = 0
  let last = 0
  let windowValue = 0
  let maximum = 0
  return (entry: { startTime: number; value: number; hadRecentInput: boolean }) => {
    if (entry.hadRecentInput) return maximum
    if (windowValue > 0 && entry.startTime - last < 1000 && entry.startTime - first < 5000) {
      windowValue += entry.value
    } else {
      first = entry.startTime
      windowValue = entry.value
    }
    last = entry.startTime
    maximum = Math.max(maximum, windowValue)
    return maximum
  }
}
