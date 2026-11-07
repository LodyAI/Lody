import Foundation

enum UsageRange: String, Codable, CaseIterable, Sendable {
  case day, week, month, total
}

enum UsageSource: String, Codable, Sendable {
  case summary, timeline
}

struct UsageBreakdown: Codable, Equatable, Sendable {
  var inputTokens: Double?
  var outputTokens: Double?
  var cacheReadInputTokens: Double?
  var cacheCreationInputTokens: Double?
  var reasoningOutputTokens: Double?

  static let keys = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens"]

  subscript(key: String) -> Double? {
    switch key {
    case "inputTokens": inputTokens
    case "outputTokens": outputTokens
    case "cacheReadInputTokens": cacheReadInputTokens
    case "cacheCreationInputTokens": cacheCreationInputTokens
    case "reasoningOutputTokens": reasoningOutputTokens
    default: nil
    }
  }
}

struct UsageTotals: Codable, Equatable, Sendable {
  var tokens: Double
  var costUSD: Double?
  var breakdown: UsageBreakdown?
}

struct UsageBucket: Codable, Equatable, Sendable {
  var bucketStartMs: Double
  var tokens: Double
  var costUSD: Double?
}

struct UsageSummary: Codable, Equatable, Sendable {
  var totals: UsageTotals
}

struct UsageTimeline: Codable, Equatable, Sendable {
  var totals: UsageTotals
  var startMs: Double
  var endMs: Double
  var bucketSizeMs: Double
  var buckets: [UsageBucket]
}

struct UsageSnapshot: Codable, Equatable, Sendable {
  var workspaceId: String
  var range: UsageRange
  var retrievedAt: Double
  var summary: UsageSummary?
  var timeline: UsageTimeline?
  var errors: [UsageSource]

  var valid: Bool {
    let totals = [summary?.totals, timeline?.totals].compactMap { $0 }
    let counts = totals.flatMap { total in
      [total.tokens] + UsageBreakdown.keys.compactMap { total.breakdown?[$0] }
    }
    let fees = totals.compactMap(\.costUSD) + (timeline?.buckets.compactMap(\.costUSD) ?? [])
    let dates = [retrievedAt] + (timeline.map { [$0.startMs, $0.endMs] + $0.buckets.map(\.bucketStartMs) } ?? [])
    let all = counts + (timeline.map { [$0.bucketSizeMs] + $0.buckets.map(\.tokens) } ?? []) + dates
    return !workspaceId.isEmpty
      && (timeline?.buckets.count ?? 0) <= 10000
      && all.allSatisfy { Self.count($0) }
      && dates.allSatisfy { $0 <= 8_640_000_000_000_000 }
      && fees.allSatisfy { $0.isFinite && $0 >= 0 }
  }

  private static func count(_ value: Double) -> Bool {
    value.isFinite && value >= 0 && value <= 9_007_199_254_740_991 && value.rounded() == value
  }
}

struct UsageRequest: Encodable, Equatable, Sendable {
  var page = "usage"
  var action = "list"
  var workspaceId: String
  var range: UsageRange
}

typealias UsageService = @MainActor (UsageRequest) async throws -> UsageSnapshot
