import UIKit
import LodyCore

@MainActor
final class AgentProviderAuthController: LodyFormController {
  var authenticated: (() -> Void)?
  private let target: ProviderTarget
  private let scope: SettingsActor
  private let scopeKey: String
  private let service: ProviderDetailService
  private var methods: [ProviderChoice]
  private var state: ProviderAuthState?
  private var flowID = UUID().uuidString.lowercased()
  private var started = false
  private var busy = false
  private var failed = false
  private var authObserver: NSObjectProtocol?
  private var pendingEvent: ProviderAuthState?
  private var polling: Task<Void, Never>?
  private var inputFields: [String: LodyFormField] = [:]
  private var selectedValues: [String: String] = [:]
  private let status = LodyFormGroup.caption()
  private let content = UIStackView()

  init(target: ProviderTarget, methods: [ProviderChoice], scope: SettingsActor, service: ProviderDetailService) {
    self.target = target
    self.methods = methods
    self.scope = scope
    scopeKey = scope.key
    self.service = service
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    polling?.cancel()
    if let authObserver { NotificationCenter.default.removeObserver(authObserver) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    content.axis = .vertical
    content.spacing = 12
    status.accessibilityIdentifier = "provider-auth-status"
    stack.addArrangedSubview(LodyFormGroup.inset(status))
    stack.addArrangedSubview(content)
    authObserver = NotificationCenter.default.addObserver(forName: .lodyProviderAuthChanged, object: nil, queue: .main) { [weak self] notification in
      guard let event = notification.object as? RuntimeContract.AgentProviderAuthState else { return }
      let eventScope = notification.userInfo?["scopeKey"] as? String
      MainActor.assumeIsolated {
        guard let self, eventScope == self.scopeKey, self.started, self.scope.key == self.scopeKey, event.flowId == self.flowID,
              let data = try? JSONEncoder().encode(event), let next = try? JSONDecoder().decode(ProviderAuthState.self, from: data) else { return }
        // The unique flow is bound to this captured workspace/machine/provider request.
        // A busy RPC reads back any differing event before presenting its result as current.
        if self.busy { self.pendingEvent = next; return }
        guard next != self.state else { return }
        self.polling?.cancel()
        self.failed = false
        self.state = next
        self.render()
        if next.status == "authenticated" { self.authenticated?() }
        self.scheduleStatus()
      }
    }
    scope.watch(self) { [weak self] in
      guard let self, self.scope.key != self.scopeKey else { return }
      self.polling?.cancel()
      self.inputFields.values.forEach { $0.text = "" }
      self.content.isUserInteractionEnabled = false
      self.status.text = self.text("scopeChanged")
    }
    render()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    header?.leftBarButtonItem = Self.barButton(symbol: "xmark", label: String(localized: "common.cancel", bundle: .lody)) { [weak self] in self?.cancel() }
  }

  private func text(_ key: String) -> String { AgentProviderSections.text(key) }
  private var terminal: Bool { ["authenticated", "cancelled", "error"].contains(state?.status ?? "") }

  private func button(_ title: String, id: String, action: @escaping @MainActor () -> Void) -> UIButton {
    let button = UIButton(type: .system)
    button.setTitle(title, for: .normal)
    button.accessibilityIdentifier = id
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    button.addAction(UIAction { _ in action() }, for: .touchUpInside)
    button.isEnabled = !busy
    content.addArrangedSubview(button)
    return button
  }

  private func render() {
    guard isViewLoaded else { return }
    content.arrangedSubviews.forEach { $0.removeFromSuperview() }
    inputFields.removeAll()
    selectedValues.removeAll()
    status.text = text(failed ? "authUnknown" : "auth.\(state?.status ?? "ready")")
    isModalInPresentation = started && !terminal
    if failed {
      _ = button(text("checkAuth"), id: "provider-auth-check") { [weak self] in self?.send("status") }
      return
    }
    if !started || state?.status == "method-required" {
      let choices = state?.methods ?? methods
      if choices.isEmpty {
        _ = button(text("signIn"), id: "provider-auth-start") { [weak self] in self?.send("start") }
      } else {
        for method in choices {
          _ = button(method.name, id: "provider-auth-method:\(method.id)") { [weak self] in self?.chooseMethod(method.id) }
        }
      }
      return
    }
    if let state, state.status == "authorization" {
      if let urlString = state.authorizationUrl, let url = URL(string: urlString), url.scheme?.lowercased() == "https", url.host != nil {
        let open = button(text("openSignIn"), id: "provider-auth-open") { [weak self] in
          guard let self, self.scope.key == self.scopeKey, !self.busy,
                self.state?.requiresAuthorizationConsent == false, self.state?.authorizationUrl == urlString else { return }
          UIApplication.shared.open(url)
        }
        open.isEnabled = !busy && !state.requiresAuthorizationConsent
      }
      if let code = state.userCode {
        let label = LodyFormGroup.caption()
        label.text = code
        label.accessibilityIdentifier = "provider-auth-user-code"
        content.addArrangedSubview(LodyFormGroup.inset(label))
      }
      if state.requiresAuthorizationConsent {
        _ = button(text("continue"), id: "provider-auth-consent") { [weak self] in self?.send("submit", response: "accept") }
        _ = button(text("decline"), id: "provider-auth-decline") { [weak self] in self?.send("submit", response: "decline") }
      }
      if state.acceptsAuthorizationCode {
        addField(id: "code", label: text("authorizationCode"), secret: true)
        _ = button(text("continue"), id: "provider-auth-submit") { [weak self] in self?.send("submit", code: self?.inputFields["code"]?.text) }
      }
    }
    if let state, state.status == "input-required" {
      for field in state.fields {
        if field.type == "select" {
          let picker = button(field.label, id: "provider-auth-field:\(field.id)") {}
          picker.showsMenuAsPrimaryAction = true
          picker.menu = UIMenu(children: field.options.map { option in
            UIAction(title: option.label) { [weak self, weak picker] _ in
              self?.selectedValues[field.id] = option.value
              picker?.setTitle("\(field.label): \(option.label)", for: .normal)
            }
          })
        } else { addField(id: field.id, label: field.label, secret: field.type == "secret") }
      }
      _ = button(text("continue"), id: "provider-auth-submit") { [weak self] in
        guard let self else { return }
        var values = self.selectedValues
        for (id, field) in self.inputFields { values[id] = field.text ?? "" }
        guard state.fields.allSatisfy({ !$0.required || !(values[$0.id] ?? "").isEmpty }) else { return }
        self.send("submit", values: values)
      }
    }
    if terminal {
      _ = button(text("done"), id: "provider-auth-done") { [weak self] in self?.closeForm() }
    }
  }

  private func addField(id: String, label: String, secret: Bool) {
    let field = LodyFormField(id: "provider-auth-field:\(id)", label: label, text: "", limit: 32000)
    field.isSecureTextEntry = secret
    field.autocapitalizationType = .none
    field.autocorrectionType = .no
    inputFields[id] = field
    content.addArrangedSubview(LodyFormGroup(field))
  }

  private func chooseMethod(_ method: String) {
    guard !busy, scope.key == scopeKey else { return }
    if state?.status == "method-required" {
      if state?.interactionId != nil { send("submit", method: method); return }
      // A start is idempotent by flow ID. Selecting a method without an input
      // interaction begins the new attempt rather than replaying the old start.
      flowID = UUID().uuidString.lowercased()
      pendingEvent = nil
      state = nil
      started = false
    }
    send("start", method: method)
  }

  private func send(_ action: String, method: String? = nil, values: [String: String]? = nil, code: String? = nil, response: String? = nil) {
    guard !busy, scope.key == scopeKey else { return }
    busy = true
    failed = false
    polling?.cancel()
    let request = ProviderAuthRequest(workspaceId: target.workspaceId, machineId: target.machineId, id: target.id,
                                      action: action, flowId: flowID, methodId: method, interactionId: state?.interactionId,
                                      values: values, authorizationCode: code, responseAction: response ?? (action == "submit" ? "accept" : nil))
    if action == "start" { started = true }
    inputFields.values.forEach { $0.text = "" }
    content.isUserInteractionEnabled = false
    Task { [weak self, service] in
      do {
        let next = try await service.auth(request)
        guard let self, self.scope.key == self.scopeKey else { return }
        self.busy = false
        if let pending = self.pendingEvent, pending != next {
          self.pendingEvent = nil
          self.send("status")
          return
        }
        self.pendingEvent = nil
        self.content.isUserInteractionEnabled = true
        self.state = next
        self.render()
        if next.status == "authenticated" { self.authenticated?() }
        if action == "cancel", next.status == "cancelled" { self.closeForm(); return }
        self.scheduleStatus()
      } catch {
        guard let self, self.scope.key == self.scopeKey else { return }
        self.busy = false
        self.pendingEvent = nil
        self.failed = true
        self.content.isUserInteractionEnabled = true
        self.render()
      }
    }
  }

  private func scheduleStatus() {
    guard !terminal, !failed, state?.status != "method-required", state?.status != "input-required",
          state?.acceptsAuthorizationCode != true, state?.requiresAuthorizationConsent != true else { return }
    polling = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(1)) } catch { return }
      guard !Task.isCancelled else { return }
      self?.send("status")
    }
  }

  private func cancel() {
    guard !busy else { return }
    if !started || terminal || scope.key != scopeKey { closeForm(); return }
    send("cancel")
  }
}
