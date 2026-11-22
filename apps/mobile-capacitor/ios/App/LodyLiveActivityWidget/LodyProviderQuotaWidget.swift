import SwiftUI
import WidgetKit

private func quotaText(_ key: String, locale: String? = nil) -> String {
    let language = locale.map { $0.lowercased().hasPrefix("zh") ? "zh-Hans" : "en" }
    let bundle = language.flatMap { Bundle.main.path(forResource: $0, ofType: "lproj") }
        .flatMap { Bundle(path: $0) } ?? .main
    return NSLocalizedString(key, tableName: "Localizable", bundle: bundle, comment: "")
}

struct LodyProviderQuotaEntry: TimelineEntry {
    let date: Date
    let snapshot: LodyProviderQuotaSnapshot?
}

func lodyQuotaPreviewEntry(now: Date = Date(), locale: String? = nil) -> LodyProviderQuotaEntry {
    let providers = [("codex", "Codex", 76.0, 54.0), ("claude", "Claude", 38.0, 69.0), ("kimi", "Kimi", 92.0, 81.0)]
        .map { kind, name, short, week in
            LodyProviderQuotaSummary.Provider(
                id: "preview-machine/\(kind)", name: name, machineName: "MacBook Pro", logoKind: kind,
                logoText: String(name.prefix(2)), online: true,
                windows: (kind == "kimi" ? [] : [
                    .init(label: "5h", remainingPercent: short, resetsAt: now.addingTimeInterval(5_400).timeIntervalSince1970),
                ]) + [
                    .init(label: "7d", remainingPercent: week, resetsAt: now.addingTimeInterval(172_800).timeIntervalSince1970),
                ], additionalWindows: 0
            )
        }
    return .init(date: now, snapshot: .init(version: 1, summary: .init(
        userId: "preview", workspaceId: "preview", workspaceName: "Lody",
        locale: locale ?? Bundle.main.preferredLocalizations.first ?? "en", providers: providers
    ), updatedAt: now))
}

struct LodyProviderQuotaTimeline: TimelineProvider {
    func placeholder(in context: Context) -> LodyProviderQuotaEntry { lodyQuotaPreviewEntry() }
    func getSnapshot(in context: Context, completion: @escaping (LodyProviderQuotaEntry) -> Void) {
        completion(context.isPreview ? lodyQuotaPreviewEntry() : current())
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LodyProviderQuotaEntry>) -> Void) {
        let entry = current()
        var dates: Set<Date> = [entry.date]
        if let snapshot = entry.snapshot {
            dates.insert(snapshot.updatedAt.addingTimeInterval(LodyProviderQuotaSnapshot.freshnessInterval))
            for provider in snapshot.summary.providers {
                for window in provider.windows {
                    if let reset = window.resetsAt { dates.insert(Date(timeIntervalSince1970: reset)) }
                }
            }
        }
        let entries = dates.filter { $0 >= entry.date }.sorted().map {
            LodyProviderQuotaEntry(date: $0, snapshot: entry.snapshot)
        }
        completion(Timeline(entries: entries, policy: .after(entry.date.addingTimeInterval(30 * 60))))
    }
    private func current() -> LodyProviderQuotaEntry {
        let now = Date()
        return .init(date: now, snapshot: LodyHomeWidgetStore.defaults().flatMap {
            LodyProviderQuotaWidgetStore.load(from: $0, now: now)
        })
    }
}

struct LodyProviderQuotaWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LodyProviderQuotaWidgetStore.kind, provider: LodyProviderQuotaTimeline()) { entry in
            LodyQuotaWidgetRoot(entry: entry)
        }
        .configurationDisplayName(quotaText("quotaWidget.name"))
        .description(quotaText("quotaWidget.description"))
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct LodyQuotaWidgetRoot: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode
    let entry: LodyProviderQuotaEntry
    var body: some View {
        if #available(iOS 17.0, *) {
            LodyProviderQuotaWidgetView(entry: entry, family: family, renderingMode: renderingMode)
                .containerBackground(for: .widget) { LodyHomeWidgetBackground(renderingMode: renderingMode) }
        } else {
            LodyProviderQuotaWidgetView(entry: entry, family: family, renderingMode: renderingMode)
                .padding(16).background(LodyHomeWidgetBackground(renderingMode: renderingMode))
        }
    }
}

