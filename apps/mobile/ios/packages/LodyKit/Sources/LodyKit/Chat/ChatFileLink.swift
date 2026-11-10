import Foundation

struct ChatFileLink {
  let path: String
  let line: Int?

  init?(_ href: String) {
    var value = href.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\\", with: "/")
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
