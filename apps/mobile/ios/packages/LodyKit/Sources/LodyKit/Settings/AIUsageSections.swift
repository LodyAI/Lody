import Foundation

enum AIUsageFormat {
  static let missing = "—"
  private static let compactUnits: [(Double, String)] = [(1e9, "B"), (1e6, "M"), (1e3, "K")]

  static func number(_ value: Double?) -> String {
    guard let value else { return text("unavailable") }
    return format(value, locale: Locale(identifier: "en_US"), fraction: 0...3)
  }

  static func cost(_ value: Double?) -> String {
    guard let value else { return text("unavailable") }
    if value > 0 && value < 0.000001 { return "<$0.000001" }
    return currency(value, fraction: 2...6)
  }

  static func compactNumber(_ value: Double?) -> String {
    guard let value else { return missing }
    guard let (size, suffix) = compactUnits.first(where: { abs(value) >= $0.0 }) else {
      return format(value, locale: LodyFormat.locale, fraction: 0...2)
    }
    return format(value / size, locale: LodyFormat.locale, fraction: 0...2) + suffix
  }

  static func compactCost(_ value: Double?) -> String {
    guard let value else { return missing }
    if value > 0 && value < 0.01 { return "<$0.01" }
    return currency(value, fraction: 2...2)
  }

  static func utc(_ template: String) -> (Double) -> String {
    let formatter = DateFormatter()
    formatter.locale = LodyFormat.locale
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.setLocalizedDateFormatFromTemplate(template)
    return { formatter.string(from: Date(timeIntervalSince1970: $0 / 1000)) }
  }

  static func text(_ key: String) -> String {
    String(localized: String.LocalizationValue("settings.aiUsage." + key), bundle: .lody)
  }

  private static func format(_ value: Double, locale: Locale, fraction: ClosedRange<Int>) -> String {
    let formatter = NumberFormatter()
    formatter.locale = locale
    formatter.numberStyle = .decimal
    formatter.roundingMode = .halfUp
    formatter.minimumFractionDigits = fraction.lowerBound
    formatter.maximumFractionDigits = fraction.upperBound
    return formatter.string(from: NSNumber(value: value)) ?? String(value)
  }

  private static func currency(_ value: Double, fraction: ClosedRange<Int>) -> String {
    let formatter = NumberFormatter()
    formatter.locale = Locale(identifier: "en_US")
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    formatter.roundingMode = .halfUp
    formatter.minimumFractionDigits = fraction.lowerBound
    formatter.maximumFractionDigits = fraction.upperBound
    return formatter.string(from: NSNumber(value: value)) ?? String(value)
  }
}

enum AIUsageSections {
  private static let day = 86_400_000.0
  private static let chartLimit = 90

  static func make(_ value: UsageSnapshot?) -> [LodyListSection] {
    guard let value else { return [] }
    let timeline = value.timeline
    let aggregate = timeline?.totals ?? value.summary?.totals
    var overview = LodyListSection()
    overview.id = "overview"
    overview.visual = stats(aggregate)
    var sections = [overview]
    if let timeline, let bars = bars(timeline) {
      var section = LodyListSection()
      section.id = "timeline"
      section.visual = bars
      sections.append(section)
    }
    if let breakdown = aggregate?.breakdown {
      var section = LodyListSection()
      section.id = "mix"
      section.header = AIUsageFormat.text("mix")
      section.visual = mix(breakdown)
      sections.append(section)
    }
    sections[sections.count - 1].footer = String.localizedStringWithFormat(String(localized: "settings.aiUsage.footer", bundle: .lody), String(describing: AIUsageFormat.utc("HHmm")(value.retrievedAt)))
    return sections
  }

  private static func stats(_ aggregate: UsageTotals?) -> LodyListVisual {
    var visual = LodyListVisual()
    visual.type = "stats"
    visual.items = [
      item(label: AIUsageFormat.text("tokens"), value: AIUsageFormat.compactNumber(aggregate?.tokens),
           accessibilityValue: AIUsageFormat.number(aggregate?.tokens)),
      item(label: AIUsageFormat.text("costShort"), value: AIUsageFormat.compactCost(aggregate?.costUSD),
           accessibilityValue: AIUsageFormat.cost(aggregate?.costUSD)),
    ]
    return visual
  }

  private static func bucketTemplate(size: Double, span: Double) -> String {
    if size < day && span <= day { return "HHmm" }
    if size < day { return "MMMdHH" }
    return "MMMd"
  }

