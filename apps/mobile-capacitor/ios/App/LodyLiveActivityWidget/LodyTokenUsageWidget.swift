import SwiftUI
import WidgetKit

private func tokenWidgetLocalized(_ key: String, locale: String? = nil) -> String {
    let language = locale.map { $0.lowercased().hasPrefix("zh") ? "zh-Hans" : "en" }
    let bundle = language.flatMap { Bundle.main.path(forResource: $0, ofType: "lproj") }
        .flatMap { Bundle(path: $0) } ?? .main
    return NSLocalizedString(key, tableName: "Localizable", bundle: bundle, comment: "")
}

struct LodyTokenWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: LodyTokenWidgetSnapshot?
}

func lodyTokenWidgetPreviewEntry(now: Date = Date(), locale: String? = nil) -> LodyTokenWidgetEntry {
    let endMs = floor(now.timeIntervalSince1970 * 1000)
    let startMs = floor(endMs / 86_400_000) * 86_400_000
    let chinese = (locale ?? Bundle.main.preferredLocalizations.first ?? "en").hasPrefix("zh")
    let total = 2_517_300.0
    let weights: [Double] = [1, 2, 4, 3, 1, 0, 0, 0, 2, 4, 5, 9, 6, 4, 8, 11, 6, 4, 8, 7, 3, 5, 8, 9]
    let currentHour = Int((endMs - startMs) / 3_600_000)
    let weightSum = weights.prefix(currentHour + 1).reduce(0, +)
    let buckets = weights.enumerated().map { index, weight in
        LodyTokenWidgetSummary.Bucket(
            startMs: floor(startMs / 3_600_000) * 3_600_000 + Double(index) * 3_600_000,
            tokens: index <= currentHour ? total * weight / weightSum : 0
        )
    }
    let summary = LodyTokenWidgetSummary(
        userId: "preview", workspaceId: "preview", workspaceName: "Workspace",
        locale: chinese ? "zh-CN" : "en", period: .utcDay, startMs: startMs, endMs: endMs,
        total: .init(tokens: total, label: chinese ? "251.7万" : "2.5M"),
        models: [
            .init(name: "gpt-6-sol", value: .init(tokens: 1_700_000, label: chinese ? "170万" : "1.7M")),
            .init(name: "claude-opus", value: .init(tokens: 817_300, label: chinese ? "81.7万" : "817K")),
        ],
        breakdown: nil,
        buckets: buckets
    )
    return .init(date: now, snapshot: .init(version: 1, summary: summary, updatedAt: now))
}

struct LodyTokenWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> LodyTokenWidgetEntry { lodyTokenWidgetPreviewEntry() }
    func getSnapshot(in context: Context, completion: @escaping (LodyTokenWidgetEntry) -> Void) {
        completion(context.isPreview ? lodyTokenWidgetPreviewEntry() : currentEntry())
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LodyTokenWidgetEntry>) -> Void) {
        let entry = currentEntry()
        var entries = [entry]
        if let snapshot = entry.snapshot {
            let expiry = Date(timeIntervalSince1970: snapshot.summary.endMs / 1000)
                .addingTimeInterval(LodyTokenWidgetSnapshot.freshnessInterval)
            if expiry > entry.date { entries.append(.init(date: expiry, snapshot: snapshot)) }
        }
        completion(Timeline(entries: entries, policy: .after(entry.date.addingTimeInterval(30 * 60))))
    }
    private func currentEntry() -> LodyTokenWidgetEntry {
        let now = Date()
        return .init(date: now, snapshot: LodyHomeWidgetStore.defaults().flatMap {
            LodyTokenUsageWidgetStore.load(from: $0, now: now)
        })
    }
}

struct LodyTokenUsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LodyTokenUsageWidgetStore.kind, provider: LodyTokenWidgetProvider()) { entry in
            LodyTokenWidgetRootView(entry: entry)
        }
        .configurationDisplayName(tokenWidgetLocalized("tokenWidget.name"))
        .description(tokenWidgetLocalized("tokenWidget.description"))
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct LodyTokenWidgetRootView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode
    let entry: LodyTokenWidgetEntry
    @ViewBuilder var body: some View {
        if #available(iOS 17.0, *) {
            LodyTokenWidgetView(entry: entry, family: family, renderingMode: renderingMode)
                .containerBackground(for: .widget) { LodyHomeWidgetBackground(renderingMode: renderingMode) }
        } else {
            LodyTokenWidgetView(entry: entry, family: family, renderingMode: renderingMode)
                .padding(16).background(LodyHomeWidgetBackground(renderingMode: renderingMode))
        }
    }
}

struct LodyTokenWidgetView: View {
    let entry: LodyTokenWidgetEntry
    let family: WidgetFamily
    let renderingMode: WidgetRenderingMode
    private var isSmall: Bool { family == .systemSmall }
    private var ink: Color { renderingMode == .fullColor ? .white : .primary }
    private var summary: LodyTokenWidgetSummary? { entry.snapshot?.summary }
    private var isFresh: Bool { entry.snapshot?.isFresh(at: entry.date) == true }
    private func localized(_ key: String) -> String { tokenWidgetLocalized(key, locale: summary?.locale) }

