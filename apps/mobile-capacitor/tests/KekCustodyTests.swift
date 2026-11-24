import Foundation
import CryptoKit

final class MemoryKekStorage: LodyKekStorage {
    var markers: [String: LodyKekMarker] = [:]
    var keys: [String: Data] = [:]
    var readError: LodyKekError?
    var failWrite = 0
    var writes = 0
    var failCreateAfterWrite = false
    var replaceCreatedKey = false
    var failDelete = false
    func readMarker(_ id: String) throws -> LodyKekMarker? { markers[id] }
    func writeMarker(_ marker: LodyKekMarker) throws {
        writes += 1
        if writes == failWrite { throw LodyKekError.unknown }
        markers[marker.scopeId] = marker
    }
    func readKey(_ id: String) throws -> Data? {
        if let error = readError { throw error }
        return keys[id]
    }
    func createKey(_ id: String, bytes: Data) throws {
        if keys[id] != nil { throw LodyKekError.reapproval }
        keys[id] = replaceCreatedKey ? Data(repeating: 1, count: 32) : bytes
        if failCreateAfterWrite { throw LodyKekError.unknown }
    }
    func deleteKey(_ id: String) throws {
        if failDelete { throw LodyKekError.unavailable }
        keys.removeValue(forKey: id)
    }
}

private struct SharedCustodyVector: Decodable {
    struct Binding: Decodable {
        let accountId, workspaceId, genesisHex, deviceHex, installationId: String
    }
    struct Entry: Decodable {
        let purpose, nonceHex, plaintextHex, aadHex, blobHex: String
    }
    let kekHex: String
    let binding: Binding
    let vectors: [Entry]
}

