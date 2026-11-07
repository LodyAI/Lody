import UIKit
import LodyCore

@MainActor
final class MessageForkController: UIViewController {
  private let sessionId: String
  private let entryId: String
  private let target = UUID().uuidString.lowercased()
  private let status = UILabel()
  private let button = UIButton(type: .system)
  private let spinner = UIActivityIndicatorView(style: .medium)
  private var attempted = false

  init(sessionId: String, entryId: String) {
    self.sessionId = sessionId; self.entryId = entryId
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "message.fork.title", bundle: .lody)
  }
  required init?(coder: NSCoder) { fatalError() }
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    status.numberOfLines = 0
    status.font = .preferredFont(forTextStyle: .body)
    status.text = String(localized: "message.fork.explanation", bundle: .lody)
    var configuration = UIButton.Configuration.filled()
    configuration.title = String(localized: "message.fork.title", bundle: .lody)
    configuration.cornerStyle = .capsule
    button.configuration = configuration
    button.isEnabled = false
    button.addAction(UIAction { [weak self] _ in self?.send() }, for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [status, spinner, button])
    stack.axis = .vertical; stack.spacing = 20
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
      button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
    ])
    spinner.startAnimating()
    Task { [weak self] in
      guard let self else { return }
      defer { self.spinner.stopAnimating() }
      do {
        let result = try await self.call(.read)
        self.button.isEnabled = result.state == .ready
        if result.state != .ready { self.status.text = String(localized: "message.action.unavailable", bundle: .lody) }
      } catch { self.status.text = String(localized: "message.action.unavailable", bundle: .lody) }
    }
  }
  private func call(_ action: RuntimeContract.ForkSessionParamsAction) async throws -> RuntimeContract.ForkSessionResult {
    guard let runtime = DataRuntime.current, runtime.sessionId == sessionId else { throw OutboxError.scopeExpired }
    return try await runtime.workspaceCall(RuntimeContract.Calls.ForkSession.self) { workspace, _ in
      RuntimeContract.ForkSessionParams(workspaceId: workspace, sourceSessionId: self.sessionId, sourceTurnId: self.entryId, action: action, targetSessionId: self.target)
    }
  }
  private func send() {
    guard !attempted else { return }
    attempted = true; button.isEnabled = false
    isModalInPresentation = true; parent?.isModalInPresentation = true
    spinner.startAnimating()
    Task { [weak self] in
      guard let self else { return }
      defer { self.spinner.stopAnimating(); self.isModalInPresentation = false; self.parent?.isModalInPresentation = false }
      do {
        let result = try await self.call(.send)
        if result.state == .created {
          LodyShell.shared.openSessionFromExternal(self.target)
        } else {
          self.status.text = String(localized: String.LocalizationValue(result.state == .rejected ? "message.action.unavailable" : "message.action.unknown"), bundle: .lody)
        }
      } catch { self.status.text = String(localized: "message.action.unknown", bundle: .lody) }
    }
  }
}
