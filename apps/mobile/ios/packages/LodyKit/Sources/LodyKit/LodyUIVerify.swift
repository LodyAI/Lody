import LodyCore
import Foundation

/// Launch-argument fixtures. Available in Debug and Release; only `--ui-verify`
/// (or `--lody-offline`) turns them on. TestFlight never passes those arguments.
enum LodyUIVerify {
  static var enabled: Bool { has("--ui-verify") }
  static var offline: Bool { enabled || has("--lody-offline") }
  static var home: Bool { enabled && has("--ui-verify-home") }
  static var mentions: Bool { enabled && has("--ui-verify-mentions") }
  static var throwProbe: Bool { enabled && has("--ui-verify-throw") }
  static var scroll: Bool {
    enabled && (has("--ui-verify-scroll") || has("--ui-verify-opening"))
  }

  static func has(_ flag: String) -> Bool {
    ProcessInfo.processInfo.arguments.contains(flag)
  }
}

extension LodyUIVerify {
  static func branches(repo: String, page: Int, attempt: Int) async throws -> CreateBranches {
    try await Task.sleep(for: .milliseconds(450))
    if repo == "Owner/Repo2", attempt == 1 { throw CocoaError(.fileReadUnknown) }
    if repo == "Owner/Repo3" { return CreateBranches(names: []) }
    if page > 1 {
      return CreateBranches(names: ["feature/search-across-pages", "feature/a-long-branch-name-that-wraps-without-hiding-the-important-part"])
    }
    let branch = repo == "Owner/Repo2" ? "trunk" : "main"
    return CreateBranches(names: [branch, "develop", "fix/session-restore"], defaultBranch: branch, nextPage: 2)
  }
}
