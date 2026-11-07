// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "LodyAppearance",
  platforms: [.iOS("26.0")],
  products: [.library(name: "LodyDesignSystem", targets: ["LodyDesignSystem"])],
  targets: [
    .target(name: "LodyDesignSystem", resources: [.process("Resources")]),
  ]
)
