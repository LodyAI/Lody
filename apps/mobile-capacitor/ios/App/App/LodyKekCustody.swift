import Foundation
import CryptoKit

/// Native-only errors. Never pass OS errors or caller data to the bridge/logger.
enum LodyKekError: String, Error {
    case invalidRequest = "INVALID_REQUEST"
    case locked = "LOCKED"
    case unavailable = "PROTECTION_UNAVAILABLE"
    case reapproval = "REAPPROVAL_REQUIRED"
    case unknown = "INSTALLATION_UNKNOWN"
    case authentication = "AUTHENTICATION_FAILED"
}

struct LodyKekScope {
    let accountId: String
    let workspaceId: String
    let genesisHash: String
    let deviceId: String
    let installationId: String
    private let genesis: Data
    private let device: Data

    init(accountId: String, workspaceId: String, genesisHash: String, deviceId: String, installationId: String) throws {
        let fields = [accountId, workspaceId, genesisHash, deviceId, installationId]
        guard fields.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 && !$0.utf8.contains(0) }) else {
            throw LodyKekError.invalidRequest
        }
        self.genesis = try Self.decodeHex32(genesisHash)
        self.device = try Self.decodeHex32(deviceId)
        _ = try Self.decodeHex32(installationId)
        self.accountId = accountId
        self.workspaceId = workspaceId
        self.genesisHash = genesisHash
        self.deviceId = deviceId
        self.installationId = installationId
    }

    /// Private storage address only, retained independently of wrapping AAD.
    private static func storageAddressBytes(_ fields: [String]) -> Data {
        var data = Data("lody.mobile.kek.v1\0".utf8)
        for field in fields {
            let bytes = Data(field.utf8)
            var length = UInt32(bytes.count).bigEndian
            withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
            data.append(bytes)
        }
        return data
    }

    var id: String {
        SHA256.hash(data: Self.storageAddressBytes([accountId, workspaceId, genesisHash, deviceId]))
            .map { String(format: "%02x", $0) }.joined()
    }

    // Same physical writer across device replacements; unrelated workspaces stay independent.
    var routingId: String {
        SHA256.hash(data: Self.storageAddressBytes([accountId, workspaceId, genesisHash]))
            .map { String(format: "%02x", $0) }.joined()
    }

    static let purposes = ["signing-private-key", "encryption-private-key", "device-credential", "installed-epoch-key", "rotation-candidate"]

    private static func decodeHex32(_ value: String) throws -> Data {
        let bytes = Array(value.utf8)
        guard bytes.count == 64, bytes.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw LodyKekError.invalidRequest
        }
        func nibble(_ byte: UInt8) -> UInt8 { byte <= 57 ? byte - 48 : byte - 87 }
        return Data(stride(from: 0, to: 64, by: 2).map { nibble(bytes[$0]) * 16 + nibble(bytes[$0 + 1]) })
    }

    /// Only the fixed A0 array schema: canonical DAG-CBOR text/bytes and uint 1.
    /// No caller-supplied CBOR/AAD, decoder, map ordering or arbitrary values.
    private func bindingAAD(domain: String, purpose: String) -> Data {
        var output = Data([0x88])
        func append(_ bytes: Data, major: UInt8) {
            let size = bytes.count
            if size < 24 { output.append(major | UInt8(size)) }
            else if size <= 255 { output.append(contentsOf: [major | 24, UInt8(size)]) }
            else { output.append(contentsOf: [major | 25, UInt8(size >> 8), UInt8(size & 255)]) }
            output.append(bytes)
        }
        append(Data(domain.utf8), major: 0x60)
        output.append(1)
        append(Data(accountId.utf8), major: 0x60)
        append(Data(workspaceId.utf8), major: 0x60)
        append(genesis, major: 0x40)
        append(device, major: 0x40)
        append(Data(installationId.utf8), major: 0x60)
        append(Data(purpose.utf8), major: 0x60)
        return output
    }

    func aad(purpose: String) throws -> Data {
        guard Self.purposes.contains(purpose) else { throw LodyKekError.invalidRequest }
        return bindingAAD(domain: "lody-e2ee/client-custody/v1\0", purpose: purpose)
    }

    // Private native receipt probe; never a public wrapping purpose.
    func probeAAD() -> Data {
        bindingAAD(domain: "lody-e2ee/client-custody/probe/v1\0", purpose: "installation-probe")
    }
}

enum LodyKekStatus: String { case missing, ready }

struct LodyKekMarker: Codable, Equatable {
    let version: Int
    let scopeId: String
    let installationId: String
    let state: String
    let probe: Data?
}

/// Only the iOS adapter may access the Keychain or the fixed marker directory.
protocol LodyKekStorage {
    func readMarker(_ id: String) throws -> LodyKekMarker?
    func writeMarker(_ marker: LodyKekMarker) throws
    func readKey(_ id: String) throws -> Data?
    func createKey(_ id: String, bytes: Data) throws
    func deleteKey(_ id: String) throws
}

