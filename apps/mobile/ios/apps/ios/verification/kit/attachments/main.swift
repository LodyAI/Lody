import Foundation
import UIKit

enum AuthKeychain { static func read() throws -> String? { "synthetic-test-token" } }

final class UploadRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storedRequests: [URLRequest] = []
  private var storedFailPart = false
  private var storedProgress: [(String, String, Int?)] = []
  private var storedBytes: [Int64] = []
  var progress: [(String, String, Int?)] {
    lock.lock(); defer { lock.unlock() }; return storedProgress
  }
  var bytes: [Int64] {
    lock.lock(); defer { lock.unlock() }; return storedBytes
  }
  func record(_ id: String, _ phase: String, _ percent: Int?) {
    lock.lock(); defer { lock.unlock() }; storedProgress.append((id, phase, percent))
  }
  func recordBytes(_ sent: Int64) {
    lock.lock(); defer { lock.unlock() }; storedBytes.append(sent)
  }
  var requests: [URLRequest] {
    get { lock.lock(); defer { lock.unlock() }; return storedRequests }
    set { lock.lock(); storedRequests = newValue; lock.unlock() }
  }
  var failPart: Bool {
    get { lock.lock(); defer { lock.unlock() }; return storedFailPart }
    set { lock.lock(); storedFailPart = newValue; lock.unlock() }
  }
}

