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
                    self.whenActive { window in
                        guard let window else {
                            call.reject("unavailable", "unavailable")
                            LodyPasskeyCallQueue.shared.finished()
                            return
                        }
                        self.start(call, window: window, registration: registration, allowed: allowed, input: input, handle: handle, userName: userName)
                    }
                }
            }
        } catch {
            let failure = error as? LodyPasskeyError ?? .invalidRequest
            call.reject(failure.rawValue, failure.rawValue)
        }
    }

    /// A tap that opens the ceremony can arrive while the scene is still
    /// `.foregroundInactive` (a dismissing sheet or Control Center). Wait briefly for
    /// activation; a scene that stays inactive is unavailable, never a credential failure.
    @MainActor private func whenActive(_ ready: @escaping @MainActor (UIWindow?) -> Void) {
        guard let window = bridge?.viewController?.viewIfLoaded?.window,
              let scene = window.windowScene else { ready(nil); return }
        switch scene.activationState {
        case .foregroundActive: ready(window); return
        case .foregroundInactive: break
        default: ready(nil); return
        }
        let wait = LodyPasskeyActivationWait(scene: scene) { active in
            ready(active && scene.activationState == .foregroundActive ? window : nil)
        }
        wait.begin(timeout: Self.activationWait)
    }

    private static let activationWait: TimeInterval = 1

    @available(iOS 18.4, *)
    @MainActor private func start(_ call: CAPPluginCall, window: UIWindow, registration: Bool, allowed: [Data], input: Data, handle: Data?, userName: String?) {
        let native = LodyPasskeyCeremony(window: window, registration: registration, allowed: allowed) { [self] result in
            self.ceremony = nil
            switch result {
            case .success(let value): call.resolve(value)
            case .failure(let error): call.reject(error.rawValue, error.rawValue)
            }
            LodyPasskeyCallQueue.shared.finished()
        }
        ceremony = native
        do { try native.start(prfInput: input, userHandle: handle, userName: userName) }
        catch {
            ceremony = nil
            let failure = error as? LodyPasskeyError ?? .failed
            call.reject(failure.rawValue, failure.rawValue)
            LodyPasskeyCallQueue.shared.finished()
        }
    }
}

/// One bounded wait for a scene's activation; it answers exactly once.
@MainActor
private final class LodyPasskeyActivationWait {
    private let scene: UIScene
    private let ready: @MainActor (Bool) -> Void
    private var observer: NSObjectProtocol?
    private var answered = false

    init(scene: UIScene, ready: @escaping @MainActor (Bool) -> Void) {
        self.scene = scene
        self.ready = ready
    }

    func begin(timeout: TimeInterval) {
        observer = NotificationCenter.default.addObserver(forName: UIScene.didActivateNotification, object: scene, queue: .main) { [self] _ in
            Task { @MainActor in self.answer(true) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [self] in
            Task { @MainActor in self.answer(false) }
        }
    }

    private func answer(_ active: Bool) {
        guard !answered else { return }
        answered = true
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        ready(active)
    }
}
