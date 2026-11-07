import LodyDesignSystem
import SwiftUI
import UIKit

struct ChatTabItem: Identifiable {
  let id: String
  let title: String
  let attention: Attention?
  let current: Bool
}

@MainActor
final class ChatTabsState: ObservableObject {
  @Published var tabs: [ChatTabItem]
  @Published var closed: [ChatTabItem]
  @Published var busy: String?
  @Published var showingClosed = false
  var resize: ((CGFloat) -> Void)?
  init(tabs: [ChatTabItem], closed: [ChatTabItem]) { self.tabs = tabs; self.closed = closed }
  var height: CGFloat {
    let rows = showingClosed ? max(1, closed.count) + 1 : tabs.count + 2
    return min(420, CGFloat(rows) * LodySize.listRow + LodySpacing.xs * 2 + 1)
  }
}

/// A native swipe-action list inside the directory button's glass panel.
struct ChatTabsPanel: View {
  @ObservedObject var state: ChatTabsState
  let creating: Bool
  var onSelect: (String) -> Void
  var onNew: () -> Void
  var onClose: (String) -> Void
  var onRestore: (String) -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private func text(_ key: String) -> String { String(localized: String.LocalizationValue(key), bundle: .lody) }

  var body: some View {
    ZStack {
      if state.showingClosed {
        VStack(spacing: 0) {
          Button { changePage(false) } label: {
            HStack(spacing: LodySpacing.md) {
              LodyIcon.back.image.resizable().frame(width: LodyIconSize.md, height: LodyIconSize.md)
              Text(text("session.tabs.closed")).lodyTextStyle(.body)
              Spacer()
            }.foregroundStyle(LodyColor.textSecondary)
              .padding(.horizontal, LodySpacing.lg).frame(height: LodySize.listRow).contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityLabel(text("common.back")).accessibilityIdentifier("tabsBack")
          Divider().padding(.horizontal, LodySpacing.lg)
          if state.closed.isEmpty {
            Text(text("session.tabs.noClosed")).lodyTextStyle(.body).foregroundStyle(LodyColor.textSecondary)
              .frame(maxWidth: .infinity, maxHeight: .infinity)
          } else {
            tabList(state.closed, closed: true)
          }
        }
        .transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .trailing).combined(with: .opacity)))
      } else {
        VStack(spacing: 0) {
          if !state.tabs.isEmpty { tabList(state.tabs, closed: false) }
          Divider().padding(.horizontal, LodySpacing.lg)
          action("session.tabs.new", icon: .plus, secondary: false, action: onNew)
            .disabled(creating || state.busy != nil).accessibilityIdentifier("newTab")
          action("session.tabs.closed", icon: .sessions, secondary: true) { changePage(true) }
            .accessibilityIdentifier("closedTabs")
        }
        .transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .leading).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity)))
      }
    }
    .clipped()
    .padding(.vertical, LodySpacing.xs)
    .onChange(of: state.height) { _, height in state.resize?(height) }
  }

  private func changePage(_ closed: Bool) {
    withAnimation(.easeInOut(duration: reduceMotion ? 0.15 : 0.22)) { state.showingClosed = closed }
  }

  private func tabList(_ tabs: [ChatTabItem], closed: Bool) -> some View {
    List(tabs) { tab in
      Button { closed ? onRestore(tab.id) : onSelect(tab.id) } label: {
        HStack(spacing: LodySpacing.md) {
          ZStack { if let attention = tab.attention { AttentionGlyph(attention: attention) } }
            .frame(width: LodyIconSize.md, height: LodyIconSize.md)
          Text(tab.title.isEmpty ? text("session.tabs.defaultTitle") : tab.title)
            .lodyTextStyle(.body).foregroundStyle(LodyColor.textPrimary).lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
          if state.busy == tab.id { ProgressView().controlSize(.small) }
          else if closed {
            LodyIcon.undo.image.resizable().renderingMode(.template)
              .frame(width: LodyIconSize.sm, height: LodyIconSize.sm).foregroundStyle(LodyColor.accentFg)
          } else if tab.current {
            LodyIcon.check.image.resizable().renderingMode(.template)
              .frame(width: LodyIconSize.sm, height: LodyIconSize.sm).foregroundStyle(LodyColor.accentFg)
          }
        }.frame(minHeight: LodySize.listRow).contentShape(Rectangle())
      }
      .buttonStyle(.plain).disabled(state.busy != nil)
      .accessibilityIdentifier((closed ? "restoreTab:" : "tab:") + tab.id)
      .accessibilityHint(closed ? text("session.tabs.restore") : text("session.tabs.swipeClose"))
      .accessibilityAddTraits(tab.current && !closed ? [.isButton, .isSelected] : .isButton)
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        if !closed {
          Button(role: .destructive) { onClose(tab.id) } label: { Label(text("session.tabs.close"), systemImage: "xmark") }
            .disabled(state.busy != nil)
        }
      }
      .listRowInsets(EdgeInsets(top: 0, leading: LodySpacing.lg, bottom: 0, trailing: LodySpacing.lg))
      .listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
    .listStyle(.plain).scrollContentBackground(.hidden).scrollBounceBehavior(.basedOnSize)
    .environment(\.defaultMinListRowHeight, LodySize.listRow)
  }

  private func action(_ key: String, icon: LodyIcon, secondary: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: LodySpacing.md) {
        icon.image.resizable().renderingMode(.template).frame(width: LodyIconSize.md, height: LodyIconSize.md)
        Text(text(key)).lodyTextStyle(.body)
        Spacer()
        if secondary {
          LodyIcon.forward.image.resizable().frame(width: LodyIconSize.sm, height: LodyIconSize.sm)
        }
      }.foregroundStyle(secondary ? LodyColor.textSecondary : LodyColor.accentFg)
        .padding(.horizontal, LodySpacing.lg).frame(height: LodySize.listRow).contentShape(Rectangle())
    }.buttonStyle(.plain)
  }
}

