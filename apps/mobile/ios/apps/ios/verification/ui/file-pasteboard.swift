import UIKit
import UniformTypeIdentifiers

let source = FileManager.default.temporaryDirectory.appendingPathComponent("clipboard-fixture.txt")
try Data("clipboard file".utf8).write(to: source)
let provider = NSItemProvider()
provider.suggestedName = source.lastPathComponent
provider.registerFileRepresentation(forTypeIdentifier: UTType.data.identifier, fileOptions: [], visibility: .all) { completion in
  completion(source, false, nil)
  return nil
}
UIPasteboard.general.setItemProviders([provider], localOnly: true, expirationDate: Date().addingTimeInterval(60))
print("READY")
fflush(stdout)
RunLoop.main.run(until: Date().addingTimeInterval(60))
