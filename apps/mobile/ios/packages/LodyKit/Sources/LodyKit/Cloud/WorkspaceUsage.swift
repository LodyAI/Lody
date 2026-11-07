import Foundation
import CoreFoundation

@MainActor enum WorkspaceUsage {
  static func metric(_ value: Any?) throws -> Double {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991,
          number.doubleValue.rounded() == number.doubleValue else { throw GitHubCloud.failure() }
    return number.doubleValue
  }
  static func cost(_ value: Any?) -> Any {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue >= 0 else { return NSNull() }
    return number.doubleValue
  }
  static func totals(_ value: Any?) throws -> [String: Any] {
    guard let raw = value as? [String: Any] else { throw GitHubCloud.failure() }
    var result: [String: Any] = ["tokens": try metric(raw["tokens"]), "costUSD": cost(raw["costUSD"])]
    if let fields = raw["breakdown"] as? [String: Any] {
      var breakdown: [String: Any] = [:]
      for key in ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens"] {
        breakdown[key] = (try? metric(fields[key])) ?? NSNull() as Any
      }
      result["breakdown"] = breakdown
    }
    return result
  }
  static func projection(_ value: Any, workspace: String, range: String, timeline: Bool) throws -> [String: Any] {
    guard let raw = value as? [String: Any], raw["workspaceId"] as? String == workspace,
          raw["range"] as? String == range else { throw GitHubCloud.failure() }
    var result: [String: Any] = ["totals": try totals(raw["totals"])]
    if timeline {
      let start = try metric(raw["startMs"]), end = try metric(raw["endMs"]), size = try metric(raw["bucketSizeMs"])
      guard end >= start, end <= 8_640_000_000_000_000, size > 0, let rows = raw["buckets"] as? [[String: Any]], rows.count <= 10000 else { throw GitHubCloud.failure() }
      var seen = Set<Double>()
      let buckets = try rows.map { row -> [String: Any] in
        let date = try metric(row["bucketStartMs"])
        guard date >= start, date <= end, seen.insert(date).inserted else { throw GitHubCloud.failure() }
        return ["bucketStartMs": date, "tokens": try metric(row["tokens"]), "costUSD": cost(row["costUSD"])]
      }
      result.merge(["startMs": start, "endMs": end, "bucketSizeMs": size, "buckets": buckets]) { _, new in new }
    }
    // The first iOS view is workspace aggregates. Never forward member names,
    // emails or per-member details from these responses to the UI.
    return result
  }
  static func run(_ request: [String: Any], workspace: String, call: WorkspaceSettingsCloud.Call) async throws -> [String: Any] {
    guard request["action"] as? String == "list", let range = request["range"] as? String,
          ["day", "week", "month", "total"].contains(range) else { throw GitHubCloud.failure() }
    let args: [String: Any] = ["workspaceId": workspace, "range": range]
    var summary: Any = NSNull(), timeline: Any = NSNull(), errors: [String] = []
    do { summary = try projection(await call("query", "usage:getWorkspaceUsageSummary", args), workspace: workspace, range: range, timeline: false) }
    catch { errors.append("summary") }
    do { timeline = try projection(await call("query", "usage:getWorkspaceUsageTimeline", args), workspace: workspace, range: range, timeline: true) }
    catch { errors.append("timeline") }
    return ["workspaceId": workspace, "range": range, "summary": summary, "timeline": timeline, "errors": errors, "retrievedAt": Int64(Date().timeIntervalSince1970 * 1000)]
  }
}
