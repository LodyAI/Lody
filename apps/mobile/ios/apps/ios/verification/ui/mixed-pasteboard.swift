import UIKit
import UniformTypeIdentifiers

// Real local providers exercise native ordering, copying and thumbnail rendering.
let names = ["01-notes.txt", "02-landscape.png", "03-report.txt", "04-portrait.png", "05-summary.txt"]
let providers = try names.enumerated().map { index, name in
  let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
  let image = name.hasSuffix(".png")
  if image {
    let size = index == 1 ? CGSize(width: 240, height: 160) : CGSize(width: 120, height: 240)
    let picture = UIGraphicsImageRenderer(size: size).image { context in
      UIColor.systemBlue.setFill(); context.fill(CGRect(origin: .zero, size: size))
      UIColor.white.setFill(); context.fill(CGRect(x: 20, y: 20, width: size.width - 40, height: size.height - 40))
      UIColor.systemOrange.setFill(); context.fill(CGRect(x: 35, y: 35, width: size.width / 3, height: size.height / 3))
    }
    try picture.pngData()!.write(to: url)
  } else {
    try Data("Offline attachment \(name)\nComplete file contents remain available.".utf8).write(to: url)
  }
  let provider = NSItemProvider()
  provider.suggestedName = name
  provider.registerFileRepresentation(forTypeIdentifier: image ? UTType.png.identifier : UTType.data.identifier,
    fileOptions: [], visibility: .all) { completion in
      completion(url, false, nil)
      return nil
    }
  return provider
}
UIPasteboard.general.setItemProviders(providers, localOnly: true, expirationDate: Date().addingTimeInterval(60))
print("READY")
fflush(stdout)
RunLoop.main.run(until: Date().addingTimeInterval(60))
