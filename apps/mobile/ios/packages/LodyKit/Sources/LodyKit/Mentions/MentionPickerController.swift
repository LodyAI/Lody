import UIKit

@MainActor
final class MentionPickerController: UIViewController {
  private let category: String
  private let store: MentionCatalogStore?
  private let onPick: (MentionItem) -> Void
  private let picker = MentionPickerView()
  private let status = LodyGroupedList(frame: .zero)
  private let search = LodyNavigationSearch()
  private var catalog: MentionCatalog?
  private var query: String
  private var loading = false
  private var failed = false
  private var generation = 0
  private var searchCommand = 0

  init(category: String, query: String, store: MentionCatalogStore?, initial: MentionCatalog?, onPick: @escaping (MentionItem) -> Void) {
    self.category = category
    self.query = query
    self.store = store
    self.onPick = onPick
    catalog = initial ?? store?.catalog(category)
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "native.chat.mention.open", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyGroupedBackground
    for child in [picker, status] as [UIView] {
      child.frame = view.bounds
      child.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      view.addSubview(child)
    }
    status.forwarded = { [weak self] name, _ in
      if name == "rowPress" { self?.reload(refresh: true) }
    }
    picker.onRetry = { [weak self] in self?.reload(refresh: true) }
    picker.onQueryReset = { [weak self] in self?.resetQuery() }
    picker.onPick = { [weak self] path in self?.pick(path) }
    search.configure(LodyNavigationSearch.Config(
      placeholder: String(localized: "native.chat.mention.open", bundle: .lody), placement: "integrated", hideWhenScrolling: false,
      autoCapitalize: "none", obscureBackground: false, hideNavigationBar: false
    ))
    search.emit = { [weak self] event, text in
      guard event == "change", let self else { return }
      query = text
      render()
    }
    if catalog == nil, store != nil { reload(refresh: false) } else { render() }
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    guard let item = parent?.navigationItem else { return }
    LodyNavigationHeader.of(item).search = search
  }

  private func reload(refresh: Bool) {
    guard let store else { return render() }
    generation += 1
    let id = generation
    loading = catalog == nil || refresh
    failed = false
    render()
    Task {
      do {
        let value = try await store.load(category, refresh: refresh)
        guard generation == id else { return }
        catalog = value
      } catch {
        guard generation == id else { return }
        failed = true
      }
      loading = false
      render()
    }
  }

  private func render() {
    let blocked = loading || failed
    status.isHidden = !blocked
    picker.isHidden = blocked
    if blocked {
      status.setPlaceholder(String(localized: String.LocalizationValue(loading ? "common.reading" : "mentions.error"), bundle: .lody))
      status.setSections(failed && !loading ? [
        .group("error", footer: String(localized: "mentions.error", bundle: .lody), [.item("retry", String(localized: "common.retry", bundle: .lody), action: true)]),
      ] : [])
      return
    }
    let items = (catalog?.items ?? []).map {
      ChatMentionItem(path: $0.path, name: $0.name, kind: $0.kind.rawValue, subtitle: $0.subtitle, insertText: $0.insertText, emoji: $0.emoji)
    }
    picker.configure(category: category, items: items, query: query, notice: MentionCatalogStore.notice(catalog))
  }

  private func resetQuery() {
    query = ""
    searchCommand += 1
    search.perform(LodyNavigationSearch.Command(token: searchCommand, action: "clearText"))
    searchCommand += 1
    search.perform(LodyNavigationSearch.Command(token: searchCommand, action: "cancelSearch"))
  }

  private func pick(_ path: String) {
    if let item = catalog?.items.first(where: { $0.path == path }) { onPick(item) }
  }

  static func page(_ params: [String: Any]) -> UIViewController {
    func decode<Value: Decodable>(_ type: Value.Type, _ key: String) -> Value? {
      guard let value = params[key], let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
      return try? JSONDecoder().decode(type, from: data)
    }
    let staticItems = decode([MentionItem].self, "items").map { MentionCatalog(items: $0, truncated: false, incomplete: false) }
    let owner = WeakPicker()
    let picker = MentionPickerController(
      category: params["category"] as? String ?? "file", query: params["query"] as? String ?? "",
      store: decode(MentionSource.self, "source").map { MentionCatalogStore(source: $0) },
      initial: decode(MentionCatalog.self, "initial") ?? staticItems
    ) { item in
      guard let controller = owner.value else { return }
      let value = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(item))) ?? NSNull()
      LodyShell.shared.finish(from: controller, value: value)
      LodyShell.shared.close(from: controller)
    }
    owner.value = picker
    return picker
  }
}

private final class WeakPicker {
  weak var value: UIViewController?
}
