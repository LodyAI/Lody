import LodyDesignSystem
import SwiftUI
import UIKit

/// One action in a bar menu; `subtitle` reads as the system menu's second line.
struct ChatMenuAction: Decodable, Equatable, Identifiable {
  let id: String
  let title: String
  let symbol: String
  var value: String?
  var subtitle: String?
  var destructive: Bool?
  var disabled: Bool?
}

/// Web `SessionInfoBar` for the native composer, as grouped glass capsules above the input:
/// the computer and live resources, the repository context with ±diff, and the repository
/// action. Colour is kept for status (PR state, CI, diff), so Send stays the one accent on screen.
struct ChatActionBarState: Decodable, Equatable {
  #if !LODY_SHARE_EXTENSION
  struct Machine: Decodable, Equatable {
    let id: String
    let workspaceId: String
    let status: String
    let members: [WorkspaceMember]
  }

  #endif

  struct Item: Decodable, Equatable, Identifiable {
    let id: String
    let symbol: String
    var tint: String?
    /// Connecting: a spinner replaces the glyph.
    var busy: Bool?
    /// An optional count beside a resource glyph.
    var badge: String?
    let accessibilityLabel: String
    /// Tap acts on the item itself; its menu (if any) opens on a long press.
    var tap: Bool?
    var menuTitle: String?
    var actions: [ChatMenuAction]?
  }

  struct Context: Decodable, Equatable {
    let label: String
    let symbol: String
    var tint: String?
    let accessibilityLabel: String
    var menuTitle: String?
    var repository: String?
    var prStatus: String?
    var prCI: String?
    /// A PR write (merge, ready for review) is in flight: a spinner replaces the PR mark.
    var busy: Bool?
    let actions: [ChatMenuAction]
    /// A Project group: the popover lists these instead of one repository's actions.
    var menuSubtitle: String?
    var members: [Member]?
  }

  /// One repository or folder of a Project group conversation.
  struct Member: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    /// `github` or `local`.
    let kind: String
    let depth: Int
    let submodule: Bool
    /// Path (when it differs from the title) · branch, or the in-place note.
    var detail: String?
    var repository: String?
    var branch: String?
    var added: Int?
    var removed: Int?
    var prNumber: Int?
    var prStatus: String?
    var prCI: String?
  }

  struct Diff: Decodable, Equatable {
    let added: Int
    let removed: Int
    let accessibilityLabel: String
    /// Opens the workspace changes; otherwise the counts are display only.
    var tap: Bool?
  }

  /// The top repository action; [more] holds the rest in priority order.
  struct Primary: Decodable, Equatable {
    let label: String
    var busy: Bool?
    /// The primary action itself opens a choice, such as the merge-method picker.
    var disclosure: Bool?
    let more: [ChatMenuAction]
    let moreLabel: String
  }

  var items: [Item]?
  var context: Context?
  var diff: Diff?
  var primary: Primary?

  var isEmpty: Bool { (items ?? []).isEmpty && context == nil && diff == nil && primary == nil }
}

