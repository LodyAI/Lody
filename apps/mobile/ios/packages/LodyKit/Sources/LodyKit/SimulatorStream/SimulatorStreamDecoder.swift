import CoreMedia
import UIKit

/// The gateway's private packets. Video: `LAVC`, sequence, tag (2 key / 3 delta),
/// avcC length and avcC (keyframes only), then length-prefixed NAL units.
/// Still images: `LODY`, sequence, JPEG. Every sequence must be acknowledged.
@MainActor final class SimulatorStreamDecoder {
  enum Output {
    case image(UIImage)
    case frame(CMSampleBuffer)
  }

  enum Failure: Error {
    case codec
    case malformed
  }

  struct Packet {
    let sequence: UInt32
    let output: Output?
    let size: CGSize?
  }

  private static let videoMagic: UInt32 = 0x4C41_5643
  private static let imageMagic: UInt32 = 0x4C4F_4459
  private var format: CMVideoFormatDescription?
  private var lastSequence: UInt32 = 0

  func reset() {
    format = nil
    lastSequence = 0
  }

  func awaitKeyFrame() { format = nil }

  func handle(_ data: Data, h264: Bool) throws -> Packet {
    let bytes = [UInt8](data)
    guard bytes.count >= 9, bytes.count <= 16 * 1024 * 1024 + 8 else { throw Failure.malformed }
    func uint32(_ offset: Int) -> UInt32 {
      bytes[offset..<offset + 4].reduce(0) { $0 << 8 | UInt32($1) }
    }
    let sequence = uint32(4)
    switch uint32(0) {
    case Self.videoMagic:
      guard h264, bytes.count >= 12, sequence > lastSequence else { throw Failure.codec }
      let key = bytes[8] == 2
      let descriptionLength = Int(bytes[9]) << 8 | Int(bytes[10])
      guard [2, 3].contains(bytes[8]), descriptionLength <= 4096,
            key ? descriptionLength >= 7 : descriptionLength == 0,
            11 + descriptionLength < bytes.count else { throw Failure.codec }
      lastSequence = sequence
      if key {
        guard let next = Self.format(avcC: Array(bytes[11..<11 + descriptionLength])) else { throw Failure.codec }
        format = next
      }
      // Deltas before the first keyframe cannot decode; acknowledge and drop them.
      guard let format else { return Packet(sequence: sequence, output: nil, size: nil) }
      let sample = Self.sample(data.subdata(in: data.startIndex + 11 + descriptionLength..<data.endIndex), format: format)
      let dimensions = CMVideoFormatDescriptionGetDimensions(format)
      return Packet(sequence: sequence, output: sample.map(Output.frame),
                    size: CGSize(width: Int(dimensions.width), height: Int(dimensions.height)))
    case Self.imageMagic:
      guard !h264 else { throw Failure.codec }
      guard sequence > 0, let image = UIImage(data: data.subdata(in: data.startIndex + 8..<data.endIndex)),
            let cgImage = image.cgImage else { throw Failure.malformed }
      return Packet(sequence: sequence, output: .image(image),
                    size: CGSize(width: cgImage.width, height: cgImage.height))
    default:
      throw Failure.malformed
    }
  }

  static func format(avcC bytes: [UInt8]) -> CMVideoFormatDescription? {
    guard bytes.count > 7, bytes[0] == 1 else { return nil }
    let lengthSize = Int32(bytes[4] & 0x03) + 1
    var cursor = 6
    var sets: [[UInt8]] = []
    func readSets(count: Int) -> Bool {
      for _ in 0..<count {
        guard cursor + 2 <= bytes.count else { return false }
        let length = Int(bytes[cursor]) << 8 | Int(bytes[cursor + 1])
        cursor += 2
        guard length > 0, cursor + length <= bytes.count else { return false }
        sets.append(Array(bytes[cursor..<cursor + length]))
        cursor += length
      }
      return true
    }
    guard readSets(count: Int(bytes[5] & 0x1F)), !sets.isEmpty, cursor < bytes.count else { return nil }
    let ppsCount = Int(bytes[cursor])
    cursor += 1
    guard readSets(count: ppsCount), sets.count >= 2 else { return nil }
    var format: CMVideoFormatDescription?
    let status = sets.withUnsafeParameterPointers { pointers, sizes in
      CMVideoFormatDescriptionCreateFromH264ParameterSets(
        allocator: kCFAllocatorDefault, parameterSetCount: sets.count,
        parameterSetPointers: pointers, parameterSetSizes: sizes,
        nalUnitHeaderLength: lengthSize, formatDescriptionOut: &format)
    }
    return status == noErr ? format : nil
  }

  static func sample(_ payload: Data, format: CMVideoFormatDescription) -> CMSampleBuffer? {
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: payload.count,
      blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
      dataLength: payload.count, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
      let block else { return nil }
    let copied = payload.withUnsafeBytes { raw in
      CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: payload.count)
    }
    guard copied == noErr else { return nil }
    var sample: CMSampleBuffer?
    var size = payload.count
    guard CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
      sampleCount: 1, sampleTimingEntryCount: 0, sampleTimingArray: nil,
      sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample) == noErr,
      let sample else { return nil }
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
       CFArrayGetCount(attachments) > 0 {
      let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(
        dictionary,
        Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
        Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
    }
    return sample
  }
}

private extension Array where Element == [UInt8] {
  func withUnsafeParameterPointers<R>(_ body: ([UnsafePointer<UInt8>], [Int]) -> R) -> R {
    let buffers = map { set -> UnsafeMutablePointer<UInt8> in
      let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: set.count)
      pointer.update(from: set, count: set.count)
      return pointer
    }
    defer { buffers.forEach { $0.deallocate() } }
    return body(buffers.map { UnsafePointer($0) }, map(\.count))
  }
}
