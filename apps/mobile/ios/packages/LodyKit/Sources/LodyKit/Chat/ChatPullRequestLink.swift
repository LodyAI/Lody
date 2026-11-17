import Foundation

/// A GitHub pull request URL in a message: `https://github.com/<owner>/<repo>/pull/<number>`,
/// optionally followed by a tab (`/files`, `/commits`), query or fragment.
struct ChatPullRequestLink: Equatable {
  let repository: String
  let number: Int
  let url: String

  init?(_ href: String) {
    let value = href.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
      let host = url.host?.lowercased(), host == "github.com" || host == "www.github.com" else { return nil }
    let parts = url.path.split(separator: "/").map(String.init)
    guard parts.count >= 4, parts[2] == "pull", !parts[3].isEmpty,
      parts[3].allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(parts[3]), number > 0 else { return nil }
    repository = "\(parts[0])/\(parts[1])"
    self.number = number
    self.url = "https://github.com/\(repository)/pull/\(number)"
  }
}
