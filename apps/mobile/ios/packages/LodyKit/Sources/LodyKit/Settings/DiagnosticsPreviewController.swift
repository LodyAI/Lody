import UIKit

@MainActor
final class DiagnosticsPreviewController: DiagnosticsController {
  private let fixture: DiagnosticsFixture
  private let controls = UIStackView()
  private let ready = UILabel()

  init() {
    let fixture = DiagnosticsFixture()
    self.fixture = fixture
    super.init(service: fixture.service())
    title = "Diagnostics"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    ready.text = "Offline diagnostic fixture"
    ready.font = .preferredFont(forTextStyle: .body)
    ready.adjustsFontForContentSizeCategory = true
    ready.accessibilityIdentifier = "diagnostics-preview-ready"
    let buttons = UIStackView(arrangedSubviews: [
      button("diagnostics-reset", "Reset") { $0.reset() },
      button("diagnostics-read-failure", "Read failure") { $0.toggle(read: true) },
      button("diagnostics-clear-failure", "Clear failure") { $0.toggle(read: false) },
    ])
    buttons.spacing = 10
    controls.axis = .vertical
    controls.alignment = .leading
    controls.addArrangedSubview(ready)
    controls.addArrangedSubview(buttons)
    controls.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(controls)
    list.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      controls.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
      controls.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
      controls.trailingAnchor.constraint(lessThanOrEqualTo: view.layoutMarginsGuide.trailingAnchor),
      list.topAnchor.constraint(equalTo: controls.bottomAnchor),
      list.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      list.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      list.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
  }

  override func begin() { reset() }

  private func reset() {
    fixture.readFailure = false
    fixture.clearFailure = false
    fixture.rejectExport = true
    list.isHidden = true
    Task {
      try? await Task.detached { try DiagnosticsStore.seedFixture() }.value
      list.isHidden = false
      remount()
    }
  }

  private func toggle(read: Bool) {
    if read { fixture.readFailure.toggle() } else { fixture.clearFailure.toggle() }
    fixture.rejectExport = true
    restart()
  }

  private func button(_ id: String, _ title: String, _ action: @escaping (DiagnosticsPreviewController) -> Void) -> UIButton {
    var configuration = UIButton.Configuration.gray()
    configuration.title = title
    let control = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in
      guard let self else { return }
      action(self)
    })
    control.accessibilityIdentifier = id
    return control
  }
}

@MainActor
private final class DiagnosticsFixture {
  var readFailure = false
  var clearFailure = false
  var rejectExport = true

  func service() -> DiagnosticsService {
    let local = DiagnosticsService.local
    return DiagnosticsService(
      count: { [unowned self] window in
        if self.readFailure { throw CocoaError(.fileReadUnknown) }
        return try await local.count(window)
      },
      share: { [unowned self] window, controller in
        if self.rejectExport {
          self.rejectExport = false
          throw CocoaError(.fileWriteUnknown)
        }
        try await local.share(window, controller)
      },
      clear: { [unowned self] in
        if self.clearFailure { throw CocoaError(.fileWriteUnknown) }
        try await local.clear()
      }
    )
  }
}

extension DiagnosticsStore {
  static func seedFixture() throws {
    guard LodyUIVerify.enabled else { throw CocoaError(.featureUnsupported) }
    try shared.clear()
    let root = shared.directory
    let date = Date()
    let app = DiagnosticsStore(directory: root, process: .app, now: { date.addingTimeInterval(-60) })
    app.flush()
    let extensionStore = DiagnosticsStore(directory: root, process: .notificationService, now: { date.addingTimeInterval(-120) })
    extensionStore.record("notification", "extension_received", fields: ["message": "3327c0d1-727b-4af6-8e0f-3f27098d15df"])
    extensionStore.flush()
    for (seconds, source) in [(1800.0, Process.app), (7200.0, .app), (172800.0, .notificationService), (691200.0, .app)] {
      let store = DiagnosticsStore(directory: root, process: source, now: { date.addingTimeInterval(-seconds) })
      store.record("notification", "status", fields: ["permission": "denied"])
      store.flush()
    }
  }
}
