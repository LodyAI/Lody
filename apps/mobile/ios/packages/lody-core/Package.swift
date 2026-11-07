// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "LodyCore",
  platforms: [.iOS("26.0"), .macOS("26.0")],
  products: [
    .library(name: "LodyCore", targets: ["LodyCore"]),
    .library(name: "LodyRuntime", targets: ["LodyRuntime"]),
  ],
  targets: [
    .target(name: "LodyCore"),
    .target(name: "LodyRuntime", dependencies: ["LodyCore"]),
    .testTarget(name: "LodyCoreTests", dependencies: ["LodyCore"]),
  ]
)
