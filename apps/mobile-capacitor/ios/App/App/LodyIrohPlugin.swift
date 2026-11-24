// Compiled only when the app target links LodyIroh.xcframework and the generated
// UniFFI Swift source; otherwise the WebView keeps encrypted Streams RPC.
#if canImport(LodyIrohBindings)
import Capacitor
import Foundation
import LodyIrohBindings

/// Native iroh transport for the WebView portable host. It exposes only open,
/// connection status, send and receive; it never returns the seed, signs nothing
/// else and keeps bridge logging off (`loggingBehavior: none`). Frames are opaque.
@objc(LodyIrohPlugin)
public final class LodyIrohPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LodyIrohPlugin"
    public let jsName = "LodyIroh"
    public let pluginMethods: [CAPPluginMethod] = ["open", "hasConnection", "connectionPath", "warm", "call", "nextReply", "cancel", "close"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    private static let maxFrame = 2 * 1024 * 1024 + 4096
    private let registry = LodyIrohRegistry()

    deinit {
        let registry = registry
        Task.detached { await registry.shutdown() }
    }

    private static func reject(_ call: CAPPluginCall, _ error: Error) {
        // Only fixed codes cross the bridge; never native messages or arguments.
        let code: String
        if case let IrohError.Failed(value) = error, value.range(of: "^[a-z_]{1,64}$", options: .regularExpression) != nil {
            code = value
        } else { code = "iroh_unavailable" }
        call.reject(code, code)
    }
    private func run(_ call: CAPPluginCall, _ body: @escaping () async throws -> [String: Any]) {
        Task {
            do { call.resolve(try await body()) } catch { Self.reject(call, error) }
        }
    }
    private static func decode(_ call: CAPPluginCall, _ name: String, limit: Int) throws -> Data {
        guard let text = call.getString(name), text.count <= (limit + 2) / 3 * 4,
              let data = Data(base64Encoded: text), data.count <= limit else { throw IrohError.Failed(code: "iroh_invalid_request") }
        return data
    }
    private static func string(_ call: CAPPluginCall, _ name: String) throws -> String {
        guard let value = call.getString(name), !value.isEmpty, value.count <= 128 else { throw IrohError.Failed(code: "iroh_invalid_request") }
        return value
    }
    private static func millis(_ call: CAPPluginCall, _ name: String) throws -> UInt32 {
        guard let value = call.getInt(name), value > 0, value <= 120_000 else { throw IrohError.Failed(code: "iroh_invalid_request") }
        return UInt32(value)
    }

    @objc public func open(_ call: CAPPluginCall) {
        run(call) { [registry] in
            var seed = try Self.decode(call, "seed", limit: 32)
            defer { seed.resetBytes(in: 0..<seed.count) }
            guard seed.count == 32, let relays = call.getArray("relays", String.self), !relays.isEmpty, relays.count <= 16
            else { throw IrohError.Failed(code: "iroh_invalid_request") }
            let token = call.getString("relayToken")
            // Mobile is dial-only with port mapping off. A proxy comes only from a
            // test build's VITE_IROH_PROXY_URL; release builds never set it.
            let proxy = call.getString("proxyUrl")
            let endpoint = try await openMobileEndpoint(seed: seed, relayUrls: relays, relayToken: token, proxyUrl: proxy)
            return ["handle": try await registry.add(endpoint: endpoint)]
        }
    }
    @objc public func connectionPath(_ call: CAPPluginCall) {
        run(call) { [registry] in
            let endpoint = try await registry.endpoint(try Self.string(call, "handle"))
            return ["value": try await endpoint.connectionPath(endpointId: try Self.string(call, "endpointId"))]
        }
    }

    @objc public func hasConnection(_ call: CAPPluginCall) {
        run(call) { [registry] in
            let endpoint = try await registry.endpoint(try Self.string(call, "handle"))
            return ["value": try await endpoint.hasConnection(endpointId: try Self.string(call, "endpointId"))]
        }
    }
    @objc public func warm(_ call: CAPPluginCall) {
        run(call) { [registry] in
            let endpoint = try await registry.endpoint(try Self.string(call, "handle"))
            try await endpoint.warm(endpointId: try Self.string(call, "endpointId"), timeoutMs: try Self.millis(call, "timeoutMs"))
            return [:]
        }
    }
    @objc public func call(_ call: CAPPluginCall) {
        run(call) { [registry] in
            let endpoint = try await registry.endpoint(try Self.string(call, "handle"))
            let request = try Self.decode(call, "request", limit: Self.maxFrame)
            let started = try await endpoint.call(
                endpointId: try Self.string(call, "endpointId"), request: request,
                connectTimeoutMs: try Self.millis(call, "connectTimeoutMs"))
            return ["call": try await registry.add(call: started)]
        }
    }
    @objc public func nextReply(_ call: CAPPluginCall) {
        run(call) { [registry] in
            let id = try Self.string(call, "call")
            let active = try await registry.call(id)
            guard let reply = try await active.nextReply() else {
                await registry.removeCall(id)
                return ["reply": NSNull()]
            }
            return ["reply": reply.base64EncodedString()]
        }
    }
    @objc public func cancel(_ call: CAPPluginCall) {
        run(call) { [registry] in
            let id = try Self.string(call, "call")
            // Lock-free in Rust: a pending nextReply returns nil promptly.
            if let active = await registry.removeCall(id) { active.cancel() }
            return [:]
        }
    }
    @objc public func close(_ call: CAPPluginCall) {
        run(call) { [registry] in
            if let endpoint = await registry.removeEndpoint(try Self.string(call, "handle")) { await endpoint.shutdown() }
            return [:]
        }
    }
}

/// Handles stay native; JS only sees random identifiers.
actor LodyIrohRegistry {
    private var closed = false
    private var endpoints: [String: MobileIrohEndpoint] = [:]
    private var calls: [String: MobileIrohCall] = [:]

    func shutdown() async {
        closed = true
        let closing = Array(endpoints.values)
        endpoints.removeAll()
        calls.values.forEach { $0.cancel() }
        calls.removeAll()
        await withTaskGroup(of: Void.self) { group in
            for endpoint in closing {
                group.addTask { await endpoint.shutdown() }
            }
        }
    }

    func add(endpoint: MobileIrohEndpoint) async throws -> String {
        guard !closed else {
            await endpoint.shutdown()
            throw IrohError.Failed(code: "iroh_closed")
        }
        let id = UUID().uuidString
        endpoints[id] = endpoint
        return id
    }
    func add(call: MobileIrohCall) throws -> String {
        guard !closed else {
            call.cancel()
            throw IrohError.Failed(code: "iroh_closed")
        }
        let id = UUID().uuidString
        calls[id] = call
        return id
    }
    func endpoint(_ id: String) throws -> MobileIrohEndpoint {
        guard let endpoint = endpoints[id] else { throw IrohError.Failed(code: "iroh_closed") }
        return endpoint
    }
    func call(_ id: String) throws -> MobileIrohCall {
        guard let call = calls[id] else { throw IrohError.Failed(code: "iroh_closed") }
        return call
    }
    @discardableResult func removeCall(_ id: String) -> MobileIrohCall? { calls.removeValue(forKey: id) }
    func removeEndpoint(_ id: String) -> MobileIrohEndpoint? { endpoints.removeValue(forKey: id) }
}
#endif
