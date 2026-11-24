import Capacitor
import Foundation

@objc(LodyPasskeyPlugin)
public final class LodyPasskeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LodyPasskeyPlugin"
    public let jsName = "LodyPasskey"
    public let pluginMethods: [CAPPluginMethod] = ["available", "register", "authenticate"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    @MainActor private var ceremony: AnyObject?

    private var enabled: Bool { Bundle.main.object(forInfoDictionaryKey: "LodyPasskeyEnabled") as? String == "YES" }

    @objc public func available(_ call: CAPPluginCall) {
        if #available(iOS 18.4, *) { call.resolve(["available": enabled]) }
        else { call.resolve(["available": false]) }
    }

    @objc public func register(_ call: CAPPluginCall) { perform(call, registration: true) }
    @objc public func authenticate(_ call: CAPPluginCall) { perform(call, registration: false) }

    private func perform(_ call: CAPPluginCall, registration: Bool) {
        guard enabled else { call.reject("unavailable", "unavailable"); return }
        guard #available(iOS 18.4, *) else { call.reject("unavailable", "unavailable"); return }
        do {
            guard call.getString("rpId") == LodyPasskeyCodec.relyingParty,
                  let encodedInput = call.getString("prfInput"),
                  let ids = call.getArray(registration ? "excludeCredentialIds" : "allowCredentialIds", String.self) else { throw LodyPasskeyError.invalidRequest }
            let input = try LodyPasskeyCodec.decode(encodedInput)
            let allowed = try LodyPasskeyCodec.credentialIds(ids)
            let handle = try call.getString("userHandle").map { try LodyPasskeyCodec.decode($0, maximum: 32) }
            let userName = call.getString("userName")
            // Snapshot inputs before queueing; no credential/state is persisted or logged.
            Task { @MainActor in
                LodyPasskeyCallQueue.shared.enqueue { [self] in
                    guard let window = self.bridge?.viewController?.viewIfLoaded?.window,
                          window.windowScene?.activationState == .foregroundActive else {
                        call.reject("unavailable", "unavailable")
                        LodyPasskeyCallQueue.shared.finished()
                        return
                    }
                    let native = LodyPasskeyCeremony(window: window, registration: registration, allowed: allowed) { [self] result in
                        self.ceremony = nil
                        switch result {
                        case .success(let value): call.resolve(value)
                        case .failure(let error): call.reject(error.rawValue, error.rawValue)
                        }
                        LodyPasskeyCallQueue.shared.finished()
                    }
                    self.ceremony = native
                    do { try native.start(prfInput: input, userHandle: handle, userName: userName) }
                    catch {
                        self.ceremony = nil
                        let failure = error as? LodyPasskeyError ?? .failed
                        call.reject(failure.rawValue, failure.rawValue)
                        LodyPasskeyCallQueue.shared.finished()
                    }
                }
            }
        } catch {
            let failure = error as? LodyPasskeyError ?? .invalidRequest
            call.reject(failure.rawValue, failure.rawValue)
        }
    }
}
