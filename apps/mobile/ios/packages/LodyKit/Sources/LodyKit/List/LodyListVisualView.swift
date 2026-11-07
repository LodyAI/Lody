import Charts
import SwiftUI
import UIKit

private let mixColors: [Color] = [
  Color(uiColor: .systemBlue),
  Color(uiColor: .systemOrange),
  Color(uiColor: .systemIndigo),
  Color(uiColor: .systemTeal),
  Color(uiColor: .systemPurple),
]

struct LodyListVisualView: View {
  let visual: LodyListVisual
  let accent: Color

  var body: some View {
    switch visual.type {
    case "stats": LodyListStatsView(items: visual.items)
    case "bars": LodyListBarsView(visual: visual, accent: accent)
    case "mix": LodyListMixView(items: visual.items)
    case "quotas": LodyListQuotasView(items: visual.items, dimmed: visual.dimmed, accent: accent)
    case "skeleton": LodyListSkeletonView()
    default: EmptyView()
    }
  }
}

private struct LodyListStatsView: View {
  let items: [LodyListVisualItem]

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.offset) { index, item in
        if index > 0 { Divider().padding(.horizontal, 16) }
        VStack(alignment: .leading, spacing: 4) {
          Text(item.label).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
          Text(item.value)
            .font(.system(.title2, design: .rounded, weight: .bold))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.label)
        .accessibilityValue(item.accessibilityValue)
      }
    }
  }
}

private struct LodyListBarsView: View {
  let visual: LodyListVisual
  let accent: Color
  @State private var selected: String?
  @State private var metric = 0

  private var showsCost: Bool { metric == 1 && visual.metrics.count > 1 }

  private var title: String { showsCost ? visual.costTitle : visual.title }

  private var headline: String {
    visual.items.first { $0.id == selected }?.detail ?? (showsCost ? visual.costSummary : visual.summary)
  }

  private var axisLabels: [String: String] {
    Dictionary(visual.items.filter { !$0.axisLabel.isEmpty }.map { ($0.id, $0.axisLabel) }, uniquingKeysWith: { first, _ in first })
  }

  private func amount(_ item: LodyListVisualItem) -> Double {
    showsCost ? item.cost ?? 0 : item.amount
  }

  private func axisValue(_ value: Double) -> String {
    let compact = value.formatted(.number.notation(.compactName).precision(.significantDigits(1...3)))
    return showsCost ? "$" + compact : compact
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
        Text(headline).font(.headline).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(title)
      .accessibilityValue(headline)
      .accessibilityIdentifier("list-visual-bars-header")
      Chart {
        if let selected {
          RectangleMark(x: .value("Bucket", selected))
            .foregroundStyle(accent.opacity(0.12))
            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 4, topTrailingRadius: 4))
            .accessibilityHidden(true)
        }
        ForEach(visual.items, id: \.id) { item in
          BarMark(x: .value("Bucket", item.id), y: .value("Amount", amount(item)))
            .foregroundStyle(accent)
            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 3, topTrailingRadius: 3))
            .accessibilityLabel(item.accessibilityLabel)
        }
      }
      .chartXScale(domain: visual.items.map(\.id))
      .chartXAxis {
        AxisMarks(values: visual.items.map(\.id).filter { axisLabels[$0] != nil }) { value in
          AxisValueLabel {
            if let id = value.as(String.self) { Text(axisLabels[id] ?? "") }
          }
        }
      }
      .chartYAxis {
        AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
          AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
          AxisValueLabel {
            if let amount = value.as(Double.self) { Text(axisValue(amount)) }
          }
        }
      }
      .chartOverlay { proxy in
        GeometryReader { geometry in
          Rectangle()
            .fill(.clear)
            .contentShape(Rectangle())
            .onTapGesture { location in
              guard let plot = proxy.plotFrame else { return }
              let x = location.x - geometry[plot].origin.x
              guard let id: String = proxy.value(atX: x) else { return }
              selected = selected == id ? nil : id
            }
        }
      }
      .frame(height: 170)
      .accessibilityIdentifier("list-visual-bars")
      if visual.metrics.count > 1 {
        Picker(visual.title, selection: $metric) {
          ForEach(Array(visual.metrics.prefix(2).enumerated()), id: \.offset) { index, label in
            Text(label).tag(index)
          }
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 200)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("list-visual-metric")
      }
    }
  }
}

