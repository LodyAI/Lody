import Foundation

struct LodyHomeWidgetScope: Codable, Equatable {
    let userId: String
    let workspaceId: String
    var isValid: Bool { !userId.isEmpty && !workspaceId.isEmpty }
    func contains(userId: String, workspaceId: String) -> Bool {
        self.userId == userId && self.workspaceId == workspaceId
    }
}

struct LodyHomeWidgetConversation: Codable, Equatable {
    enum Status: String, Codable {
        case waiting
        case running
        case unread
    }

    let id: String
    let title: String
    let status: Status
    let agentLogoKind: String
    let agentLogoText: String
    let agentName: String
    let updatedAt: Double

    var isValid: Bool {
        !id.isEmpty && id.count <= 256 && title.count <= 96 &&
        ["codex", "claude", "deepseek", "mimo", "minimax", "glm", "agent"].contains(agentLogoKind) &&
        agentLogoText.count <= 3 && !agentName.isEmpty && agentName.count <= 48 &&
        updatedAt.isFinite && updatedAt >= 0 && updatedAt <= 8_640_000_000_000_000
    }
}

struct LodyHomeWidgetSummary: Codable, Equatable {
    let userId: String
    let workspaceId: String
    let workspaceName: String
    let items: [LodyHomeWidgetConversation]

    var isValid: Bool {
        !userId.isEmpty && !workspaceId.isEmpty && !workspaceName.isEmpty &&
        items.count <= 3 && items.allSatisfy(\.isValid) &&
        Set(items.map(\.id)).count == items.count
    }
}

struct LodyHomeWidgetSnapshot: Codable, Equatable {
    let version: Int
    let summary: LodyHomeWidgetSummary
    let updatedAt: Date

    static let freshnessInterval: TimeInterval = 15 * 60

    func isFresh(at now: Date) -> Bool {
        now >= updatedAt && now.timeIntervalSince(updatedAt) < Self.freshnessInterval
    }
}

// Shared by the containing app and its existing WidgetKit extension. This
// Only bounded session identity/title, agent and status metadata crosses this
// local boundary. Never persist transcripts, prompts, commands or credentials.
enum LodyHomeWidgetStore {
    static let kind = "LodyConversationSummary"
    static let appGroupIdentifier = "group.ai.lody.mobile.onesignal"
    static let snapshotKey = "LodyHomeWidgetSummary.v2"
    private static let legacySnapshotKey = "LodyHomeWidgetSummary.v1"

    static func defaults() -> UserDefaults? {
        UserDefaults(suiteName: appGroupIdentifier)
    }

    static func retainIfOwned(_ scope: LodyHomeWidgetScope, from defaults: UserDefaults, now: Date = Date()) -> Bool {
        if let snapshot = load(from: defaults, now: now),
           scope.contains(userId: snapshot.summary.userId, workspaceId: snapshot.summary.workspaceId) { return true }
        clear(from: defaults)
        return false
    }

    static func load(from defaults: UserDefaults, now: Date = Date()) -> LodyHomeWidgetSnapshot? {
        guard let data = defaults.data(forKey: snapshotKey),
              let snapshot = try? JSONDecoder().decode(LodyHomeWidgetSnapshot.self, from: data),
              snapshot.version == 2,
              snapshot.summary.isValid,
              snapshot.updatedAt.timeIntervalSince1970.isFinite,
              snapshot.updatedAt <= now else {
            return nil
        }
        return snapshot
    }

    static func save(
        _ summary: LodyHomeWidgetSummary,
        to defaults: UserDefaults,
        now: Date = Date()
    ) throws {
        guard summary.isValid else {
            throw CocoaError(.coderInvalidValue)
        }
        let snapshot = LodyHomeWidgetSnapshot(version: 2, summary: summary, updatedAt: now)
        let data = try JSONEncoder().encode(snapshot)
        defaults.set(data, forKey: snapshotKey)
        defaults.removeObject(forKey: legacySnapshotKey)
    }

    @discardableResult
    static func clear(from defaults: UserDefaults) -> Bool {
        let hadSnapshot = defaults.object(forKey: snapshotKey) != nil ||
            defaults.object(forKey: legacySnapshotKey) != nil
        defaults.removeObject(forKey: snapshotKey)
        defaults.removeObject(forKey: legacySnapshotKey)
        return hadSnapshot
    }

    @discardableResult
    static func clearAll(from defaults: UserDefaults) -> Bool {
        let hadConversations = clear(from: defaults)
        let hadTokens = LodyTokenUsageWidgetStore.clear(from: defaults)
        let hadQuota = LodyProviderQuotaWidgetStore.clear(from: defaults)
        return hadConversations || hadTokens || hadQuota
    }
}
