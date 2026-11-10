import AppKit

// Sample a normalized content point so a container handoff can be compared
// with its own rendered baseline, independent of screen scale and theme.
guard CommandLine.arguments.count == 4,
      let data = try? Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])),
      let image = NSBitmapImageRep(data: data),
      let x = Double(CommandLine.arguments[2]),
      let y = Double(CommandLine.arguments[3]),
      let color = image.colorAt(x: Int(Double(image.pixelsWide - 1) * x),
                                y: Int(Double(image.pixelsHigh - 1) * y))?.usingColorSpace(.deviceRGB) else {
  fatalError("Expected an image and normalized x/y coordinates")
}
print("\(color.redComponent),\(color.greenComponent),\(color.blueComponent)")