struct LodyProviderQuotaWidgetView: View {
    let entry: LodyProviderQuotaEntry
    let family: WidgetFamily
    let renderingMode: WidgetRenderingMode
    private var small: Bool { family == .systemSmall }
    private var ink: Color { renderingMode == .fullColor ? .white : .primary }
    private var summary: LodyProviderQuotaSummary? { entry.snapshot?.summary }
    private var fresh: Bool { entry.snapshot?.isFresh(at: entry.date) == true }
    private func text(_ key: String) -> String { quotaText(key, locale: summary?.locale) }

    var body: some View {
        Group {
            if fresh, let providers = summary?.providers, !providers.isEmpty {
                if small, let provider = providers.first {
                    smallCard(provider)
                } else {
                    mediumCard(providers)
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    header
                    Spacer(minLength: 0)
                    Text(text(entry.snapshot != nil && !fresh ? "quotaWidget.stale" : "quotaWidget.empty"))
                        .font(.system(size: 15, weight: .semibold))
                    Text(text("quotaWidget.hint")).font(.system(size: 10)).foregroundStyle(ink.opacity(0.75))
                    Spacer(minLength: 0)
                    footer
                }
            }
        }
        .foregroundStyle(ink)
        .padding(.horizontal, small ? 0 : 8)
    }

