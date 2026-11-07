import LodyCore
import UIKit

@MainActor
struct DirectoryService {
  var machines: () async throws -> [DirectoryMachine]
  var browse: (_ machineId: String, _ path: String?, _ cursor: String?) async throws -> DirectoryListing
  var add: (_ machineId: String, _ path: String) async throws -> CreateProject
  var cancel: () -> Void

  static func live(workspaceId: String) -> DirectoryService {
    let browserId = LocalProjects.browserId("directory")
    func request(_ action: String, _ machineId: String? = nil, _ path: String? = nil, _ cursor: String? = nil) -> LocalProjectsRequest {
      LocalProjectsRequest(
        workspaceId: workspaceId, browserId: browserId, action: action, machineId: machineId, path: path, cursor: cursor
      )
    }
    return DirectoryService(
      machines: { try await LocalProjects.call(request("machines"), as: RuntimeContract.LocalProjectsResultMachines.self).machines },
      browse: { try await LocalProjects.call(request("browse", $0, $1, $2), as: DirectoryListing.self) },
      add: { try await LocalProjects.call(request("add", $0, $1), as: CreateProject.self) },
      cancel: { LocalProjects.cancel(workspaceId: workspaceId, browserId: browserId) }
    )
  }
}

@MainActor
final class DirectoryBrowser {
  let service: DirectoryService
  let select: (CreateProject?, UIViewController?) -> Void

  init(service: DirectoryService, select: @escaping (CreateProject?, UIViewController?) -> Void) {
    self.service = service
    self.select = select
  }

  func close() {
    service.cancel()
    select(nil, nil)
  }
}

@MainActor
class DirectoryController: UIViewController {
  static func browse(workspaceId: String) async -> CreateProject? {
    await withCheckedContinuation { continuation in
      var pending = true
      let browser = DirectoryBrowser(service: .live(workspaceId: workspaceId)) { project, controller in
        guard pending else { return }
        pending = false
        continuation.resume(returning: project)
        if let controller { (controller.parent ?? controller).navigationController?.dismiss(animated: true) }
      }
      LodyShell.shared.presentNative(DirectoryController(browser: browser), title: text("title"), detents: [1], grabber: true)
    }
  }

  let list = LodyGroupedList(frame: .zero)
  private let browser: DirectoryBrowser
  private let root: Bool
  private let path: String?
  private var machine: DirectoryMachine?
  private var machines: [DirectoryMachine] = []
  private var directory: DirectoryListing?
  private var loading = true
  private var saving = false
  private var error = ""
  private var generation = 0
  private lazy var useItem = LodyFormController.barButton(symbol: "checkmark", label: Self.text("accessibility.use"), prominent: true) {
    [weak self] in self?.confirm()
  }
  private lazy var cancelItem = LodyFormController.barButton(symbol: "xmark", label: String(localized: "common.cancel", bundle: .lody)) {
    [weak self] in self?.cancel()
  }

