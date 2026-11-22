import Foundation

@main
enum HomeWidgetStoreTests {
    static func main() throws {
        let suite = "ai.lody.tests.home-widget.\(ProcessInfo.processInfo.processIdentifier)"
        guard let defaults = UserDefaults(suiteName: suite),
              let reader = UserDefaults(suiteName: suite) else {
            fatalError("Cannot create isolated test preferences")
        }
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func item(
            _ id: String = "synthetic-session", title: String = "Fix session sync",
            status: LodyHomeWidgetConversation.Status = .waiting, updatedAt: Double = 1_799_999_880_000
        ) -> LodyHomeWidgetConversation {
            .init(
                id: id, title: title, status: status, agentLogoKind: "codex", agentLogoText: "CX",
                agentName: "Codex", updatedAt: updatedAt
            )
        }
        func summary(_ items: [LodyHomeWidgetConversation]) -> LodyHomeWidgetSummary {
            .init(
                userId: "synthetic-user", workspaceId: "synthetic-workspace", workspaceName: "Example",
                items: items
            )
        }
        let conversations = summary([
            item("waiting"), item("running", status: .running), item("unread", status: .unread),
        ])

        precondition(LodyHomeWidgetStore.load(from: reader, now: now) == nil)
        defaults.set(Data("legacy".utf8), forKey: "LodyHomeWidgetSummary.v1")
        try LodyHomeWidgetStore.save(conversations, to: defaults, now: now)
        precondition(defaults.object(forKey: "LodyHomeWidgetSummary.v1") == nil)
        let snapshot = LodyHomeWidgetStore.load(from: reader, now: now)!
        precondition(snapshot.summary == conversations)
        precondition(snapshot.updatedAt == now)
        precondition(snapshot.isFresh(at: now.addingTimeInterval(899)))
        precondition(!snapshot.isFresh(at: now.addingTimeInterval(900)))
        precondition(!snapshot.isFresh(at: now.addingTimeInterval(-1)))

        let ownedScope = LodyHomeWidgetScope(userId: "synthetic-user", workspaceId: "synthetic-workspace")
        let conversationBytes = defaults.data(forKey: LodyHomeWidgetStore.snapshotKey)!
        precondition(LodyHomeWidgetStore.retainIfOwned(ownedScope, from: defaults, now: now.addingTimeInterval(900)))
        precondition(defaults.data(forKey: LodyHomeWidgetStore.snapshotKey) == conversationBytes)
        precondition(LodyHomeWidgetStore.load(from: reader, now: now.addingTimeInterval(900))?.isFresh(at: now.addingTimeInterval(900)) == false)
        for scope in [
            LodyHomeWidgetScope(userId: "another-user", workspaceId: "synthetic-workspace"),
            LodyHomeWidgetScope(userId: "synthetic-user", workspaceId: "another-workspace"),
        ] {
            precondition(!LodyHomeWidgetStore.retainIfOwned(scope, from: defaults, now: now))
            precondition(LodyHomeWidgetStore.load(from: reader, now: now) == nil)
            try LodyHomeWidgetStore.save(conversations, to: defaults, now: now)
        }

        // A ready workspace with no relevant conversations is valid, not signed out.
        try LodyHomeWidgetStore.save(summary([]), to: defaults, now: now)
        precondition(LodyHomeWidgetStore.load(from: reader, now: now)?.summary.items.isEmpty == true)

        defaults.set("preserved", forKey: "unrelated-native-preference")
        precondition(LodyHomeWidgetStore.clear(from: defaults))
        precondition(LodyHomeWidgetStore.load(from: reader, now: now) == nil)
        precondition(defaults.string(forKey: "unrelated-native-preference") == "preserved")
        precondition(!LodyHomeWidgetStore.clear(from: defaults))
        defaults.set(Data("legacy".utf8), forKey: "LodyHomeWidgetSummary.v1")
        precondition(LodyHomeWidgetStore.clear(from: defaults))
        precondition(defaults.object(forKey: "LodyHomeWidgetSummary.v1") == nil)

        defaults.set(Data("broken".utf8), forKey: LodyHomeWidgetStore.snapshotKey)
        precondition(!LodyHomeWidgetStore.retainIfOwned(ownedScope, from: defaults, now: now))
        precondition(LodyHomeWidgetStore.load(from: reader, now: now) == nil)
        for invalid in [
            LodyHomeWidgetSnapshot(version: 1, summary: conversations, updatedAt: now),
            LodyHomeWidgetSnapshot(version: 2, summary: conversations, updatedAt: now.addingTimeInterval(1)),
            LodyHomeWidgetSnapshot(version: 2, summary: summary([item("duplicate"), item("duplicate")]), updatedAt: now),
            LodyHomeWidgetSnapshot(version: 2, summary: summary((0..<4).map { item("session-\($0)") }), updatedAt: now),
            LodyHomeWidgetSnapshot(version: 2, summary: summary([item(title: String(repeating: "x", count: 97))]), updatedAt: now),
            LodyHomeWidgetSnapshot(version: 2, summary: summary([item(updatedAt: -1)]), updatedAt: now),
        ] {
            defaults.set(try JSONEncoder().encode(invalid), forKey: LodyHomeWidgetStore.snapshotKey)
            precondition(LodyHomeWidgetStore.load(from: reader, now: now) == nil)
        }
        do {
            try LodyHomeWidgetStore.save(summary([item(title: String(repeating: "x", count: 97))]), to: defaults, now: now)
            fatalError("Malformed data was saved")
        } catch CocoaError.coderInvalidValue {}

        // Decode the JS bridge's numeric timestamp and persist only typed fields.
        var raw = try JSONSerialization.jsonObject(with: JSONEncoder().encode(conversations)) as! [String: Any]
        raw["authToken"] = "synthetic-secret"
        var rawItems = raw["items"] as! [[String: Any]]
        rawItems[0]["permissionCommand"] = "synthetic-private-command"
        raw["items"] = rawItems
        let decoded = try JSONDecoder().decode(LodyHomeWidgetSummary.self, from: JSONSerialization.data(withJSONObject: raw))
        precondition(decoded == conversations)
        try LodyHomeWidgetStore.save(decoded, to: defaults, now: now)
        let saved = String(data: defaults.data(forKey: LodyHomeWidgetStore.snapshotKey)!, encoding: .utf8)!
        precondition(!saved.contains("synthetic-secret") && !saved.contains("synthetic-private-command"))
        rawItems[0]["status"] = "unknown"
        raw["items"] = rawItems
        let malformed = try JSONSerialization.data(withJSONObject: raw)
        precondition((try? JSONDecoder().decode(LodyHomeWidgetSummary.self, from: malformed)) == nil)
        try verifyTokenStore(defaults: defaults, reader: reader, now: now)
        try verifyQuotaStore(defaults: defaults, reader: reader, now: now)
        print("Home Widget conversation store behavior verified")
    }

