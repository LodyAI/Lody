// Synthetic fixture only; not shipped or used by a product entry point.
import Foundation
import Security
import CryptoKit

let args = CommandLine.arguments
guard args.count == 5, let uuid = UUID(uuidString: args[2]),
      ["personal-device", "machine"].contains(args[4]),
      URL(fileURLWithPath: args[3]).lastPathComponent == "lody-host-keys-" + uuid.uuidString else {
    exit(64)
}
let action = args[1]
let directory = args[3]
let path = directory + "/fixture.keychain"
let service = "ai.lody.synthetic.host-keys." + uuid.uuidString
let password = Data("SYNTHETIC-FIXTURE-ONLY".utf8)
func emit(_ object: [String: Any]) {
    print(String(data: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), encoding: .utf8)!)
}
func fail(_ status: OSStatus) -> Never { emit(["status": status]); exit(0) }
func require(_ status: OSStatus) { if status != errSecSuccess { fail(status) } }
func searchList() -> NSArray {
    var value: CFArray?
    require(SecKeychainCopySearchList(&value))
    return value! as NSArray
}
let before = searchList()
// Process-local policy only. Never change default/search-list/user keychain settings.
require(SecKeychainSetUserInteractionAllowed(false))
var keychain: SecKeychain?
if action == "setup" {
    require(password.withUnsafeBytes { SecKeychainCreate(path, UInt32(password.count), $0.baseAddress, false, nil, &keychain) })
} else {
    require(SecKeychainOpen(path, &keychain))
}
guard let keychain else { exit(70) }
require(password.withUnsafeBytes { SecKeychainUnlock(keychain, UInt32(password.count), $0.baseAddress, true) })
var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: args[4] + ":synthetic-account:synthetic-device",
    kSecMatchSearchList as String: [keychain],
    kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail
]
if action == "setup" {
    guard before.isEqual(searchList()) else { exit(71) }
    emit(["status": 0]); exit(0)
}
if action == "cleanup" {
    // Exact fixture service + both known purposes, never enumerate user entries.
    for purpose in ["personal-device", "machine"] {
        query[kSecAttrAccount as String] = purpose + ":synthetic-account:synthetic-device"
        let deleted = SecItemDelete(query as CFDictionary)
        guard [errSecSuccess, errSecItemNotFound].contains(deleted) else { fail(deleted) }
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        guard status == errSecItemNotFound && found == nil else { exit(72) }
    }
    require(SecKeychainDelete(keychain))
    guard before.isEqual(searchList()) else { exit(73) }
    emit(["status": 0, "deletedAndMissing": true]); exit(0)
}
if action == "create" {
    let sign = Curve25519.Signing.PrivateKey()
    let agreement = Curve25519.KeyAgreement.PrivateKey()
    var bytes = sign.rawRepresentation + agreement.rawRepresentation
    defer { bytes.resetBytes(in: 0..<bytes.count) }
    var add = query
    add.removeValue(forKey: kSecMatchSearchList as String)
    add[kSecUseKeychain as String] = keychain
    add[kSecValueData as String] = bytes
    require(SecItemAdd(add as CFDictionary, nil))
} else if action == "corrupt" {
    // Deliberately corrupt this fixture's record only, to exercise read preservation.
    require(SecItemUpdate(query as CFDictionary, [kSecValueData as String: Data([1, 2, 3])] as CFDictionary))
} else if action == "locked-read" {
    require(SecKeychainLock(keychain))
} else if action != "read" { exit(64) }
query[kSecReturnData as String] = true
query[kSecMatchLimit as String] = kSecMatchLimitOne
var found: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &found)
if status != errSecSuccess {
    guard found == nil else { exit(74) }
    fail(status)
}
guard var bytes = found as? Data else { exit(75) }
defer { bytes.resetBytes(in: 0..<bytes.count) }
guard bytes.count == 64 else {
    emit(["status": 0, "invalidRecord": true]); exit(0)
}
let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: bytes.prefix(32))
let agreement = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: bytes.suffix(32))
// Fixed, synthetic self-test. No caller-controlled message or signature output.
let message = Data("host-keys synthetic self-test".utf8)
guard signing.publicKey.isValidSignature(try signing.signature(for: message), for: message) else { exit(76) }
let peer = Curve25519.KeyAgreement.PrivateKey()
let a = try agreement.sharedSecretFromKeyAgreement(with: peer.publicKey)
let b = try peer.sharedSecretFromKeyAgreement(with: agreement.publicKey)
guard a.withUnsafeBytes({ Data($0) }) == b.withUnsafeBytes({ Data($0) }) else { exit(77) }
func hex(_ bytes: Data) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
guard before.isEqual(searchList()) else { exit(78) }
emit(["status": 0, "ed25519": hex(signing.publicKey.rawRepresentation), "x25519": hex(agreement.publicKey.rawRepresentation)])