/// Three glass capsules grouped by purpose, so the composer stays the only full-width shape:
/// environment (computer and live resources), context (PR or branch with ±diff) and the
/// repository action, pinned trailing. Never scrolls: `ViewThatFits` takes the first stage that
/// fits on one line — long labels capped, then the diff hidden, then the environment folded
/// into one icon with a "+n" badge — and only at very large text moves the action to its own row.
struct ChatActionBarContent: View {
  var state = ChatActionBarState()
  var onAction: (String) -> Void = { _ in }
  var onPrimaryFrame: (CGRect) -> Void = { _ in }
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    GlassEffectContainer(spacing: 8) {
      ViewThatFits(in: .horizontal) {
        row(diffDot: false, folded: false)
        row(diffDot: true, folded: false)
        row(diffDot: true, folded: true)
        // ViewThatFits shows its last choice when none fits. At ordinary sizes that is still one
        // row, where the context label truncates as far as needed; only accessibility text sizes
        // give the action its own line.
        if typeSize.isAccessibilitySize {
          stacked
        } else {
          row(diffDot: true, folded: true)
        }
      }
    }
    .font(.subheadline)
    .coordinateSpace(name: "chat-action-bar")
    .onPreferenceChange(PrimaryActionFrame.self, perform: onPrimaryFrame)
  }

  private func row(diffDot: Bool, folded: Bool) -> some View {
    HStack(spacing: 8) {
      leading(diffDot: diffDot, folded: folded)
      Spacer(minLength: 0)
      if let primary = state.primary { primaryCapsule(primary) }
    }
    .frame(height: ChatActionBarView.rowHeight)
  }

  /// Last resort at very large text: information on the first line (the context truncates), the
  /// action whole on its own trailing line.
  private var stacked: some View {
    VStack(alignment: .trailing, spacing: 8) {
      HStack(spacing: 8) {
        leading(diffDot: true, folded: true)
        Spacer(minLength: 0)
      }
      .frame(minHeight: ChatActionBarView.rowHeight)
      if let primary = state.primary { primaryCapsule(primary) }
    }
  }

  @ViewBuilder private func leading(diffDot: Bool, folded: Bool) -> some View {
    if !environment.isEmpty {
      if folded && environment.count > 1 { foldedEnvironment } else { environmentCapsule }
    }
    if state.context != nil || state.diff != nil { contextCapsule(diffDot: diffDot) }
  }

  // MARK: Environment

  /// Computer and live resources; tasks are shown in the transcript.
  private var environment: [ChatActionBarState.Item] { state.items ?? [] }

  private var environmentCapsule: some View {
    HStack(spacing: 0) {
      ForEach(environment) { item($0) }
    }
    .padding(.horizontal, 2)
    .glassEffect(.regular, in: .capsule)
    .fixedSize()
  }

  /// One icon stands for the group: a computer in trouble first, then a live resource, then
  /// the first item; the menu lists every item.
  private var foldedEnvironment: some View {
    let items = environment
    let lead = items.first { $0.id == "machine" && $0.tint == "warning" }
      ?? items.first { ["browser", "simulator", "emulator"].contains($0.id) }
      ?? items[0]
    return Menu {
      ForEach(items) { item in
        Button {
          open(item)
        } label: { Label(item.accessibilityLabel, systemImage: item.symbol) }
      }
    } label: {
      HStack(spacing: 2) {
        glyph(lead)
        Text("+\(items.count - 1)").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(LodyColor.iconSecondary)
          .padding(.trailing, 8)
      }
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 2)
    .glassEffect(.regular, in: .capsule)
    .fixedSize()
    .accessibilityLabel(items.map(\.accessibilityLabel).joined(separator: ", "))
    .accessibilityIdentifier("session-bar:environment")
  }

  private func open(_ item: ChatActionBarState.Item) {
    onAction(item.id)
  }

  @ViewBuilder private func item(_ item: ChatActionBarState.Item) -> some View {
    resourceItem(item)
    .buttonStyle(.plain)
    .accessibilityLabel(item.accessibilityLabel)
    .accessibilityIdentifier(Self.identifier(item.id))
  }

  @ViewBuilder private func resourceItem(_ item: ChatActionBarState.Item) -> some View {
    let actions = item.actions ?? []
    if actions.isEmpty {
      Button { open(item) } label: { glyph(item) }
    } else if item.tap == true {
      Menu { menu(actions, prefix: item.id, title: item.menuTitle) } label: { glyph(item) } primaryAction: { open(item) }
    } else {
      Menu { menu(actions, prefix: item.id, title: item.menuTitle) } label: { glyph(item) }
    }
  }

  private static func identifier(_ id: String) -> String {
    switch id {
    case "browser", "simulator", "emulator": "session-preview"
    default: "session-bar:" + id
    }
  }

  private func glyph(_ item: ChatActionBarState.Item) -> some View {
    HStack(spacing: 3) {
      if item.busy == true {
        ProgressView().controlSize(.small)
      } else {
        Image(systemName: item.symbol).foregroundStyle(Self.tint(item.tint))
      }
      if let badge = item.badge {
        Text(badge).monospacedDigit().foregroundStyle(LodyColor.iconSecondary)
      }
    }
    .padding(.horizontal, item.badge == nil ? 0 : 6)
    .frame(minWidth: ChatActionBarView.rowHeight, minHeight: ChatActionBarView.rowHeight)
    .contentShape(Rectangle())
  }

  // MARK: Context

  /// PR or branch with the ±diff. Long labels are capped; once space runs short the diff becomes
  /// hidden counts that remain available in the menu.
  @ViewBuilder private func contextCapsule(diffDot: Bool) -> some View {
    if let context = state.context, let members = context.members {
      groupCapsule(context, members: members, diffDot: diffDot)
    } else {
      repositoryCapsule(diffDot: diffDot)
    }
  }

  /// A Project group: the repository and PR counts with the group-wide ±diff; the popover lists
  /// every member.
  private func groupCapsule(_ context: ChatActionBarState.Context, members: [ChatActionBarState.Member], diffDot: Bool) -> some View {
    let label = HStack(spacing: 6) {
      LodyIcon.projectGroup.image
        .resizable().renderingMode(.template).scaledToFit().frame(width: LodyIconSize.sm, height: LodyIconSize.sm)
        .foregroundStyle(Self.tint(context.tint))
      Text(context.label).lineLimit(1).foregroundStyle(LodyColor.textPrimary)
        .frame(maxWidth: 160, alignment: .leading).fixedSize(horizontal: true, vertical: false)
      if let diff = state.diff, !diffDot {
        HStack(spacing: 4) {
          Text("+\(diff.added)").foregroundStyle(LodyColor.diffAddedText)
          Text("−\(diff.removed)").foregroundStyle(LodyColor.diffRemovedText)
        }
        .font(.subheadline.weight(.medium).monospacedDigit())
        .fixedSize()
      }
      Image(systemName: "chevron.down")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(LodyColor.iconSecondary)
    }
    .padding(.horizontal, 12)
    .frame(minHeight: ChatActionBarView.rowHeight)
    .contentShape(Capsule())
    return GroupMembersPopover(
      title: context.menuTitle ?? "", subtitle: context.menuSubtitle ?? "", members: members, diff: state.diff,
      onAction: { onAction("context:" + $0) }, label: label
    )
    .buttonStyle(.plain)
    .glassEffect(.regular, in: .capsule)
    .accessibilityLabel([context.accessibilityLabel, state.diff?.accessibilityLabel].compactMap { $0 }.joined(separator: ", "))
    .accessibilityIdentifier("session-bar:context")
  }

  private func repositoryCapsule(diffDot: Bool) -> some View {
    let context = state.context
    var actions = context?.actions ?? []
    if let diff = state.diff, diff.tap == true {
      actions.insert(.init(
        id: "diff", title: String(localized: "workspaceChanges.menuTitle", bundle: .lody), symbol: "plus.forwardslash.minus"
      ), at: actions.first?.id == "pr" ? 1 : 0)
    }
    let label = HStack(spacing: 6) {
      if let context {
          if context.busy == true {
            ProgressView().controlSize(.small)
          } else if let status = context.prStatus, !status.isEmpty {
            LodyPullRequestIcon(status: status, ci: context.prCI)
          } else {
            Image(systemName: context.symbol).foregroundStyle(Self.tint(context.tint))
          }
          Text(context.label).lineLimit(1).truncationMode(.middle).foregroundStyle(LodyColor.textPrimary)
            .frame(maxWidth: 140, alignment: .leading).fixedSize(horizontal: true, vertical: false)
        }
        if let diff = state.diff {
          if !diffDot || context == nil {
            HStack(spacing: 4) {
              Text("+\(diff.added)").foregroundStyle(LodyColor.diffAddedText)
              Text("−\(diff.removed)").foregroundStyle(LodyColor.diffRemovedText)
            }
            .font(.subheadline.weight(.medium).monospacedDigit())
            .fixedSize()
          }
        }
        if actions.count > 1 {
          Image(systemName: "chevron.down")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(LodyColor.iconSecondary)
        }
      }
      .padding(.horizontal, 12)
      .frame(minHeight: ChatActionBarView.rowHeight)
      .contentShape(Capsule())
    return ContextActionsPopover(
      actions: actions, title: context?.menuTitle, repository: context?.repository, diff: state.diff, prStatus: context?.prStatus, prCI: context?.prCI,
      onAction: { onAction("context:" + $0) }, label: label
    )
    .buttonStyle(.plain)
    .glassEffect(.regular, in: .capsule)
    .accessibilityLabel([context?.accessibilityLabel, state.diff?.accessibilityLabel].compactMap { $0 }.joined(separator: ", "))
    .accessibilityIdentifier("session-bar:context")
  }

  // MARK: Action

  /// Web's primary action + chevron as one neutral capsule with a soft internal divider. The
  /// label never truncates.
  private func primaryCapsule(_ primary: ChatActionBarState.Primary) -> some View {
    HStack(spacing: 0) {
      Button {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onAction("act")
      } label: {
        HStack(spacing: 8) {
          if primary.busy == true { ProgressView().controlSize(.small) }
          Text(primary.label)
          if primary.disclosure == true && primary.more.isEmpty && primary.busy != true {
            Image(systemName: "chevron.down").font(.footnote.weight(.semibold))
          }
        }
          .fontWeight(.semibold)
          .lineLimit(1)
          .padding(.leading, 14)
          .padding(.trailing, primary.more.isEmpty ? 14 : 8)
          .frame(minHeight: ChatActionBarView.rowHeight)
          .contentShape(Rectangle())
      }
      .background(GeometryReader { geometry in
        Color.clear.preference(key: PrimaryActionFrame.self, value: geometry.frame(in: .named("chat-action-bar")))
      })
      .accessibilityIdentifier("session-bar:act")
      if !primary.more.isEmpty {
        Divider().frame(height: 16)
        Menu { menu(primary.more, prefix: "more", title: nil) } label: {
          Image(systemName: "chevron.down")
            .font(.footnote.weight(.semibold))
            .padding(.leading, 8)
            .padding(.trailing, 12)
            .frame(minHeight: ChatActionBarView.rowHeight)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(primary.moreLabel)
        .accessibilityIdentifier("session-bar:more")
      }
    }
    .buttonStyle(.plain)
    .disabled(primary.busy == true)
    .foregroundStyle(LodyColor.textPrimary)
    .fixedSize()
    .glassEffect(.regular.interactive(), in: .capsule)
  }

  // MARK: Menus

  @ViewBuilder private func menu(_ actions: [ChatMenuAction], prefix: String, title: String?) -> some View {
    if let title, !title.isEmpty {
      Section(title) { menuItems(actions, prefix: prefix) }
    } else {
      menuItems(actions, prefix: prefix)
    }
  }

  private func menuItems(_ actions: [ChatMenuAction], prefix: String) -> some View {
    ForEach(actions) { action in
      Button(role: action.destructive == true ? .destructive : nil) { onAction(prefix + ":" + action.id) } label: {
        Label {
          Text(action.title)
          if let subtitle = action.subtitle { Text(subtitle) }
        } icon: {
          Image(systemName: action.symbol)
        }
      }
      .disabled(action.disabled == true)
    }
  }

  static func tint(_ name: String?) -> Color {
    switch name {
    case "open": LodyColor.prOpen
    case "merged": LodyColor.prMerged
    case "closed": LodyColor.prClosed
    case "draft": LodyColor.prDraft
    case "warning": LodyColor.warningDefault
    case "danger": LodyColor.dangerDefault
    case "primary": LodyColor.textPrimary
    default: LodyColor.iconSecondary
    }
  }
}

