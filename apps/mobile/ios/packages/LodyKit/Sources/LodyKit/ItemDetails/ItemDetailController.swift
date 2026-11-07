import LodyCore
import UIKit

@MainActor
class ItemDetailController: UIViewController {
  private let store: ItemDetailStore
  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private var expanded: Set<String> = []

  init(sessionId: String, entryId: String, itemIds: [String], generation: Int, service: ItemDetailService? = nil) {
    store = ItemDetailStore(sessionId: sessionId, entryId: entryId, itemIds: itemIds, generation: generation,
                            service: service ?? .live(sessionId: sessionId))
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "detail.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
  isolated deinit { store.finish() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.accessibilityIdentifier = "item-detail-scroll"
    LodyScrollEdges.navigation(scroll)
    view.addSubview(scroll)
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.topAnchor), scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40),
    ])
    store.changed = { [weak self] in self?.render() }
    store.start()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    LodyScrollEdges.bind(scroll, to: self)
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if SettingsPage.leaving(self) { store.finish() }
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    parent?.navigationItem.rightBarButtonItem = UIBarButtonItem(
      title: String(localized: "common.done", bundle: .lody), primaryAction: UIAction { [weak self] _ in
        guard let self else { return }
        store.finish()
        LodyShell.shared.finish(from: self, value: nil)
        LodyShell.shared.close(from: self)
      }
    )
  }

  private func render() {
    for view in stack.arrangedSubviews { view.removeFromSuperview() }
    for id in store.itemIds {
      let item = store.items[id]
      if let detail = item?.detail {
        for block in detail.blocks { stack.addArrangedSubview(ItemDetailBlockView.make(block)) }
        raw(detail.rawInput, key: id + ":input", title: "detail.rawInput")
        raw(detail.rawOutput, key: id + ":output", title: "detail.rawOutput")
        if detail.truncated {
          stack.addArrangedSubview(ItemDetailBlockView.text(String(localized: "detail.truncated", bundle: .lody), color: .secondaryLabel, monospaced: false))
          stack.addArrangedSubview(button("detail.loadMore", id: "item-detail-more-" + id, enabled: item?.loading != true) { [weak self] in
            self?.store.loadMore(id)
          })
        }
      }
      if item?.loading == true || item == nil {
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.accessibilityIdentifier = "item-detail-loading-" + id
        spinner.startAnimating()
        stack.addArrangedSubview(spinner)
      }
      if let error = item?.error {
        let message = ItemDetailBlockView.text(String(localized: "detail.error.load", bundle: .lody) + "\n" + error, color: .systemRed, monospaced: false)
        message.accessibilityIdentifier = "item-detail-error-" + id
        stack.addArrangedSubview(message)
        stack.addArrangedSubview(button("common.retry", id: "item-detail-retry-" + id) { [weak self] in self?.store.retry(id) })
      }
    }
  }

  private func raw(_ value: RuntimeContract.DetailValue?, key: String, title: String) {
    guard let value else { return }
    let isExpanded = expanded.contains(key)
    let label = String.localizedStringWithFormat(String(localized: String.LocalizationValue(isExpanded ? "detail.collapse" : "detail.expand"), bundle: .lody), String(describing: String(localized: String.LocalizationValue(title), bundle: .lody)))
    let control = button(label, id: "item-detail-raw-" + key) { [weak self] in
      guard let self else { return }
      if expanded.contains(key) { expanded.remove(key) } else { expanded.insert(key) }
      render()
    }
    stack.addArrangedSubview(control)
    if isExpanded { stack.addArrangedSubview(ItemDetailBlockView.text(ItemDetailBlockView.json(value.value))) }
  }

  private func button(_ key: String, id: String, enabled: Bool = true, action: @escaping () -> Void) -> UIButton {
    let button = UIButton(type: .system)
    button.setTitle(String(localized: String.LocalizationValue(key), bundle: .lody), for: .normal)
    button.contentHorizontalAlignment = .leading
    button.accessibilityIdentifier = id
    button.isEnabled = enabled
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
    button.addAction(UIAction { _ in action() }, for: .touchUpInside)
    return button
  }
}
