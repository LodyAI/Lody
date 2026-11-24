import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

@available(iOS 18.4, *)
@MainActor
final class LodyPasskeyCeremony: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private let window: UIWindow
    private let registration: Bool
    private let allowed: [Data]
    private let finish: (Result<[String: Any], LodyPasskeyError>) -> Void
    private var controller: ASAuthorizationController?
    private var settled = false

    init(window: UIWindow, registration: Bool, allowed: [Data], finish: @escaping (Result<[String: Any], LodyPasskeyError>) -> Void) {
        self.window = window
        self.registration = registration
        self.allowed = allowed
        self.finish = finish
    }

    static func challenge() throws -> Data {
        var bytes = Data(count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer in
            guard let address = buffer.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, buffer.count, address)
        }
        guard status == errSecSuccess else { throw LodyPasskeyError.unavailable }
        return bytes
    }

    func start(prfInput: Data, userHandle: Data?, userName: String?) throws {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: LodyPasskeyCodec.relyingParty)
        let request: ASAuthorizationRequest
        if registration {
            guard let userHandle, userHandle.count == 32, let userName, !userName.isEmpty,
                  userName.utf8.count <= 256 else { throw LodyPasskeyError.invalidRequest }
            let create = provider.createCredentialRegistrationRequest(challenge: try Self.challenge(), name: userName, userID: userHandle)
            create.userVerificationPreference = .required
            create.prf = .checkForSupport
            create.excludedCredentials = allowed.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
            request = create
        } else {
            let assertion = provider.createCredentialAssertionRequest(challenge: try Self.challenge())
            assertion.userVerificationPreference = .required
            assertion.allowedCredentials = allowed.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
            assertion.prf = .inputValues(.init(saltInput1: prfInput))
            request = assertion
        }
        let controller = ASAuthorizationController(authorizationRequests: [request])
        self.controller = controller
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { window }

    private func complete(_ result: Result<[String: Any], LodyPasskeyError>) {
        guard !settled else { return }
        settled = true
        controller = nil
        finish(result)
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        if registration, let created = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            guard !created.credentialID.isEmpty, !allowed.contains(created.credentialID) else { complete(.failure(.failed)); return }
            complete(.success([
                "credentialId": LodyPasskeyCodec.encode(created.credentialID),
                "prfEnabled": created.prf?.isSupported == true,
            ]))
        } else if !registration, let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            guard !assertion.credentialID.isEmpty, allowed.isEmpty || allowed.contains(assertion.credentialID) else { complete(.failure(.failed)); return }
            var first = assertion.prf?.first.withUnsafeBytes { Data($0) }
            defer { if let count = first?.count { first?.resetBytes(in: 0..<count) } }
            complete(.success([
                "credentialId": LodyPasskeyCodec.encode(assertion.credentialID),
                "userHandle": assertion.userID.isEmpty ? NSNull() : LodyPasskeyCodec.encode(assertion.userID) as Any,
                "userVerified": LodyPasskeyCodec.userVerified(assertion.rawAuthenticatorData),
                "prfFirst": first.map(LodyPasskeyCodec.encode) as Any? ?? NSNull(),
            ]))
        } else { complete(.failure(.failed)) }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let native = error as NSError
        complete(.failure(native.domain == ASAuthorizationError.errorDomain && native.code == ASAuthorizationError.canceled.rawValue ? .cancelled : .failed))
    }
}
