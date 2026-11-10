import UIKit

/// Independently resettable fixtures for the production preset and Pi editors.
@MainActor
enum AgentProvidersAdvancedPreview {
  static func make(pi: Bool) -> UIViewController {
    let fixture = Fixture(pi: pi)
    let details = ProviderDetailService(
      detail: { try fixture.detail($0) },
      probe: { _ in ProviderProbe(success: true, authRequired: false, capabilities: ProviderCapabilities()) },
      auth: { _ in throw SettingsError("provider_auth_unavailable") },
      operation: { request in
        guard request.action == "pi-extension-scan", request.id == "pi-agent" else { throw SettingsError("provider_operation_unavailable") }
        return ProviderOperationResult(action: request.action, success: true, extensions: [
          .init(path: "/fixture/extensions/retained", name: "Retained extension"),
          .init(path: "/fixture/extensions/example", name: "Example extension"),
        ])
      }
    )
    return AgentProvidersController(scope: SettingsActor(userId: "fixture", workspaceId: pi ? "pi-preview" : "presets-preview"),
                                    service: { try fixture.perform($0) }, details: details)
  }

  private final class Fixture {
    private let pi: Bool
    private var revision = 0
    private var endpoint = "https://us.fixture.invalid/v1"
    private var runtime: [String: ProviderJSON] = [
      "piPath": .string("/fixture/bin/pi"),
      "piExtensions": .array([.string("/fixture/extensions/retained")]),
    ]
    private var snapshot: AgentProviderSnapshot

    init(pi: Bool) {
      self.pi = pi
      let preset = ProviderPreset(id: "fixture-gateway", name: "Fixture gateway", cliType: "registry", agentType: "reasonix",
                                  tokenEnvKey: "FIXTURE_API_KEY", protectedEnvKeys: ["FIXTURE_API_KEY", "ANTHROPIC_BASE_URL"], modes: [
        .init(id: "regions", name: "Regional endpoint", endpoint: "https://us.fixture.invalid/v1", tokenPrefix: "fixture-", customEndpoint: false, endpoints: [
          .init(id: "us", name: "Fixture US", url: "https://us.fixture.invalid/v1"),
          .init(id: "eu", name: "Fixture EU", url: "https://eu.fixture.invalid/v1"),
        ]),
        .init(id: "custom", name: "Custom endpoint", endpoint: "https://custom.fixture.invalid/v1", tokenPrefix: "fixture-", customEndpoint: true, endpoints: []),
      ])
      let item = AgentProviderItem(id: pi ? "pi-agent" : "preset-agent", machineId: "studio", name: pi ? "Fixture Pi" : "Fixture gateway",
                                   cliType: pi ? "builtin" : "registry", agentType: pi ? "pi" : "reasonix")
      snapshot = AgentProviderSnapshot(
        machines: [.init(id: "studio", name: "Fixture Mac", online: true, readOnly: false, os: "darwin", supportsSetup: true, supportsPiExtensions: true)],
        providers: [item], setups: [],
        catalog: [.init(id: pi ? "pi" : preset.id, name: item.name, cliType: item.cliType, agentType: item.agentType, presetId: pi ? nil : preset.id)],
        presets: pi ? [] : [preset])
    }

    func detail(_ target: ProviderTarget) throws -> ProviderDetail {
      guard target.machineId == "studio", target.id == snapshot.providers.first?.id else { throw SettingsError("provider_not_found") }
      return ProviderDetail(id: target.id, machineId: target.machineId, revision: String(revision), description: "",
                            env: pi ? [] : [.init(key: "FIXTURE_API_KEY", hasValue: true), .init(key: "KEEP_ME", hasValue: true)],
                            endpoints: pi ? [] : [.init(key: "ANTHROPIC_BASE_URL", value: endpoint)],
                            runtimeOverrides: pi ? runtime : [:], titleGeneration: nil, presetId: pi ? nil : "fixture-gateway",
                            capabilities: ProviderCapabilities(), supportsAuthentication: false, supportsMethodSelection: false,
                            supportsCodexProfiles: false, supportsPiExtensions: pi, unavailableActions: [])
    }

    func perform(_ request: AgentProviderRequest) throws -> AgentProviderSnapshot {
      if request.action == "list" { return snapshot }
      guard request.action == "save", let fields = request.fields, request.id == snapshot.providers.first?.id,
            request.machineId == "studio", fields.detailRevision == String(revision) else { throw SettingsError("provider_conflict") }
      if pi {
        if case .object(let patch) = fields.runtimeOverrides {
          guard patch["action"] == .string("merge"), case .object(let value) = patch["value"],
                case .array(let remove) = patch["remove"] else { throw SettingsError("invalid_runtime_patch") }
          runtime.merge(value) { _, next in next }
          for case .string(let key) in remove { runtime.removeValue(forKey: key) }
        }
      } else {
        if let preset = fields.presetId {
          guard preset == "fixture-gateway", fields.presetModeId == "custom",
                let next = fields.presetEndpoint, URL(string: next)?.host?.hasSuffix(".fixture.invalid") == true,
                fields.envPatch?["FIXTURE_API_KEY"] == "fixture-synthetic-key" else { throw SettingsError("invalid_preset") }
          endpoint = next
        } else {
          // An unrelated edit must keep the stored endpoint and credential without resending either.
          guard fields.envPatch == nil, fields.presetEndpoint == nil, fields.presetModeId == nil else { throw SettingsError("invalid_preset_patch") }
        }
      }
      snapshot.providers[0].name = fields.name
      revision += 1
      return snapshot
    }
  }
}