/// UIKit host for the bar inside the composer. One row is `rowHeight`; at very large text the
/// stacked fallback is taller, so the composer asks for `fittingHeight(width:)`.
final class ChatActionBarView: UIView {
  static let rowHeight: CGFloat = 36

  private let host = UIHostingController(rootView: ChatActionBarContent())
  private var rendered: ChatActionBarState?
  var onAction: ((String) -> Void)?
  private(set) var primaryFrame: CGRect = .zero

  override init(frame: CGRect) {
    super.init(frame: frame)
    accessibilityIdentifier = "session-action-bar"
    host.safeAreaRegions = []
    host.sizingOptions = []
    host.view.backgroundColor = .clear
    host.view.isOpaque = false
    host.view.translatesAutoresizingMaskIntoConstraints = false
    addSubview(host.view)
    NSLayoutConstraint.activate([
      host.view.topAnchor.constraint(equalTo: topAnchor),
      host.view.leadingAnchor.constraint(equalTo: leadingAnchor),
      host.view.trailingAnchor.constraint(equalTo: trailingAnchor),
      host.view.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    alpha = 0
    isHidden = true
  }

  required init?(coder: NSCoder) { fatalError() }

  /// Whether the bar has anything to show for this state.
  static func shows(_ state: ChatActionBarState?) -> Bool { !(state?.isEmpty ?? true) }

  /// The height the chosen stage needs at this width: one row, or two at very large text.
  func fittingHeight(width: CGFloat) -> CGFloat {
    guard width > 0 else { return Self.rowHeight }
    let size = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
    return max(Self.rowHeight, ceil(size.height))
  }

  func render(_ state: ChatActionBarState?, visible: Bool, animated: Bool) {
    let state = state ?? ChatActionBarState()
    if rendered != state {
      rendered = state
      let content = ChatActionBarContent(
        state: state,
        onAction: { [weak self] in self?.onAction?($0) },
        onPrimaryFrame: { [weak self] in self?.primaryFrame = $0 }
      )
      // Glass capsules morph between stages and as groups come and go.
      if animated && window != nil && !UIAccessibility.isReduceMotionEnabled {
        withAnimation(.smooth(duration: 0.3)) { host.rootView = content }
      } else {
        host.rootView = content
      }
    }
    let shown = visible && Self.shows(state)
    guard isUserInteractionEnabled != shown || isHidden == shown else { return }
    isUserInteractionEnabled = shown
    accessibilityElementsHidden = !shown
    if shown { isHidden = false }
    let update = { self.alpha = shown ? 1 : 0 }
    if animated && window != nil && !UIAccessibility.isReduceMotionEnabled {
      UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: update) { _ in
        self.isHidden = !self.isUserInteractionEnabled
      }
    } else {
      update()
      isHidden = !shown
    }
  }
}

/// Native popover content keeps semantic diff colours, which system menu titles discard.
private struct ContextActionsPopover<Label: View>: View {
  let actions: [ChatMenuAction]
  let title: String?
  let repository: String?
  let diff: ChatActionBarState.Diff?
  let prStatus: String?
  let prCI: String?
  let onAction: (String) -> Void
  let label: Label
  @State private var presented = false

