/// Page ownership is independent of the currently displayed session. Replacing a
/// page must not release the subscription still owned by its successor.
struct SessionSubscriptions {
  private var counts: [String: Int] = [:]

  mutating func retain(_ id: String) { counts[id, default: 0] += 1 }

  mutating func release(_ id: String) -> Bool {
    guard let count = counts[id] else { return false }
    if count > 1 { counts[id] = count - 1; return false }
    counts[id] = nil
    return true
  }
}