private struct LodyListMixView: View {
  let items: [LodyListVisualItem]

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      GeometryReader { proxy in
        let gaps = CGFloat(max(0, items.count - 1)) * 2
        HStack(spacing: 2) {
          ForEach(Array(items.enumerated()), id: \.offset) { index, item in
            if item.fraction > 0 {
              Rectangle()
                .fill(mixColors[index % mixColors.count])
                .frame(width: max(4, (proxy.size.width - gaps) * item.fraction))
            }
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: 4))
      }
      .frame(height: 14)
      .accessibilityHidden(true)
      VStack(spacing: 0) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 3)
              .fill(mixColors[index % mixColors.count])
              .frame(width: 10, height: 10)
            Text(item.label)
            Spacer(minLength: 8)
            Text(item.value).monospacedDigit()
            Text(item.percent)
              .monospacedDigit()
              .foregroundStyle(.secondary)
              .frame(minWidth: 44, alignment: .trailing)
          }
          .font(.subheadline)
          .frame(minHeight: 32)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(item.label)
          .accessibilityValue(item.accessibilityValue)
        }
      }
    }
  }
}

private let warningText = Color(uiColor: UIColor { traits in
  traits.userInterfaceStyle == .dark ? .systemOrange : UIColor(red: 0.79, green: 0.2, blue: 0, alpha: 1)
})

private struct LodyListQuotasView: View {
  let items: [LodyListVisualItem]
  let dimmed: Bool
  let accent: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
        if index > 0 { Divider().padding(.vertical, 12) }
        LodyListQuotaView(item: item, dimmed: dimmed, accent: accent)
      }
    }
    .padding(.vertical, 6)
  }
}

private struct LodyListQuotaView: View {
  let item: LodyListVisualItem
  let dimmed: Bool
  let accent: Color

  private var warns: Bool { item.tone == "warning" && !dimmed }

  private var fill: Color {
    if dimmed { return Color(uiColor: .systemGray3) }
    return warns ? Color(uiColor: .systemOrange) : accent
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) {
        Text(item.label).lineLimit(1)
        Spacer(minLength: 8)
        Text(item.caption).monospacedDigit().lineLimit(1)
      }
      .font(.footnote)
      .foregroundStyle(.secondary)
      Text(item.value)
        .font(.system(.title2, design: .rounded, weight: .bold))
        .monospacedDigit()
        .foregroundStyle(dimmed ? .secondary : .primary)
        .padding(.top, 2)
        .padding(.bottom, 8)
      GeometryReader { proxy in
        let width = proxy.size.width
        ZStack(alignment: .leading) {
          Capsule().fill(Color(uiColor: .tertiarySystemFill))
          Capsule()
            .fill(fill)
            .frame(width: item.fraction > 0 ? max(8, width * min(1, item.fraction)) : 0)
          if let pace = item.pace, item.fraction < 1, !dimmed {
            RoundedRectangle(cornerRadius: 1)
              .fill(Color.primary)
              .frame(width: 2, height: proxy.size.height)
              .offset(x: min(width - 2, max(0, width * pace - 1)))
          }
        }
      }
      .frame(height: 8)
      .padding(.vertical, 4)
      if !item.detail.isEmpty {
        Label {
          Text(item.detail)
        } icon: {
          if warns { Image(systemName: "exclamationmark.triangle.fill") }
        }
        .labelStyle(QuotaDetailLabelStyle())
        .font(.footnote.weight(warns ? .medium : .regular))
        .foregroundStyle(warns ? warningText : .secondary)
        .padding(.top, 6)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(item.accessibilityLabel)
    .accessibilityIdentifier(item.id)
  }
}

private struct QuotaDetailLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 5) {
      configuration.icon
      configuration.title
    }
  }
}

private struct LodyListSkeletonView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var dim = false

  var body: some View {
    VStack(spacing: 0) {
      ForEach(0..<3, id: \.self) { index in
        if index > 0 { Divider().padding(.leading, 44) }
        HStack(spacing: 14) {
          RoundedRectangle(cornerRadius: 8).frame(width: 29, height: 29)
          VStack(alignment: .leading, spacing: 8) {
            Capsule().frame(width: [150, 120, 170][index], height: 12)
            Capsule().frame(width: [90, 110, 80][index], height: 10)
          }
          Spacer()
        }
        .frame(minHeight: 64)
      }
    }
    .foregroundStyle(Color(uiColor: .tertiarySystemFill))
    .opacity(dim ? 0.5 : 1)
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(String(localized: "native.list.loading", bundle: .lody))
    .accessibilityIdentifier("list-skeleton")
  }
}

struct LodyListNoticeView: View {
  let notice: LodyListNotice
  let tint: Color
  let action: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: notice.symbol)
        .foregroundStyle(tint)
        .accessibilityHidden(true)
      Text(notice.text)
        .font(.subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("list-notice-text")
      if !notice.actionSymbol.isEmpty {
        Button(action: action) {
          Image(systemName: notice.actionSymbol)
            .font(.body.weight(.semibold))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.accentColor)
        .accessibilityLabel(notice.actionLabel)
        .accessibilityIdentifier("list-notice-action")
      }
    }
    .frame(minHeight: 44)
  }
}