  private var actionLabelWidth: CGFloat {
    let font = UIFont.preferredFont(forTextStyle: .body)
    return ceil(actions.filter { $0.id != "branch" }.map {
      ($0.title as NSString).size(withAttributes: [.font: font]).width
    }.max() ?? 0)
  }

  var body: some View {
    label
      .accessibilityElement(children: .ignore)
      .onTapGesture { presented = true }
      .onLongPressGesture { presented = true }
      .accessibilityAddTraits(.isButton)
      .popover(isPresented: $presented, arrowEdge: .bottom) {
        VStack(alignment: .leading, spacing: LodySpacing.xs) {
          if let title, !title.isEmpty {
            HStack(spacing: LodySpacing.xs) {
              if let repository, !repository.isEmpty {
                RepositoryIcon(repository: repository, size: LodyIconSize.md, opacity: 0.8)
              } else {
                Image(systemName: "folder").accessibilityHidden(true)
              }
              Text(title).lineLimit(1).truncationMode(.middle)
            }
            .font(.subheadline).foregroundStyle(LodyColor.textSecondary)
            .padding(.horizontal, LodySpacing.md)
            .padding(.top, LodySpacing.xs)
          }
          if let branch = actions.first(where: { $0.id == "branch" }) {
            HStack(spacing: LodySpacing.xs) {
              Text(String(localized: "bar.context.currentBranch", bundle: .lody))
                .font(.footnote).foregroundStyle(LodyColor.textSecondary)
                .fixedSize()
              Text(branch.title).font(.footnote).foregroundStyle(LodyColor.textSecondary)
                .lineLimit(1).truncationMode(.middle)
              Spacer(minLength: 0)
              Button {
                presented = false
                onAction(branch.id)
              } label: {
                Image(systemName: branch.symbol).font(.footnote)
                  .frame(width: 44, height: 44)
                  .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .foregroundStyle(LodyColor.iconSecondary)
              .accessibilityLabel(String(localized: "session.title.copyBranch", bundle: .lody))
            }
            .padding(.leading, LodySpacing.md)
          }
          ForEach(actions.filter { $0.id != "branch" }) { action in
            Button {
              presented = false
              onAction(action.id)
            } label: {
              HStack(spacing: LodySpacing.md) {
                if action.id == "pr", let status = prStatus {
                  LodyPullRequestIcon(status: status, ci: prCI, size: LodyIconSize.md)
                } else {
                  Image(systemName: action.symbol).frame(width: LodyIconSize.md)
                }
                Text(action.title).lineLimit(1)
                  .frame(width: actionLabelWidth, alignment: .leading)
                HStack(spacing: LodySpacing.xs) {
                  if let value = action.value { Text(verbatim: value) }
                  if action.id == "diff", let diff {
                    Text("+\(diff.added)").foregroundStyle(LodyColor.diffAddedText)
                    Text("−\(diff.removed)").foregroundStyle(LodyColor.diffRemovedText)
                  }
                }
                .fixedSize()
                Spacer(minLength: 0)
              }
              .font(.body.monospacedDigit())
              .frame(minHeight: 44)
              .padding(.horizontal, LodySpacing.md)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(action.disabled == true)
            .foregroundStyle(LodyColor.textPrimary)
          }
        }
        .padding(LodySpacing.sm)
        .frame(width: 320)
        .fixedSize(horizontal: false, vertical: true)
        .presentationCompactAdaptation(.popover)
      }
  }
}

/// The members of a Project group conversation, each with its branch, ±diff and current PR
/// (web `SessionProjectMembersChip`). Every PR stays visible at once; a PR row opens that PR's
/// page, and a member without one offers its branch to copy.
private struct GroupMembersPopover<Label: View>: View {
  let title: String
  let subtitle: String
  let members: [ChatActionBarState.Member]
  let diff: ChatActionBarState.Diff?
  let onAction: (String) -> Void
  let label: Label
  @State private var presented = false

  var body: some View {
    label
      .accessibilityElement(children: .ignore)
      .onTapGesture { presented = true }
      .onLongPressGesture { presented = true }
      .accessibilityAddTraits(.isButton)
      .popover(isPresented: $presented, arrowEdge: .bottom) {
        VStack(alignment: .leading, spacing: LodySpacing.xs) {
          VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(LodyColor.textPrimary).lineLimit(1)
            Text(subtitle).font(.footnote).foregroundStyle(LodyColor.textSecondary).lineLimit(1)
          }
          .padding(.horizontal, LodySpacing.md)
          .padding(.top, LodySpacing.xs)
          ScrollView {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(members) { row($0) }
            }
          }
          .scrollBounceBehavior(.basedOnSize)
          .frame(maxHeight: 360)
          if let diff, diff.tap == true {
            Divider().padding(.horizontal, LodySpacing.md)
            Button {
              presented = false
              onAction("diff")
            } label: {
              HStack(spacing: LodySpacing.md) {
                Image(systemName: "plus.forwardslash.minus").frame(width: LodyIconSize.md)
                Text(String(localized: "bar.group.allChanges", bundle: .lody)).lineLimit(1)
                Spacer(minLength: 0)
                Text("+\(diff.added)").foregroundStyle(LodyColor.diffAddedText)
                Text("−\(diff.removed)").foregroundStyle(LodyColor.diffRemovedText)
              }
              .font(.body.monospacedDigit())
              .frame(minHeight: 44)
              .padding(.horizontal, LodySpacing.md)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(LodyColor.textPrimary)
            .accessibilityIdentifier("session-bar:group-diff")
          }
        }
        .padding(LodySpacing.sm)
        .frame(width: 340)
        .fixedSize(horizontal: false, vertical: true)
        .presentationCompactAdaptation(.popover)
      }
  }

  @ViewBuilder private func row(_ member: ChatActionBarState.Member) -> some View {
    let content = HStack(alignment: .center, spacing: LodySpacing.sm) {
      icon(member).frame(width: LodyIconSize.md, height: LodyIconSize.md)
      VStack(alignment: .leading, spacing: 2) {
        Text(member.title).font(.subheadline.monospaced()).foregroundStyle(LodyColor.textPrimary)
          .lineLimit(1).truncationMode(.middle)
        HStack(spacing: LodySpacing.xs) {
          if let detail = member.detail, !detail.isEmpty {
            Text(detail).lineLimit(1).truncationMode(.middle).foregroundStyle(LodyColor.textSecondary)
          }
          if let added = member.added, let removed = member.removed {
            Text("+\(added)").foregroundStyle(LodyColor.diffAddedText).fixedSize()
            Text("−\(removed)").foregroundStyle(LodyColor.diffRemovedText).fixedSize()
          }
        }
        .font(.footnote.monospacedDigit())
      }
      Spacer(minLength: 0)
      if let number = member.prNumber, let status = member.prStatus {
        HStack(spacing: 4) {
          LodyPullRequestIcon(status: status, ci: member.prCI)
          Text(verbatim: "#\(number)").font(.subheadline.monospacedDigit()).foregroundStyle(LodyColor.textSecondary)
        }
        .fixedSize()
      } else if member.branch != nil {
        Button {
          presented = false
          onAction("memberBranch:" + member.id)
        } label: {
          Image(systemName: "doc.on.doc").font(.footnote)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(LodyColor.iconSecondary)
        .accessibilityLabel(String(localized: "session.title.copyBranch", bundle: .lody))
      }
    }
    .padding(.leading, LodySpacing.md + CGFloat(member.depth) * 14)
    .padding(.trailing, LodySpacing.md)
    .frame(minHeight: 52)
    .contentShape(Rectangle())
    if member.prNumber != nil {
      Button {
        presented = false
        onAction("member:" + member.id)
      } label: { content }
      .buttonStyle(.plain)
      .accessibilityElement(children: .combine)
      .accessibilityHint(Text(String(localized: "bar.context.viewPR", bundle: .lody)))
      .accessibilityIdentifier("session-bar:member:" + member.id)
    } else {
      content
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session-bar:member:" + member.id)
    }
  }

  @ViewBuilder private func icon(_ member: ChatActionBarState.Member) -> some View {
    if member.submodule {
      Image(systemName: "arrow.triangle.branch").foregroundStyle(LodyColor.iconSecondary)
    } else if let repository = member.repository, member.kind == "github" {
      RepositoryIcon(repository: repository, size: LodyIconSize.md, opacity: 0.8)
    } else {
      Image(systemName: "folder").foregroundStyle(LodyColor.iconSecondary)
    }
  }
}

private struct PrimaryActionFrame: PreferenceKey {
  static let defaultValue: CGRect = .zero
  static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
    let next = nextValue()
    if !next.isEmpty { value = next }
  }
}

/// A native anchored menu rather than an action sheet's oversized pill buttons.
final class MergeOptionsController: UIHostingController<MergeOptionsContent>, UIPopoverPresentationControllerDelegate {
  /// The last method chosen, shared by the action bar and the PR page (web `usePreferredPrMergeMethod`).
  static let preferenceKey = "lody.prMergeMethod"
  static var preferred: String { UserDefaults.standard.string(forKey: preferenceKey) ?? "merge" }

