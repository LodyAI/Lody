import Foundation

/// Upstream's ordered DataChannel framing: uint32 BE total + offset, then payload.
/// Retain only one bounded frame; never hand partial/corrupted H.264 to the decoder.
struct SimulatorRTCFrame {
  enum Failure: Error { case malformed }
  private var bytes = Data()
  private var length = 0

  mutating func append(_ chunk: Data) throws -> Data? {
    guard chunk.count > 8, chunk.count <= 16 * 1024 else { throw Failure.malformed }
    let header = Array(chunk.prefix(8))
    let total = header[0..<4].reduce(0) { $0 << 8 | Int($1) }
    let offset = header[4..<8].reduce(0) { $0 << 8 | Int($1) }
    guard total > 0, total <= 16 * 1024 * 1024 + 8,
          offset == bytes.count, offset + chunk.count - 8 <= total,
          bytes.isEmpty || length == total else { throw Failure.malformed }
    length = total
    bytes.append(chunk.dropFirst(8))
    guard bytes.count == length else { return nil }
    let frame = bytes
    bytes = Data()
    length = 0
    return frame
  }
}