final class UploadProtocol: URLProtocol {
  private static let recorder = UploadRecorder()
  static var requests: [URLRequest] {
    get { recorder.requests }
    set { recorder.requests = newValue }
  }
  static var failPart: Bool {
    get { recorder.failPart }
    set { recorder.failPart = newValue }
  }
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "api.lody.ai" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.requests.append(request)
    assert(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-test-token")
    if request.url!.path.hasPrefix("/diagnostics/") {
      let status: Int
      let body: String
      switch request.url!.lastPathComponent {
      case "unauthorized":
        status = 401; body = #"{"error":"Unauthorized","message":"private-server-message"}"#
      case "quota":
        status = 403; body = #"{"error":{"code":"STORAGE_QUOTA_EXCEEDED","message":"private-server-message"}}"#
      case "rate":
        status = 429; body = #"{"code":"rate_limited","error":"private-server-message"}"#
      case "private":
        status = 403; body = #"{"code":"private-token","error":"private-server-message"}"#
      case "html":
        status = 502; body = "<html>private-server-message</html>"
      case "malformed":
        status = 200; body = "private-server-message"
      case "timeout", "cancelled":
        let code = request.url!.lastPathComponent == "timeout" ? NSURLErrorTimedOut : NSURLErrorCancelled
        client?.urlProtocol(self, didFailWithError: NSError(domain: NSURLErrorDomain, code: code,
          userInfo: [NSLocalizedDescriptionKey: "private-network-description", NSURLErrorFailingURLErrorKey: URL(string: "https://private-url/?token=private-token")!]))
        return
      default: fatalError("Unknown diagnostic fixture")
      }
      client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)
      return
    }
    if request.httpMethod == "GET" {
      let status: Int
      switch request.url!.lastPathComponent {
      case "missing": status = 404
      case "failed": status = 503
      default: status = 200
      }
      client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Length": "3"])!, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data("hi!".utf8))
      client?.urlProtocolDidFinishLoading(self)
      return
    }
    var uploaded = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 65536)
      while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        uploaded.append(contentsOf: buffer.prefix(count))
      }
    }
    let path = request.url!.path
    var body: [String: Any] = [:]
    var status = 200
    if path.contains("session-images") {
      assert(request.value(forHTTPHeaderField: "Content-Type")!.contains("multipart/form-data"))
      assert(uploaded.range(of: Data("name=\"sessionId\"\r\n\r\ns1\r\n".utf8)) != nil)
      assert(uploaded.range(of: Data("name=\"file\"".utf8)) != nil)
      assert(uploaded.count > 100)
      body = ["image": ["type": "image", "imageId": "image1", "mimeType": "image/png", "fileName": "photo.png", "sizeBytes": 100]]
    } else if path.hasSuffix("/create") {
      assert(request.value(forHTTPHeaderField: "x-file-sha256")!.count == 64)
      body = ["uploadId": "upload1", "fileId": "file1"]
    } else if path.contains("/part/") {
      assert(request.httpMethod == "PUT")
      assert(request.value(forHTTPHeaderField: "x-file-id") == "file1")
      assert(uploaded.count == Int(request.value(forHTTPHeaderField: "x-file-part-size-bytes")!))
      assert(uploaded.allSatisfy { $0 == 65 })
      status = Self.failPart ? 503 : 200
      body = ["etag": "etag-" + path.components(separatedBy: "/").last!]
    } else if path.hasSuffix("/abort") {
      assert(request.httpMethod == "DELETE")
    } else {
      if path.hasSuffix("/complete") {
        let value = try! JSONSerialization.jsonObject(with: uploaded) as! [String: Any]
        let parts = value["parts"] as! [[String: Any]]
        assert(parts.count == 2 && parts[1]["partNumber"] as? Int == 2 && parts[1]["etag"] as? String == "etag-2")
      } else { assert(uploaded == Data("hi!".utf8)) }
      body = ["file": ["type": "file", "fileId": "file1", "fileName": "test.txt", "mimeType": "text/plain", "sizeBytes": 3, "sha256": "abc", "textPreview": true, "transport": "r2", "uploadedAt": 1]]
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@main struct Check {
  static func main() async throws {
    let original = SessionAttachments.imageDownloadURL(workspace: "ws", session: "source", imageId: "img1")
    assert(original.absoluteString == "https://api.lody.ai/api/workspaces/ws/session-images/source/img1")
    assert(!original.path.contains("thumbnail"), "Full image download must not use the thumbnail route")
    let thumb = SessionAttachments.imageThumbnailURL(workspace: "ws", session: "source", imageId: "img1", width: 768)
    assert(thumb.path.hasSuffix("/session-images/source/img1/thumbnail"))
    assert(thumb.query == "width=768&fit=scale-down&quality=85")
    assert(thumb != original, "Lightbox preview must not reuse the thumbnail URL")
    URLProtocol.registerClass(UploadProtocol.self)
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("test.txt")
    try Data("hi!".utf8).write(to: file)
    let abandonedDirectory: URL
    do {
      let batch = AttachmentDownloadBatch(root: root)
      abandonedDirectory = batch.makeDirectory()
      try FileManager.default.createDirectory(at: abandonedDirectory, withIntermediateDirectories: true)
      try Data("downloaded".utf8).write(to: abandonedDirectory.appendingPathComponent("attachment.txt"))
    }
    assert(!FileManager.default.fileExists(atPath: abandonedDirectory.path),
      "A failed edit preparation must remove every downloaded attachment directory")
    var handedOffBatch: AttachmentDownloadBatch? = AttachmentDownloadBatch(root: root)
    let handedOffDirectory = handedOffBatch!.makeDirectory()
    try FileManager.default.createDirectory(at: handedOffDirectory, withIntermediateDirectories: true)
    handedOffBatch?.handOff()
    handedOffBatch = nil
    assert(FileManager.default.fileExists(atPath: handedOffDirectory.path),
      "A successful edit preparation must retain files handed to the composer")
    try FileManager.default.removeItem(at: handedOffDirectory)
    func attachment(_ url: URL, _ kind: String = "file") -> [String: Any] {
      ["id": url.lastPathComponent, "uri": url.absoluteString, "name": url.lastPathComponent, "kind": kind]
    }
    let smallProgress = UploadRecorder()
    let small = try await SessionAttachments.upload([attachment(file)], workspace: "w1", session: "s1", onProgress: smallProgress.record)
    assert(smallProgress.progress.first?.1 == "preparing" && smallProgress.progress.last?.1 == "complete")
    assert(smallProgress.progress.allSatisfy { $0.0 == "test.txt" })
    assert(small[0]["fileId"] as? String == "file1")
    assert(UploadProtocol.requests.last!.value(forHTTPHeaderField: "x-file-sha256") == "c0ddd62c7717180e7ffb8a15bb9674d3ec92592e0b7ac7d1d5289836b4553be2")
    let image = root.appendingPathComponent("photo.png")
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10))
    try renderer.pngData { context in UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 10, height: 10)) }.write(to: image)
    let imageProgress = UploadRecorder()
    let images = try await SessionAttachments.upload([attachment(image, "image")], workspace: "w1", session: "s1", onProgress: imageProgress.record)
    assert(imageProgress.progress.contains { $0.1 == "uploading" && $0.2 == 0 })
    assert(imageProgress.progress.last?.0 == "photo.png" && imageProgress.progress.last?.1 == "complete")
    assert(images[0]["imageId"] as? String == "image1")
    let video = root.appendingPathComponent("IMG_3933.mov")
    try Data("hi!".utf8).write(to: video)
    UploadProtocol.requests = []
    let videos = try await SessionAttachments.upload([attachment(video, "image")], workspace: "w1", session: "s1")
    assert(videos[0]["fileId"] as? String == "file1")
    assert(UploadProtocol.requests.contains { $0.url!.path.contains("session-files") })
    assert(!UploadProtocol.requests.contains { $0.url!.path.contains("session-images") })
    try Data(repeating: 65, count: 16 * 1024 * 1024 + 1).write(to: file)
    UploadProtocol.requests = []
    let multipartProgress = UploadRecorder()
    _ = try await SessionAttachments.upload([attachment(file)], workspace: "w1", session: "s1", onProgress: multipartProgress.record)
    let percentages = multipartProgress.progress.compactMap { $0.2 }
    assert(percentages == percentages.sorted() && percentages.first == 0 && percentages.last == 100,
      "Multipart progress must accumulate across parts without resetting")
    assert(multipartProgress.progress.last?.1 == "complete")
    assert(UploadProtocol.requests.map { $0.url!.lastPathComponent } == ["create", "1", "2", "complete"])
    assert(UploadProtocol.requests[2].value(forHTTPHeaderField: "x-file-part-size-bytes") == "1")
    UploadProtocol.failPart = true
    let failedProgress = UploadRecorder()
    do {
      _ = try await SessionAttachments.upload([attachment(file)], workspace: "w1", session: "s1", onProgress: failedProgress.record)
      fatalError("Failed upload must not produce an attachment")
    } catch { assert(UploadProtocol.requests.last!.url!.lastPathComponent == "abort") }
    assert(!failedProgress.progress.contains { $0.1 == "complete" }, "A failed upload must never report completion")
    func diagnostics() throws -> (String, [[String: Any]]) {
      // Reopen the real on-disk store, then use the same export as Settings.
      DiagnosticsStore.shared.flush()
      let restored = DiagnosticsStore(directory: DiagnosticsStore.shared.directory, process: .app)
      let file = try restored.export(since: 900)
      defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
      let text = try String(contentsOf: file, encoding: .utf8)
      let records = try text.split(separator: "\n").filter { $0.hasPrefix("{") }.map {
        try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any]
      }
      return (text, records)
    }
    let (_, multipartEvents) = try diagnostics()
    let failedPart = multipartEvents.last { $0["event"] as? String == "http_failed" }!
    let failedPartFields = failedPart["fields"] as! [String: String]
    assert(failedPartFields["stage"] == "multipart_part" && failedPartFields["httpStatus"] == "503")
    assert(multipartEvents.contains {
      let fields = $0["fields"] as? [String: String]
      return $0["event"] as? String == "request_succeeded" && fields?["stage"] == "multipart_abort" && fields?["attempt"] == failedPartFields["attempt"]
    }, "Cleanup must not hide the failed part, and must share its attempt identifier")
    let httpFailures: [(String, Int, String?)] = [("unauthorized", 401, "unauthorized"), ("quota", 403, "storage_quota_exceeded"),
                                               ("rate", 429, "rate_limited"), ("private", 403, nil), ("html", 502, nil), ("malformed", 200, nil)]
    for (fixture, status, serverCode) in httpFailures {
      let attempt = UUID()
      do {
        _ = try await SessionAttachments.request("https://api.lody.ai/diagnostics/\(fixture)", token: "synthetic-test-token",
          stage: "image_upload", attempt: attempt, headers: ["x-file-name": "private-filename"])
        fatalError("Failed requests must still reject the upload")
      } catch {}
      let (_, records) = try diagnostics()
      let events = records.filter { ($0["fields"] as? [String: String])?["attempt"] == attempt.uuidString }
      assert(events.count == 2 && events.first?["event"] as? String == "request_started")
      assert(events.last?["event"] as? String == (fixture == "malformed" ? "invalid_response" : "http_failed"))
      let fields = events.last!["fields"] as! [String: String]
      assert(fields["stage"] == "image_upload" && fields["httpStatus"] == String(status))
      assert(fields["serverCode"] == serverCode && fields["networkCode"] == nil)
    }
    for (fixture, code) in [("timeout", NSURLErrorTimedOut), ("cancelled", NSURLErrorCancelled)] {
      let attempt = UUID()
      do {
        _ = try await SessionAttachments.request("https://api.lody.ai/diagnostics/\(fixture)", token: "synthetic-test-token",
          stage: "file_upload", attempt: attempt, headers: [:], body: Data("private-file-contents".utf8), onProgress: { _, _ in })
        fatalError("Network failures must still reject the upload")
      } catch let error as NSError {
        assert(error.domain == NSURLErrorDomain && error.code == code, "Preserve the original transport error")
      }
      let (_, records) = try diagnostics()
      let event = records.last { ($0["fields"] as? [String: String])?["attempt"] == attempt.uuidString }!
      let fields = event["fields"] as! [String: String]
      assert(event["event"] as? String == "transport_failed" && fields["networkCode"] == String(code))
      assert(fields["stage"] == "file_upload" && fields["httpStatus"] == nil)
    }
    let (diagnosticText, _) = try diagnostics()
    for secret in ["synthetic-test-token", "private-token", "private-server-message", "private-filename", "private-url", "private-network-description", "private-file-contents", "api.lody.ai", "upload1", "test.txt"] {
      assert(!diagnosticText.contains(secret), "Export must exclude credentials, raw errors, URLs, upload IDs, filenames and attachment contents")
    }
    print("PASS: exported upload diagnostics distinguish HTTP, quota, transport and invalid-response failures without private data")
    let before = UploadProtocol.requests.count
    do {
      _ = try await SessionAttachments.upload([attachment(URL(fileURLWithPath: "/etc/passwd"))], workspace: "w1", session: "s1")
      fatalError("Must reject files outside picker storage")
    } catch { assert(UploadProtocol.requests.count == before) }
    let downloadDirectory = root.appendingPathComponent("download")
    let downloaded = try await SessionAttachments.download(workspace: "w /1", session: "source", fileId: "f /1",
      fileName: "../../report.txt", sizeBytes: 3, directory: downloadDirectory)
    assert(downloaded == downloadDirectory.appendingPathComponent("report.txt"))
    let downloadedBytes = try Data(contentsOf: downloaded)
    assert(downloadedBytes == Data("hi!".utf8))
    assert(UploadProtocol.requests.last!.url!.absoluteString == "https://api.lody.ai/api/workspaces/w%20%2F1/session-files/source/f%20%2F1")
    for (id, size) in [("missing", 3), ("failed", 3), ("incomplete", 4)] {
      let failedDirectory = root.appendingPathComponent(id)
      do {
        _ = try await SessionAttachments.download(workspace: "w1", session: "s1", fileId: id,
          fileName: "report.txt", sizeBytes: size, directory: failedDirectory)
        fatalError("Failed or incomplete downloads must not become previews")
      } catch { assert(!FileManager.default.fileExists(atPath: failedDirectory.path)) }
    }
    let requestCount = UploadProtocol.requests.count
    do {
      _ = try await SessionAttachments.download(workspace: "w1", session: "s1", fileId: "huge",
        fileName: "movie.mp4", sizeBytes: 100 * 1024 * 1024 + 1, directory: root.appendingPathComponent("huge"))
      fatalError("Reject oversized downloads before requesting them")
    } catch { assert(UploadProtocol.requests.count == requestCount) }
    guard let endpoint = ProcessInfo.processInfo.environment["LODY_UPLOAD_TEST_URL"], endpoint.hasPrefix("http://127.0.0.1:") else {
      fatalError("Run with the loopback progress-server.py fixture")
    }
    let transportProgress = UploadRecorder()
    let body = Data(repeating: 65, count: 8 * 1024 * 1024)
    _ = try await SessionAttachments.request(endpoint, token: "synthetic-test-token", stage: "file_upload", attempt: UUID(), headers: [:], body: body) { sent, total in
      assert(total == body.count)
      transportProgress.recordBytes(sent)
    }
    let sent = transportProgress.bytes
    assert(sent.first == 0 && sent.last == Int64(body.count))
    assert(sent.contains { $0 > 0 && $0 < body.count }, "Must observe actual URLSession byte callbacks before completion")
    assert(sent == sent.sorted(), "Upload bytes must progress monotonically")
    print("PASS: real loopback URLSession callbacks, image/file phases, cumulative multipart progress and failed-upload cleanup")
    print("PASS: native image/file upload and disk download, authorization, safe filenames, failed/incomplete responses and size limits")
  }
}
