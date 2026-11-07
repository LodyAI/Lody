import Foundation
import ImageIO
import Vision

// Remote Photos picker content is absent from AXe on iOS 26. Wait for its
// visible loaded state before tapping the fixed Simulator fixture positions.
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  fatalError("Cannot read picker screenshot")
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .fast
request.recognitionLanguages = ["en-US"]
try VNImageRequestHandler(cgImage: image).perform([request])
let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(String(decoding: try JSONEncoder().encode(lines), as: UTF8.self))
