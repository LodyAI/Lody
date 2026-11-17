import UIKit

@MainActor
enum AgentProvidersPreview {
  static func make() -> UIViewController {
    let fixture = Fixture()
    let details = ProviderDetailService(
      detail: { try fixture.detail($0) },
      probe: { _ in ProviderProbe(success: true, authRequired: false, capabilities: fixture.capabilities) },
      auth: { request in
        var status = "authorization"
        if request.action == "cancel" { status = "cancelled" }
        if request.action == "submit" {
          guard request.authorizationCode == "synthetic-code" else { throw SettingsError("provider_auth_failed") }
          status = "authenticated"
        }
        return ProviderAuthState(flowId: request.flowId, status: status, methods: [], fields: [], userCode: "FIXTURE-1234", acceptsAuthorizationCode: status == "authorization", requiresAuthorizationConsent: false)
      },
      operation: { request in ProviderOperationResult(action: request.action, success: true, status: request.action.hasPrefix("binary-") ? "installed" : nil, extensions: request.action == "pi-extension-scan" ? [.init(path: "/fixture/extensions/example", name: "Example extension")] : nil, version: "fixture") }
    )
    return AgentProvidersController(scope: SettingsActor(userId: "fixture", workspaceId: "provider-preview"), service: { request in
      try fixture.perform(request)
    }, details: details)
  }

  private final class Fixture {
    private var refreshCount = 0
    private var revisions: [String: Int] = [:]
    private var descriptions: [String: String] = [:]
    private var envKeys: [String: Set<String>] = [:]
    private var runtimes: [String: [String: ProviderJSON]] = [:]
    private var titles: [String: ProviderJSON] = [:]
    var capabilities: ProviderCapabilities {
      ProviderCapabilities(models: [.init(id: "fixture-model", name: "Fixture model")], modes: [], sessionTitle: false, options: [], authMethods: [.init(id: "fixture-sign-in", name: "Fixture sign-in")])
    }
    func detail(_ target: ProviderTarget) throws -> ProviderDetail {
      guard snapshot.providers.contains(where: { $0.id == target.id && $0.machineId == target.machineId }) || snapshot.setups.contains(where: { $0.id == target.id && $0.machineId == target.machineId }) else { throw SettingsError("provider_not_found") }
      return ProviderDetail(id: target.id, machineId: target.machineId, revision: String(revisions[target.id] ?? 0),
                            description: descriptions[target.id] ?? "", env: (envKeys[target.id] ?? ["EXISTING_FIXTURE_VALUE"]).sorted().map { .init(key: $0, hasValue: true) }, endpoints: [],
                            runtimeOverrides: runtimes[target.id] ?? [:], titleGeneration: titles[target.id], capabilities: capabilities,
                            supportsAuthentication: true, supportsMethodSelection: true, supportsCodexProfiles: true, supportsPiExtensions: true, unavailableActions: [])
    }
    var snapshot = AgentProviderSnapshot(
      machines: [
        AgentProviderMachine(id: "studio", name: "Studio Mac", online: true, readOnly: false, os: "darwin", supportsSetup: true, supportsCodexProfiles: true, supportsAuthentication: true, supportsPiExtensions: true),
        AgentProviderMachine(id: "empty", name: "Build Linux", online: true, readOnly: false, os: "linux", supportsSetup: true),
        AgentProviderMachine(id: "team", name: "Team Mac", online: false, readOnly: true, os: "darwin"),
      ],
      providers: [
        AgentProviderItem(id: "codex", machineId: "studio", name: "Codex", cliType: "builtin", agentType: "codex", prompt: "Keep changes focused."),
        AgentProviderItem(id: "claude", machineId: "studio", name: "Claude Code", cliType: "builtin", agentType: "claude"),
        AgentProviderItem(id: "team-codex", machineId: "team", name: "Team Codex", cliType: "builtin", agentType: "codex", readOnly: true),
      ],
      setups: [AgentProviderSetup(id: "setup", machineId: "studio", name: "Kimi setup", agentType: "kimi", status: "failed",
                                  attempt: 1, failureCode: "runtime_unavailable", canRetry: true, canDelete: true)],
      catalog: [
        AgentProviderCatalogItem(id: "codex", name: "Codex", cliType: "builtin", agentType: "codex"),
        AgentProviderCatalogItem(id: "claude", name: "Claude Code", cliType: "builtin", agentType: "claude"),
      ]
    )