/// Shows the panel as a card pinned just below the header (the page's safe-area top), over a
/// clear tap-to-dismiss layer. A popover anchored in the navigation bar was drawn over the title;
/// this always opens under it and drops in from the header.
@MainActor
final class ChatTabsOverlay: UIView {
  private let card = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
  private let content: UIHostingController<ChatTabsPanel>
  private var heightConstraint: NSLayoutConstraint?
  let state: ChatTabsState
  private var collapsedTransform = CGAffineTransform.identity

  /// The panel currently shown in `host`, if any.
  static func shown(in host: UIView) -> ChatTabsOverlay? { host.subviews.compactMap { $0 as? ChatTabsOverlay }.first }

  static func present(_ panel: ChatTabsPanel, tabs: Int, in host: UIViewController, source: UIView? = nil) -> ChatTabsOverlay {
    let overlay = ChatTabsOverlay(panel: panel)
    overlay.show(in: host, height: panel.state.height, source: source)
    return overlay
  }

  private init(panel: ChatTabsPanel) {
    state = panel.state
    content = UIHostingController(rootView: panel)
    super.init(frame: .zero)
    state.resize = { [weak self] height in
      guard let self else { return }
      self.heightConstraint?.constant = min(height, max(100, self.bounds.height - self.safeAreaInsets.top - self.safeAreaInsets.bottom - 32))
      UIView.animate(withDuration: 0.22) { self.layoutIfNeeded() }
    }
    accessibilityViewIsModal = true
    accessibilityIdentifier = "chat-tabs-panel"
    let dismiss = UITapGestureRecognizer(target: self, action: #selector(backgroundTapped(_:)))
    dismiss.cancelsTouchesInView = false
    addGestureRecognizer(dismiss)
    card.cornerConfiguration = .corners(radius: .fixed(22))
    card.clipsToBounds = true
    content.view.backgroundColor = .clear
    content.view.translatesAutoresizingMaskIntoConstraints = false
    card.contentView.addSubview(content.view)
    card.translatesAutoresizingMaskIntoConstraints = false
    addSubview(card)
    NSLayoutConstraint.activate([
      content.view.topAnchor.constraint(equalTo: card.contentView.topAnchor),
      content.view.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor),
      content.view.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor),
      content.view.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func show(in host: UIViewController, height: CGFloat, source: UIView?) {
    let root = host.view!
    host.addChild(content)
    translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(self)
    heightConstraint = card.heightAnchor.constraint(equalToConstant: min(height, max(100, root.bounds.height - root.safeAreaInsets.top - root.safeAreaInsets.bottom - 32)))
    NSLayoutConstraint.activate([
      topAnchor.constraint(equalTo: root.topAnchor), bottomAnchor.constraint(equalTo: root.bottomAnchor),
      leadingAnchor.constraint(equalTo: root.leadingAnchor), trailingAnchor.constraint(equalTo: root.trailingAnchor),
      // Below the directory button, aligned to the trailing controls.
      card.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor, constant: LodySpacing.sm),
      card.trailingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.trailingAnchor, constant: -LodyLayout.screenPaddingX),
      card.widthAnchor.constraint(equalToConstant: min(320, max(200, root.bounds.width - 2 * LodyLayout.screenPaddingX))),
      heightConstraint!,
    ])
    content.didMove(toParent: host)
    root.layoutIfNeeded()
    UISelectionFeedbackGenerator().selectionChanged()
    // Grow out of the directory button, like the adjacent More menu.
    let anchor = source.map { $0.convert($0.bounds, to: self) }
      ?? CGRect(x: card.frame.midX, y: card.frame.minY, width: 0, height: 0)
    collapsedTransform = CGAffineTransform(
      translationX: anchor.midX - card.center.x,
      y: anchor.midY - card.center.y
    ).scaledBy(x: 0.55, y: 0.15)
    card.alpha = 0
    content.view.alpha = 0
    if !UIAccessibility.isReduceMotionEnabled { card.transform = collapsedTransform }
    UIView.animate(springDuration: 0.3, bounce: 0, initialSpringVelocity: 0,
                   options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.card.alpha = 1
      self.card.transform = .identity
      self.content.view.alpha = 1
    }
  }

