import Foundation

enum HTMLPreviewResource {
  static let scheme = "lody-preview"
  static let filePrefix = "/__lody_files/"

  static func url(path: String, host: String) -> URL {
    var components = URLComponents()
    components.scheme = scheme
    components.host = host
    components.path = filePrefix + path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    return components.url!
  }

  static func path(_ url: URL, documentPath: String) -> String {
    let path = String(url.path.dropFirst(filePrefix.count))
    return documentPath.hasPrefix("/") ? "/" + path : path
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
