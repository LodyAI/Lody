import Foundation

/// Only the small plan projection enters the bundled data runtime. The Better
/// Auth credential and short-lived Convex JWT remain in native memory.
@MainActor final class WorkspaceBilling {
  private var cached: (workspace: String, user: String, expiresAt: TimeInterval, value: [String: Any])?

  func clear() { cached = nil }

  func entitlement(workspace: String, user: String) async -> [String: Any]? {
    if let cached, cached.workspace == workspace, cached.user == user,
       cached.expiresAt > Date.timeIntervalSinceReferenceDate {
      return cached.value
    }
    do {
      guard let value = try await GitHubCloud.call(
        "query", path: "billing:getWorkspaceBillingEntitlement",
        args: ["workspaceId": workspace]
      ) as? [String: Any],
        let tier = value["effectivePlanTier"] as? String,
        ["free", "plus", "enterprise"].contains(tier),
        let pending = value["checkoutPending"] as? Bool else { return nil }
      let projection: [String: Any] = ["effectivePlanTier": tier, "checkoutPending": pending]
      cached = (workspace, user, Date.timeIntervalSinceReferenceDate + 60, projection)
      return projection
    } catch {
      // An unavailable entitlement fails open, matching the other clients.
      return nil
    }
  }
}
