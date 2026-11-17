import Foundation

enum HTMLPreviewResource {
  static let scheme = "lody-preview"
  static let filePrefix = "/__lody_files/"
  /// Absolute paths on the session's computer, from rewritten `file://` URLs.
  static let absolutePrefix = "/__lody_fs/"

  static func url(path: String, host: String) -> URL {
    var components = URLComponents()
    components.scheme = scheme
    components.host = host
    components.path = filePrefix + path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    return components.url!
  }

  /// The computer path a preview URL names. A website-root path resolves like a
  /// browser opening the document from disk, so only a document opened by an
  /// absolute path can resolve it; otherwise this returns nil.
  static func path(_ url: URL, documentPath: String) -> String? {
    let value = url.path
    if value.hasPrefix(absolutePrefix) {
      let path = String(value.dropFirst(absolutePrefix.count))
      return windowsDrive(path) != nil ? path : "/" + path
    }
    if value.hasPrefix(filePrefix) {
      let path = String(value.dropFirst(filePrefix.count))
      return documentPath.hasPrefix("/") ? "/" + path : path
    }
    if documentPath.hasPrefix("/") { return value }
    if let drive = windowsDrive(documentPath) { return drive + value }
    return nil
  }

  /// Authored `file://` URLs name files on the session's computer. Route them through
  /// the preview so the computer's file-preview policy decides what is readable.
  static func rewriteFileURLs(_ data: Data, host: String) -> Data {
    guard let text = String(data: data, encoding: .utf8), text.range(of: "file:", options: .caseInsensitive) != nil else { return data }
    let replaced = text.replacingOccurrences(
      of: #"(?i)file://(?:localhost)?/"#, with: scheme + "://" + host + absolutePrefix, options: .regularExpression
    )
    return Data(replaced.utf8)
  }

  private static func windowsDrive(_ path: String) -> String? {
    path.range(of: #"^[A-Za-z]:/"#, options: .regularExpression) == nil ? nil : String(path.prefix(2))
  }

  static func safeReference(_ value: String) -> String {
    guard var components = URLComponents(string: value) else {
      return String(value.prefix(2048))
    }
    components.user = nil
    components.password = nil
    components.query = nil
    components.fragment = nil
    return String((components.string ?? value).prefix(2048))
  }

  static func code(_ url: URL) -> String {
    if url.isFileURL { return "local_file_unavailable" }
    let host = (url.host ?? "").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host.hasPrefix("127.") {
      return "local_service_unavailable"
    }
    return "resource_failed"
  }
}
