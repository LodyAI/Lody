import Foundation

let hour = 3_600_000.0
let snapshot = UsageSnapshot(
  workspaceId: "w",
  range: .day,
  retrievedAt: 6 * hour,
  summary: UsageSummary(totals: UsageTotals(tokens: 99, costUSD: 99)),
  timeline: UsageTimeline(
    totals: UsageTotals(
      tokens: 1_284_331, costUSD: nil,
      breakdown: UsageBreakdown(
        inputTokens: 300, outputTokens: 100, cacheReadInputTokens: 600, cacheCreationInputTokens: 0, reasoningOutputTokens: nil
      )
    ),
    startMs: 0, endMs: 24 * hour, bucketSizeMs: hour,
    buckets: [
      UsageBucket(bucketStartMs: 2 * hour, tokens: 5, costUSD: 0.5),
      UsageBucket(bucketStartMs: 0, tokens: 12, costUSD: 1),
      UsageBucket(bucketStartMs: hour, tokens: 70_000, costUSD: nil),
    ]
  ),
  errors: [.summary]
)

func visual(_ sections: [LodyListSection], _ type: String) -> LodyListVisual? {
  sections.first { $0.visual?.type == type }?.visual
}

precondition(AIUsageFormat.cost(nil) == "settings.aiUsage.unavailable", "Unknown cost stays unavailable")
precondition(AIUsageFormat.cost(0) == "$0.00", "True zero cost stays zero")
precondition(AIUsageFormat.cost(1.25) == "$1.25")
precondition(AIUsageFormat.cost(0.0000001) == "<$0.000001")
precondition(AIUsageFormat.number(nil) == "settings.aiUsage.unavailable")
precondition(AIUsageFormat.number(12_500) == "12,500")
precondition(AIUsageFormat.compactCost(nil) == "—")
precondition(AIUsageFormat.compactCost(0) == "$0.00")
precondition(AIUsageFormat.compactCost(0.004) == "<$0.01")
precondition(AIUsageFormat.compactCost(3.4182) == "$3.42")
for (value, expected) in [(1_284_331.0, "1.28M"), (6000, "6K"), (950, "950"), (2_500_000_000, "2.5B")] {
  precondition(AIUsageFormat.compactNumber(value) == expected, "\(value) -> \(AIUsageFormat.compactNumber(value))")
}
precondition(AIUsageFormat.compactNumber(nil) == "—")

let sections = AIUsageSections.make(snapshot)
precondition(sections.map(\.id) == ["overview", "timeline", "mix"])
precondition(sections.last?.footer == "settings.aiUsage.footer", "Footer belongs to the last section")
let stats = visual(sections, "stats")!
precondition(stats.items.map(\.value) == ["1.28M", "—"], "Totals come from the server timeline: \(stats.items.map(\.value))")
precondition(stats.items.map(\.accessibilityValue) == ["1,284,331", "settings.aiUsage.unavailable"])

let bars = visual(sections, "bars")!
precondition(bars.items.map(\.amount) == [12, 70_000, 5], "Buckets are ordered by start")
precondition(bars.items.map(\.id) == ["bucket:0", "bucket:3600000", "bucket:7200000"])
precondition(bars.items.compactMap { $0.axisLabel.isEmpty ? nil : $0.axisLabel } == ["00:00", "01:00", "02:00"],
             "\(bars.items.map(\.axisLabel))")
precondition(bars.items.allSatisfy { !$0.accessibilityLabel.isEmpty })
precondition(bars.items.map(\.cost) == [1, nil, 0.5], "Missing cost is never a zero bar")
precondition(bars.metrics.count == 2 && !bars.costSummary.isEmpty, "Priced buckets add the cost metric")

let tokensOnly = UsageSnapshot(
  workspaceId: "w", range: .day, retrievedAt: 0, summary: nil,
  timeline: UsageTimeline(
    totals: snapshot.timeline!.totals, startMs: 0, endMs: 24 * hour, bucketSizeMs: hour,
    buckets: snapshot.timeline!.buckets.map { UsageBucket(bucketStartMs: $0.bucketStartMs, tokens: $0.tokens, costUSD: nil) }
  ),
  errors: []
)
precondition(visual(AIUsageSections.make(tokensOnly), "bars")!.metrics.isEmpty, "No cost metric without priced buckets")

let mix = visual(sections, "mix")!
precondition(mix.items.map(\.label) == UsageBreakdown.keys.map { "settings.aiUsage.\($0)" }, "Mix keeps a fixed order")
precondition(mix.items[0].percent == "30%")
precondition(mix.items[3].value == "0")
precondition(mix.items[4].value == "—" && mix.items[4].fraction == 0, "Missing values are never zero")
precondition(mix.items[0].accessibilityValue == "300, 30%")