    static func verifyQuotaStore(defaults: UserDefaults, reader: UserDefaults, now: Date) throws {
        let windows: [LodyProviderQuotaSummary.Window] = [
            .init(label: "5h · Standard", remainingPercent: 0, resetsAt: now.addingTimeInterval(60).timeIntervalSince1970),
            .init(label: "5h · Fable", remainingPercent: 100, resetsAt: nil),
        ]
        func summary(name: String = "Codex") -> LodyProviderQuotaSummary {
            .init(userId: "synthetic-user", workspaceId: "synthetic-workspace", workspaceName: "Example", locale: "zh_CN", providers: [
                .init(id: "synthetic-provider", name: name, machineName: "Synthetic Mac", logoKind: "codex", logoText: "CX", online: true, windows: windows, additionalWindows: 1),
            ])
        }
        try LodyProviderQuotaWidgetStore.save(summary(), to: defaults, now: now)
        let snapshot = LodyProviderQuotaWidgetStore.load(from: reader, now: now)!
        precondition(snapshot.summary == summary())
        let quotaBytes = defaults.data(forKey: LodyProviderQuotaWidgetStore.snapshotKey)!
        let ownedScope = LodyHomeWidgetScope(userId: "synthetic-user", workspaceId: "synthetic-workspace")
        precondition(LodyProviderQuotaWidgetStore.retainIfOwned(ownedScope, from: defaults, now: now.addingTimeInterval(900)))
        precondition(defaults.data(forKey: LodyProviderQuotaWidgetStore.snapshotKey) == quotaBytes)
        for scope in [
            LodyHomeWidgetScope(userId: "another-user", workspaceId: "synthetic-workspace"),
            LodyHomeWidgetScope(userId: "synthetic-user", workspaceId: "another-workspace"),
        ] {
            precondition(!LodyProviderQuotaWidgetStore.retainIfOwned(scope, from: defaults, now: now))
            precondition(LodyProviderQuotaWidgetStore.load(from: reader, now: now) == nil)
            try LodyProviderQuotaWidgetStore.save(summary(), to: defaults, now: now)
        }
        precondition(snapshot.isFresh(at: now.addingTimeInterval(899)))
        precondition(!snapshot.isFresh(at: now.addingTimeInterval(900)))
        precondition(!snapshot.summary.providers[0].windows[0].needsRefresh(at: now.addingTimeInterval(59)))
        precondition(snapshot.summary.providers[0].windows[0].needsRefresh(at: now.addingTimeInterval(60)))
        // A valid typed object with a huge ignored field still must be rejected before decoding.
        var oversized = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as! [String: Any]
        oversized["padding"] = String(repeating: "x", count: LodyProviderQuotaWidgetStore.maximumBytes)
        defaults.set(try JSONSerialization.data(withJSONObject: oversized), forKey: LodyProviderQuotaWidgetStore.snapshotKey)
        precondition(LodyProviderQuotaWidgetStore.load(from: reader, now: now) == nil)
        // Swift Character counts do not bound UTF-8 storage.
        do {
            try LodyProviderQuotaWidgetStore.save(summary(name: "a" + String(repeating: "\u{301}", count: 100_000)), to: defaults, now: now)
            fatalError("Oversized UTF-8 text was saved")
        } catch CocoaError.coderInvalidValue {}
        try LodyProviderQuotaWidgetStore.save(summary(), to: defaults, now: now)
        let untouched = Data("preserved-widget-data".utf8)
        defaults.set(untouched, forKey: LodyTokenUsageWidgetStore.snapshotKey)
        precondition(LodyProviderQuotaWidgetStore.clear(from: defaults))
        precondition(defaults.data(forKey: LodyTokenUsageWidgetStore.snapshotKey) == untouched)
        try LodyProviderQuotaWidgetStore.save(summary(), to: defaults, now: now)
        precondition(LodyHomeWidgetStore.clearAll(from: defaults))
        precondition(defaults.object(forKey: LodyProviderQuotaWidgetStore.snapshotKey) == nil)
        precondition(defaults.object(forKey: LodyTokenUsageWidgetStore.snapshotKey) == nil)
        precondition(defaults.string(forKey: "unrelated-native-preference") == "preserved")
        precondition(!LodyHomeWidgetStore.clearAll(from: defaults))
        print("Provider quota Widget store behavior verified")
    }

