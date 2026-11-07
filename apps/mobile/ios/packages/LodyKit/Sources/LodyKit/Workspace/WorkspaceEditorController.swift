import UIKit

@MainActor
struct WorkspaceEditorService {
  var rename: @MainActor (String, String) async throws -> Void
  var upload: @MainActor (String, WorkspaceIconFile) async throws -> String
  var pick: @MainActor (UIViewController) async throws -> WorkspaceIconFile?

  static var live: WorkspaceEditorService {
    WorkspaceEditorService(
      rename: { id, name in
        guard NativeHomeFixture.active else { return try await AuthSession.shared.updateWorkspace(id: id, name: name) }
        try await NativeHomeFixture.request("updateWorkspace", ["workspaceId": id, "name": name])
      },
      upload: { id, file in
        guard NativeHomeFixture.active else { return try await AuthSession.shared.updateWorkspaceIcon(id: id, file: file) }
        let uri = file.url.absoluteString
        try await NativeHomeFixture.request("updateWorkspaceIcon", ["workspaceId": id, "uri": uri])
        return uri
      },
      pick: { try await WorkspaceIconPicker().pick(from: $0) }
    )
  }
}

@MainActor
final class WorkspaceEditorController: LodyFormController {
  private let workspaceId: String
  private let original: String
  private let color: UIColor
  private let service: WorkspaceEditorService
  private var busy = false
  private var saving = false
  private var imageTask: Task<Void, Never>?
  private lazy var name = LodyFormField(id: "workspace-name", label: text("name"), text: original, limit: 120)
  private let avatar = UIImageView()
  private let letter = UILabel()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let overlay = UIView()
  private let changeLabel = UILabel()
  private let iconButton = UIButton(type: .custom)
  private lazy var cancelItem = Self.barButton(symbol: "xmark", label: String(localized: "common.cancel", bundle: .lody)) { [weak self] in
    self?.closeForm()
  }
  private lazy var saveItem = Self.barButton(symbol: "checkmark", label: text("save"), prominent: true) { [weak self] in
    self?.save()
  }

