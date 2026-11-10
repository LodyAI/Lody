import LodyCore
import LodyDesignSystem
import SwiftUI

/// Colour and glyph per runtime state group. Only `attention` uses the warning hue; running uses
/// the accent, paused and ended stay neutral.
@MainActor
enum ScheduleTone {
  static func color(_ group: RuntimeContract.ScheduleStateGroup) -> Color {
    switch group {
    case .running: LodyColor.accentDefault
    case .attention: LodyColor.warningDefault
    case .paused, .ended: LodyColor.iconSecondary
    }
  }

  static func fill(_ group: RuntimeContract.ScheduleStateGroup) -> Color {
    switch group {
    case .running: LodyColor.accentSubtle
    case .attention: LodyColor.warningSubtle
    case .paused, .ended: LodyColor.fillSecondary
    }
  }

  static func symbol(_ group: RuntimeContract.ScheduleStateGroup) -> String {
    switch group {
    case .running: "clock.fill"
    case .attention: "exclamationmark.triangle.fill"
    case .paused: "pause.fill"
    case .ended: "checkmark"
    }
  }

  static func label(_ group: RuntimeContract.ScheduleStateGroup) -> String {
    switch group {
    case .running: ScheduleFormat.text("overview.active")
    case .attention: ScheduleFormat.text("overview.attention")
    case .paused: ScheduleFormat.text("overview.paused")
    case .ended: ScheduleFormat.text("overview.ended")
    }
  }

  /// The order list groups follow: what needs a look first.
  static let order: [RuntimeContract.ScheduleStateGroup] = [.attention, .running, .paused, .ended]
}

/// The schedule's Agent mark inside a tinted rounded tile, with the state glyph as a badge.
struct ScheduleMarkView: View {
  let agentType: String?
  let group: RuntimeContract.ScheduleStateGroup
  var size: CGFloat = 40

  var body: some View {
    RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
      .fill(ScheduleTone.fill(group))
      .frame(width: size, height: size)
      .overlay { agent }
      .overlay(alignment: .bottomTrailing) {
        Image(systemName: ScheduleTone.symbol(group))
          .font(.system(size: size * 0.22, weight: .bold))
          .foregroundStyle(.white)
          .frame(width: size * 0.42, height: size * 0.42)
          .background(ScheduleTone.color(group), in: Circle())
          .overlay(Circle().stroke(LodyColor.bgRaised, lineWidth: 2))
          .offset(x: size * 0.12, y: size * 0.12)
      }
      .accessibilityHidden(true)
  }

  @ViewBuilder private var agent: some View {
    let inner = size * 0.5
    switch LodyAgentIcon.mark(cliType: nil, agentType: agentType) {
    case .asset(let name):
      Image(name, bundle: .main).resizable().scaledToFit().frame(width: inner, height: inner)
    case .terminal:
      LodyIcon.terminal.image.resizable().renderingMode(.template).scaledToFit()
        .frame(width: inner, height: inner).foregroundStyle(LodyColor.iconPrimary)
    case .generic:
      LodyIcon.agent.image.resizable().renderingMode(.template).scaledToFit()
        .frame(width: inner, height: inner).foregroundStyle(LodyColor.iconPrimary)
    }
  }
}

/// One list row in the chat row's shape: name with the short state trailing where Chats shows the
/// age; a footnote line with the kind glyph, frequency and computer; a reason line only when the
/// schedule needs a look.
struct ScheduleRowView: View {
  let item: ScheduleItem
  let zone: TimeZone

  var body: some View {
    let status = ScheduleFormat.state(item.state, zone: zone)
    let attention = item.state.group == .attention
    let ended = item.state.group == .ended
    VStack(alignment: .leading, spacing: LodySpacing.xxs) {
      HStack(alignment: .center, spacing: LodySpacing.sm) {
        Text(item.title)
          .lodyTextStyle(.body)
          .foregroundStyle(ended ? LodyColor.textTertiary : LodyColor.textPrimary)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(status.label)
          .lodyTextStyle(.footnote)
          .foregroundStyle(attention ? LodyColor.warningDefault : LodyColor.textTertiary)
          .lineLimit(1)
          .frame(maxWidth: LodyLayout.trailingMetaMaxWidth, alignment: .trailing)
          .fixedSize(horizontal: false, vertical: true)
      }
      HStack(spacing: LodySpacing.xs) {
        ScheduleGlyph(icon: kindIcon, color: LodyColor.iconSecondary)
        Text(ScheduleFormat.summary(item.rule, zone: zone))
          .lodyTextStyle(.footnote).foregroundStyle(LodyColor.textSecondary).lineLimit(1)
        if !machine.isEmpty {
          ScheduleGlyph(icon: .desktop, color: LodyColor.iconTertiary).padding(.leading, LodySpacing.xs)
          Text(machine).lodyTextStyle(.footnote).foregroundStyle(LodyColor.textTertiary).lineLimit(1)
        }
        Spacer(minLength: 0)
      }
      if attention || item.state.kind == .blocked, let detail = status.detail, !detail.isEmpty {
        Text(detail)
          .lodyTextStyle(.footnote)
          .foregroundStyle(LodyColor.warningDefault)
          .lineLimit(2)
      }
    }
    .padding(.horizontal, LodyLayout.listEdgeX)
    .padding(.vertical, LodySpacing.sm)
    .frame(maxWidth: .infinity, minHeight: LodySize.listRow, alignment: .leading)
    .accessibilityHidden(true)
  }

  /// A message, a manual task or a timed task.
  private var kindIcon: LodyIcon {
    if item.scheduledMessage { return .session }
    return item.rule.kind == .manual ? .hand : .clock
  }

