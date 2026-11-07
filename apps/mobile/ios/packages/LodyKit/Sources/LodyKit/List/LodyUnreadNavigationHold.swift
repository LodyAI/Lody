struct LodyUnreadNavigationHold {
  private var id: String?

  var isHolding: Bool { id != nil }

  mutating func begin(rowID: String, unread: Bool, coversList: Bool) {
    guard coversList, unread else { return }
    id = rowID
  }

  func applied(rowID: String, unread: Bool) -> Bool {
    id == rowID || unread
  }

  mutating func end() -> String? {
    defer { id = nil }
    return id
  }
}
