import Foundation

struct ChatFileLink {
  let path: String
  let line: Int?

  init?(_ href: String) {
    var value = href.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\\", with: "/")
    // `file:///Users/a/report.html` and `file:///C:/a/report.html` name a file on the session's computer.
    if let range = value.range(of: #"^file://(?:localhost)?/"#, options: [.regularExpression, .caseInsensitive]) {
      let rest = String(value[range.upperBound...])
      value = rest.range(of: #"^[A-Za-z]:/"#, options: .regularExpression) != nil ? rest : "/" + rest
    }
    let suffix = #"(?:#L([1-9][0-9]*)(?:C[0-9]+)?(?:-L?[0-9]+(?:C[0-9]+)?)?|:L([1-9][0-9]*)(?:C[0-9]+)?|:([1-9][0-9]*)(?::[0-9]+)?)$"#
    var start: Int?
    if let range = value.range(of: suffix, options: .regularExpression) {
      start = Int(value[range].drop(while: { !$0.isNumber }).prefix(while: \.isNumber))
      value.removeSubrange(range)
    }
    let windows = value.range(of: #"^[A-Za-z]:/"#, options: .regularExpression) != nil
    guard !value.isEmpty, !value.hasPrefix("#"), !value.hasPrefix("//"),
      windows || value.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) == nil else { return nil }
    guard !value.contains("?"), !value.contains("#"),
      value.contains("/") || !(value as NSString).pathExtension.isEmpty else { return nil }
    value = value.removingPercentEncoding ?? value
    guard !value.contains("\0"), value.utf8.count <= 32768 else { return nil }
    path = value
    line = start
  }

  private static let bareDomainTLDs: Set<String> = ["com", "org", "net", "io", "dev", "app", "co", "ai", "gov", "edu", "info"]

  /// Web `matchWholeFilePath` for inline code, narrowed to Markdown, the only type the native
  /// preview opens: the whole span must be one file path. Native clients have no session file
  /// index to confirm relative paths, so a missing file shows the preview's not-found state.
  static func markdownCode(_ code: String) -> String? {
    let value = code.trimmingCharacters(in: .whitespaces)
    guard !value.isEmpty, value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
      let link = ChatFileLink(value), iconName(for: link.path) == "markdown" else { return nil }
    // `example.com/readme.md` is an unschemed URL, not a file.
    let first = link.path.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
    if link.path.contains("/"), first.contains("."), let tld = first.split(separator: ".").last,
      bareDomainTLDs.contains(tld.lowercased()) { return nil }
    return value
  }

  static func iconName(for path: String) -> String {
    let name = (path as NSString).lastPathComponent.lowercased()
    if name == "dockerfile" { return "docker" }
    if name == "package.json" { return "nodejs" }
    if name.hasPrefix(".git") { return "git" }
    switch (name as NSString).pathExtension {
    case "md", "markdown", "mdx": return "markdown"
    case "png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "ico": return "image"
    case "pdf": return "pdf"
    case "mp4", "mov", "m4v", "webm": return "video"
    case "mp3", "wav", "m4a", "aac", "flac": return "audio"
    case "zip", "gz", "tar", "7z", "rar": return "zip"
    case "swift": return "swift"
    case "ts", "mts", "cts": return "typescript"
    case "tsx": return "react_ts"
    case "js", "mjs", "cjs": return "javascript"
    case "jsx": return "react"
    case "json", "jsonc": return "json"
    case "py": return "python"
    case "html", "htm": return "html"
    case "css": return "css"
    case "scss", "sass": return "sass"
    case "yml", "yaml": return "yaml"
    case "rs": return "rust"
    case "go": return "go"
    case "java": return "java"
    case "c", "h": return "c"
    case "cpp", "hpp", "cc": return "cpp"
    case "sh", "bash", "zsh": return "console"
    case "doc", "docx": return "word"
    case "ppt", "pptx": return "powerpoint"
    case "xls", "xlsx", "csv": return "table"
    case "txt", "rtf", "log": return "document"
    default: return "file"
    }
  }
}
