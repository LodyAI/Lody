/// Empty-section supplementaries sit at the top of the card. Inserting rows
/// then interpolates that header/footer through the new cells.
enum LodyListSectionAnimation {
  static func itemCountsCrossEmpty(previous: [String: Int], next: [String: Int]) -> Bool {
    Set(previous.keys).intersection(next.keys).contains { id in
      ((previous[id] ?? 0) == 0) != ((next[id] ?? 0) == 0)
    }
  }

  /// A list placeholder already explains the empty state. Keep a footer-only
  /// help section when the host did not supply one.
  static func hidesEmptyFooter(rowCount: Int, placeholder: String) -> Bool {
    rowCount == 0 && !placeholder.isEmpty
  }
}