  static func merged(_ buckets: [UsageBucket]) -> [UsageBucket] {
    let size = Int((Double(buckets.count) / Double(chartLimit)).rounded(.up))
    guard size > 1 else { return buckets }
    return stride(from: 0, to: buckets.count, by: size).map { start in
      let group = buckets[start..<min(start + size, buckets.count)]
      let costs = group.map(\.costUSD)
      return UsageBucket(
        bucketStartMs: group.first!.bucketStartMs,
        tokens: group.reduce(0) { $0 + $1.tokens },
        costUSD: costs.contains { $0 == nil } ? nil : costs.reduce(0) { $0 + ($1 ?? 0) }
      )
    }
  }

  private static func bars(_ timeline: UsageTimeline) -> LodyListVisual? {
    let sorted = timeline.buckets.sorted { $0.bucketStartMs < $1.bucketStartMs }
    guard let first = sorted.first, let last = sorted.last else { return nil }
    let buckets = merged(sorted)
    let span = last.bucketStartMs - first.bucketStartMs
    let format = AIUsageFormat.utc(bucketTemplate(size: timeline.bucketSizeMs, span: span))
    let time = { (bucket: UsageBucket) in format(bucket.bucketStartMs) }
    let step = max(1, Int((Double(buckets.count) / 4).rounded(.up)))
    var visual = LodyListVisual()
    visual.type = "bars"
    visual.title = AIUsageFormat.text("chartTitle")
    visual.items = buckets.enumerated().map { index, bucket in
      let detail = String.localizedStringWithFormat(String(localized: "settings.aiUsage.bucketDetail", bundle: .lody), String(describing: AIUsageFormat.compactCost(bucket.costUSD)), String(describing: time(bucket)), String(describing: AIUsageFormat.compactNumber(bucket.tokens)))
      var item = LodyListVisualItem()
      item.id = "bucket:\(Int64(bucket.bucketStartMs))"
      item.amount = bucket.tokens
      item.cost = bucket.costUSD
      if index % step == 0 { item.axisLabel = time(bucket) }
      item.detail = detail
      item.accessibilityLabel = detail
      return item
    }
    let peak = buckets.dropFirst().reduce(buckets[0]) { $1.tokens > $0.tokens ? $1 : $0 }
    visual.summary = String.localizedStringWithFormat(String(localized: "settings.aiUsage.peak", bundle: .lody), String(describing: time(peak)), String(describing: AIUsageFormat.compactNumber(peak.tokens)))
    let priced = buckets.filter { $0.costUSD != nil }
    if let firstPriced = priced.first {
      let costPeak = priced.dropFirst().reduce(firstPriced) { ($1.costUSD ?? 0) > ($0.costUSD ?? 0) ? $1 : $0 }
      visual.metrics = [AIUsageFormat.text("tokens"), AIUsageFormat.text("costMetric")]
      visual.costTitle = AIUsageFormat.text("costChartTitle")
      visual.costSummary = String.localizedStringWithFormat(String(localized: "settings.aiUsage.peak", bundle: .lody), String(describing: time(costPeak)), String(describing: AIUsageFormat.compactCost(costPeak.costUSD)))
    }
    return visual
  }

  private static func mix(_ breakdown: UsageBreakdown) -> LodyListVisual {
    let total = UsageBreakdown.keys.reduce(0) { $0 + (breakdown[$1] ?? 0) }
    var visual = LodyListVisual()
    visual.type = "mix"
    visual.items = UsageBreakdown.keys.map { key in
      let value = breakdown[key]
      let fraction = value.map { total > 0 ? $0 / total : 0 } ?? 0
      let percent = value == nil || total == 0 ? AIUsageFormat.missing : "\(Int((fraction * 100).rounded()))%"
      var entry = item(
        label: AIUsageFormat.text(key),
        value: value == nil ? AIUsageFormat.missing : AIUsageFormat.number(value),
        accessibilityValue: value == nil ? AIUsageFormat.text("unavailable") : "\(AIUsageFormat.number(value)), \(percent)"
      )
      entry.percent = percent
      entry.fraction = fraction
      return entry
    }
    return visual
  }

  private static func item(label: String, value: String, accessibilityValue: String) -> LodyListVisualItem {
    var item = LodyListVisualItem()
    item.label = label
    item.value = value
    item.accessibilityValue = accessibilityValue
    return item
  }
}