let summaryOnly = UsageSnapshot(
  workspaceId: "w", range: .day, retrievedAt: 0, summary: snapshot.summary, timeline: nil, errors: []
)
precondition(visual(AIUsageSections.make(summaryOnly), "bars") == nil)
precondition(visual(AIUsageSections.make(summaryOnly), "stats")!.items.map(\.value) == ["99", "$99.00"])
precondition(AIUsageSections.make(nil).isEmpty)

let week = (0..<168).map {
  UsageBucket(bucketStartMs: Double($0) * hour, tokens: $0 == 0 ? 1000 : 1, costUSD: $0 == 1 ? nil : 0.01)
}
let long = UsageSnapshot(
  workspaceId: "w", range: .week, retrievedAt: 0, summary: nil,
  timeline: UsageTimeline(totals: UsageTotals(tokens: 1167), startMs: 0, endMs: 168 * hour, bucketSizeMs: hour, buckets: week),
  errors: []
)
let longBars = visual(AIUsageSections.make(long), "bars")!
precondition(longBars.items.count <= 90, "Long ranges merge adjacent buckets")
precondition(longBars.items.reduce(0) { $0 + $1.amount } == 1167)
precondition(longBars.items[0].cost == nil, "A merged bucket with an unknown cost stays unknown")
precondition(longBars.items.first { !$0.axisLabel.isEmpty }!.axisLabel.contains("Jan"), longBars.items[0].axisLabel)

precondition(snapshot.valid)
var invalid = snapshot
invalid.retrievedAt = .infinity
precondition(!invalid.valid, "Non-finite dates are rejected")
invalid = snapshot
invalid.timeline!.buckets[0].tokens = 1.5
precondition(!invalid.valid, "Token counts are integers")
let decoded = try! JSONDecoder().decode(UsageSnapshot.self, from: Data(#"""
{"workspaceId":"w","range":"week","retrievedAt":1,"summary":null,"timeline":null,"errors":["timeline"]}
"""#.utf8))
precondition(decoded.range == .week && decoded.errors == [.timeline])
let request = String(decoding: try! JSONEncoder().encode(UsageRequest(workspaceId: "w", range: .month)), as: UTF8.self)
let fields = try! JSONSerialization.jsonObject(with: Data(request.utf8)) as! [String: String]
precondition(fields == ["page": "usage", "action": "list", "workspaceId": "w", "range": "month"], request)

let base = (title: "Couldn’t Load Usage", hasData: false)
precondition(LodyListState.make(title: base.title, hasData: false, loading: true).loading, "First load shows the skeleton")
precondition(!LodyListState.make(title: base.title, hasData: true, loading: true).loading, "Refresh over data keeps it visible")
let unavailable = LodyListState.make(title: base.title, hasData: false, failed: true)
precondition(unavailable.unavailable?.title == base.title && unavailable.notice == nil)
precondition(unavailable.unavailable?.actionTitle == "settings.state.tryAgain")
let stale = LodyListState.make(title: base.title, hasData: true, failed: true, syncedAt: 0, now: 2 * hour)
precondition(stale.unavailable == nil && stale.notice?.text == "settings.state.staleAt", "Failed refresh keeps data")
precondition(stale.notice?.actionSymbol == "arrow.clockwise")
precondition(LodyListState.make(title: base.title, hasData: true, failed: true).notice?.text == "settings.state.stale")
let unconfirmed = LodyListState.make(title: base.title, hasData: true, failed: true, offline: true, unconfirmed: true)
precondition(unconfirmed.notice?.text == "settings.state.unconfirmed", "Unconfirmed outranks stale and offline")
precondition(unconfirmed.notice?.actionLabel == "settings.state.refresh", "Unconfirmed offers only a re-read")
precondition(LodyListState.make(title: base.title, hasData: true, offline: true).notice?.text == "settings.state.offline")
let partial = LodyListState.make(title: base.title, hasData: false, partial: "partial")
precondition(partial.unavailable == nil && partial.notice?.text == "partial" && partial.notice?.tint == "warning")

var calendar = Calendar(identifier: .gregorian)
calendar.timeZone = TimeZone(identifier: "UTC")!
let noon = 1_792_152_000_000.0
precondition(LodyRelativeTime.text(noon - 30_000, now: noon, calendar: calendar) == "time.justNow")
precondition(LodyRelativeTime.text(noon - 5 * 60_000, now: noon, calendar: calendar) == "time.minutesAgo")
precondition(LodyRelativeTime.text(noon - 2 * hour, now: noon, calendar: calendar) == "time.hoursAgo")
precondition(LodyRelativeTime.text(noon - 20 * hour, now: noon, calendar: calendar) == "time.yesterday")
precondition(LodyRelativeTime.text(noon - 72 * hour, now: noon, calendar: calendar) == "Oct 13",
             LodyRelativeTime.text(noon - 72 * hour, now: noon, calendar: calendar))
precondition(LodyRelativeTime.text(.nan, now: noon, calendar: calendar) == "")

print("PASS: usage formatting, sections, chart merge, snapshot validation, list state, relative time")
