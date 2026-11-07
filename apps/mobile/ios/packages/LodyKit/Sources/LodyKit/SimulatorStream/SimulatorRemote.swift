import UIKit

/// The CLI gateway behind a Quick Tunnel: one fixed viewer, one device stream and
/// typed controls. The tunnel authorizes each request by the viewer URL's token, and
/// only rewrites an Origin equal to the tunnel origin into the gateway's own.
enum SimulatorRemote {
  private static let session = URLSession(configuration: .ephemeral)

  static func endpoint(_ viewer: URL, _ name: String, query: [URLQueryItem] = [], websocket: Bool = false) -> URL? {
    guard let resolved = URL(string: name, relativeTo: viewer),
          var components = URLComponents(url: resolved, resolvingAgainstBaseURL: true) else { return nil }
    components.queryItems = (URLComponents(url: viewer, resolvingAgainstBaseURL: false)?.queryItems ?? []) + query
    if websocket { components.scheme = viewer.scheme == "https" ? "wss" : "ws" }
    return components.url
  }

  static func request(_ viewer: URL, _ address: URL, timeout: TimeInterval) -> URLRequest {
    var request = URLRequest(url: address, timeoutInterval: timeout)
    if let scheme = viewer.scheme, let host = viewer.host {
      let port = viewer.port.map { ":\($0)" } ?? ""
      request.setValue("\(scheme)://\(host)\(port)", forHTTPHeaderField: "Origin")
    }
    return request
  }

  static func control(_ viewer: URL, operationId: String, control: [String: String], session: URLSession? = nil) async -> Bool {
    guard let address = endpoint(viewer, "control"),
          let body = try? JSONSerialization.data(withJSONObject: [
            "operationId": operationId, "requestId": UUID().uuidString, "control": control,
          ]) else { return false }
    var post = request(viewer, address, timeout: 12)
    post.httpMethod = "POST"
    post.setValue("application/json", forHTTPHeaderField: "Content-Type")
    post.httpBody = body
    guard let (data, response) = try? await (session ?? Self.session).data(for: post),
          (response as? HTTPURLResponse)?.statusCode == 200,
          let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return result["success"] as? Bool == true
  }

  @MainActor static func exterior(_ viewer: URL) async -> SimulatorExterior? {
    func read(_ name: String, limit: Int) async -> Data? {
      guard let address = endpoint(viewer, name),
            let (data, response) = try? await session.data(for: request(viewer, address, timeout: 12)),
            (response as? HTTPURLResponse)?.statusCode == 200, data.count <= limit else { return nil }
      return data
    }
    guard let json = await read("exterior.json", limit: 64 * 1024),
          let geometry = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
          let png = await read("bezel.png", limit: 4 * 1024 * 1024),
          let image = UIImage(data: png, scale: 1), let pixels = image.cgImage else { return nil }
    func rect(_ value: Any?) -> CGRect? {
      guard let item = value as? [String: Any], let x = item["x"] as? Double, let y = item["y"] as? Double,
            let width = item["width"] as? Double, let height = item["height"] as? Double,
            x >= 0, y >= 0, width > 0, height > 0 else { return nil }
      return CGRect(x: x, y: y, width: width, height: height)
    }
    guard let width = geometry["width"] as? Double, let height = geometry["height"] as? Double,
          width > 0, height > 0, width <= 16384, height <= 16384,
          pixels.width == Int(width), pixels.height == Int(height),
          let screen = rect(geometry["screen"]),
          let radius = (geometry["screen"] as? [String: Any])?["radius"] as? Double,
          radius >= 0, radius <= min(screen.width, screen.height) / 2 else { return nil }
    let bounds = CGRect(x: 0, y: 0, width: width, height: height)
    let buttons = (geometry["buttons"] as? [[String: Any]] ?? []).prefix(16).compactMap { item -> (id: String, frame: CGRect)? in
      guard let id = item["button"] as? String, ["home", "lock", "volume-up", "volume-down", "action"].contains(id),
            let frame = rect(item), bounds.contains(frame) else { return nil }
      return (id, frame)
    }
    guard bounds.contains(screen) else { return nil }
    return SimulatorExterior(size: bounds.size, screen: screen, radius: radius, buttons: buttons, image: image)
  }
}
