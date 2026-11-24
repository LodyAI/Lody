import SwiftUI
import WidgetKit

private func homeWidgetLocalized(_ key: String) -> String {
    NSLocalizedString(key, comment: "")
}

struct LodyHomeWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: LodyHomeWidgetSnapshot?
}

private func homeWidgetPreviewEntry() -> LodyHomeWidgetEntry {
    let now = Date()
    let items: [LodyHomeWidgetConversation] = [
        .init(
            id: "preview-waiting", title: homeWidgetLocalized("homeWidget.sample.waiting"),
            status: .waiting, agentLogoKind: "claude", agentLogoText: "CC", agentName: "Claude",
            updatedAt: now.addingTimeInterval(-120).timeIntervalSince1970 * 1000
        ),
        .init(
            id: "preview-running", title: homeWidgetLocalized("homeWidget.sample.running"),
            status: .running, agentLogoKind: "codex", agentLogoText: "CX", agentName: "Codex",
            updatedAt: now.addingTimeInterval(-60).timeIntervalSince1970 * 1000
        ),
        .init(
            id: "preview-unread", title: homeWidgetLocalized("homeWidget.sample.unread"),
            status: .unread, agentLogoKind: "claude", agentLogoText: "CC", agentName: "Claude",
            updatedAt: now.addingTimeInterval(-300).timeIntervalSince1970 * 1000
        ),
    ]
    return LodyHomeWidgetEntry(
        date: now,
        snapshot: LodyHomeWidgetSnapshot(
            version: 2,
            summary: .init(
                userId: "preview", workspaceId: "preview", workspaceName: "Workspace", items: items
            ),
            updatedAt: now
        )
    )
}

struct LodyHomeWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> LodyHomeWidgetEntry {
        homeWidgetPreviewEntry()
    }

    func getSnapshot(in context: Context, completion: @escaping (LodyHomeWidgetEntry) -> Void) {
        completion(context.isPreview ? homeWidgetPreviewEntry() : currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LodyHomeWidgetEntry>) -> Void) {
        let entry = currentEntry()
        var entries = [entry]
        if let snapshot = entry.snapshot {
            let expiry = snapshot.updatedAt.addingTimeInterval(LodyHomeWidgetSnapshot.freshnessInterval)
            if expiry > entry.date {
                entries.append(LodyHomeWidgetEntry(date: expiry, snapshot: snapshot))
            }
        }
        // Re-read local state only. WidgetKit owns scheduling; no network,
        // background execution entitlement or real-time update promise.
        completion(Timeline(entries: entries, policy: .after(entry.date.addingTimeInterval(30 * 60))))
    }

    private func currentEntry() -> LodyHomeWidgetEntry {
        let now = Date()
        let snapshot = LodyHomeWidgetStore.defaults().flatMap {
            LodyHomeWidgetStore.load(from: $0, now: now)
        }
        return LodyHomeWidgetEntry(date: now, snapshot: snapshot)
    }
}

struct LodyHomeScreenWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: LodyHomeWidgetStore.kind, provider: LodyHomeWidgetProvider()) { entry in
            LodyHomeWidgetRootView(entry: entry)
        }
        .configurationDisplayName(homeWidgetLocalized("homeWidget.name"))
        .description(homeWidgetLocalized("homeWidget.description"))
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private extension View {
    @ViewBuilder
    func homeWidgetBackground(renderingMode: WidgetRenderingMode) -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(for: .widget) {
                LodyHomeWidgetBackground(renderingMode: renderingMode)
            }
        } else {
            padding(16).background(LodyHomeWidgetBackground(renderingMode: renderingMode))
        }
    }
}

private struct LodyHomeWidgetRootView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode
    let entry: LodyHomeWidgetEntry

    var body: some View {
        LodyHomeWidgetView(entry: entry, family: family, renderingMode: renderingMode)
            .homeWidgetBackground(renderingMode: renderingMode)
    }
}

struct LodyHomeWidgetBackground: View {
    let renderingMode: WidgetRenderingMode

