import UIKit

@MainActor
final class MessageShareController: UIViewController {
  private struct Block {
    let id: Int
    let kind: String
    let text: String
  }

  private let preview: MessageSharePreview
  private let list = LodyGroupedList(frame: .zero)
  private let feedback = UIStackView()
  private let feedbackLabel = UILabel()
  private lazy var feedbackButton = LodyFormButton.make(id: "message-share-feedback-action", title: "") { [weak self] in
    self?.feedbackAction()
  }
  private var blocks: [Block] = []
  private var selected: [Int]?
  private var selecting = false
  private var state = "loading"
  private var error = ""
  private var retryable = true
  private lazy var selectItem = LodyFormController.barButton(symbol: "checklist", label: Self.text("selectBlocks")) { [weak self] in
    self?.setSelecting(true)
  }
  private lazy var shareItem = LodyFormController.barButton(symbol: "square.and.arrow.up", label: Self.text("shareImage")) {
    [weak self] in self?.preview.share()
  }
  private lazy var doneItem = LodyFormController.barButton(title: String(localized: "common.done", bundle: .lody), label: String(localized: "common.done", bundle: .lody)) {
    [weak self] in self?.setSelecting(false)
  }
  private lazy var closeItem: UIBarButtonItem = {
    let title = Self.text("preview")
    return LodyFormController.barButton(
      symbol: "xmark", label: String.localizedStringWithFormat(String(localized: "accessibility.closeSheet", bundle: .lody), String(describing: title))
    ) { [weak self] in self?.dismiss(animated: true) }
  }()

  init(contentJSON: String) {
    preview = MessageSharePreview(contentJSON: contentJSON)
    super.init(nibName: nil, bundle: nil)
    title = Self.text("preview")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyBackground
    preview.owner = self
    preview.onBlocks = { [weak self] values in
      self?.blocks = values.compactMap { value in
        guard let id = value["id"] as? Int else { return nil }
        return Block(id: id, kind: value["kind"] as? String ?? "", text: value["text"] as? String ?? "")
      }
      self?.render()
    }
    preview.onState = { [weak self] state, message, retryable in
      guard let self else { return }
      self.state = state
      self.error = message
      self.retryable = retryable
      self.render()
    }
    for child in [preview, list] as [UIView] {
      child.frame = view.bounds
      child.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      view.addSubview(child)
    }
    list.setTransparent(true)
    list.forwarded = { [weak self] name, body in
      guard name == "rowPress", let id = body["id"] as? String else { return }
      self?.toggle(id)
    }
    feedbackLabel.numberOfLines = 0
    feedbackLabel.textAlignment = .center
    feedbackLabel.font = .preferredFont(forTextStyle: .body)
    feedbackLabel.adjustsFontForContentSizeCategory = true
    feedback.axis = .vertical
    feedback.alignment = .center
    feedback.spacing = 16
    feedback.addArrangedSubview(feedbackLabel)
    feedback.addArrangedSubview(feedbackButton)
    feedback.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(feedback)
    NSLayoutConstraint.activate([
      feedback.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      feedback.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
      feedback.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
    ])
    render()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    parent?.navigationItem.leftBarButtonItems = [closeItem]
    render()
  }

  private func setSelecting(_ value: Bool) {
    selecting = value
    if !value {
      state = "loading"
      preview.select(selected.map(Set.init))
    }
    render()
  }

  private func toggle(_ id: String) {
    switch id {
    case "select-all": selected = nil
    case "select-none": selected = []
    default:
      guard let block = Int(id.replacingOccurrences(of: "share-block-", with: "")) else { return }
      var ids = selected ?? blocks.map(\.id)
      if let index = ids.firstIndex(of: block) { ids.remove(at: index) } else { ids.append(block) }
      selected = ids
    }
    render()
  }

  private func feedbackAction() {
    if state == "empty" {
      setSelecting(true)
    } else if retryable {
      preview.retry()
    } else {
      dismiss(animated: true)
    }
  }

  private func render() {
    preview.isHidden = selecting
    list.isHidden = !selecting
    selectItem.isEnabled = !blocks.isEmpty
    shareItem.isEnabled = state == "ready"
    let items = selecting ? [doneItem] : [shareItem, selectItem]
    if parent?.navigationItem.rightBarButtonItems != items { parent?.navigationItem.rightBarButtonItems = items }
    let showsFeedback = !selecting && (state == "error" || state == "empty")
    feedback.isHidden = !showsFeedback
    feedbackLabel.text = state == "empty" ? Self.text("emptySelection") : error
    var action = String(localized: String.LocalizationValue(retryable ? "common.retry" : "common.done"), bundle: .lody)
    if state == "empty" { action = Self.text("selectBlocks") }
    feedbackButton.setTitle(action, for: .normal)
    guard selecting else { return }
    let chosen = selected ?? blocks.map(\.id)
    let rows = blocks.map { block in
      let kind = Self.text("block.\(block.kind)")
      let isOn = chosen.contains(block.id)
      return LodyListRow.item(
        "share-block-\(block.id)", block.text.isEmpty ? kind : block.text, subtitle: kind, selected: isOn,
        accessibilityValue: Self.text(isOn ? "selected" : "notSelected")
      )
    }
    list.setSections([
      .group("selection-actions", [.item("select-all", Self.text("selectAll")), .item("select-none", Self.text("selectNone"))]),
      .group(
        "blocks", header: String.localizedStringWithFormat(String(localized: "native.chat.message.selectedCount", bundle: .lody), String(describing: chosen.count), String(describing: blocks.count)),
        rows
      ),
    ])
  }

  private static func text(_ key: String) -> String { String(localized: String.LocalizationValue("native.chat.message." + key), bundle: .lody) }
}