@main struct KekCustodyTests {
    static var assertions = 0
    static func check(_ value: Bool, _ message: String) {
        precondition(value, message)
        assertions += 1
    }
    static func rejects(_ expected: LodyKekError, _ action: () throws -> Void) {
        do { try action(); preconditionFailure("expected rejection") }
        catch { check((error as? LodyKekError) == expected, "wrong failure code") }
    }
    static func scope(_ installation: String = String(repeating: "03", count: 32), account: String = "account", workspace: String = "workspace", genesis: String = String(repeating: "01", count: 32), device: String = String(repeating: "02", count: 32)) throws -> LodyKekScope {
        try LodyKekScope(accountId: account, workspaceId: workspace, genesisHash: genesis, deviceId: device, installationId: installation)
    }
    static func hex(_ value: String) -> Data {
        let chars = Array(value)
        return Data(stride(from: 0, to: chars.count, by: 2).map { UInt8(String(chars[$0...$0 + 1]), radix: 16)! })
    }
    static func nativeQueue() {
        let queue = LodyKekCallQueue()
        let started = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let independent = DispatchSemaphore(value: 0), next = DispatchSemaphore(value: 0)
        let state = NSLock()
        var order: [String] = []
        func append(_ event: String) { state.lock(); order.append(event); state.unlock() }
        queue.enqueue(route: "same-routing-scope") {
            append("old-entered")
            started.signal()
            release.wait() // Deliberately hung native work; no close budget can release it.
            append("old-settled")
        }
        precondition(started.wait(timeout: .now() + 30) == .success, "native start signal missing")
        queue.enqueue(route: "same-routing-scope") { append("replacement-entered"); next.signal() }
        queue.enqueue(route: "independent-workspace") { append("independent-settled"); independent.signal() }
        precondition(independent.wait(timeout: .now() + 30) == .success, "unrelated route blocked")
        state.lock(); let before = order; state.unlock()
        check(before == ["old-entered", "independent-settled"], "pending native work released its physical route")
        // Abandoning the original observer does not remove the admitted native closure.
        release.signal()
        precondition(next.wait(timeout: .now() + 30) == .success, "retained route never settled")
        state.lock(); let after = order; state.unlock()
        check(after == ["old-entered", "independent-settled", "old-settled", "replacement-entered"], "new incarnation overtook old native work")
        let reused = DispatchSemaphore(value: 0)
        queue.enqueue(route: "same-routing-scope") { reused.signal() }
        precondition(reused.wait(timeout: .now() + 30) == .success, "settled route did not reopen")
        // A full reset purges custody only after every admitted call on every route returns.
        let hung = DispatchSemaphore(value: 0), entered = DispatchSemaphore(value: 0)
        let purged = DispatchSemaphore(value: 0)
        order = []
        queue.enqueue(route: "reset-route-a") { append("a-entered"); entered.signal(); hung.wait(); append("a-settled") }
        precondition(entered.wait(timeout: .now() + 30) == .success, "native start signal missing")
        queue.enqueue(route: "reset-route-b") { append("b-settled") }
        let late = DispatchSemaphore(value: 0)
        queue.fenced(on: .global()) { append("purge"); purged.signal() }
        // Arrives while the purge waits: it must neither overtake nor interleave with it.
        queue.enqueue(route: "reset-route-c") { append("late-entered"); late.signal() }
        hung.signal()
        precondition(purged.wait(timeout: .now() + 30) == .success, "reset purge never ran")
        precondition(late.wait(timeout: .now() + 30) == .success, "held call never ran after the purge")
        state.lock(); let reset = order; state.unlock()
        let purgeAt = reset.firstIndex(of: "purge") ?? -1
        check(purgeAt >= 0 && reset.contains("a-settled") && reset.contains("b-settled")
              && (reset.firstIndex(of: "a-settled") ?? Int.max) < purgeAt
              && (reset.firstIndex(of: "b-settled") ?? Int.max) < purgeAt,
              "reset purge ran before admitted calls returned")
        check(reset.last == "late-entered" && (reset.firstIndex(of: "late-entered") ?? -1) > purgeAt,
              "a call arriving during the purge reached custody before it settled")
        let reopened = DispatchSemaphore(value: 0)
        queue.enqueue(route: "reset-route-c") { reopened.signal() }
        precondition(reopened.wait(timeout: .now() + 30) == .success, "fence never lifted")
        let idle = DispatchSemaphore(value: 0)
        LodyKekCallQueue().fenced(on: .global()) { idle.signal() }
        precondition(idle.wait(timeout: .now() + 30) == .success, "idle reset purge never ran")
    }
    static func main() throws {
        nativeQueue()
        let s = try scope()
        let bytes = Data((0..<32).map(UInt8.init))
        let store = MemoryKekStorage()
        let host = LodyKekCustody(storage: store)
        check(try host.status(s) == .missing, "fresh absence must be observable without creation")
        rejects(.reapproval) { _ = try host.wrap(s, purpose: "installed-epoch-key", plaintext: bytes) }
        try host.install(s)
        try host.status(s)
        let packet = try host.wrap(s, purpose: "installed-epoch-key", plaintext: bytes)
        check(packet.count == 61 && packet.first == 1, "32-byte A0 wrapper must have 61 bytes and v1 prefix")
        let purposes = ["signing-private-key", "encryption-private-key", "device-credential", "installed-epoch-key", "rotation-candidate"]
        for purpose in purposes {
            let blob = try host.wrap(s, purpose: purpose, plaintext: bytes)
            check(try host.unwrap(s, purpose: purpose, wrapped: blob) == bytes, "purpose did not round trip")
            for otherPurpose in purposes where otherPurpose != purpose {
                rejects(.authentication) { _ = try host.unwrap(s, purpose: otherPurpose, wrapped: blob) }
            }
        }
        rejects(.invalidRequest) { _ = try host.wrap(s, purpose: "epoch-key", plaintext: bytes) }
        var wrongVersion = packet; wrongVersion[0] = 2
        rejects(.invalidRequest) { _ = try host.unwrap(s, purpose: "installed-epoch-key", wrapped: wrongVersion) }
        for length in [0, 1, 12, 28, 4126] {
            rejects(.invalidRequest) { _ = try host.unwrap(s, purpose: "installed-epoch-key", wrapped: Data(repeating: 1, count: length)) }
        }
        for length in [0, 4096] {
            let input = Data(repeating: 5, count: length)
            let blob = try host.wrap(s, purpose: "device-credential", plaintext: input)
            check(blob.count == length + 29, "A0 wrapper overhead mismatch")
            check(try host.unwrap(s, purpose: "device-credential", wrapped: blob) == input, "body boundary failed")
        }
        for invalid in ["", "a", String(repeating: "ab", count: 31), String(repeating: "AB", count: 32), String(repeating: "gg", count: 32)] {
            rejects(.invalidRequest) { _ = try scope(invalid) }
            rejects(.invalidRequest) { _ = try scope(genesis: invalid) }
            rejects(.invalidRequest) { _ = try scope(device: invalid) }
        }
        let fresh = LodyKekCustody(storage: store)
        check(try fresh.unwrap(s, purpose: "installed-epoch-key", wrapped: packet) == bytes, "reopen did not recover exact bytes")
        check(try host.wrap(s, purpose: "installed-epoch-key", plaintext: bytes) != packet, "nonce repeated")
        let retainedKey = store.keys[s.id], retainedReceipt = store.markers[s.id]
        try fresh.install(s) // Exact settled installation retry must reconcile without replacement.
        check(store.keys[s.id] == retainedKey && store.markers[s.id] == retainedReceipt, "retry replaced native identity")
        rejects(.authentication) { _ = try fresh.unwrap(s, purpose: "signing-private-key", wrapped: packet) }
        var corrupt = packet; corrupt[15] ^= 1
        rejects(.authentication) { _ = try fresh.unwrap(s, purpose: "installed-epoch-key", wrapped: corrupt) }
        rejects(.invalidRequest) { _ = try fresh.wrap(s, purpose: "installation-probe", plaintext: bytes) }
        rejects(.invalidRequest) { _ = try fresh.wrap(s, purpose: "unknown", plaintext: bytes) }
        rejects(.invalidRequest) { _ = try fresh.wrap(s, purpose: "installed-epoch-key", plaintext: Data(repeating: 1, count: 4097)) }
        for other in [try scope(String(repeating: "04", count: 32)), try scope(account: "other"), try scope(workspace: "other"), try scope(genesis: String(repeating: "04", count: 32)), try scope(device: String(repeating: "04", count: 32))] {
            rejects(.reapproval) { _ = try fresh.unwrap(other, purpose: "installed-epoch-key", wrapped: packet) }
        }
        for error in [LodyKekError.locked, .unavailable] {
            store.readError = error
            rejects(error) { try fresh.status(s) }
            rejects(error) { _ = try fresh.unwrap(s, purpose: "installed-epoch-key", wrapped: packet) }
        }
        store.readError = nil
        let originalMarker = store.markers[s.id]
        store.markers.removeAll() // reinstall with residual Keychain, or marker-only loss
        rejects(.reapproval) { try fresh.status(s) }
        rejects(.reapproval) { try fresh.install(s) }
        rejects(.reapproval) { try fresh.delete(s) }
        check(store.keys.count == 1, "residual key overwritten or deleted without a matching marker")
        store.markers[s.id] = originalMarker
        let originalKey = store.keys.removeValue(forKey: s.id)
        rejects(.reapproval) { try fresh.status(s) } // restored wrapped files/marker without KEK
        rejects(.reapproval) { try fresh.install(s) }
        store.keys[s.id] = Data(repeating: 99, count: 32) // wrong KEK must fail the probe
        rejects(.reapproval) { try fresh.status(s) }
        store.keys[s.id] = originalKey
        store.failDelete = true
        rejects(.unavailable) { try fresh.delete(s) }
        rejects(.unknown) { try fresh.status(s) }
        store.failDelete = false
        try fresh.delete(s)
        try fresh.delete(s)
        check(store.keys.isEmpty, "delete did not read back key absence")
        rejects(.unknown) { try fresh.status(s) }
        rejects(.reapproval) { try fresh.install(s) }
        for failure in [1, 2] {
            let failed = MemoryKekStorage(); failed.failWrite = failure
            let custody = LodyKekCustody(storage: failed)
            rejects(.unknown) { try custody.install(s) }
            if failure == 1 { check(failed.keys.isEmpty, "key written before pending receipt") }
            else {
                rejects(.unknown) { try custody.status(s) }
                rejects(.reapproval) { try custody.install(s) }
                check(failed.keys.count == 1, "unknown key overwritten")
            }
        }
        let unknown = MemoryKekStorage(); unknown.failCreateAfterWrite = true
        let interrupted = LodyKekCustody(storage: unknown)
        rejects(.unknown) { try interrupted.install(s) }
        rejects(.unknown) { try interrupted.status(s) }
        rejects(.reapproval) { try interrupted.install(s) }
        check(unknown.keys.count == 1, "unknown installation overwritten")

        let wrongReadback = MemoryKekStorage(); wrongReadback.replaceCreatedKey = true
        let wrongInstall = LodyKekCustody(storage: wrongReadback)
        rejects(.unknown) { try wrongInstall.install(s) }
        rejects(.unknown) { try wrongInstall.status(s) }
        rejects(.reapproval) { try wrongInstall.install(s) }
        for bad in [LodyKekMarker(version: 2, scopeId: s.id, installationId: s.installationId, state: "ready", probe: originalMarker!.probe),
                    LodyKekMarker(version: 1, scopeId: "wrong", installationId: s.installationId, state: "ready", probe: originalMarker!.probe)] {
            store.markers[s.id] = bad
            rejects(.reapproval) { try fresh.status(s) }
            rejects(.reapproval) { try fresh.delete(s) }
        }

        let isolated = MemoryKekStorage(), oldBinding = try scope()
        let newBinding = try scope(String(repeating: "05", count: 32), device: String(repeating: "06", count: 32))
        let separate = try scope(account: "other-account")
        let lifecycle = LodyKekCustody(storage: isolated)
        try lifecycle.install(oldBinding); try lifecycle.install(newBinding); try lifecycle.install(separate)
        let newPacket = try lifecycle.wrap(newBinding, purpose: "device-credential", plaintext: bytes)
        check(oldBinding.routingId == newBinding.routingId && oldBinding.id != newBinding.id, "replacement changed the physical writer scope")
        check(oldBinding.routingId != separate.routingId, "independent account shares a physical queue")
        try lifecycle.delete(oldBinding)
        let reopenedNew = LodyKekCustody(storage: isolated)
        check(try reopenedNew.status(newBinding) == .ready && reopenedNew.status(separate) == .ready, "old deletion removed another identity")
        check(try reopenedNew.unwrap(newBinding, purpose: "device-credential", wrapped: newPacket) == bytes, "replacement wrapper was relabeled or lost")

        // Node WebCrypto fixture => CryptoKit; reverse result is verified by Node.
        let fixtureURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as! [String: String]
        let aadCases = try String(contentsOf: fixtureURL.deletingLastPathComponent().appendingPathComponent("aad-cases.tsv"), encoding: .utf8)
        for row in aadCases.split(separator: "\n") {
            let parts = row.split(separator: "\t").map(String.init)
            let binding = try scope(account: parts[0], workspace: parts[1])
            let encoded = try binding.aad(purpose: "rotation-candidate").map { String(format: "%02x", $0) }.joined()
            check(encoded == parts[2], "DAG-CBOR UTF-8/minimal-length encoding mismatch")
        }
        let interop = MemoryKekStorage()
        interop.keys[s.id] = Data(base64Encoded: fixture["key"]!)!
        interop.markers[s.id] = LodyKekMarker(version: 1, scopeId: s.id, installationId: s.installationId, state: "ready", probe: Data(base64Encoded: fixture["probe"]!)!)
        let native = LodyKekCustody(storage: interop)
        check(try native.unwrap(s, purpose: "installed-epoch-key", wrapped: Data(base64Encoded: fixture["wrapped"]!)!) == bytes, "JS to Swift failed")
        // Make every alternate binding locally usable with the SAME synthetic KEK.
        // Rejection must now come from public AAD authentication, not a missing marker.
        for other in [try scope(String(repeating: "04", count: 32)), try scope(account: "other"), try scope(workspace: "other"),
                      try scope(genesis: String(repeating: "04", count: 32)), try scope(device: String(repeating: "04", count: 32))] {
            let alternate = MemoryKekStorage()
            let key = Data(base64Encoded: fixture["key"]!)!
            let proof = Data([1]) + (try AES.GCM.seal(Data("lody.mobile.kek.installation.v1".utf8), using: SymmetricKey(data: key), authenticating: other.probeAAD()).combined!)
            alternate.keys[other.id] = key
            alternate.markers[other.id] = LodyKekMarker(version: 1, scopeId: other.id, installationId: other.installationId, state: "ready", probe: proof)
            let candidate = LodyKekCustody(storage: alternate)
            try candidate.status(other)
            rejects(.authentication) { _ = try candidate.unwrap(other, purpose: "installed-epoch-key", wrapped: Data(base64Encoded: fixture["wrapped"]!)!) }
        }
        let output = try native.wrap(s, purpose: "installed-epoch-key", plaintext: bytes)
        try output.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        // Frozen public A0 vector e1e3b5a10f65d94655d097cd262f008a35c2688e.
        // The runner pins the exact JSON bytes; expected AAD/blob are never regenerated.
        let shared = try JSONDecoder().decode(SharedCustodyVector.self, from: Data(contentsOf: fixtureURL.deletingLastPathComponent().appendingPathComponent("client-custody-vector.json")))
        let binding = shared.binding
        let bound = try LodyKekScope(accountId: binding.accountId, workspaceId: binding.workspaceId, genesisHash: binding.genesisHex, deviceId: binding.deviceHex, installationId: binding.installationId)
        let sharedKeyBytes = hex(shared.kekHex)
        let sharedKey = SymmetricKey(data: sharedKeyBytes)
        let sharedStore = MemoryKekStorage()
        sharedStore.keys[bound.id] = sharedKeyBytes
        let sharedProbe = LodyKekCustody.frame(try AES.GCM.seal(Data("lody.mobile.kek.installation.v1".utf8), using: sharedKey, authenticating: bound.probeAAD()))
        sharedStore.markers[bound.id] = LodyKekMarker(version: 1, scopeId: bound.id, installationId: bound.installationId, state: "ready", probe: sharedProbe)
        let sharedHost = LodyKekCustody(storage: sharedStore)
        for vector in shared.vectors {
            let expectedAAD = hex(vector.aadHex), expectedBlob = hex(vector.blobHex), plaintext = hex(vector.plaintextHex)
            check(try bound.aad(purpose: vector.purpose) == expectedAAD, "shared A0 AAD bytes differ")
            let sealed = try AES.GCM.seal(plaintext, using: sharedKey, nonce: AES.GCM.Nonce(data: hex(vector.nonceHex)), authenticating: bound.aad(purpose: vector.purpose))
            check(LodyKekCustody.frame(sealed) == expectedBlob, "shared A0 wrapper bytes differ")
            check(try sharedHost.unwrap(bound, purpose: vector.purpose, wrapped: expectedBlob) == plaintext, "shared A0 native unwrap differs")
            let generated = try sharedHost.wrap(bound, purpose: vector.purpose, plaintext: plaintext)
            // Compare the complete real-wrap result using its native random nonce.
            let expectedFresh = try AES.GCM.seal(plaintext, using: sharedKey, nonce: AES.GCM.Nonce(data: generated.subdata(in: 1..<13)), authenticating: expectedAAD)
            check(generated == Data([1]) + expectedFresh.combined!, "native random-wrap bytes differ from A0")
            var badTag = expectedBlob; badTag[badTag.count - 1] ^= 1
            rejects(.authentication) { _ = try sharedHost.unwrap(bound, purpose: vector.purpose, wrapped: badTag) }
            var badVersion = expectedBlob; badVersion[0] = 2
            rejects(.invalidRequest) { _ = try sharedHost.unwrap(bound, purpose: vector.purpose, wrapped: badVersion) }
        }
        print("Kek custody: \(assertions) assertions passed (injected storage; no simulator/hardware claim)")
    }
}