    var body: some View {
        VStack(alignment: .leading, spacing: isSmall ? 7 : 8) {
            header
            if let summary, isFresh {
                totals(summary)
                skyline(summary)
                period(summary)
            } else {
                emptyContent
                HStack {
                    Text(localized("tokenWidget.open"))
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.right").accessibilityHidden(true)
                }
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(ink.opacity(0.45))
            }
        }
        .foregroundStyle(ink)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        HStack(spacing: 6) {
            LodyLogoMark(size: 19).accessibilityHidden(true)
            Text("Lody").font(.system(size: 14, weight: .bold, design: .rounded))
            Spacer(minLength: 4)
            if let summary {
                Text(summary.workspaceName)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(ink.opacity(0.5))
                    .lineLimit(1).truncationMode(.middle)
            }
        }
    }

    private func totals(_ summary: LodyTokenWidgetSummary) -> some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(localized("tokenWidget.range.\(summary.period.rawValue)"))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(ink.opacity(0.6))
                Text(summary.total.label)
                    .font(.system(size: isSmall ? 30 : 32, weight: .medium, design: .rounded))
                    .monospacedDigit().lineLimit(1).minimumScaleFactor(0.65)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(localized("tokenWidget.range.\(summary.period.rawValue)"))
            .accessibilityValue(String(summary.total.tokens))
            if !isSmall {
                Rectangle().fill(ink.opacity(0.1)).frame(width: 0.5, height: 32)
                if let breakdown = summary.breakdown {
                    HStack(spacing: 12) {
                        detail("tokenWidget.input", value: breakdown.input)
                        detail("tokenWidget.output", value: breakdown.output)
                        detail("tokenWidget.cache", value: breakdown.cacheRead)
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(summary.models.enumerated()), id: \.offset) { _, model in
                            HStack(spacing: 6) {
                                Text(model.name).font(.system(size: 9, weight: .medium))
                                    .foregroundStyle(ink.opacity(0.6)).lineLimit(1)
                                Spacer(minLength: 0)
                                Text(model.value.label)
                                    .font(.system(size: 12, weight: .medium, design: .rounded))
                                    .monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
                                    .layoutPriority(1)
                            }
                        }
                        if summary.models.isEmpty {
                            Text(localized("tokenWidget.noModels"))
                                .font(.system(size: 10)).foregroundStyle(ink.opacity(0.5))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func detail(_ key: String, value: LodyTokenWidgetValue?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(localized(key)).font(.system(size: 9, weight: .medium))
                .foregroundStyle(ink.opacity(0.52)).lineLimit(2)
                .frame(height: 22, alignment: .bottomLeading)
            Text(value?.label ?? "—")
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(localized(key))
        .accessibilityValue(value.map { String($0.tokens) } ?? localized("tokenWidget.unavailable"))
    }

    private func skyline(_ summary: LodyTokenWidgetSummary) -> some View {
        let maxTokens = summary.buckets.map(\.tokens).max() ?? 0
        return GeometryReader { geometry in
            HStack(alignment: .bottom, spacing: isSmall ? 2 : 3) {
                ForEach(Array(summary.buckets.enumerated()), id: \.offset) { index, bucket in
                    RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                        .fill(renderingMode == .fullColor
                            ? (bucket.startMs <= summary.endMs && (index == summary.buckets.count - 1 || summary.buckets[index + 1].startMs > summary.endMs) ? LodyWidgetAppearance.brandTeal : LodyWidgetAppearance.running).opacity(bucket.startMs > summary.endMs ? 0.06 : bucket.tokens > 0 ? 0.8 : 0.15)
                            : ink.opacity(bucket.tokens > 0 ? 0.65 : 0.15))
                        .frame(maxWidth: .infinity)
                        .frame(height: maxTokens > 0 ? max(2, geometry.size.height * bucket.tokens / maxTokens) : 2)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
        .frame(maxHeight: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(localized("tokenWidget.trend"))
    }

    private func period(_ summary: LodyTokenWidgetSummary) -> some View {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: summary.locale)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "MM/dd HH:mm"
        let start = formatter.string(from: Date(timeIntervalSince1970: summary.startMs / 1000))
        let end = formatter.string(from: Date(timeIntervalSince1970: summary.endMs / 1000))
        return HStack(spacing: 3) {
            Text(isSmall && summary.period == .utcDay ? "\(end) UTC" : "\(start)–\(end) UTC")
                .minimumScaleFactor(0.7)
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right").accessibilityHidden(true)
        }
        .font(.system(size: 8, weight: .medium)).monospacedDigit()
        .foregroundStyle(ink.opacity(0.46)).lineLimit(1)
    }

    private var emptyContent: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(localized(summary == nil ? "tokenWidget.empty.title" : "tokenWidget.stale.title"))
                .font(.system(size: 15, weight: .semibold))
            Text(localized(summary == nil ? "tokenWidget.empty.body" : "tokenWidget.stale.body"))
                .font(.system(size: isSmall ? 10 : 11))
                .foregroundStyle(ink.opacity(0.56))
                .lineLimit(isSmall ? 2 : 1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

@available(iOS 17.0, *)
#Preview(as: .systemSmall) {
    LodyTokenUsageWidget()
} timeline: {
    lodyTokenWidgetPreviewEntry()
    LodyTokenWidgetEntry(date: Date(), snapshot: nil)
}