  init(params: [String: Any], service: WorkspaceEditorService = .live) {
    workspaceId = params["workspaceId"] as? String ?? ""
    original = params["name"] as? String ?? ""
    color = lodyTint(params["color"] as? String ?? "") ?? .lodyAccent
    self.service = service
    super.init(nibName: nil, bundle: nil)
    setImage(params["image"] as? String)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { imageTask?.cancel() }

  override func viewDidLoad() {
    super.viewDidLoad()
    name.clearButtonMode = .whileEditing
    name.returnKeyType = .done
    name.placeholder = text("placeholder")
    name.changed = { [weak self] in self?.render() }
    name.addAction(UIAction { [weak self] _ in self?.save() }, for: .editingDidEndOnExit)
    name.addAction(UIAction { [weak self] _ in
      DispatchQueue.main.async { self?.name.selectAll(nil) }
    }, for: .editingDidBegin)
    stack.addArrangedSubview(iconRow())
    stack.addArrangedSubview(LodyFormGroup(footer: text("nameFooter"), name))
    render()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    header?.leftBarButtonItems = [cancelItem]
    header?.rightBarButtonItems = [saveItem]
    render()
  }

  private func iconRow() -> UIView {
    let size: CGFloat = 96
    let circle = UIView()
    circle.backgroundColor = color
    circle.layer.cornerRadius = size / 2
    circle.clipsToBounds = true
    circle.isUserInteractionEnabled = false
    letter.font = .systemFont(ofSize: 38, weight: .semibold)
    letter.textColor = .white
    letter.textAlignment = .center
    avatar.contentMode = .scaleAspectFill
    overlay.backgroundColor = UIColor.black.withAlphaComponent(0.4)
    spinner.color = .white
    spinner.hidesWhenStopped = true
    for child in [letter, avatar, overlay, spinner] as [UIView] {
      child.translatesAutoresizingMaskIntoConstraints = false
      circle.addSubview(child)
      NSLayoutConstraint.activate([
        child.centerXAnchor.constraint(equalTo: circle.centerXAnchor),
        child.centerYAnchor.constraint(equalTo: circle.centerYAnchor),
      ])
    }
    for fill in [letter, avatar, overlay] {
      NSLayoutConstraint.activate([
        fill.widthAnchor.constraint(equalTo: circle.widthAnchor),
        fill.heightAnchor.constraint(equalTo: circle.heightAnchor),
      ])
    }
    overlay.isHidden = true
    changeLabel.text = text("changeIconButton")
    changeLabel.font = .dynamic(of: 15)
    let column = UIStackView(arrangedSubviews: [circle, changeLabel])
    column.axis = .vertical
    column.alignment = .center
    column.spacing = 10
    column.isUserInteractionEnabled = false
    column.translatesAutoresizingMaskIntoConstraints = false
    iconButton.addSubview(column)
    iconButton.isAccessibilityElement = true
    iconButton.accessibilityTraits = .button
    iconButton.accessibilityLabel = text("changeIcon")
    iconButton.addAction(UIAction { [weak self] _ in self?.changeIcon() }, for: .primaryActionTriggered)
    iconButton.translatesAutoresizingMaskIntoConstraints = false
    let row = UIView()
    row.addSubview(iconButton)
    NSLayoutConstraint.activate([
      circle.widthAnchor.constraint(equalToConstant: size),
      circle.heightAnchor.constraint(equalToConstant: size),
      column.topAnchor.constraint(equalTo: iconButton.topAnchor),
      column.bottomAnchor.constraint(equalTo: iconButton.bottomAnchor),
      column.leadingAnchor.constraint(equalTo: iconButton.leadingAnchor),
      column.trailingAnchor.constraint(equalTo: iconButton.trailingAnchor),
      iconButton.topAnchor.constraint(equalTo: row.topAnchor),
      iconButton.bottomAnchor.constraint(equalTo: row.bottomAnchor),
      iconButton.centerXAnchor.constraint(equalTo: row.centerXAnchor),
    ])
    return row
  }

  private func render() {
    let trimmed = name.trimmed
    letter.text = String((trimmed.isEmpty ? original : name.text ?? "").prefix(1))
    saveItem.isEnabled = !busy && !trimmed.isEmpty && trimmed != original
    cancelItem.isEnabled = !busy
    name.isEnabled = !busy
    iconButton.isEnabled = !busy
    changeLabel.textColor = busy ? .tertiaryLabel : color
  }

  private func save() {
    let trimmed = name.trimmed
    guard !saving, !trimmed.isEmpty, trimmed != original else { return }
    saving = true
    busy = true
    render()
    Task {
      do {
        try await service.rename(workspaceId, trimmed)
        LodyShell.shared.finish(from: self, value: nil)
        closeForm()
      } catch {
        LodyToastOverlay.shared.show(message: error.localizedDescription, kind: "error")
      }
      saving = false
      busy = false
      render()
    }
  }

  private func changeIcon() {
    guard !busy else { return }
    Task {
      do {
        guard let file = try await service.pick(self) else { return }
        busy = true
        uploading(true)
        render()
        setImage(try await service.upload(workspaceId, file))
      } catch {
        LodyToastOverlay.shared.show(message: error.localizedDescription, kind: "error")
      }
      busy = false
      uploading(false)
      render()
    }
  }

  private func uploading(_ value: Bool) {
    overlay.isHidden = !value
    if value { spinner.startAnimating() } else { spinner.stopAnimating() }
  }

  private func setImage(_ value: String?) {
    imageTask?.cancel()
    avatar.image = nil
    guard let value, !value.isEmpty, let url = URL(string: value) else { return }
    imageTask = Task { [weak self] in
      guard let (data, _) = try? await URLSession.shared.data(from: url), let image = UIImage(data: data),
            !Task.isCancelled else { return }
      self?.avatar.image = image
    }
  }

  private func text(_ key: String) -> String { String(localized: String.LocalizationValue("workspace.edit." + key), bundle: .lody) }
}