  private var machine: String {
    [item.machineName ?? "", item.projectName ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
  }
}

/// A Lucide glyph at the chat detail line's size.
struct ScheduleGlyph: View {
  let icon: LodyIcon
  var color: Color = LodyColor.iconSecondary

  var body: some View {
    icon.image.resizable().renderingMode(.template).foregroundStyle(color)
      .frame(width: LodyIconSize.sm, height: LodyIconSize.sm)
  }
}

/// The Chats group label: tertiary `groupLabel` text at the screen's reading edge.
struct ScheduleSectionTitle: View {
  let text: String

  var body: some View {
    Text(text)
      .lodyTextStyle(.groupLabel)
      .foregroundStyle(LodyColor.textTertiary)
      .padding(.horizontal, LodyLayout.listEdgeX)
      .padding(.vertical, LodySpacing.xs)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityAddTraits(.isHeader)
  }
}

struct ScheduleInlineLabel: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: LodySpacing.xs) {
      configuration.icon.font(.system(size: 11, weight: .semibold)).foregroundStyle(LodyColor.iconTertiary)
      configuration.title
    }
  }
}

/// The editor's header card for a stored schedule: state, rule summary, last run, and quick
/// actions (owner only; run and resume need a computer whose CLI runs schedules).
struct ScheduleHeroView: View {
  struct Action: Identifiable {
    let id: String
    let title: String
    let symbol: String
    let enabled: Bool
    let perform: () -> Void
  }

  let item: ScheduleItem
  let zone: TimeZone
  let actions: [Action]

  var body: some View {
    let status = ScheduleFormat.state(item.state, zone: zone)
    let group = item.state.group
    VStack(alignment: .leading, spacing: LodySpacing.md) {
      HStack(alignment: .center, spacing: LodySpacing.md) {
        ScheduleMarkView(agentType: item.agentType, group: group, size: 52)
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 5) {
            Circle().fill(ScheduleTone.color(group)).frame(width: 7, height: 7)
            Text(status.label)
              .lodyTextStyle(.bodySmall)
              .fontWeight(.semibold)
              .foregroundStyle(group == .attention ? LodyColor.warningDefault : LodyColor.textPrimary)
              .lineLimit(2)
          }
          if let detail = status.detail, !detail.isEmpty {
            Text(detail)
              .lodyTextStyle(.footnote)
              .foregroundStyle(group == .attention ? LodyColor.warningDefault : LodyColor.textSecondary)
              .lineLimit(3)
          }
          Text(ScheduleFormat.summary(item.rule, zone: zone))
            .lodyTextStyle(.footnote)
            .foregroundStyle(LodyColor.textSecondary)
            .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      if !facts.isEmpty {
        HStack(spacing: LodySpacing.sm) {
          ForEach(facts, id: \.symbol) { fact in
            Label(fact.text, systemImage: fact.symbol)
              .labelStyle(ScheduleInlineLabel())
              .lodyTextStyle(.caption)
              .foregroundStyle(LodyColor.textSecondary)
              .lineLimit(1)
              .padding(.horizontal, LodySpacing.sm)
              .padding(.vertical, 5)
              .background(LodyColor.fillSecondary, in: Capsule())
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      if !actions.isEmpty {
        HStack(spacing: LodySpacing.sm) {
          ForEach(actions) { action in
            Button(action: action.perform) {
              VStack(spacing: 5) {
                Image(systemName: action.symbol).font(.system(size: 17, weight: .semibold))
                Text(action.title).lodyTextStyle(.caption).fontWeight(.medium).lineLimit(1).minimumScaleFactor(0.8)
              }
              .foregroundStyle(action.enabled ? LodyColor.accentDefault : LodyColor.textDisabled)
              .frame(maxWidth: .infinity, minHeight: 58)
              .background(LodyColor.fillSecondary, in: RoundedRectangle(cornerRadius: LodyRadius.lg, style: .continuous))
              .contentShape(RoundedRectangle(cornerRadius: LodyRadius.lg, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!action.enabled)
            .accessibilityIdentifier(action.id)
          }
        }
      }
    }
    .padding(LodySpacing.lg)
    .background(Color(uiColor: .lodyOpaqueCard), in: RoundedRectangle(cornerRadius: LodyRadius.xl, style: .continuous))
    .padding(.horizontal, LodyLayout.listEdgeX)
  }

  private var facts: [(symbol: String, text: String)] {
    var result: [(symbol: String, text: String)] = []
    if let machine = item.machineName, !machine.isEmpty { result.append(("desktopcomputer", machine)) }
    if let last = item.lastRunAt {
      result.append(("clock.arrow.circlepath", String(format: ScheduleFormat.text("lastRun"), LodyRelativeTime.compact(last, now: LodyRelativeTime.now()))))
    }
    return result
  }
}

/// Days of the month wrap to preserve comfortable native touch targets.
struct ScheduleMonthDaysView: View {
  let selected: Set<Int>
  let enabled: Bool
  let toggle: (Int) -> Void

  var body: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 6)], spacing: 6) {
      ForEach(1...31, id: \.self) { day in
        let on = selected.contains(day)
        Button { toggle(day) } label: {
          Text("\(day)")
            .font(.system(.subheadline, design: .rounded).weight(on ? .semibold : .regular))
            .monospacedDigit()
            .foregroundStyle(on ? LodyColor.textOnAccent : LodyColor.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(on ? LodyColor.accentDefault : LodyColor.fillSecondary, in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(String(format: ScheduleFormat.text("repeat.dayOfMonthN"), String(day)))
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("schedule-day-\(day)")
      }
    }
    .padding(.horizontal, LodyFormGroup.margin)
    .padding(.vertical, LodySpacing.md)
    .opacity(enabled ? 1 : 0.5)
  }
}