    @ViewBuilder private var header: some View {
        if small {
            HStack(spacing: 6) {
                LodyLogoMark(size: 19).accessibilityHidden(true)
                Text("Lody").font(.system(size: 14, weight: .bold, design: .rounded)).fixedSize()
                Spacer(minLength: 4)
                if let workspaceName = summary?.workspaceName {
                    Text(workspaceName).font(.system(size: 10, weight: .medium))
                        .foregroundStyle(ink.opacity(0.5)).lineLimit(1).truncationMode(.middle)
                }
            }
        } else {
            HStack(spacing: 6) {
                LodyLogoMark(size: 14)
                Text(text("quotaWidget.name")).font(.system(size: 10, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 0)
                Text(text("quotaWidget.remaining")).font(.system(size: 9)).foregroundStyle(ink.opacity(0.75))
            }
        }
    }

    private var footer: some View {
        Text(text("quotaWidget.snapshot"))
            .font(.system(size: 8, weight: .medium)).foregroundStyle(ink.opacity(0.7))
    }

    private func smallCard(_ provider: LodyProviderQuotaSummary.Provider) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            header
            HStack(spacing: 5) {
                LodyAgentLogo(kind: provider.logoKind, text: provider.logoText)
                    .accessibilityHidden(true)
                Text(provider.name).font(.system(size: 10, weight: .medium))
                    .foregroundStyle(ink.opacity(0.62)).lineLimit(1)
                if provider.additionalWindows > 0 {
                    Text("+\(provider.additionalWindows)").font(.system(size: 8)).foregroundStyle(ink.opacity(0.75))
                }
                Spacer(minLength: 0)
                Text(text("quotaWidget.remaining")).font(.system(size: 8)).foregroundStyle(ink.opacity(0.8))
            }
            HStack(spacing: 12) {
                ForEach(Array(provider.windows.enumerated()), id: \.offset) { index, window in
                    VStack(spacing: 4) {
                        quotaRing(window, index: index, single: provider.windows.count == 1)
                        Text(reset(window)).font(.system(size: 7.5)).foregroundStyle(ink.opacity(0.75))
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Text(provider.machineName + " · " + text(provider.online ? "quotaWidget.snapshot" : "quotaWidget.cached"))
                .font(.system(size: 8)).foregroundStyle(ink.opacity(0.7))
                .lineLimit(1).truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func quotaRing(_ window: LodyProviderQuotaSummary.Window, index: Int, single: Bool) -> some View {
        let diameter: CGFloat = single ? 62 : 58
        return ZStack {
            Circle().stroke(ink.opacity(0.35), lineWidth: 5)
            if !window.needsRefresh(at: entry.date), window.remainingPercent > 0 {
                Circle().trim(from: 0, to: window.remainingPercent / 100)
                    .stroke(quotaColor(index), style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            VStack(spacing: 1) {
                Text(percent(window)).font(.system(size: 16, weight: .bold, design: .rounded))
                    .monospacedDigit().lineLimit(1).minimumScaleFactor(0.75)
                Text(window.label).font(.system(size: 8, weight: .medium))
                    .foregroundStyle(ink.opacity(0.85)).lineLimit(1).minimumScaleFactor(0.7)
            }
            .padding(.horizontal, 5)
        }
        .padding(3)
        .frame(width: diameter, height: diameter)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(window.label), \(text("quotaWidget.remaining")) \(percent(window)), \(reset(window))")
    }

    private func quotaColor(_ index: Int) -> Color {
        renderingMode == .fullColor
            ? (index == 0 ? LodyWidgetAppearance.brandTeal : Color(red: 0.42, green: 0.70, blue: 1))
            : ink
    }

    private func mediumCard(_ providers: [LodyProviderQuotaSummary.Provider]) -> some View {
        let columns = alignedPeriods(providers)
        let columnCount = columns.isEmpty ? providers.map { $0.windows.count }.max() ?? 1 : columns.count
        let machineName = commonMachineName(providers)
        let attention = attentionWindow(providers)
        return VStack(alignment: .leading, spacing: 6) {
            header
            VStack(spacing: machineName == nil && attention != nil ? 3 : 9) {
                ForEach(providers, id: \.id) { provider in
                    providerRow(provider, periods: columns, columnCount: columnCount,
                                sharedMachine: machineName != nil,
                                attention: attention.flatMap { $0.provider.id == provider.id ? $0.window : nil })
                }
            }
            .frame(maxHeight: .infinity)
            mediumFooter(machineName: machineName)
        }
    }

    // The producer prefixes named windows with their duration. Align common
    // periods only when each is unique; named windows sharing a period stay separate.
    private func period(_ window: LodyProviderQuotaSummary.Window) -> String {
        window.label.components(separatedBy: " · ")[0]
    }

    private func alignedPeriods(_ providers: [LodyProviderQuotaSummary.Provider]) -> [String] {
        let periods = Set(providers.flatMap { $0.windows.map(period) })
        guard periods.isSubset(of: ["5h", "7d"]), providers.allSatisfy({ provider in
            Set(provider.windows.map(period)).count == provider.windows.count
        }) else { return [] }
        return ["5h", "7d"].filter { periods.contains($0) }
    }

    private func commonMachineName(_ providers: [LodyProviderQuotaSummary.Provider]) -> String? {
        guard let first = providers.first else { return nil }
        let machineId = first.id.split(separator: "/", maxSplits: 1).first
        return providers.allSatisfy {
            $0.machineName == first.machineName && $0.id.split(separator: "/", maxSplits: 1).first == machineId
        } ? first.machineName : nil
    }

    private func providerRow(_ provider: LodyProviderQuotaSummary.Provider, periods: [String], columnCount: Int,
                             sharedMachine: Bool, attention: LodyProviderQuotaSummary.Window?) -> some View {
        var windows: [LodyProviderQuotaSummary.Window?] = periods.isEmpty
            ? provider.windows.map { $0 }
            : periods.map { key in provider.windows.first { period($0) == key } }
        while windows.count < columnCount { windows.append(nil) }
        let width: CGFloat = columnCount == 1 ? 164 : 76
        return HStack(spacing: 12) {
            HStack(spacing: 8) {
                LodyAgentLogo(kind: provider.logoKind, text: provider.logoText)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 3) {
                        Text(provider.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                        if provider.additionalWindows > 0 {
                            Text("+\(provider.additionalWindows)").font(.system(size: 8)).foregroundStyle(ink.opacity(0.75))
                        }
                    }
                    if !sharedMachine {
                        Text(provider.machineName + (provider.online ? "" : " · " + text("quotaWidget.cached")))
                            .font(.system(size: 8)).foregroundStyle(ink.opacity(0.7)).lineLimit(1)
                    } else if !provider.online {
                        Text(text("quotaWidget.cached")).font(.system(size: 8)).foregroundStyle(ink.opacity(0.7))
                    }
                    if let attention {
                        Text("\(attention.label) · \(reset(attention))")
                            .font(.system(size: 7.5, weight: .medium))
                            .foregroundStyle(renderingMode == .fullColor ? LodyWidgetAppearance.waiting : ink)
                            .lineLimit(1).truncationMode(.middle).minimumScaleFactor(0.8)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 12) {
                ForEach(Array(windows.enumerated()), id: \.offset) { index, window in
                    if let window {
                        quotaBar(window, index: index).frame(width: width)
                    } else {
                        Color.clear.frame(width: width, height: 25).accessibilityHidden(true)
                    }
                }
            }
            .frame(width: 164)
        }
    }

    private func quotaBar(_ window: LodyProviderQuotaSummary.Window, index: Int) -> some View {
        let color = renderingMode == .fullColor && window.remainingPercent <= 20
            ? LodyWidgetAppearance.waiting : quotaColor(period(window) == "7d" ? 1 : index)
        return VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(window.label).font(.system(size: 8.5, weight: .medium))
                    .foregroundStyle(ink.opacity(0.8)).lineLimit(1).minimumScaleFactor(0.75)
                Spacer(minLength: 0)
                Text(percent(window)).font(.system(size: 14, weight: .semibold, design: .rounded))
                    .monospacedDigit().fixedSize()
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(ink.opacity(0.35))
                    if !window.needsRefresh(at: entry.date), window.remainingPercent > 0 {
                        Capsule().fill(color).frame(width: geometry.size.width * window.remainingPercent / 100)
                    }
                }
            }
            .frame(height: 4).accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(window.label), \(text("quotaWidget.remaining")) \(percent(window)), \(reset(window))")
    }

    private func attentionWindow(_ providers: [LodyProviderQuotaSummary.Provider])
        -> (provider: LodyProviderQuotaSummary.Provider, window: LodyProviderQuotaSummary.Window)? {
        providers.flatMap { provider in provider.windows.map { (provider: provider, window: $0) } }
            .filter { $0.window.needsRefresh(at: entry.date) || $0.window.remainingPercent <= 20 }
            .min { left, right in
                let leftExpired = left.window.needsRefresh(at: entry.date)
                let rightExpired = right.window.needsRefresh(at: entry.date)
                if leftExpired != rightExpired { return leftExpired }
                return left.window.remainingPercent < right.window.remainingPercent
            }
    }

    private func mediumFooter(machineName: String?) -> some View {
        Text([machineName, text("quotaWidget.snapshot")].compactMap { $0 }.joined(separator: " · "))
            .font(.system(size: 8, weight: .medium)).foregroundStyle(ink.opacity(0.7)).lineLimit(1)
    }
    private func percent(_ window: LodyProviderQuotaSummary.Window) -> String {
        window.needsRefresh(at: entry.date) ? "—" : String(format: "%.0f%%", window.remainingPercent)
    }
    private func reset(_ window: LodyProviderQuotaSummary.Window) -> String {
        if window.needsRefresh(at: entry.date) { return text("quotaWidget.refresh") }
        guard let reset = window.resetsAt else { return text("quotaWidget.unknownReset") }
        let date = Date(timeIntervalSince1970: reset)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: summary?.locale ?? "en")
        formatter.setLocalizedDateFormatFromTemplate(date.timeIntervalSince(entry.date) >= 86_400 ? "MdHHmm" : "HHmm")
        return text("quotaWidget.resets") + " " + formatter.string(from: date)
    }
}