  @objc private func backgroundTapped(_ gesture: UITapGestureRecognizer) {
    guard !card.frame.contains(gesture.location(in: self)) else { return }
    close()
  }

  /// Fades the card back into the header, then removes the overlay.
  func close(then done: (() -> Void)? = nil) {
    isUserInteractionEnabled = false
    let finish = {
      self.content.willMove(toParent: nil)
      self.content.removeFromParent()
      self.removeFromSuperview()
      done?()
    }
    guard window != nil else { return finish() }
    UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseIn, .beginFromCurrentState]) {
      self.card.alpha = 0
      if !UIAccessibility.isReduceMotionEnabled { self.card.transform = self.collapsedTransform }
      self.content.view.alpha = 0
    } completion: { _ in finish() }
  }
}

/// Native bar item: shares the More button's glass background.
final class DirectoryTabsButton: UIButton {
  private let status = UIImageView()
  private var isUnread = false
  init() {
    super.init(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
    setImage(LodyIcon.sessions.uiImage?.preparingThumbnail(of: CGSize(width: LodyIconSize.md, height: LodyIconSize.md))?.withRenderingMode(.alwaysTemplate), for: .normal)
    tintColor = .label
    accessibilityIdentifier = "chat-directory-tabs"
    status.contentMode = .scaleAspectFit
    status.isUserInteractionEnabled = false
    addSubview(status)
    NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: 44), heightAnchor.constraint(equalToConstant: 44)])
  }
  required init?(coder: NSCoder) { fatalError() }
  override func layoutSubviews() {
    super.layoutSubviews()
    let size: CGFloat = isUnread ? 6 : 12
    status.frame = CGRect(x: bounds.maxX - 11 - size / 2, y: bounds.maxY - 11 - size / 2, width: size, height: size)
  }
  func setStatus(_ symbol: String) {
    isUnread = symbol == "circle.fill"
    setNeedsLayout()
    status.isHidden = symbol.isEmpty
    status.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: symbol == "circle.fill" ? 6 : 11, weight: .semibold))
    status.tintColor = symbol == "exclamationmark.circle" ? LodyUIColor.dangerDefault : LodyUIColor.accentDefault
  }
}
