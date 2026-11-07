import Foundation
import Lexical
import LexicalLinkPlugin

private let punctuation = Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".utf16)
private let backslash = UInt16(UInt8(ascii: "\\"))
private let backtick = UInt16(UInt8(ascii: "`"))

private func isWhitespace(_ unit: UInt16?) -> Bool {
  guard let unit, let scalar = Unicode.Scalar(unit) else { return false }
  return CharacterSet.whitespacesAndNewlines.contains(scalar)
}

private func isPunctuation(_ unit: UInt16?) -> Bool {
  unit.map(punctuation.contains) ?? false
}

private struct InlineMatch {
  var start: Int
  var end: Int
  var tag: String
  var content: String
}

private final class Delimiter {
  var index: Int
  let char: UInt16
  var length: Int
  let canOpen: Bool
  let canClose: Bool
  var active = true

  init(index: Int, char: UInt16, length: Int, canOpen: Bool, canClose: Bool) {
    self.index = index
    self.char = char
    self.length = length
    self.canOpen = canOpen
    self.canClose = canClose
  }
}

struct InlineImport {
  let formats: [(tag: String, formats: [TextFormatType])]
  let importsLinks: Bool

  private var hasCode: Bool { formats.contains { $0.tag == "`" } }

  func importText(_ node: TextNode) throws {
    let text = node.getTextPart()
    var format = findFormat(in: text)
    var link = importsLinks ? findLink(in: text) : nil
    if let found = format, let foundLink = link {
      if found.tag == "`" {
        if foundLink.start <= found.start && foundLink.end >= found.end {
          format = nil
        } else {
          link = nil
        }
      } else if (found.start <= foundLink.start && found.end >= foundLink.end) || foundLink.start > found.end {
        link = nil
      } else {
        format = nil
      }
    }

    if let found = format, let tagFormats = formats.first(where: { $0.tag == found.tag })?.formats {
      let (before, transformed, after) = try split(node, found.start, found.end, whole: (text as NSString).length)
      try transformed.setText(found.content)
      var textFormat = transformed.getFormat()
      for type in tagFormats { textFormat.updateFormat(type: type, value: true) }
      _ = try transformed.setFormat(format: textFormat)
      for part in [after, before, transformed] {
        if let part, !part.getFormat().code { try importText(part) }
      }
    } else if let foundLink = link {
      let (before, transformed, after) = try split(node, foundLink.start, foundLink.end, whole: -1)
      let linkText = try replaceWithLink(transformed, foundLink.groups)
      for part in [after, before, linkText] {
        if let part, !part.getFormat().code { try importText(part) }
      }
    }
    try node.setText(unescape(node.getTextPart()))
  }

  private func split(_ node: TextNode, _ start: Int, _ end: Int, whole: Int) throws -> (TextNode?, TextNode, TextNode?) {
    if whole >= 0, start == 0, end == whole { return (nil, node, nil) }
    if start == 0 {
      let parts = try node.splitText(splitOffsets: [end])
      return (nil, parts[0], parts.count > 1 ? parts[1] : nil)
    }
    let parts = try node.splitText(splitOffsets: [start, end])
    return (parts[0], parts[1], parts.count > 2 ? parts[2] : nil)
  }

  private func findFormat(in text: String) -> InlineMatch? {
    let units = Array(text.utf16)
    let codeSpans = hasCode ? scanCodeSpans(units) : []
    let delimiters = scanDelimiters(units, excluding: codeSpans.map { $0.start..<$0.end })
    let emphasis = delimiters.isEmpty ? nil : processEmphasis(units, delimiters)
    let code = codeSpans.first
    if let code, let emphasis {
      return emphasis.start <= code.start && emphasis.end >= code.end ? emphasis : code
    }
    return code ?? emphasis
  }