  init(title: String, preferred: String, source: UIView, rect: CGRect, onMerge: @escaping (String) -> Void) {
    super.init(rootView: MergeOptionsContent(title: title, preferred: MergeOptionsController.method(preferred), onMerge: { _ in }))
    configure(onMerge)
    popoverPresentationController?.sourceView = source
    popoverPresentationController?.sourceRect = rect
  }

  /// Anchored to a toolbar item (the PR page's Merge button).
  init(title: String, preferred: String, item: UIBarButtonItem, onMerge: @escaping (String) -> Void) {
    super.init(rootView: MergeOptionsContent(title: title, preferred: MergeOptionsController.method(preferred), onMerge: { _ in }))
    configure(onMerge)
    popoverPresentationController?.sourceItem = item
  }

  private static func method(_ value: String) -> String { ["merge", "squash", "rebase"].contains(value) ? value : "merge" }

  private func configure(_ onMerge: @escaping (String) -> Void) {
    rootView.onMerge = { [weak self] method in
      UserDefaults.standard.set(method, forKey: Self.preferenceKey)
      self?.dismiss(animated: true) { onMerge(method) }
    }
    modalPresentationStyle = .popover
    view.backgroundColor = .clear
    preferredContentSize = sizeThatFits(in: CGSize(width: 300, height: CGFloat.greatestFiniteMagnitude))
    popoverPresentationController?.permittedArrowDirections = .down
    popoverPresentationController?.delegate = self
  }
  @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
  func adaptivePresentationStyle(for controller: UIPresentationController) -> UIModalPresentationStyle { .none }
  func adaptivePresentationStyle(for controller: UIPresentationController, traitCollection: UITraitCollection) -> UIModalPresentationStyle { .none }
}

struct MergeOptionsContent: View {
  let title: String
  let preferred: String
  var onMerge: (String) -> Void
  private var methods: [String] { [preferred] + ["merge", "squash", "rebase"].filter { $0 != preferred } }
  /// One SF Symbol per method so the rows read apart at a glance.
  private static let symbols = ["merge": "arrow.triangle.merge", "squash": "rectangle.compress.vertical", "rebase": "square.stack.3d.up"]
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: LodySpacing.xs) {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(LodyColor.textPrimary).lineLimit(2)
        Text(String(localized: "bar.merge.message", bundle: .lody))
          .font(.footnote).foregroundStyle(LodyColor.textSecondary).fixedSize(horizontal: false, vertical: true)
      }
      .padding(LodySpacing.md)
      Divider().padding(.horizontal, LodySpacing.md)
      ForEach(methods, id: \.self) { method in
        Button { onMerge(method) } label: {
          HStack(spacing: LodySpacing.md) {
            Image(systemName: Self.symbols[method] ?? "arrow.triangle.merge")
              .font(.body).frame(width: 24).foregroundStyle(LodyColor.iconSecondary)
            Text(String(localized: String.LocalizationValue("bar.merge." + method), bundle: .lody))
              .font(.body).frame(maxWidth: .infinity, alignment: .leading)
            if method == preferred { Image(systemName: "checkmark").font(.footnote.weight(.semibold)).foregroundStyle(LodyColor.iconSecondary) }
          }
          .padding(.horizontal, LodySpacing.md)
          .padding(.vertical, LodySpacing.sm)
          .frame(minHeight: LodySize.listRow)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(LodyColor.textPrimary)
        .accessibilityIdentifier("merge-method:" + method)
      }
    }
    .padding(LodySpacing.sm)
    .frame(width: 300)
    .fixedSize(horizontal: false, vertical: true)
  }
}

