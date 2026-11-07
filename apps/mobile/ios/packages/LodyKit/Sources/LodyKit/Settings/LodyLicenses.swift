import Foundation

struct LodyLicense: Decodable, Sendable {
  let name: String
  let version: String?
  let license: String
  let url: String?
  let firstParty: Bool?
  let text: Int
}

@MainActor
enum LodyLicenses {
  private struct Catalog: Decodable {
    let packages: [LodyLicense]
    let texts: [String]
  }

  private static var cache: Catalog?

  // A few hundred KB: decode on first open instead of at launch.
  private static var catalog: Catalog {
    if let cache { return cache }
    let url = Bundle.main.url(forResource: "LodyLicenses", withExtension: "json")
    let loaded = url.flatMap { try? Data(contentsOf: $0) }
      .flatMap { try? JSONDecoder().decode(Catalog.self, from: $0) } ?? Catalog(packages: [], texts: [])
    cache = loaded
    return loaded
  }

  static var packages: [LodyLicense] { catalog.packages }

  static func entry(_ name: String) -> LodyLicense? { packages.first { $0.name == name } }

  static func text(_ entry: LodyLicense) -> String {
    let texts = catalog.texts
    return texts.indices.contains(entry.text) ? texts[entry.text] : ""
  }
}
