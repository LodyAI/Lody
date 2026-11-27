import Capacitor
import Foundation
import UIKit

@objc(LodyPasskeyPlugin)
public final class LodyPasskeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LodyPasskeyPlugin"
    public let jsName = "LodyPasskey"
    public let pluginMethods: [CAPPluginMethod] = ["available", "register", "authenticate"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    @MainActor private var ceremony: AnyObject?
    private static let activationWait: TimeInterval = 1

    private var enabled: Bool { Bundle.main.object(forInfoDictionaryKey: "LodyPasskeyEnabled") as? String == "YES" }

    @objc public func available(_ call: CAPPluginCall) {
        if #available(iOS 18.4, *) { call.resolve(["available": enabled]) }
        else { call.resolve(["available": false]) }
    }

    @objc public func register(_ call: CAPPluginCall) { perform(call, registration: true) }
    @objc public func authenticate(_ call: CAPPluginCall) { perform(call, registration: false) }

    private func reject(_ call: CAPPluginCall, _ error: LodyPasskeyError) {
        call.reject(error.rawValue, error.rawValue)
    }

    private func perform(_ call: CAPPluginCall, registration: Bool) {
        guard enabled else { reject(call, .unavailable); return }
        guard #available(iOS 18.4, *) else { reject(call, .unavailable); return }
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
                    Task { @MainActor in
                        defer { LodyPasskeyCallQueue.shared.finished() }
                        await self.run(call, registration: registration, allowed: allowed, input: input, handle: handle, userName: userName)
                    }
                }
            }
        } catch {
            reject(call, error as? LodyPasskeyError ?? .invalidRequest)
        }
    }

    /// Owns one queued call until the system ceremony actually settles.
    @available(iOS 18.4, *)
    @MainActor private func run(_ call: CAPPluginCall, registration: Bool, allowed: [Data], input: Data, handle: Data?, userName: String?) async {
        guard let window = await waitForActiveWindow() else { reject(call, .unavailable); return }
        let result = await withCheckedContinuation { (settled: CheckedContinuation<Result<[String: Any], LodyPasskeyError>, Never>) in
            let native = LodyPasskeyCeremony(window: window, registration: registration, allowed: allowed) { settled.resume(returning: $0) }
            ceremony = native
            do { try native.start(prfInput: input, userHandle: handle, userName: userName) }
            catch { settled.resume(returning: .failure(error as? LodyPasskeyError ?? .failed)) }
        }
        ceremony = nil
        switch result {
        case .success(let value): call.resolve(value)
        case .failure(let error): reject(call, error)
        }
    }

    /// A tap can open the ceremony while the scene is still `.foregroundInactive` (a closing
    /// sheet or Control Center). Wait briefly for activation; a scene that stays inactive or
    /// leaves the foreground is unavailable, never a credential failure.
    @MainActor private func waitForActiveWindow() async -> UIWindow? {
        guard let scene = bridge?.viewController?.viewIfLoaded?.window?.windowScene else { return nil }
        if scene.activationState == .foregroundInactive {
            await withTaskGroup(of: Void.self) { group in
                for name in [UIScene.didActivateNotification, UIScene.didEnterBackgroundNotification] {
                    group.addTask { @MainActor in
                        for await _ in NotificationCenter.default.notifications(named: name, object: scene) { return }
                    }
                }
                group.addTask { try? await Task.sleep(for: .seconds(Self.activationWait)) }
                await group.next()
                group.cancelAll()
            }
        }
        // Re-read after the wait: an activation before the observers subscribed is still seen here.
        guard scene.activationState == .foregroundActive else { return nil }
        return bridge?.viewController?.viewIfLoaded?.window
    }
}