#if !LODY_SHARE_EXTENSION
// The Share extension reuses composer chrome but has no conversation machine panel.
/// Read-only machine details, fetched on presentation from the public visibility endpoint.
struct ChatMachinePanel: View {
  let name: String
  let machine: ChatActionBarState.Machine
  @State private var ownerID: String?
  private var owner: WorkspaceMember? { machine.members.first { $0.id == ownerID } }
  @State private var shared: Bool?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: "desktopcomputer")
        Text(name).fontWeight(.medium).lineLimit(1)
        Spacer(minLength: 8)
        Label(String(localized: String.LocalizationValue("devices." + machine.status), bundle: .lody),
          systemImage: machine.status == "online" ? "circle.fill" : "circle")
          .font(.caption).foregroundStyle(.secondary)
      }
      HStack(spacing: 8) {
        if let owner {
          ChatOwnerAvatar(member: owner)
          Text(owner.name)
        } else {
          Image(systemName: "person.crop.circle")
          Text(String(localized: "devices.ownerUnknown", bundle: .lody))
        }
      }
      Label(visibilityLabel, systemImage: visibilitySymbol)
        .foregroundStyle(.secondary)
    }
    .font(.subheadline)
    .padding(16)
    .frame(idealWidth: 300, maxWidth: 360)
    .task(id: machine.workspaceId + ":" + machine.id) {
      ownerID = nil
      shared = nil
      guard !LodyUIVerify.enabled else { return }
      do {
        let rows = try await GitHubCloud.call("query", path: "machines:listVisibleMachines",
          args: ["workspaceId": machine.workspaceId]) as? [[String: Any]]
        try Task.checkCancellation()
        guard let row = rows?.first(where: { $0["machineId"] as? String == machine.id }),
          let ownerID = row["ownerUserId"] as? String,
          let visibility = row["sharedWithTeam"] as? Bool else { return }
        self.ownerID = ownerID
        shared = visibility
      } catch {
        // Unknown is not private; never infer visibility from ownership or connectivity.
      }
    }
  }

  private var visibilitySymbol: String {
    guard let shared else { return "questionmark.circle" }
    return shared ? "person.2" : "lock"
  }

  private var visibilityLabel: String {
    guard let shared else { return String(localized: "devices.visibilityUnknown", bundle: .lody) }
    return String(localized: String.LocalizationValue(shared ? "devices.shared" : "devices.private"), bundle: .lody)
  }
}

#endif
