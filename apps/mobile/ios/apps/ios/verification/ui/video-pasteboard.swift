import UIKit
import UniformTypeIdentifiers

let movie = FileManager.default.temporaryDirectory.appendingPathComponent("IMG_3933.mov")
try Data("video-bytes".utf8).write(to: movie)
let poster = FileManager.default.temporaryDirectory.appendingPathComponent("IMG_3933.png")
try UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { context in
  UIColor.red.setFill()
  context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
}.write(to: poster)
let provider = NSItemProvider()
provider.suggestedName = "IMG_3933"
provider.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all) { completion in
  completion(poster, false, nil)
  return nil
}
provider.registerFileRepresentation(forTypeIdentifier: UTType.mpeg4Movie.identifier, fileOptions: [], visibility: .all) { completion in
  completion(movie, false, nil)
  return nil
}
UIPasteboard.general.setItemProviders([provider], localOnly: true, expirationDate: Date().addingTimeInterval(60))
print("READY")
fflush(stdout)
RunLoop.main.run(until: Date().addingTimeInterval(60))
