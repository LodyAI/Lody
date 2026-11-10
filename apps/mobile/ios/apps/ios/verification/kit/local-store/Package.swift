// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "LocalStoreVerification",
  defaultLocalization: "en",
  platforms: [.macOS(.v13)],
  dependencies: [.package(url: "https://github.com/Lakr233/MarkdownView.git", exact: "4.6.5")],
  targets: [.executableTarget(
    name: "LocalStoreVerification",
    dependencies: [.product(name: "MarkdownParser", package: "MarkdownView")],
    path: "Sources",
    resources: [.process("Resources")],
    linkerSettings: [.linkedLibrary("sqlite3")]
  )]
)
