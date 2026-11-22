import Foundation

struct LodyTokenWidgetValue: Codable, Equatable {
    let tokens: Double
    let label: String

    var isValid: Bool {
        tokens.isFinite && tokens >= 0 && tokens <= 9_007_199_254_740_991 &&
        !label.isEmpty && label.count <= 32 &&
        label.rangeOfCharacter(from: .controlCharacters) == nil
    }
}

struct LodyTokenWidgetSummary: Codable, Equatable {
    enum Period: String, Codable { case utcDay, window }
    struct Model: Codable, Equatable {
        let name: String
        let value: LodyTokenWidgetValue
        var isValid: Bool {
            !name.isEmpty && name.count <= 64 &&
            name.rangeOfCharacter(from: .controlCharacters) == nil && value.isValid
        }
    }
    struct Breakdown: Codable, Equatable {
        let input: LodyTokenWidgetValue
        let output: LodyTokenWidgetValue
        let cacheRead: LodyTokenWidgetValue
        var isValid: Bool { input.isValid && output.isValid && cacheRead.isValid }
    }
    struct Bucket: Codable, Equatable {
        let startMs: Double
        let tokens: Double
    }
    let userId: String
    let workspaceId: String
    let workspaceName: String
    let locale: String
    let period: Period
    let startMs: Double
    let endMs: Double
    let total: LodyTokenWidgetValue
    let models: [Model]
    let breakdown: Breakdown?
    let buckets: [Bucket]

    var isValid: Bool {
        guard !userId.isEmpty, !workspaceId.isEmpty, !workspaceName.isEmpty,
              !locale.isEmpty, locale.count <= 32,
              startMs.isFinite, startMs >= 0, startMs.rounded() == startMs,
              endMs.isFinite, endMs >= startMs, endMs.rounded() == endMs,
              endMs <= 9_007_199_254_740_991, endMs - startMs <= 25 * 3_600_000,
              total.isValid, models.count <= 2, models.allSatisfy(\.isValid),
              breakdown?.isValid != false, buckets.count <= 25 else { return false }
        let dayStart = floor(endMs / 86_400_000) * 86_400_000
        guard (period == .utcDay) == (startMs == dayStart) else { return false }
        let lastBucket = period == .utcDay ? dayStart + 23 * 3_600_000 : endMs
        var previous = -Double.infinity
        for bucket in buckets {
            guard bucket.startMs.isFinite, bucket.startMs.rounded() == bucket.startMs,
                  bucket.startMs >= floor(startMs / 3_600_000) * 3_600_000,
                  bucket.startMs <= lastBucket, bucket.startMs > previous,
                  bucket.tokens.isFinite, bucket.tokens >= 0,
                  bucket.startMs <= endMs || bucket.tokens == 0,
                  bucket.tokens <= 9_007_199_254_740_991 else { return false }
            previous = bucket.startMs
        }
        return true
    }
}

struct LodyTokenWidgetSnapshot: Codable, Equatable {
    let version: Int
    let summary: LodyTokenWidgetSummary
    let updatedAt: Date

    static let freshnessInterval: TimeInterval = 15 * 60

    func isFresh(at now: Date) -> Bool {
        // A foreground write cannot make an old server window fresh again.
        now >= updatedAt && now.timeIntervalSince1970 * 1000 <
            summary.endMs + Self.freshnessInterval * 1000
    }
}

enum LodyTokenUsageWidgetStore {
    static let kind = "LodyTokenUsage"
    static let snapshotKey = "LodyTokenUsageWidget.v1"

    static func load(from defaults: UserDefaults, now: Date = Date()) -> LodyTokenWidgetSnapshot? {
        guard let data = defaults.data(forKey: snapshotKey),
              let snapshot = try? JSONDecoder().decode(LodyTokenWidgetSnapshot.self, from: data),
              snapshot.version == 1, snapshot.summary.isValid,
              snapshot.updatedAt.timeIntervalSince1970.isFinite, snapshot.updatedAt <= now,
              snapshot.summary.endMs <= now.timeIntervalSince1970 * 1000 + 60_000 else { return nil }
        return snapshot
    }

    static func save(_ summary: LodyTokenWidgetSummary, to defaults: UserDefaults, now: Date = Date()) throws {
        guard summary.isValid, summary.endMs <= now.timeIntervalSince1970 * 1000 + 60_000 else {
            throw CocoaError(.coderInvalidValue)
        }
        let snapshot = LodyTokenWidgetSnapshot(version: 1, summary: summary, updatedAt: now)
        defaults.set(try JSONEncoder().encode(snapshot), forKey: snapshotKey)
    }

    @discardableResult
    static func clear(from defaults: UserDefaults) -> Bool {
        let hadSnapshot = defaults.object(forKey: snapshotKey) != nil
        defaults.removeObject(forKey: snapshotKey)
        return hadSnapshot
    }
}
