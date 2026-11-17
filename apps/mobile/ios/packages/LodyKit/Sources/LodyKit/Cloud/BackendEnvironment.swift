import Foundation

/// Build-owned endpoints. No deep link, preference or remote response can override these.
enum BackendEnvironment {
  private static let values = Bundle.main.object(forInfoDictionaryKey: "LodyBackends") as? [String: String] ?? [:]
  static let convex = values["CONVEX_URL"] ?? "https://convex.lody.ai"
  static let site = values["CONVEX_SITE_URL"] ?? "https://backend.lody.ai"
  static let worker = values["CF_WORKER_URL"] ?? "https://api.lody.ai"
  static let storageSuffix = values["STORAGE_SUFFIX"] ?? ""
}
