import Foundation

struct LodyProviderQuotaSummary: Codable, Equatable {
    struct Window: Codable, Equatable {
        let label: String
        let remainingPercent: Double
        let resetsAt: Double?
        var isValid: Bool {
            validText(label, bytes: 256) && remainingPercent.isFinite &&
            (0...100).contains(remainingPercent) &&
            (resetsAt == nil || (resetsAt!.isFinite && resetsAt! > 0 && resetsAt! < 8_640_000_000_000))
        }
        func needsRefresh(at date: Date) -> Bool {
            resetsAt.map { date.timeIntervalSince1970 >= $0 } ?? false
        }
    }
    struct Provider: Codable, Equatable {
        let id: String
        let name: String
        let machineName: String
        let logoKind: String
        let logoText: String
        let online: Bool
        let windows: [Window]
        let additionalWindows: Int
        var isValid: Bool {
            validText(id, bytes: 1024) && validText(name, bytes: 192) &&
            validText(machineName, bytes: 192) &&
            ["codex", "claude", "kimi", "deepseek", "minimax", "mimo", "glm", "agent"].contains(logoKind) &&
            validText(logoText, bytes: 16) && !windows.isEmpty && windows.count <= 2 &&
            windows.allSatisfy(\.isValid) && (0...999).contains(additionalWindows)
        }
    }
    let userId: String
    let workspaceId: String
    let workspaceName: String
    let locale: String
    let providers: [Provider]

    var isValid: Bool {
        validText(userId, bytes: 256) && validText(workspaceId, bytes: 256) &&
        validText(workspaceName, bytes: 320) && validText(locale, bytes: 64) &&
        providers.count <= 3 && providers.allSatisfy(\.isValid) &&
        Set(providers.map(\.id)).count == providers.count
    }
}

private func validText(_ value: String, bytes: Int) -> Bool {
    !value.isEmpty && value.utf8.count <= bytes &&
    value.rangeOfCharacter(from: .controlCharacters) == nil
}

struct LodyProviderQuotaSnapshot: Codable, Equatable {
    let version: Int
    let summary: LodyProviderQuotaSummary
    let updatedAt: Date
    static let freshnessInterval: TimeInterval = 15 * 60
    func isFresh(at now: Date) -> Bool {
        now >= updatedAt && now.timeIntervalSince(updatedAt) < Self.freshnessInterval
    }
}

enum LodyProviderQuotaWidgetStore {
    static let kind = "LodyProviderQuota"
    static let snapshotKey = "LodyProviderQuotaWidget.v1"
    static let maximumBytes = 32 * 1024

    static func retainIfOwned(_ scope: LodyHomeWidgetScope, from defaults: UserDefaults, now: Date = Date()) -> Bool {
        if let snapshot = load(from: defaults, now: now),
           scope.contains(userId: snapshot.summary.userId, workspaceId: snapshot.summary.workspaceId) { return true }
        clear(from: defaults)
        return false
    }

    static func load(from defaults: UserDefaults, now: Date = Date()) -> LodyProviderQuotaSnapshot? {
        guard let data = defaults.data(forKey: snapshotKey), data.count <= maximumBytes,
              let snapshot = try? JSONDecoder().decode(LodyProviderQuotaSnapshot.self, from: data),
              snapshot.version == 1, snapshot.summary.isValid,
              snapshot.updatedAt.timeIntervalSince1970.isFinite, snapshot.updatedAt <= now else { return nil }
        return snapshot
    }

    static func save(_ summary: LodyProviderQuotaSummary, to defaults: UserDefaults, now: Date = Date()) throws {
        guard summary.isValid else { throw CocoaError(.coderInvalidValue) }
        let snapshot = LodyProviderQuotaSnapshot(version: 1, summary: summary, updatedAt: now)
        let data = try JSONEncoder().encode(snapshot)
        guard data.count <= maximumBytes else { throw CocoaError(.coderInvalidValue) }
        defaults.set(data, forKey: snapshotKey)
    }

    @discardableResult
    static func clear(from defaults: UserDefaults) -> Bool {
        let present = defaults.object(forKey: snapshotKey) != nil
        defaults.removeObject(forKey: snapshotKey)
        return present
    }
}
