import UIKit

@MainActor
final class SubagentTaskController: UIViewController {
  let entryId: String
  let itemId: String
  private var item: [String: Any]
  private let chat = LodyChatView(frame: .zero)
  private let list = LodyGroupedList(frame: .zero)
  var onActivity: ((String, String) -> Void)?
  var onFile: ((String, Int) -> Void)?

  init(entryId: String, item: [String: Any]) {
    self.entryId = entryId; self.item = item; itemId = item["itemId"] as! String
    super.init(nibName: nil, bundle: nil)
    chat.setProcessEntryID(entryId); chat.setProcessStartID("__subagent__"); chat.setComposerState("{}")
    chat.setEmptyText(String(localized: "process.empty", bundle: .lody))
    chat.onActivityPress = { [weak self] body in
      guard let entry = body["entryId"] as? String, let item = body["itemId"] as? String else { return }
      self?.onActivity?(entry, item)
    }
    chat.onFilePress = { [weak self] body in
      guard let path = body["path"] as? String else { return }
      self?.onFile?(path, body["line"] as? Int ?? 0)
    }
  }
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
  override func viewDidLoad() {
    super.viewDidLoad()
    for child in [chat, list] as [UIView] {
      child.frame = view.bounds; child.autoresizingMask = [.flexibleWidth, .flexibleHeight]; view.addSubview(child)
    }
    list.forwarded = { [weak self] name, body in
      guard name == "rowPress", body["id"] as? String == "subagent-detail-copy", let self else { return }
      UIPasteboard.general.string = result
      LodyToastOverlay.shared.show(message: String(localized: "subagent.detail.copied", bundle: .lody), kind: "info")
    }
    render()
  }
  func update(_ json: String) {
    if let next = SessionController.item(in: json, entryId: entryId, itemId: itemId) { item = next }
    if isViewLoaded { render() }
  }
  private var result: String { (item[item["status"] as? String == "failed" ? "error" : "summary"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
  private func render() {
    let actor = (item["actor"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "native.chat.transcript.subtask", bundle: .lody)
    let description = (item["description"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? actor
    let status = item["status"] as? String ?? ""
    let key = ["pending": "pending", "in_progress": "running", "completed": "completed", "failed": "failed"][status]
    var labels = [actor]
    if let key { labels.append(String(localized: String.LocalizationValue("native.chat.subagent." + key), bundle: .lody)) }
    if item["isBackgrounded"] as? Bool == true { labels.append(String(localized: "native.chat.subagent.background", bundle: .lody)) }
    let subtitle = labels.joined(separator: " · ")
    if let run = item["run"] as? [String: Any] {
      var items = run["items"] as? [[String: Any]] ?? []
      if !result.isEmpty, !items.contains(where: { $0["type"] as? String == "text" && ($0["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) == result }) {
        items.append(["itemId": itemId + ":result", "type": "text", "text": result])
      }
      items.insert(["itemId": itemId + ":header", "type": "text", "text": subtitle + "\n\n" + description], at: 0)
      let state = run["state"] as? String ?? ""
      let entry: [String: Any] = ["id": entryId, "role": "assistant", "status": state,
        "finished": !["pending", "running", "in_progress"].contains(state), "items": items]
      let data = try! JSONSerialization.data(withJSONObject: [entry])
      chat.setEntries(String(decoding: data, as: UTF8.self)); chat.scheduleUpdate()
      list.isHidden = true; chat.isHidden = false
      return
    }
    chat.isHidden = true; list.isHidden = false
    var section = LodyListSection(); section.id = "task"
    var header = LodyListRow(); header.id = "subagent-header"; header.title = description; header.subtitle = subtitle
    section.rows = [header]
    if !result.isEmpty {
      var body = LodyListRow(); body.id = "subagent-detail-result"; body.title = result
      var copy = LodyListRow(); copy.id = "subagent-detail-copy"; copy.title = String(localized: "subagent.detail.copy", bundle: .lody); copy.action = true
      section.rows += [body, copy]
    }
    if let name = item["lastToolName"] as? String, !name.isEmpty {
      var tool = LodyListRow(); tool.id = "subagent-last-tool"; tool.title = String(localized: "subagent.detail.lastTool", bundle: .lody); tool.value = name
      section.rows.append(tool)
    }
    list.setSections([section])
  }
}
