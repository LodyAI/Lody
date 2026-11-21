import Capacitor
import Foundation

@objc(LodyKekPlugin)
public final class LodyKekPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LodyKekPlugin"
    public let jsName = "LodyKek"
    public let pluginMethods: [CAPPluginMethod] = ["install", "status", "wrap", "unwrap", "delete"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private static func reject(_ call: CAPPluginCall, error: Error) {
        let failure: LodyKekError
        if let typed = error as? LodyKekError { failure = typed }
        else if let cocoa = error as? CocoaError,
                cocoa.code == .fileReadNoPermission || cocoa.code == .fileWriteNoPermission { failure = .locked }
        else { failure = .unavailable }
        call.reject(failure.rawValue, failure.rawValue)
    }

    private func perform(_ call: CAPPluginCall, operation: @escaping (LodyKekCustody, LodyKekScope) throws -> [String: Any]) {
        do {
            guard let account = call.getString("accountId"), let workspace = call.getString("workspaceId"),
                  let genesis = call.getString("genesisHash"), let device = call.getString("deviceId"),
                  let installation = call.getString("installationId") else { throw LodyKekError.invalidRequest }
            let scope = try LodyKekScope(accountId: account, workspaceId: workspace, genesisHash: genesis, deviceId: device, installationId: installation)
            LodyKekCallQueue.shared.enqueue(route: scope.routingId) {
                // Promise settlement means actual native return, never a cancelled waiter or timeout.
                do {
                    let custody = LodyKekCustody(storage: try LodyKeychainKekStorage())
                    call.resolve(try operation(custody, scope))
                } catch { Self.reject(call, error: error) }
            }
        } catch { Self.reject(call, error: error) }
    }

    @objc public func install(_ call: CAPPluginCall) {
        perform(call) { custody, scope in
            try custody.install(scope)
            return ["state": "ready", "version": 1, "installationId": scope.installationId]
        }
    }
    @objc public func status(_ call: CAPPluginCall) {
        perform(call) { custody, scope in
            let state = try custody.status(scope)
            return ["state": state.rawValue, "version": 1, "installationId": scope.installationId]
        }
    }
    @objc public func wrap(_ call: CAPPluginCall) {
        perform(call) { custody, scope in
            guard let purpose = call.getString("purpose"), let encoded = call.getString("plaintext"), encoded.count <= 5464,
                  let bytes = Data(base64Encoded: encoded) else { throw LodyKekError.invalidRequest }
            return ["wrapped": try custody.wrap(scope, purpose: purpose, plaintext: bytes).base64EncodedString()]
        }
    }
    @objc public func unwrap(_ call: CAPPluginCall) {
        perform(call) { custody, scope in
            guard let purpose = call.getString("purpose"), let encoded = call.getString("wrapped"), encoded.count <= 5500,
                  let bytes = Data(base64Encoded: encoded) else { throw LodyKekError.invalidRequest }
            return ["plaintext": try custody.unwrap(scope, purpose: purpose, wrapped: bytes).base64EncodedString()]
        }
    }
    @objc public func delete(_ call: CAPPluginCall) {
        perform(call) { custody, scope in
            try custody.delete(scope)
            return ["state": "deleted"]
        }
    }
}
