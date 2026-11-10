import UIKit

/// A synthetic machine rejects the wrong method-selection flow and consent order.
@MainActor
enum AgentProvidersAuthPreview {
  static func make() -> UIViewController {
    let fixture = Fixture()
    let service = ProviderDetailService(
      detail: { _ in throw SettingsError("unused") },
      probe: { _ in throw SettingsError("unused") },
      auth: { try fixture.auth($0) },
      operation: { _ in throw SettingsError("unused") }
    )
    return AgentProviderAuthController(target: .init(workspaceId: "auth-preview", machineId: "studio", id: "fixture-agent"),
                                       methods: [], scope: SettingsActor(userId: "fixture", workspaceId: "auth-preview"), service: service)
  }

  private final class Fixture {
    private var firstFlow: String?
    private var activeFlow: String?
    private var phase = 0

    func auth(_ request: ProviderAuthRequest) throws -> ProviderAuthState {
      guard request.workspaceId == "auth-preview", request.machineId == "studio", request.id == "fixture-agent" else { throw SettingsError("wrong_auth_scope") }
      var state = ProviderAuthState(flowId: request.flowId, status: "method-required", methods: [], fields: [],
                                    acceptsAuthorizationCode: false, requiresAuthorizationConsent: false)
      if request.action == "cancel" { state.status = "cancelled"; return state }
      switch phase {
      case 0:
        guard request.action == "start", request.methodId == nil else { throw SettingsError("wrong_initial_start") }
        firstFlow = request.flowId
        phase = 1
        state.methods = [.init(id: "browser", name: "Browser sign-in")]
      case 1:
        guard request.action == "start", request.methodId == "browser", request.flowId != firstFlow,
              request.interactionId == nil else { throw SettingsError("method_requires_new_flow") }
        activeFlow = request.flowId
        phase = 2
        state.interactionId = "fixture-method"
        state.methods = [.init(id: "organization", name: "Organization sign-in")]
      case 2:
        guard request.action == "submit", request.methodId == "organization", request.flowId == activeFlow,
              request.interactionId == "fixture-method" else { throw SettingsError("method_requires_existing_interaction") }
        phase = 3
        state.status = "authorization"
        state.interactionId = "fixture-consent"
        state.authorizationUrl = "https://signin.fixture.invalid/authorize"
        state.requiresAuthorizationConsent = true
      case 3:
        guard request.action == "submit", request.responseAction == "accept", request.flowId == activeFlow,
              request.interactionId == "fixture-consent" else { throw SettingsError("consent_required") }
        phase = 4
        state.status = "authorization"
        state.interactionId = "fixture-code"
        state.authorizationUrl = "https://signin.fixture.invalid/authorize"
        state.acceptsAuthorizationCode = true
      default:
        guard request.action == "submit", request.authorizationCode == "fixture-final-code", request.flowId == activeFlow,
              request.interactionId == "fixture-code" else { throw SettingsError("wrong_final_interaction") }
        state.status = "authenticated"
      }
      return state
    }
  }
}
