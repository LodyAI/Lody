// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "LodyKit",
  defaultLocalization: "en",
  platforms: [.iOS("26.0")],
  products: [.library(name: "LodyKit", targets: ["LodyKit"])],
  dependencies: [
    .package(path: "../lody-core"),
    .package(path: "../chat-kit"),
    .package(path: "../lexical-swift"),
    // Platform-owned appearance code and resources.
    .package(path: "../LodyAppearance"),
    .package(path: "../../node_modules/@rien7/anchored-overlay-kit"),
    .package(url: "https://github.com/Lakr233/MarkdownView.git", exact: "4.6.5"),
    .package(url: "https://github.com/lukilabs/beautiful-mermaid-swift.git", exact: "1.0.4"),
    .package(url: "https://github.com/apple/swift-collections.git", exact: "1.7.1"),
    .package(url: "https://github.com/Lakr233/Litext.git", exact: "3.6.2"),
    .package(url: "https://github.com/OneSignal/OneSignal-XCFramework.git", exact: "5.5.1"),
  ],
  targets: [
    .binaryTarget(name: "LodyDataChannel", path: "Vendor/LodyDataChannel.xcframework"),
    .target(
      name: "LodyKit",
      dependencies: [
        .product(name: "LodyCore", package: "lody-core"),
        .product(name: "LodyRuntime", package: "lody-core"),
        .product(name: "ChatKit", package: "chat-kit"),
        .product(name: "LodyDesignSystem", package: "LodyAppearance"),
        .product(name: "Lexical", package: "lexical-swift"),
        .product(name: "LexicalListPlugin", package: "lexical-swift"),
        .product(name: "LexicalLinkPlugin", package: "lexical-swift"),
        .product(name: "LexicalMarkdown", package: "lexical-swift"),
        .product(name: "EditorHistoryPlugin", package: "lexical-swift"),
        .product(name: "LexicalHTML", package: "lexical-swift"),
        .product(name: "AnchoredOverlayKit", package: "anchored-overlay-kit"),
        .product(name: "MarkdownView", package: "MarkdownView"),
        .product(name: "MarkdownParser", package: "MarkdownView"),
        .product(name: "BeautifulMermaid", package: "beautiful-mermaid-swift"),
        .product(name: "OrderedCollections", package: "swift-collections"),
        .product(name: "Litext", package: "Litext"),
        .product(name: "OneSignalFramework", package: "OneSignal-XCFramework"),
        "LodyDataChannel",
      ],
      exclude: ["Notifications/AGENTS.md", "SimulatorStream/README.md"],
      resources: [.process("Chat/Shaders"), .process("Resources")],
      linkerSettings: [.linkedLibrary("sqlite3"), .linkedLibrary("c++")]
    ),
  ]
)
