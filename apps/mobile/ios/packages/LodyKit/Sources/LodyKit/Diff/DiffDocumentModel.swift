import Foundation

enum DiffDocumentStyle: String {
  case unified
  case split
}

enum DiffDocumentItem: Equatable {
  case line(InlineDiffLine)
  case pair(InlineDiffLine?, InlineDiffLine?)
  case gap(Range<Int>)
}

enum DiffDocumentModel {
  static func normalized(_ text: String) -> String {
    text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
  }

  static func file(_ text: String) -> [InlineDiffLine] {
    InlineDiffModel.splitLines(text).enumerated().map {
      InlineDiffLine(kind: .context, oldNumber: $0.offset + 1, newNumber: $0.offset + 1, text: $0.element, emphasis: [])
    }
  }

  static func lineRanges(_ text: String) -> [NSRange] {
    var location = 0
    return InlineDiffModel.splitLines(text).map { line in
      let length = (line as NSString).length
      defer { location += length + 1 }
      return NSRange(location: location, length: length)
    }
  }

  static func hidden(_ rows: [InlineDiffLine], context: Int = 3) -> [Range<Int>] {
    let changes = rows.indices.filter { rows[$0].kind != .context }
    guard !changes.isEmpty else { return [] }
    var visible = [Bool](repeating: false, count: rows.count)
    for index in changes {
      for nearby in max(0, index - context)...min(rows.count - 1, index + context) {
        visible[nearby] = true
      }
    }
    var result: [Range<Int>] = []
    var start: Int?
    for index in rows.indices {
      if !visible[index] {
        start = start ?? index
      } else if let first = start {
        result.append(first..<index)
        start = nil
      }
    }
    if let start { result.append(start..<rows.count) }
    return result
  }

  static func items(_ rows: [InlineDiffLine], hidden: [Range<Int>], style: DiffDocumentStyle) -> [DiffDocumentItem] {
    var result: [DiffDocumentItem] = []
    var cursor = 0
    for gap in hidden.sorted(by: { $0.lowerBound < $1.lowerBound })
    where gap.lowerBound >= cursor && gap.upperBound <= rows.count && !gap.isEmpty {
      result += visible(rows[cursor..<gap.lowerBound], style: style)
      result.append(.gap(gap))
      cursor = gap.upperBound
    }
    result += visible(rows[cursor..<rows.count], style: style)
    return result
  }

  static func pairs(_ rows: ArraySlice<InlineDiffLine>) -> [(InlineDiffLine?, InlineDiffLine?)] {
    var result: [(InlineDiffLine?, InlineDiffLine?)] = []
    var deletes: [InlineDiffLine] = []
    var inserts: [InlineDiffLine] = []
    func flush() {
      for index in 0..<max(deletes.count, inserts.count) {
        result.append((
          deletes.indices.contains(index) ? deletes[index] : nil,
          inserts.indices.contains(index) ? inserts[index] : nil
        ))
      }
      deletes = []
      inserts = []
    }
    for row in rows {
      switch row.kind {
      case .delete:
        if !inserts.isEmpty { flush() }
        deletes.append(row)
      case .insert:
        inserts.append(row)
      case .context:
        flush()
        result.append((row, row))
      }
    }
    flush()
    return result
  }

  private static func visible(_ rows: ArraySlice<InlineDiffLine>, style: DiffDocumentStyle) -> [DiffDocumentItem] {
    switch style {
    case .unified: return rows.map { .line($0) }
    case .split: return pairs(rows).map { .pair($0.0, $0.1) }
    }
  }
}

enum DiffLanguage {
  static func name(for path: String) -> String? {
    let name = (path as NSString).lastPathComponent.lowercased()
    let ext = (name as NSString).pathExtension
    return [
      "ts": "typescript", "tsx": "typescript", "js": "javascript", "jsx": "javascript",
      "swift": "swift", "py": "python", "rb": "ruby", "go": "go", "rs": "rust",
      "java": "java", "kt": "kotlin", "c": "c", "cpp": "cpp", "cs": "csharp",
      "json": "json", "yml": "yaml", "yaml": "yaml", "md": "markdown",
      "css": "css", "html": "xml", "sh": "bash",
    ][ext.isEmpty ? name : ext]
  }
}
