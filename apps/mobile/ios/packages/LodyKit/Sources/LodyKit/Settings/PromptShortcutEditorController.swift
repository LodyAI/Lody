import LodyCore
import UIKit

@MainActor
final class PromptShortcutEditorController: LodyFormController {
  var saved: (() -> Void)?
  private let workspace: SettingsWorkspace
  private let entry: PromptShortcutEntry?
  private let value: PromptShortcutValue?
  private let service: PromptShortcutService
  private let readOnly: Bool
  private var busy = false
  private var attempt: PromptShortcutRequest?
  private lazy var name = LodyFormField(
    id: "shortcut-name", label: String(localized: "settings.remote.name", bundle: .lody), text: value?.name, limit: 60
  )
  private lazy var slug = LodyFormField(id: "shortcut-slug", label: text("slug"), text: value?.slug, limit: 40)
  private lazy var prompt = LodyFormTextView(
    id: "shortcut-prompt", label: String(localized: "settings.remote.prompt", bundle: .lody), text: value?.prompt,
    limit: PromptShortcutSections.promptLimit, minHeight: 160
  )
  private lazy var shared = LodyFormToggle(
    id: "shortcut-shared", title: text("workspace"), isOn: value?.visibility == .workspace
  )
  private lazy var promptGroup = LodyFormGroup(header: String(localized: "settings.remote.prompt", bundle: .lody), prompt)
  private lazy var cancelItem = Self.barButton(symbol: "xmark", label: String(localized: "common.cancel", bundle: .lody)) { [weak self] in
    self?.closeForm()
  }
  private lazy var saveItem = Self.barButton(symbol: "checkmark", label: String(localized: "common.save", bundle: .lody), prominent: true) {
    [weak self] in self?.save()
  }

  init(workspace: SettingsWorkspace, entry: PromptShortcutEntry?, value: PromptShortcutValue?, service: @escaping PromptShortcutService) {
    self.workspace = workspace
    self.entry = entry
    self.value = value
    self.service = service
    readOnly = value.map { PromptShortcutSections.readOnly($0, userId: workspace.userId) } ?? false
    super.init(nibName: nil, bundle: nil)
    title = text("title")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    slug.autocapitalizationType = .none
    for field in [name, slug] { field.changed = { [weak self] in self?.render() } }
    prompt.changed = { [weak self] in self?.render() }
    let hints = (readOnly ? [text("readonly")] : []) + [text("slugHint")]
    stack.addArrangedSubview(LodyFormGroup(footer: hints.joined(separator: " "), name, slug))
    stack.addArrangedSubview(promptGroup)
    stack.addArrangedSubview(LodyFormGroup(footer: text("visibilityHint"), shared))
    render()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    header?.leftBarButtonItems = [cancelItem]
    header?.rightBarButtonItems = readOnly ? [] : [saveItem]
    render()
  }

  private var valid: Bool {
    !name.trimmed.isEmpty && !prompt.trimmed.isEmpty && PromptShortcutSections.validSlug(slug.text ?? "")
  }

  private func render() {
    guard isViewLoaded else { return }
    let editable = !readOnly && !busy && attempt == nil
    for field in [name, slug] { field.isEnabled = editable }
    prompt.isEditable = editable
    shared.toggle.isEnabled = editable && entry == nil
    promptGroup.footer = attempt == nil ? nil : text("uncertain")
    cancelItem.isEnabled = !busy
    saveItem.accessibilityLabel = String(localized: String.LocalizationValue(attempt == nil ? "common.save" : "common.retry"), bundle: .lody)
    saveItem.isEnabled = !busy && valid
  }

  // A held attempt is replayed unchanged after a lost response, so a retry can
  // repair publication without a second body or silently replacing the save.
  private func save() {
    guard !busy, !readOnly, valid else { return }
    let request = attempt ?? makeRequest()
    attempt = request
    busy = true
    render()
    Task { [weak self, service] in
      let ok = (try? await service(request)) != nil
      guard let self else { return }
      self.busy = false
      if ok {
        self.saved?()
        self.closeForm()
      } else {
        LodyToastOverlay.shared.show(message: self.text("saveFailed"), kind: "error")
        self.render()
      }
    }
  }

  private func makeRequest() -> PromptShortcutRequest {
    let now = Int(LodyRelativeTime.now())
    let next = PromptShortcutValue(
      v: 1, id: value?.id ?? Self.uuid(), workspaceId: workspace.workspaceId, ownerUserId: workspace.userId,
      visibility: shared.toggle.isOn ? .workspace : .private, name: name.trimmed, emoji: value?.emoji,
      slug: slug.text ?? "", description: value?.description, scope: RuntimeContract.PromptShortcutScope(),
      revision: Self.uuid(), createdAt: value?.createdAt ?? now, updatedAt: now, prompt: prompt.text, mentions: []
    )
    return .save(entry: entry, value: next, bodyDocId: Self.uuid())
  }

  private static func uuid() -> String { UUID().uuidString.lowercased() }

  private func text(_ key: String) -> String { PromptShortcutSections.text(key) }
}