    func perform(_ request: AgentProviderRequest) throws -> AgentProviderSnapshot {
      switch request.action {
      case "list": break
      case "save":
        guard let fields = request.fields, let id = request.id, let machine = request.machineId else { throw SettingsError("invalid_setting") }
        guard snapshot.machines.first(where: { $0.id == machine })?.readOnly == false else { throw SettingsError("setting_read_only") }
        if let revision = fields.detailRevision, revision != String(revisions[id] ?? 0) { throw SettingsError("provider_conflict") }
        if fields.name.contains("Rejected fixture") { throw SettingsError("setting_write_unknown") }
        if let description = fields.description { descriptions[id] = description }
        var keys = envKeys[id] ?? ["EXISTING_FIXTURE_VALUE"]
        for (key, value) in fields.envPatch ?? [:] {
          if value == nil { keys.remove(key) } else { keys.insert(key) }
        }
        envKeys[id] = keys
        if case .object(let patch) = fields.runtimeOverrides, case .object(let values) = patch["value"] {
          var runtime = runtimes[id] ?? [:]
          runtime.merge(values) { _, new in new }
          if case .array(let remove) = patch["remove"] {
            for case .string(let key) in remove { runtime.removeValue(forKey: key) }
          }
          runtimes[id] = runtime
        }
        if case .object(let patch) = fields.titleGeneration { titles[id] = patch["value"] }
        revisions[id, default: 0] += 1
        if fields.cliType != "custom" && (!fields.command.isEmpty || !fields.args.isEmpty) { throw SettingsError("invalid_provider_command") }
        if request.base == nil && fields.cliType == "builtin" && fields.agentType != "deepseek" {
          snapshot.setups.append(AgentProviderSetup(id: id, machineId: machine, name: fields.name, agentType: fields.agentType,
                                                   status: "queued", attempt: 1, canDelete: true))
          return result(request)
        }
        snapshot.providers.removeAll { $0.id == id }
        snapshot.providers.append(AgentProviderItem(id: id, machineId: machine, name: fields.name, cliType: fields.cliType,
                                                    agentType: fields.agentType, prompt: fields.prompt, command: fields.command, args: fields.args))
      case "delete": snapshot.providers.removeAll { $0.id == request.base?.id }
      case "refresh":
        refreshCount += 1
        if refreshCount == 2 { throw SettingsError("provider_refresh_unknown") }
        snapshot.authRequired = true
      case "retrySetup":
        if let index = snapshot.setups.firstIndex(where: { $0.id == request.setup?.id }) {
          snapshot.setups[index].status = "queued"
          snapshot.setups[index].attempt += 1
          snapshot.setups[index].canRetry = false
        }
      case "deleteSetup": snapshot.setups.removeAll { $0.id == request.setup?.id }
      default: throw SettingsError("invalid_setting")
      }
      return result(request)
    }

    private func result(_ request: AgentProviderRequest) -> AgentProviderSnapshot {
      guard request.action != "list", let machine = request.machineId ?? request.base?.machineId ?? request.setup?.machineId else { return snapshot }
      var next = snapshot
      next.authRequired = request.action == "refresh" ? snapshot.authRequired : nil
      next.providers = snapshot.providers.filter { $0.machineId == machine }
      next.setups = snapshot.setups.filter { $0.machineId == machine }
      return next
    }
  }
}
