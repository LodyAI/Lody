import LodyCore
import UIKit

@MainActor
final class DirectoryPreviewController: DirectoryController {
  private let selection: UILabel

  init() {
    let selection = UILabel()
    let anchor = DirectoryPreviewAnchor()
    self.selection = selection
    super.init(browser: DirectoryBrowser(service: DirectoryFixture().service()) { project, _ in
      guard let project, let page = anchor.controller?.parent else { return }
      selection.text = "Selected \(project.name) \(project.rootPath)"
      page.navigationController?.popToViewController(page, animated: true)
    })
    anchor.controller = self
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    selection.font = .preferredFont(forTextStyle: .body)
    selection.adjustsFontForContentSizeCategory = true
    selection.numberOfLines = 0
    selection.accessibilityIdentifier = "directory-selected"
    selection.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(selection)
    NSLayoutConstraint.activate([
      selection.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
      selection.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
      selection.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
    ])
  }
}

@MainActor
private final class DirectoryPreviewAnchor {
  weak var controller: UIViewController?
}

@MainActor
private final class DirectoryFixture {
  private var travelReads = 0
  private var unconfirmed: Set<String> = []

  func service() -> DirectoryService {
    DirectoryService(
      machines: { [self] in
        try await pause()
        return [DirectoryMachine(id: "studio", name: "Studio Mac"), DirectoryMachine(id: "travel", name: "Travel Mac")]
      },
      browse: { [self] machineId, path, cursor in
        try await pause()
        return try listing(machineId, path, cursor)
      },
      add: { [self] machineId, path in
        try await pause()
        if path.hasSuffix("/website"), unconfirmed.insert(path).inserted { throw SettingsError("project_write_unknown") }
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return CreateProject(id: "project:\(path)", machineId: machineId, name: name, rootPath: path)
      },
      cancel: {}
    )
  }

  private func pause() async throws { try await Task.sleep(for: .milliseconds(300)) }

  private func listing(_ machineId: String, _ path: String?, _ cursor: String?) throws -> DirectoryListing {
    if machineId == "travel" {
      travelReads += 1
      if travelReads == 1 { throw SettingsError("offline") }
      return DirectoryListing(path: "/Users/travel", parentPath: "/Users", entries: [], truncated: false)
    }
    let home = "/Users/demo"
    switch (path ?? home, cursor) {
    case (home, nil):
      return DirectoryListing(path: home, parentPath: "/Users", entries: [
        entry(home, "Projects"), entry(home, "Documents"), entry(home, "Private", error: "EACCES"),
      ], truncated: true, nextCursor: "page-2")
    case (home, _):
      return DirectoryListing(path: home, parentPath: "/Users", entries: [entry(home, "Documents"), entry(home, "Music")], truncated: false)
    case ("\(home)/Projects", _):
      let projects = "\(home)/Projects"
      return DirectoryListing(path: projects, parentPath: home, entries: [entry(projects, "lody-ios"), entry(projects, "website")], truncated: false)
    case (let other, _):
      return DirectoryListing(path: other, parentPath: nil, entries: [], truncated: false)
    }
  }

  private func entry(_ parent: String, _ name: String, error: String? = nil) -> RuntimeContract.LocalProjectsResultDirectoryEntriesItem {
    RuntimeContract.LocalProjectsResultDirectoryEntriesItem(name: name, absolutePath: "\(parent)/\(name)", error: error)
  }
}