  init(browser: DirectoryBrowser, machine: DirectoryMachine? = nil, path: String? = nil) {
    self.browser = browser
    self.machine = machine
    self.path = path
    root = machine == nil && path == nil
    super.init(nibName: nil, bundle: nil)
    title = Self.text("title")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in self?.event(name, body) }
    list.setTransparent(true)
    load()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    render()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if root, SettingsPage.leaving(self) { browser.close() }
  }

  private func load() {
    generation += 1
    let id = generation
    loading = true
    error = ""
    render()
    Task {
      do {
        if let machine {
          let next = try await browser.service.browse(machine.id, path, nil)
          guard generation == id else { return }
          directory = next
        } else {
          let next = try await browser.service.machines()
          guard generation == id else { return }
          machines = next
          if next.count == 1 {
            machine = next[0]
            return load()
          }
        }
      } catch {
        guard generation == id else { return }
        self.error = Self.text(machine == nil ? "error.machines" : "error.read")
      }
      loading = false
      render()
    }
  }

  private func more() {
    guard let machine, let current = directory, let cursor = current.nextCursor, !loading else { return }
    loading = true
    render()
    Task {
      do {
        var next = try await browser.service.browse(machine.id, current.path, cursor)
        let known = Set(current.entries.map(\.absolutePath))
        next.entries = current.entries + next.entries.filter { !known.contains($0.absolutePath) }
        directory = next
      } catch {
        self.error = Self.text("error.loadMore")
      }
      loading = false
      render()
    }
  }

  private func confirm() {
    guard let machine, let directory, !loading, !saving else { return }
    saving = true
    error = ""
    render()
    Task {
      do {
        let project = try await browser.service.add(machine.id, directory.path)
        browser.select(project, self)
      } catch {
        self.error = Self.text("\(error)".contains("project_write_unknown") ? "error.registerUnknown" : "error.register")
      }
      saving = false
      render()
    }
  }

  private func cancel() {
    (parent ?? self).navigationController?.dismiss(animated: true)
  }

  private func enter(_ path: String) {
    guard let machine, !saving else { return }
    let name = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    LodyShell.shared.pushNative(DirectoryController(browser: browser, machine: machine, path: path), title: name, from: self)
  }

  private func event(_ name: String, _ body: [String: Any]) {
    guard name == "rowPress", let id = body["id"] as? String, !saving else { return }
    if machine == nil {
      if id == "retry" { return load() }
      guard let picked = machines.first(where: { $0.id == id }) else { return }
      LodyShell.shared.pushNative(DirectoryController(browser: browser, machine: picked), title: picked.name, from: self)
      return
    }
    switch id {
    case "retry": load()
    case "path": promptPath()
    case "more": more()
    default:
      guard id.hasPrefix("entry:"), let index = Int(id.dropFirst(6)), let entries = directory?.entries,
            entries.indices.contains(index), entries[index].error == nil else { return }
      enter(entries[index].absolutePath)
    }
  }

  private func promptPath() {
    let alert = UIAlertController(title: Self.text("prompt.title"), message: Self.text("prompt.message"), preferredStyle: .alert)
    alert.addTextField { [directory] field in
      field.text = directory?.path ?? ""
      field.autocorrectionType = .no
      field.autocapitalizationType = .none
    }
    alert.addAction(UIAlertAction(title: String(localized: "common.cancel", bundle: .lody), style: .cancel))
    alert.addAction(UIAlertAction(title: String(localized: "common.open", bundle: .lody), style: .default) { [weak self, weak alert] _ in
      MainActor.assumeIsolated {
        let value = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !value.isEmpty { self?.enter(value) }
      }
    })
    present(alert, animated: true)
  }

  private func render() {
    let header = parent?.navigationItem
    if root, let parent, parent.navigationController?.viewControllers.first === parent {
      cancelItem.isEnabled = !saving
      if header?.leftBarButtonItems != [cancelItem] { header?.leftBarButtonItems = [cancelItem] }
    }
    if machine != nil {
      useItem.accessibilityLabel = Self.text(saving ? "accessibility.using" : "accessibility.use")
      useItem.isEnabled = directory != nil && !loading && !saving
      if header?.rightBarButtonItems != [useItem] { header?.rightBarButtonItems = [useItem] }
    } else {
      header?.rightBarButtonItems = nil
    }
    list.setPlaceholder(placeholder())
    list.setSections(machine == nil ? machineSections() : folderSections())
  }

  private func placeholder() -> String {
    if loading { return String(localized: "common.reading", bundle: .lody) }
    return Self.text(machine == nil ? "noMachine" : "empty")
  }

  private func machineSections() -> [LodyListSection] {
    var rows = machines.map {
      LodyListRow.item($0.id, $0.name, image: "desktopcomputer", disclosure: true, navigates: true)
    }
    if !error.isEmpty { rows.append(.item("retry", String(localized: "common.retry", bundle: .lody))) }
    return [.group("machines", footer: error, rows)]
  }

  private func folderSections() -> [LodyListSection] {
    var footer = error
    if footer.isEmpty, saving { footer = Self.text("saving") }
    if footer.isEmpty, loading { footer = Self.text("loading") }
    var locationRows = [LodyListRow.item(
      "path", directory?.path ?? path ?? Self.text("home"), subtitle: Self.text("enterPath"), image: "folder",
      action: !saving, subtitleMono: true
    )]
    if !error.isEmpty { locationRows.append(.item("retry", String(localized: "common.retry", bundle: .lody), action: !saving)) }
    var sections: [LodyListSection] = [
      .group("location", header: machine?.name ?? "", footer: footer, locationRows),
      .group("directories", (directory?.entries ?? []).enumerated().map { index, entry in
        .item(
          "entry:\(index)", entry.name, subtitle: entry.error == nil ? "" : Self.text("entry.noAccess"), image: "folder",
          action: entry.error == nil && !saving, disclosure: true, navigates: true
        )
      }),
    ]
    if directory?.truncated == true {
      sections.append(.group("more", [
        .item("more", String(localized: String.LocalizationValue(loading ? "common.reading" : "common.loadMore"), bundle: .lody), action: !loading && !saving),
      ]))
    }
    return sections
  }

  static func text(_ key: String) -> String { String(localized: String.LocalizationValue("directory." + key), bundle: .lody) }
}