    var body: some View {
        if renderingMode == .fullColor {
            LodyWidgetAppearance.background.overlay {
                LinearGradient(
                    colors: [
                        LodyWidgetAppearance.brandTeal.opacity(0.13),
                        .clear,
                        LodyWidgetAppearance.brandBlue.opacity(0.12),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            }
        }
    }
}

struct LodyHomeWidgetView: View {
    let entry: LodyHomeWidgetEntry
    let family: WidgetFamily
    let renderingMode: WidgetRenderingMode

    private var isSmall: Bool { family == .systemSmall }
    private var isFresh: Bool { entry.snapshot?.isFresh(at: entry.date) == true }
    private var ink: Color { renderingMode == .fullColor ? .white : .primary }
    private var items: [LodyHomeWidgetConversation] {
        isFresh ? entry.snapshot?.summary.items ?? [] : []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if let featured = items.first {
                if isSmall {
                    featuredConversation(featured)
                    footer(time: updatedAtLabel(featured))
                } else {
                    conversationList
                }
            } else {
                emptyContent
                footer(time: nil)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(ink)
    }

    private var header: some View {
        HStack(spacing: 6) {
            LodyLogoMark(size: 19).accessibilityHidden(true)
            Text("Lody")
                .font(.system(size: 14, weight: .bold, design: .rounded))
            Spacer(minLength: 4)
            if let workspaceName = entry.snapshot?.summary.workspaceName {
                Text(workspaceName)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(ink.opacity(0.5))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    private func featuredConversation(_ item: LodyHomeWidgetConversation) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                LodyAgentLogo(kind: item.agentLogoKind, text: item.agentLogoText)
                    .accessibilityHidden(true)
                Text(item.agentName)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(ink.opacity(0.62))
                    .lineLimit(1)
            }
            Text(title(item))
                .font(.system(size: 15, weight: .semibold))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            status(item)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var conversationList: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    Rectangle().fill(ink.opacity(0.07)).frame(height: 0.5)
                }
                HStack(alignment: .center, spacing: 8) {
                    LodyAgentLogo(kind: item.agentLogoKind, text: item.agentLogoText)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title(item))
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                        HStack(spacing: 5) {
                            status(item)
                            Text("·").foregroundStyle(ink.opacity(0.3))
                            Text(item.agentName)
                                .foregroundStyle(ink.opacity(0.5))
                                .lineLimit(1)
                        }
                        .font(.system(size: 9, weight: .medium))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Text(updatedAtLabel(item))
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(ink.opacity(0.46))
                        .lineLimit(1)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private func status(_ item: LodyHomeWidgetConversation) -> some View {
        HStack(spacing: 4) {
            Circle().fill(statusColor(item.status)).frame(width: 4, height: 4)
                .accessibilityHidden(true)
            Text(homeWidgetLocalized("homeWidget.status.\(item.status.rawValue)"))
                .lineLimit(1)
        }
        .font(.system(size: isSmall ? 11 : 9, weight: .medium))
        .foregroundStyle(statusColor(item.status))
    }

    private var emptyContent: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(homeWidgetLocalized(
                entry.snapshot == nil ? "homeWidget.empty.title" :
                    isFresh ? "homeWidget.quiet.title" : "homeWidget.stale.title"
            ))
                .font(.system(size: isSmall ? 15 : 16, weight: .semibold))
            Text(homeWidgetLocalized(
                entry.snapshot == nil ? "homeWidget.empty.body" :
                    isFresh ? "homeWidget.quiet.body" : "homeWidget.stale.body"
            ))
                .font(.system(size: isSmall ? 10 : 11))
                .foregroundStyle(ink.opacity(0.56))
                .lineLimit(isSmall ? 2 : 1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func footer(time: String?) -> some View {
        HStack(spacing: 4) {
            Text(time ?? homeWidgetLocalized("homeWidget.open"))
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right")
                .font(.system(size: 9, weight: .semibold))
                .accessibilityHidden(true)
        }
        .font(.system(size: 9, weight: .medium))
        .foregroundStyle(ink.opacity(0.45))
        .lineLimit(1)
    }

    private func title(_ item: LodyHomeWidgetConversation) -> String {
        item.title.isEmpty ? homeWidgetLocalized("homeWidget.untitled") : item.title
    }

    private func updatedAtLabel(_ item: LodyHomeWidgetConversation) -> String {
        guard item.updatedAt > 0 else { return homeWidgetLocalized("homeWidget.recent") }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.dateTimeStyle = .numeric
        let date = min(Date(timeIntervalSince1970: item.updatedAt / 1000), entry.date)
        return formatter.localizedString(for: date, relativeTo: entry.date)
    }

    private func statusColor(_ status: LodyHomeWidgetConversation.Status) -> Color {
        guard renderingMode == .fullColor else { return ink.opacity(0.8) }
        switch status {
        case .waiting: return LodyWidgetAppearance.waiting
        case .running: return LodyWidgetAppearance.running
        case .unread: return LodyWidgetAppearance.unread
        }
    }
}

@available(iOS 17.0, *)
#Preview(as: .systemSmall) {
    LodyHomeScreenWidget()
} timeline: {
    LodyHomeWidgetEntry(date: Date(), snapshot: nil)
    homeWidgetPreviewEntry()
}
