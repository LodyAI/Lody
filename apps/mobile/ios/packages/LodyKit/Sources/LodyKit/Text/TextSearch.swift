import Foundation

enum TextSearch {
  static func ranges(in text: String, query: String) -> [NSRange] {
    guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
    var result: [NSRange] = []
    var start = text.startIndex
    // The same locale/case/diacritic search as localizedStandardRange, without
    // copying the entire remaining message for every occurrence.
    while start < text.endIndex,
      let range = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive],
        range: start..<text.endIndex, locale: .current), !range.isEmpty {
      result.append(NSRange(range, in: text))
      start = range.upperBound
    }
    return result
  }

  static func snippet(_ text: String, query: String) -> String? {
    guard let match = text.localizedStandardRange(of: query) else { return nil }
    var start = text.index(match.lowerBound, offsetBy: -18, limitedBy: text.startIndex) ?? text.startIndex
    if start > text.startIndex, !text[text.index(before: start)].isWhitespace,
       let space = text[start..<match.lowerBound].firstIndex(where: \.isWhitespace) {
      start = text.index(after: space)
    }
    let end = text.index(match.upperBound, offsetBy: 90, limitedBy: text.endIndex) ?? text.endIndex
    let body = text[start..<end].split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return (start > text.startIndex ? "…" : "") + body + (end < text.endIndex ? "…" : "")
  }
}
