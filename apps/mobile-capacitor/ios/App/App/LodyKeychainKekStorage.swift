import Foundation
import Security
import Darwin

/// No access groups, arbitrary paths, synchronizable items, or key export bridge.
final class LodyKeychainKekStorage: LodyKekStorage {
    private let directory: URL
    private let service = "ai.lody.mobile.e2ee.kek.v1"

    init() throws {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        directory = support.appendingPathComponent("LodyE2eeCustody", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    private func file(_ id: String) -> URL { directory.appendingPathComponent(id + ".json") }

    func readMarker(_ id: String) throws -> LodyKekMarker? {
        do { return try JSONDecoder().decode(LodyKekMarker.self, from: Data(contentsOf: file(id))) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
        catch let error as CocoaError where error.code == .fileReadNoPermission { throw LodyKekError.locked }
        catch { throw LodyKekError.unknown }
    }

    func writeMarker(_ marker: LodyKekMarker) throws {
        do {
            try JSONEncoder().encode(marker).write(to: file(marker.scopeId), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var url = file(marker.scopeId)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.synchronize()
            let descriptor = open(directory.path, O_RDONLY)
            guard descriptor >= 0 else { throw LodyKekError.unknown }
            defer { close(descriptor) }
            guard fsync(descriptor) == 0 else { throw LodyKekError.unknown }
        } catch { throw LodyKekError.unknown }
    }

    private func query(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: id,
         kSecAttrSynchronizable as String: false,
         kSecUseDataProtectionKeychain as String: true]
    }

    private func check(_ status: OSStatus) throws {
        if status == errSecSuccess { return }
        if status == errSecInteractionNotAllowed { throw LodyKekError.locked }
        if status == errSecDuplicateItem || status == errSecItemNotFound { throw LodyKekError.reapproval }
        throw LodyKekError.unavailable
    }

    func readKey(_ id: String) throws -> Data? {
        var request = query(id)
        request[kSecReturnData as String] = true
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let item = result as? [String: Any],
              let accessible = item[kSecAttrAccessible as String] as? String,
              accessible == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String,
              (item[kSecAttrSynchronizable as String] as? Bool) != true,
              let bytes = item[kSecValueData as String] as? Data, bytes.count == 32 else { throw LodyKekError.unavailable }
        return bytes
    }

    func createKey(_ id: String, bytes: Data) throws {
        var request = query(id)
        request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        request[kSecValueData as String] = bytes
        // Add-only: never update/replace an existing or uncertain key.
        try check(SecItemAdd(request as CFDictionary, nil))
    }

    func deleteKey(_ id: String) throws {
        let status = SecItemDelete(query(id) as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }
}
