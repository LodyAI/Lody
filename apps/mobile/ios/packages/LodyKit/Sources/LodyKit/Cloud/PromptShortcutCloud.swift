import Foundation

// Resource grants go directly to the native-owned runtime.
@MainActor enum PromptShortcutCloud {
  static func call(operation: String, workspace: String, args: [String: Any]) async throws -> Any {
    let kind: String
    switch operation {
    case "listAccessibleDocuments": kind = "query"
    case "getStreamToken": kind = "action"
    case "stageDocument", "activateDocument": kind = "mutation"
    default: throw GitHubCloud.failure()
    }
    var scoped = args
    scoped["workspaceId"] = workspace
    return try await GitHubCloud.call(kind, path: "promptShortcuts:\(operation)", args: scoped)
  }
}
