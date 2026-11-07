import UIKit

@MainActor
final class ProcessController: UIViewController {
  private let chat = LodyChatView(frame: .zero)
  var onActivity: ((String, String) -> Void)?
  var onFile: ((String, Int) -> Void)?

  init(entryId: String, startItemId: String) {
    super.init(nibName: nil, bundle: nil)
    chat.setProcessEntryID(entryId)
    chat.setProcessStartID(startItemId)
    chat.setComposerState("{}")
    chat.setEmptyText(String(localized: "process.empty", bundle: .lody))
    chat.onActivityPress = { [weak self] body in
      guard let entryId = body["entryId"] as? String, let itemId = body["itemId"] as? String else { return }
      self?.onActivity?(entryId, itemId)
    }
    chat.onFilePress = { [weak self] body in
      guard let path = body["path"] as? String else { return }
      self?.onFile?(path, (body["line"] as? NSNumber)?.intValue ?? 0)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    chat.frame = view.bounds
    chat.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(chat)
  }

  // The owning session projects each revision; this page never opens or closes a runtime subscription.
  func update(_ entries: String, animate: Bool = true) {
    chat.setEntries(entries, animate: animate)
    chat.scheduleUpdate()
  }
}