    static func verifyTokenStore(defaults: UserDefaults, reader: UserDefaults, now: Date) throws {
        let end = now.timeIntervalSince1970 * 1000
        let start = floor(end / 86_400_000) * 86_400_000
        func summary(
            endMs: Double = end, total: Double = 3_000_000,
            label: String = "3M", modelName: String = "model-a", futureTokens: Double = 0
        ) -> LodyTokenWidgetSummary {
            .init(
                userId: "synthetic-user", workspaceId: "synthetic-workspace", workspaceName: "Example",
                locale: "en", period: .utcDay, startMs: start, endMs: endMs,
                total: .init(tokens: total, label: label),
                models: [.init(name: modelName, value: .init(tokens: total, label: label))],
                breakdown: nil,
                buckets: (0..<24).map { index in
                    let date = start + Double(index) * 3_600_000
                    return .init(startMs: date, tokens: date > endMs ? futureTokens : 0)
                }
            )
        }
        precondition(LodyTokenUsageWidgetStore.load(from: reader, now: now) == nil)
        let data = summary()
        try LodyTokenUsageWidgetStore.save(data, to: defaults, now: now)
        let snapshot = LodyTokenUsageWidgetStore.load(from: reader, now: now)!
        precondition(snapshot.summary == data)
        precondition(snapshot.isFresh(at: now.addingTimeInterval(899)))
        precondition(!snapshot.isFresh(at: now.addingTimeInterval(900)))

        // A rewrite of the same server period does not renew source freshness.
        try LodyTokenUsageWidgetStore.save(data, to: defaults, now: now.addingTimeInterval(901))
        precondition(LodyTokenUsageWidgetStore.load(from: reader, now: now.addingTimeInterval(901))?.isFresh(at: now.addingTimeInterval(901)) == false)
        try LodyTokenUsageWidgetStore.save(summary(total: 0, label: "0"), to: defaults, now: now)
        precondition(LodyTokenUsageWidgetStore.load(from: reader, now: now)?.summary.total.tokens == 0)
        precondition(LodyTokenUsageWidgetStore.load(from: reader, now: now)?.summary.breakdown == nil)

        let conversationData = defaults.data(forKey: LodyHomeWidgetStore.snapshotKey)
        precondition(LodyTokenUsageWidgetStore.clear(from: defaults))
        precondition(defaults.data(forKey: LodyHomeWidgetStore.snapshotKey) == conversationData)
        precondition(defaults.string(forKey: "unrelated-native-preference") == "preserved")
        precondition(!LodyTokenUsageWidgetStore.clear(from: defaults))
        for invalid in [summary(total: -1), summary(label: "bad\nlabel"), summary(modelName: String(repeating: "x", count: 65)), summary(futureTokens: 1)] {
            defaults.set(try JSONEncoder().encode(LodyTokenWidgetSnapshot(version: 1, summary: invalid, updatedAt: now)), forKey: LodyTokenUsageWidgetStore.snapshotKey)
            precondition(LodyTokenUsageWidgetStore.load(from: reader, now: now) == nil)
        }
        let unknown = LodyTokenWidgetSnapshot(version: 2, summary: data, updatedAt: now)
        defaults.set(try JSONEncoder().encode(unknown), forKey: LodyTokenUsageWidgetStore.snapshotKey)
        precondition(LodyTokenUsageWidgetStore.load(from: reader, now: now) == nil)
        do {
            try LodyTokenUsageWidgetStore.save(summary(endMs: end + 60_001), to: defaults, now: now)
            fatalError("Future Token window was saved")
        } catch CocoaError.coderInvalidValue {}
        try LodyTokenUsageWidgetStore.save(data, to: defaults, now: now)
        defaults.set(Data("legacy".utf8), forKey: "LodyHomeWidgetSummary.v1")
        precondition(defaults.data(forKey: LodyHomeWidgetStore.snapshotKey) != nil)
        precondition(LodyHomeWidgetStore.clearAll(from: defaults))
        precondition(LodyHomeWidgetStore.load(from: reader, now: now) == nil)
        precondition(LodyTokenUsageWidgetStore.load(from: reader, now: now) == nil)
        precondition(defaults.object(forKey: "LodyHomeWidgetSummary.v1") == nil)
        precondition(defaults.string(forKey: "unrelated-native-preference") == "preserved")
        precondition(!LodyHomeWidgetStore.clearAll(from: defaults))
        print("Token Widget store behavior verified")
    }
}
