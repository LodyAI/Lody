import Foundation
import Security

enum AuthKeychain {
  private static var query: [String: Any] { [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "ai.lody.mobile.auth",
    kSecAttrAccount as String: "better-auth-session",
  ] }
  static func read() throws -> String? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
    return token
  }
  static func save(_ token: String) throws {
    guard !token.isEmpty else { throw NSError(domain: "LodyKit.Auth", code: 1) }
    let values = [kSecValueData as String: Data(token.utf8)]
    var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      var item = query.merging(values) { _, value in value }
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
  }
  static func clear() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
  }
}