  private func scanCodeSpans(_ units: [UInt16]) -> [InlineMatch] {
    var runs: [(index: Int, length: Int)] = []
    var i = 0
    while i < units.count {
      guard units[i] == backtick else {
        i += 1
        continue
      }
      var length = 1
      while i + length < units.count && units[i + length] == backtick { length += 1 }
      runs.append((i, length))
      i += length
    }
    var spans: [InlineMatch] = []
    var open = 0
    while open < runs.count {
      let opener = runs[open]
      if isEscaped(units, opener.index) {
        open += 1
        continue
      }
      guard let close = runs.indices.first(where: { $0 > open && runs[$0].length == opener.length }) else {
        open += 1
        continue
      }
      let closer = runs[close]
      var content = String(decoding: units[(opener.index + opener.length)..<closer.index], as: UTF16.self)
      if content.utf16.count >= 2, content.hasPrefix(" "), content.hasSuffix(" "), content.contains(where: { $0 != " " }) {
        content = String(content.dropFirst().dropLast())
      }
      spans.append(InlineMatch(start: opener.index, end: closer.index + closer.length, tag: "`", content: content))
      open = close + 1
    }
    return spans
  }

  private func isEscaped(_ units: [UInt16], _ index: Int) -> Bool {
    var count = 0
    var i = index - 1
    while i >= 0 && units[i] == backslash {
      count += 1
      i -= 1
    }
    return count % 2 == 1
  }

  private func scanDelimiters(_ units: [UInt16], excluding ranges: [Range<Int>]) -> [Delimiter] {
    let chars = Set(formats.map(\.tag).filter { !$0.hasPrefix("`") }.compactMap { $0.utf16.first })
    var delimiters: [Delimiter] = []
    var i = 0
    while i < units.count {
      let char = units[i]
      if !chars.contains(char) || isEscaped(units, i) || ranges.contains(where: { $0.contains(i) }) {
        i += 1
        continue
      }
      var length = 1
      while i + length < units.count && units[i + length] == char { length += 1 }
      let canOpen = canEmphasis(char, units, i, length, open: true)
      let canClose = canEmphasis(char, units, i, length, open: false)
      if canOpen || canClose {
        delimiters.append(Delimiter(index: i, char: char, length: length, canOpen: canOpen, canClose: canClose))
      }
      i += length
    }
    return delimiters
  }

  private func canEmphasis(_ char: UInt16, _ units: [UInt16], _ index: Int, _ length: Int, open: Bool) -> Bool {
    guard isFlanking(units, index, length, left: open) else { return false }
    guard char == UInt16(UInt8(ascii: "_")) else { return true }
    if !isFlanking(units, index, length, left: !open) { return true }
    let adjacent = open ? (index > 0 ? units[index - 1] : nil) : (index + length < units.count ? units[index + length] : nil)
    return isPunctuation(adjacent)
  }

  private func isFlanking(_ units: [UInt16], _ index: Int, _ length: Int, left: Bool) -> Bool {
    let before = index > 0 ? units[index - 1] : nil
    let after = index + length < units.count ? units[index + length] : nil
    let primary = left ? after : before
    let secondary = left ? before : after
    guard let primary, !isWhitespace(primary) else { return false }
    if !isPunctuation(primary) { return true }
    return secondary == nil || isWhitespace(secondary) || isPunctuation(secondary)
  }

