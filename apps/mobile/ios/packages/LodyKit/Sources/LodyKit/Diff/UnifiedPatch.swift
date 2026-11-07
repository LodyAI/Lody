import Foundation

enum UnifiedPatch {
  struct Line: Equatable {
    var text: String
    var newline: Bool

    static func == (left: Line, right: Line) -> Bool {
      left.newline == right.newline && left.text.utf8.elementsEqual(right.text.utf8)
    }
  }

  private struct Run {
    enum Kind { case context, delete, insert }
    var kind: Kind
    var lines: [Line]
  }

  private struct Hunk {
    var oldStart: Int
    var oldLines: Int
    var newStart: Int
    var newLines: Int
    var lines: [(sign: String, line: Line)]
  }

  static func make(path: String, old: String, new: String, context: Int = 4) -> String {
    var output = ["===================================================================", "--- " + quoted("a/" + path), "+++ " + quoted("b/" + path)]
    for hunk in hunks(runs(old: old, new: new), context: context) {
      let oldStart = hunk.oldLines == 0 ? hunk.oldStart - 1 : hunk.oldStart
      let newStart = hunk.newLines == 0 ? hunk.newStart - 1 : hunk.newStart
      output.append("@@ -\(oldStart),\(hunk.oldLines) +\(newStart),\(hunk.newLines) @@")
      for (sign, line) in hunk.lines {
        output.append(sign + line.text)
        if !line.newline { output.append("\\ No newline at end of file") }
      }
    }
    return output.joined(separator: "\n") + "\n"
  }

  static func quoted(_ name: String) -> String {
    let bytes = Array(name.utf8)
    guard bytes.contains(where: { $0 < 0x20 || $0 > 0x7E || $0 == 0x22 || $0 == 0x5C }) else { return name }
    let escapes: [UInt8: String] = [0x07: "\\a", 0x08: "\\b", 0x09: "\\t", 0x0A: "\\n", 0x0B: "\\v", 0x0C: "\\f", 0x0D: "\\r", 0x22: "\\\"", 0x5C: "\\\\"]
    let body = bytes.map { byte in
      if let escape = escapes[byte] { return escape }
      if (0x20...0x7E).contains(byte) { return String(UnicodeScalar(byte)) }
      let octal = String(byte, radix: 8)
      return "\\" + String(repeating: "0", count: max(0, 3 - octal.count)) + octal
    }
    return "\"" + body.joined() + "\""
  }

  static func lines(_ text: String) -> [Line] {
    guard !text.isEmpty else { return [] }
    var result = text.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false).map {
      Line(text: String(String.UnicodeScalarView($0)), newline: true)
    }
    if text.unicodeScalars.last == "\n" {
      result.removeLast()
    } else {
      result[result.count - 1].newline = false
    }
    return result
  }

  private static func runs(old: String, new: String) -> [Run] {
    let oldLines = lines(old), newLines = lines(new)
    var removed = Set<Int>(), inserted = Set<Int>()
    for change in newLines.difference(from: oldLines) {
      switch change {
      case .remove(let offset, _, _): removed.insert(offset)
      case .insert(let offset, _, _): inserted.insert(offset)
      }
    }
    var result: [Run] = []
    func append(_ kind: Run.Kind, _ line: Line) {
      if result.last?.kind == kind {
        result[result.count - 1].lines.append(line)
      } else {
        result.append(Run(kind: kind, lines: [line]))
      }
    }
    var oldIndex = 0, newIndex = 0
    while oldIndex < oldLines.count || newIndex < newLines.count {
      if oldIndex < oldLines.count, removed.contains(oldIndex) {
        append(.delete, oldLines[oldIndex])
        oldIndex += 1
      } else if newIndex < newLines.count, inserted.contains(newIndex) {
        append(.insert, newLines[newIndex])
        newIndex += 1
      } else {
        append(.context, oldLines[oldIndex])
        oldIndex += 1
        newIndex += 1
      }
    }
    return result
  }

  private static func hunks(_ runs: [Run], context: Int) -> [Hunk] {
    let runs = runs + [Run(kind: .context, lines: [])]
    var hunks: [Hunk] = []
    var oldStart = 0, newStart = 0, oldLine = 1, newLine = 1
    var current: [(sign: String, line: Line)] = []
    for (index, run) in runs.enumerated() {
      if run.kind != .context {
        if oldStart == 0 {
          oldStart = oldLine
          newStart = newLine
          if index > 0 {
            current = runs[index - 1].lines.suffix(context).map { (" ", $0) }
            oldStart -= current.count
            newStart -= current.count
          }
        }
        let sign = run.kind == .insert ? "+" : "-"
        current += run.lines.map { (sign, $0) }
        if run.kind == .insert { newLine += run.lines.count } else { oldLine += run.lines.count }
        continue
      }
      if oldStart != 0 {
        if run.lines.count <= context * 2, index < runs.count - 2 {
          current += run.lines.map { (" ", $0) }
        } else {
          let size = min(run.lines.count, context)
          current += run.lines.prefix(size).map { (" ", $0) }
          hunks.append(Hunk(
            oldStart: oldStart, oldLines: oldLine - oldStart + size,
            newStart: newStart, newLines: newLine - newStart + size, lines: current
          ))
          oldStart = 0
          newStart = 0
          current = []
        }
      }
      oldLine += run.lines.count
      newLine += run.lines.count
    }
    return hunks
  }
}