/// Calls are serialized by the plugin. No key cache survives a call.
final class LodyKekCustody {
    private let storage: LodyKekStorage
    private static let probe = Data("lody.mobile.kek.installation.v1".utf8)

    init(storage: LodyKekStorage) { self.storage = storage }

    private func marker(_ scope: LodyKekScope, state: String, probe: Data? = nil) -> LodyKekMarker {
        LodyKekMarker(version: 1, scopeId: scope.id, installationId: scope.installationId, state: state, probe: probe)
    }

    private func load(_ scope: LodyKekScope) throws -> SymmetricKey {
        guard let saved = try storage.readMarker(scope.id), saved.version == 1,
              saved.scopeId == scope.id, saved.installationId == scope.installationId else { throw LodyKekError.reapproval }
        guard saved.state == "ready", let proof = saved.probe else { throw LodyKekError.unknown }
        guard let bytes = try storage.readKey(scope.id), bytes.count == 32 else { throw LodyKekError.reapproval }
        let key = SymmetricKey(data: bytes)
        guard let decoded = try? Self.open(proof, key: key, aad: scope.probeAAD()),
              decoded == Self.probe else { throw LodyKekError.reapproval }
        return key
    }

    /// Host must durably record its pending identity + installationId BEFORE calling.
    /// Reconcile only a fully settled exact installation; pending/missing halves never recreate keys.
    func install(_ scope: LodyKekScope) throws {
        if let saved = try storage.readMarker(scope.id) {
            guard saved.state == "ready" else { throw LodyKekError.reapproval }
            _ = try load(scope) // Exact readback/probe only; never replace a key or wrapper.
            return
        }
        guard try storage.readKey(scope.id) == nil else { throw LodyKekError.reapproval }
        try storage.writeMarker(marker(scope, state: "pending"))
        let key = SymmetricKey(size: .bits256)
        try storage.createKey(scope.id, bytes: key.withUnsafeBytes { Data($0) })
        guard let stored = try storage.readKey(scope.id), stored.count == 32 else { throw LodyKekError.unknown }
        let proof = try Self.seal(Self.probe, key: key, aad: scope.probeAAD())
        guard let opened = try? Self.open(proof, key: SymmetricKey(data: stored), aad: scope.probeAAD()),
              opened == Self.probe else { throw LodyKekError.unknown }
        let receipt = marker(scope, state: "ready", probe: proof)
        try storage.writeMarker(receipt)
        guard try storage.readMarker(scope.id) == receipt else { throw LodyKekError.unknown }
        _ = try load(scope)
    }

    @discardableResult func status(_ scope: LodyKekScope) throws -> LodyKekStatus {
        if try storage.readMarker(scope.id) == nil {
            guard try storage.readKey(scope.id) == nil else { throw LodyKekError.reapproval }
            return .missing // An observation only, never permission to initialize.
        }
        _ = try load(scope)
        return .ready
    }

    func wrap(_ scope: LodyKekScope, purpose: String, plaintext: Data) throws -> Data {
        guard (0...4096).contains(plaintext.count) else { throw LodyKekError.invalidRequest }
        let key = try load(scope)
        return try Self.seal(plaintext, key: key, aad: scope.aad(purpose: purpose))
    }

    func unwrap(_ scope: LodyKekScope, purpose: String, wrapped: Data) throws -> Data {
        guard (29...4125).contains(wrapped.count), wrapped.first == 1 else { throw LodyKekError.invalidRequest }
        let key = try load(scope)
        do {
            return try Self.open(wrapped, key: key, aad: scope.aad(purpose: purpose))
        } catch let error as LodyKekError { throw error }
        catch { throw LodyKekError.authentication }
    }

    private static func seal(_ plaintext: Data, key: SymmetricKey, aad: Data) throws -> Data {
        frame(try AES.GCM.seal(plaintext, using: key, authenticating: aad))
    }

    /// Fixed envelope framing, also exercised with the public synthetic vector.
    /// Nonces still come only from CryptoKit in the production wrap path.
    static func frame(_ sealed: AES.GCM.SealedBox) -> Data { Data([1]) + sealed.combined! }

    private static func open(_ wrapped: Data, key: SymmetricKey, aad: Data) throws -> Data {
        guard (29...4125).contains(wrapped.count), wrapped.first == 1 else { throw LodyKekError.invalidRequest }
        return try AES.GCM.open(AES.GCM.SealedBox(combined: wrapped.dropFirst()), using: key, authenticating: aad)
    }

    func delete(_ scope: LodyKekScope) throws {
        if let saved = try storage.readMarker(scope.id) {
            guard saved.version == 1, saved.scopeId == scope.id,
                  saved.installationId == scope.installationId else { throw LodyKekError.reapproval }
        } else {
            // A residual key has no provable incarnation without its marker.
            guard try storage.readKey(scope.id) == nil else { throw LodyKekError.reapproval }
        }
        // Persist a tombstone before deleting; an interrupted delete cannot reopen.
        try storage.writeMarker(marker(scope, state: "deleted"))
        try storage.deleteKey(scope.id)
        guard try storage.readKey(scope.id) == nil else { throw LodyKekError.unknown }
    }
}