  private func processEmphasis(_ units: [UInt16], _ delimiters: [Delimiter]) -> InlineMatch? {
    var bottoms: [String: Int] = [:]
    var position = 0
    var result: InlineMatch?
    while position < delimiters.count {
      let closer = delimiters[position]
      if !closer.active || !closer.canClose || closer.length == 0 {
        position += 1
        continue
      }
      let key = "\(closer.char)\(closer.canOpen)\(closer.length % 3)"
      let bottom = bottoms[key] ?? -1
      var found = false
      var openIndex = position - 1
      while openIndex > bottom {
        defer { openIndex -= 1 }
        let opener = delimiters[openIndex]
        if !opener.active || !opener.canOpen || opener.length == 0 || opener.char != closer.char { continue }
        if opener.canClose || closer.canOpen {
          let sum = opener.length + closer.length
          if sum % 3 == 0 && opener.length % 3 != 0 && closer.length % 3 != 0 { continue }
        }
        let maxLength = min(opener.length, closer.length)
        guard let tag = formats.map(\.tag).filter({ $0.utf16.first == opener.char && $0.utf16.count <= maxLength }).max(by: { $0.utf16.count < $1.utf16.count })
        else { continue }
        found = true
        let length = tag.utf16.count
        let match = InlineMatch(
          start: opener.index + (opener.length - length),
          end: closer.index + length,
          tag: tag,
          content: String(decoding: units[(opener.index + opener.length)..<closer.index], as: UTF16.self)
        )
        if result == nil || match.start < result!.start || (match.start == result!.start && match.end > result!.end) {
          result = match
        }
        for j in (openIndex + 1)..<position { delimiters[j].active = false }
        opener.length -= length
        closer.length -= length
        opener.active = opener.length > 0
        if closer.length > 0 {
          closer.index += length
        } else {
          closer.active = false
          position += 1
        }
        break
      }
      if !found {
        bottoms[key] = position - 1
        if !closer.canOpen { closer.active = false }
        position += 1
      }
    }
    return result
  }

  private struct LinkMatch {
    let start: Int
    let end: Int
    let groups: [String?]
  }

  private static let linkPattern = try! NSRegularExpression(pattern: #"(?:\[(.+?)\])(?:\((?:([^()\s]+)(?:\s"((?:[^"]*\\")*[^"]*)"\s*)?)\))"#)

  private func findLink(in text: String) -> LinkMatch? {
    let ns = text as NSString
    guard let match = Self.linkPattern.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
    let groups = (0..<match.numberOfRanges).map { match.range(at: $0).location == NSNotFound ? nil : ns.substring(with: match.range(at: $0)) }
    return LinkMatch(start: match.range.location, end: match.range.location + match.range.length, groups: groups)
  }

  private func replaceWithLink(_ node: TextNode, _ groups: [String?]) throws -> TextNode? {
    var ancestor = node.getParent()
    while let current = ancestor {
      if current is LinkNode { return nil }
      ancestor = current.getParent()
    }
    guard let linkText = groups[1] else { return nil }
    let open = linkText.filter { $0 == "[" }.count
    let close = linkText.filter { $0 == "]" }.count
    if open < close { return nil }
    var parsed = linkText
    var outside = ""
    if open > close {
      let parts = linkText.components(separatedBy: "[")
      outside = "[" + parts[0]
      parsed = parts.dropFirst().joined(separator: "[")
    }
    let link = LinkNode(url: groups[2].map(unescape) ?? "", key: nil)
    link.title = groups[3].map(unescape)
    let text = createTextNode(text: parsed)
    _ = try text.setFormat(format: node.getFormat())
    try link.append([text])
    _ = try node.replace(replaceWith: link)
    if !outside.isEmpty { _ = try link.insertBefore(nodeToInsert: createTextNode(text: outside)) }
    return text
  }
}

private let escapePattern = try! NSRegularExpression(pattern: #"\\([!-/:-@\[-`{-~])"#)
private let entityPattern = try! NSRegularExpression(pattern: #"&#(\d+);"#)

func unescape(_ value: String) -> String {
  let ns = value as NSString
  var output = escapePattern.stringByReplacingMatches(in: value, range: NSRange(location: 0, length: ns.length), withTemplate: "$1")
  for match in entityPattern.matches(in: output, range: NSRange(location: 0, length: (output as NSString).length)).reversed() {
    let code = (output as NSString).substring(with: match.range(at: 1))
    guard let value = UInt32(code), let scalar = Unicode.Scalar(value) else { continue }
    output = (output as NSString).replacingCharacters(in: match.range, with: String(Character(scalar)))
  }
  return output
}
