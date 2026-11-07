import Foundation

struct InlineDiffLine: Equatable {
  enum Kind: Equatable { case context, insert, delete }
  var kind: Kind
  var oldNumber: Int?
  var newNumber: Int?
  var text: String
  var emphasis: [NSRange]
}

struct InlineDiffHunk: Equatable {
  var oldStart: Int
  var oldCount: Int
  var newStart: Int
  var newCount: Int
  var lines: [InlineDiffLine]
}

struct InlineDiffDocument: Equatable {
  var hunks: [InlineDiffHunk]
}

enum InlineDiffModel {
  static func build(old: String, new: String, context: Int = 3) -> InlineDiffDocument {
    InlineDiffDocument(hunks: hunks(from: rows(old: old, new: new), context: context))
  }

  static func rows(old: String, new: String) -> [InlineDiffLine] {
    var rows = alignedLines(splitLines(old), splitLines(new))
    emphasizeAdjacentReplacements(&rows)
    return rows
  }

  static func splitLines(_ text: String) -> [String] {
    if text.isEmpty { return [] }
    var parts = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    if text.hasSuffix("\n") { parts.removeLast() }
    return parts
  }

  private static func alignedLines(_ oldLines: [String], _ newLines: [String]) -> [InlineDiffLine] {
    let difference = newLines.difference(from: oldLines)
    var removed = Set<Int>()
    var inserted = Set<Int>()
    for change in difference {
      switch change {
      case .remove(let offset, _, _): removed.insert(offset)
      case .insert(let offset, _, _): inserted.insert(offset)
      }
    }
    var rows: [InlineDiffLine] = []
    var oldIndex = 0
    var newIndex = 0
    var oldNumber = 1
    var newNumber = 1
    while oldIndex < oldLines.count || newIndex < newLines.count {
      if oldIndex < oldLines.count, removed.contains(oldIndex) {
        rows.append(InlineDiffLine(
          kind: .delete,
          oldNumber: oldNumber,
          newNumber: nil,
          text: oldLines[oldIndex],
          emphasis: []
        ))
        oldIndex += 1
        oldNumber += 1
      } else if newIndex < newLines.count, inserted.contains(newIndex) {
        rows.append(InlineDiffLine(
          kind: .insert,
          oldNumber: nil,
          newNumber: newNumber,
          text: newLines[newIndex],
          emphasis: []
        ))
        newIndex += 1
        newNumber += 1
      } else {
        rows.append(InlineDiffLine(
          kind: .context,
          oldNumber: oldNumber,
          newNumber: newNumber,
          text: oldLines[oldIndex],
          emphasis: []
        ))
        oldIndex += 1
        newIndex += 1
        oldNumber += 1
        newNumber += 1
      }
    }
    return rows
  }

  private static func emphasizeAdjacentReplacements(_ rows: inout [InlineDiffLine]) {
    var index = 0
    while index < rows.count {
      if rows[index].kind == .delete,
        index + 1 < rows.count,
        rows[index + 1].kind == .insert
      {
        let pair = wordEmphasis(rows[index].text, rows[index + 1].text)
        rows[index].emphasis = pair.0
        rows[index + 1].emphasis = pair.1
        index += 2
      } else {
        index += 1
      }
    }
  }

  private static func wordEmphasis(_ left: String, _ right: String) -> ([NSRange], [NSRange]) {
    let leftTokens = tokens(left)
    let rightTokens = tokens(right)
    let difference = rightTokens.map(\.text).difference(from: leftTokens.map(\.text))
    var removed = Set<Int>()
    var inserted = Set<Int>()
    for change in difference {
      switch change {
      case .remove(let offset, _, _): removed.insert(offset)
      case .insert(let offset, _, _): inserted.insert(offset)
      }
    }
    return (
      leftTokens.enumerated().compactMap { removed.contains($0.offset) ? $0.element.range : nil },
      rightTokens.enumerated().compactMap { inserted.contains($0.offset) ? $0.element.range : nil }
    )
  }

  private static func tokens(_ text: String) -> [(text: String, range: NSRange)] {
    var result: [(String, NSRange)] = []
    var current = ""
    var start = text.startIndex
    var index = text.startIndex
    var word: Bool?
    while index < text.endIndex {
      let character = text[index]
      let nextWord = character.isLetter || character.isNumber || character == "_"
      if let word, word != nextWord {
        result.append((current, NSRange(start..<index, in: text)))
        current = ""
        start = index
      }
      current.append(character)
      word = nextWord
      index = text.index(after: index)
    }
    if !current.isEmpty {
      result.append((current, NSRange(start..<text.endIndex, in: text)))
    }
    return result
  }

  private static func hunks(from rows: [InlineDiffLine], context: Int) -> [InlineDiffHunk] {
    if rows.isEmpty { return [] }
    let changes = rows.indices.filter { rows[$0].kind != .context }
    if changes.isEmpty {
      return [hunk(rows[0..<rows.count])]
    }
    var keep = Set<Int>()
    for index in changes {
      let lower = max(0, index - context)
      let upper = min(rows.count - 1, index + context)
      for nearby in lower...upper { keep.insert(nearby) }
    }
    var result: [InlineDiffHunk] = []
    var cursor = 0
    while cursor < rows.count {
      guard keep.contains(cursor) else {
        cursor += 1
        continue
      }
      var end = cursor
      while end + 1 < rows.count, keep.contains(end + 1) { end += 1 }
      result.append(hunk(rows[cursor...end]))
      cursor = end + 1
    }
    return result
  }

  private static func hunk(_ rows: ArraySlice<InlineDiffLine>) -> InlineDiffHunk {
    let oldNumbers = rows.compactMap(\.oldNumber)
    let newNumbers = rows.compactMap(\.newNumber)
    return InlineDiffHunk(
      oldStart: oldNumbers.first ?? 0,
      oldCount: oldNumbers.count,
      newStart: newNumbers.first ?? 0,
      newCount: newNumbers.count,
      lines: Array(rows)
    )
  }
}
