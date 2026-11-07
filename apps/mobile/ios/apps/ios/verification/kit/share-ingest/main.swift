import UIKit
import UniformTypeIdentifiers

func check(_ condition: Bool, _ message: String) {
  if !condition { fatalError(message) }
}

func file(_ name: String, _ bytes: Data = Data("x".utf8)) -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + name)
  try! bytes.write(to: url)
  return url
}

func image(_ name: String) -> NSItemProvider {
  let data = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { context in
    UIColor.systemBlue.setFill()
    context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
  }
  let provider = NSItemProvider(contentsOf: file(name, data))!
  provider.suggestedName = name
  return provider
}

@MainActor
func run() async {
  // Safari: URL, page title and a preview image; duplicates are folded.
  let url = NSItemProvider(object: URL(string: "https://example.com/post")! as NSURL)
  let title = NSItemProvider(object: "Example post" as NSString)
  let again = NSItemProvider(object: "Example post" as NSString)
  let draft = await ShareIngest.load([title, url, again, image("preview.png")])
  check(draft.text == "Example post\n\nhttps://example.com/post", "text and URL joined once: \(draft.text)")
  check(draft.attachments.count == 1 && draft.attachments[0].isImage, "preview image attached")
  check(draft.attachments[0].url.path.hasPrefix(FileManager.default.temporaryDirectory.path)
    || draft.attachments[0].url.resolvingSymlinksInPath().path.hasPrefix(FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path),
    "attachments are copied to disk")

  // Files stay files; web archives are never attached.
  let pdf = NSItemProvider(contentsOf: file("paper.pdf"))!
  let archive = NSItemProvider(item: Data("x".utf8) as NSData, typeIdentifier: "com.apple.webarchive")
  let files = await ShareIngest.load([pdf, archive])
  check(files.attachments.count == 1 && files.attachments[0].name.hasSuffix("paper.pdf") && !files.attachments[0].isImage,
    "file attached: \(files.attachments.map(\.name)) dropped \(files.dropped)")

  // Limits: at most eight images; extras are dropped and reported.
  let many = await ShareIngest.load((0..<10).map { image("shot\($0).png") })
  check(many.attachments.count == ShareStore.limits.images && many.dropped == 2, "image limit \(many.attachments.count) \(many.dropped)")

  // Text over 64 KiB becomes a text file rather than being truncated.
  let long = String(repeating: "a", count: ShareStore.limits.textBytes + 1)
  let big = await ShareIngest.load([NSItemProvider(object: long as NSString)])
  check(big.text.isEmpty && big.attachments.first?.name == ChatAttachment.pastedTextName, "long text becomes a file")
  let stored = try! String(contentsOf: big.attachments[0].url, encoding: .utf8)
  check(stored.count == long.count, "long text kept whole")

  let empty = await ShareIngest.load([])
  check(empty.text.isEmpty && empty.attachments.isEmpty && empty.dropped == 0, "nothing shared")
  print("PASS: share ingest")
}

Task { @MainActor in
  await run()
  exit(0)
}
RunLoop.main.run()
