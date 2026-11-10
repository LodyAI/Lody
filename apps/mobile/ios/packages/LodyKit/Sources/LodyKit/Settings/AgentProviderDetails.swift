import Foundation
import LodyCore

typealias ProviderJSON = RuntimeContract.JSONValue

struct ProviderChoice: Codable, Equatable, Sendable {
  var id: String
  var name: String
}

struct ProviderCapabilities: Codable, Equatable, Sendable {
  struct Option: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var type: String
    var value: ProviderJSON?
    var choices: [ProviderChoice]
  }
  var models: [ProviderChoice] = []
  var modes: [ProviderChoice] = []
  var sessionTitle: Bool = false
  var options: [Option] = []
  var authMethods: [ProviderChoice] = []
}

struct ProviderDetail: Codable, Equatable, Sendable {
  struct Environment: Codable, Equatable, Sendable { var key: String; var hasValue: Bool }
  struct Endpoint: Codable, Equatable, Sendable { var key: String; var value: String }
  var id: String
  var machineId: String
  var revision: String
  var description: String
  var env: [Environment]
  var endpoints: [Endpoint]
  var runtimeOverrides: [String: ProviderJSON]
  var titleGeneration: ProviderJSON?
  var codexAuth: ProviderJSON?
  var presetId: String?
  var capabilities: ProviderCapabilities
  var supportsAuthentication: Bool
  var supportsMethodSelection: Bool
  var supportsCodexProfiles: Bool
  var supportsPiExtensions: Bool
  var supportsRateLimitsRefresh: Bool?
  struct Unavailable: Codable, Equatable, Sendable { var action: String; var reason: String }
  var unavailableActions: [Unavailable]
}

struct ProviderTarget: Encodable, Sendable {
  var workspaceId: String
  var machineId: String
  var id: String
}

struct ProviderProbe: Decodable, Sendable {
  var success: Bool
  var authRequired: Bool
  var capabilities: ProviderCapabilities
}

struct ProviderAuthRequest: Encodable, Sendable {
  var workspaceId: String
  var machineId: String
  var id: String
  var action: String
  var flowId: String
  var methodId: String?
  var interactionId: String?
  var values: [String: String]?
  var authorizationCode: String?
  var responseAction: String?
}

struct ProviderAuthState: Decodable, Equatable, Sendable {
  struct Field: Decodable, Equatable, Sendable {
    struct Option: Decodable, Equatable, Sendable { var value: String; var label: String }
    var id: String
    var label: String
    var type: String
    var required: Bool
    var options: [Option]
  }
  var flowId: String
  var status: String
  var methods: [ProviderChoice]
  var fields: [Field]
  var interactionId: String?
  var authorizationUrl: String?
  var userCode: String?
  var acceptsAuthorizationCode: Bool
  var requiresAuthorizationConsent: Bool
  var errorCode: String?
}

struct ProviderOperationRequest: Encodable, Sendable {
  var workspaceId: String
  var machineId: String
  var id: String?
  var action: String
  var cliType: String?
  var agentType: String?
}
struct ProviderOperationResult: Decodable, Sendable {
  struct ExtensionPath: Decodable, Sendable { var path: String; var name: String }
  var action: String
  var success: Bool
  var status: String?
  var extensions: [ExtensionPath]?
  var version: String?
  var errorCode: String?
}

@MainActor
struct ProviderDetailService {
  var detail: @MainActor (ProviderTarget) async throws -> ProviderDetail
  var probe: @MainActor (ProviderTarget) async throws -> ProviderProbe
  var auth: @MainActor (ProviderAuthRequest) async throws -> ProviderAuthState
  var operation: @MainActor (ProviderOperationRequest) async throws -> ProviderOperationResult

  static let cloud = ProviderDetailService(
    detail: { try await DataRuntime.settingsCall(RuntimeContract.Calls.AgentProviderDetail.self, $0, as: ProviderDetail.self) },
    probe: { try await DataRuntime.settingsCall(RuntimeContract.Calls.AgentProviderProbe.self, $0, as: ProviderProbe.self) },
    auth: { try await DataRuntime.settingsCall(RuntimeContract.Calls.AgentProviderAuth.self, $0, as: ProviderAuthState.self, timeout: 70) },
    operation: { try await DataRuntime.settingsCall(RuntimeContract.Calls.AgentProviderOperation.self, $0, as: ProviderOperationResult.self, timeout: 360) }
  )
}

extension Notification.Name {
  static let lodyProvidersChanged = Notification.Name("lody.providers-changed")
  static let lodyProviderAuthChanged = Notification.Name("lody.provider-auth-changed")
  static let lodyProviderOperationProgress = Notification.Name("lody.provider-operation-progress")
}
