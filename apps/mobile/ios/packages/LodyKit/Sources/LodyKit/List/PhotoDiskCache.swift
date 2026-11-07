import Foundation
import CryptoKit

/// Public avatar bytes only. Access on the photo IO queue, never the UI thread.
struct PhotoDiskCache: Sendable {
  let directory: URL
  var maxBytes = 16 * 1024 * 1024
  var maxEntries = 128

  private func file(_ url: URL) -> URL {
    let hash = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appendingPathComponent(hash)
  }

  func isFresh(_ url: URL) -> Bool {
    guard let date = try? file(url).resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate else { return false }
    return Date().timeIntervalSince(date) < 24 * 60 * 60
  }

  func read(_ url: URL) -> Data? {
    let target = file(url)
    guard let size = try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize,
          size <= min(maxBytes, 2 * 1024 * 1024) else { return nil }
    return try? Data(contentsOf: target)
  }

  func write(_ data: Data, for url: URL) {
    guard !data.isEmpty, data.count <= min(maxBytes, 2 * 1024 * 1024) else { return }
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try data.write(to: file(url), options: .atomic)
      let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])
        .compactMap { url -> (URL, Int, Date)? in
          guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
          return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 > $1.2 }
      var total = 0
      for (index, file) in files.enumerated() {
        total += file.1
        if index >= maxEntries || total > maxBytes { try? FileManager.default.removeItem(at: file.0) }
      }
    } catch { /* Cache failures never prevent displaying the downloaded image. */ }
  }
}
