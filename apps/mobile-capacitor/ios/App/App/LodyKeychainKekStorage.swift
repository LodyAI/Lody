import Foundation
import Security
import Darwin

/// No access groups, arbitrary paths, synchronizable items, or key export bridge.
final class LodyKeychainKekStorage: LodyKekStorage {
    private static let service = "ai.lody.mobile.e2ee.kek.v1"
    private static let directoryName = "LodyE2eeCustody"
    private let directory: URL

    init() throws {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        directory = support.appendingPathComponent(Self.directoryName, isDirectory: true)
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

    /// This service's non-synced data-protection items; one account when `id` is given.
    private static func baseQuery(_ id: String? = nil) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrSynchronizable as String: false,
                                    kSecUseDataProtectionKeychain as String: true]
        if let id = id { query[kSecAttrAccount as String] = id }
        return query
    }

    /// Full native reset only, once WebKit storage (which held every wrapped original) is
    /// gone and no LodyKek call is still admitted. Deletes every KEK of this service, then
    /// the receipts: a key never outlives its receipt, so a partial purge still refuses reuse.
    static func purgeAll() -> Bool {
        let all = baseQuery()
        let deleted = SecItemDelete(all as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else { return false }
        var remaining = all
        remaining[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(remaining as CFDictionary, nil) == errSecItemNotFound else { return false }
        guard let support = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                         appropriateFor: nil, create: false) else { return false }
        let receipts = support.appendingPathComponent(directoryName, isDirectory: true)
        if FileManager.default.fileExists(atPath: receipts.path) {
            do { try FileManager.default.removeItem(at: receipts) } catch { return false }
        }
        return !FileManager.default.fileExists(atPath: receipts.path)
    }

    private func check(_ status: OSStatus) throws {
        if status == errSecSuccess { return }
        if status == errSecInteractionNotAllowed { throw LodyKekError.locked }
        if status == errSecDuplicateItem || status == errSecItemNotFound { throw LodyKekError.reapproval }
        throw LodyKekError.unavailable
    }

    func readKey(_ id: String) throws -> Data? {
        var request = Self.baseQuery(id)
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
        var request = Self.baseQuery(id)
        request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        request[kSecValueData as String] = bytes
        // Add-only: never update/replace an existing or uncertain key.
        try check(SecItemAdd(request as CFDictionary, nil))
    }

    func deleteKey(_ id: String) throws {
        let status = SecItemDelete(Self.baseQuery(id) as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }
}
