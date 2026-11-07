import LodyCore
import UIKit

@MainActor
struct FilesService {
  var list: @MainActor (RuntimeContract.ListDirParams) async throws -> RuntimeContract.DirectoryListing
  var open: @MainActor (String, String, UIViewController) async -> Void
  static let live = FilesService(list: { params in
    guard let runtime = DataRuntime.current, runtime.workspace == params.workspaceId, runtime.userId == params.userId else {
      throw DataRuntime.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
    }
    return try await runtime.perform(RuntimeContract.Calls.ListDir.self, params)
  }, open: { sessionId, path, controller in
    await FileContentController.open(sessionId: sessionId, path: path, feedback: .live(sessionId: sessionId), from: controller)
  })
}

@MainActor
class FilesController: UIViewController {
  private let params: RuntimeContract.ListDirParams
  private let service: FilesService
  private let list = LodyGroupedList(frame: .zero)
  private var listing: RuntimeContract.DirectoryListing?
  private var error = ""
  private var task: Task<Void, Never>?
  private var opening = false

  init(params: RuntimeContract.ListDirParams, service: FilesService = .live) {
    self.params = params; self.service = service
    super.init(nibName: nil, bundle: nil)
  }
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
  isolated deinit { task?.cancel() }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in
      if name == "rowPress", let id = body["id"] as? String { self?.press(id) }
    }
    reload()
  }
  private func reload() {
    task?.cancel(); error = ""; render()
    task = Task { [weak self, params, service] in
      do {
        let next = try await service.list(params)
        guard !Task.isCancelled, let self else { return }
        listing = next
      } catch {
        guard !Task.isCancelled, let self else { return }
        self.error = String(localized: String.LocalizationValue(error.localizedDescription.contains("permission_denied") ? "files.error.archived" : "files.error.directory"), bundle: .lody)
      }
      self?.render()
    }
  }
  private func render() {
    var section = LodyListSection(); section.id = "entries"
    section.footer = error.isEmpty && listing?.truncated == true ? String(localized: "files.truncated", bundle: .lody) : error
    section.rows = (listing?.entries ?? []).map { entry in
      var row = LodyListRow(); row.id = "entry:" + entry.name; row.title = entry.name
      row.image = entry.type == .directory ? "folder" : ""
      row.filePath = entry.type == .file ? join(entry.name) : ""
      row.imageTint = entry.type == .file ? "secondary" : ""
      row.action = true; row.navigates = true; row.disclosure = entry.type == .directory
      return row
    }
    if !error.isEmpty {
      var retry = LodyListRow(); retry.id = "retry"; retry.title = String(localized: "common.retry", bundle: .lody); retry.action = true
      section.rows.append(retry)
    }
    list.setPlaceholder(String(localized: String.LocalizationValue(listing == nil ? "common.reading" : "files.emptyFolder"), bundle: .lody))
    list.setSections([section])
  }
  private func join(_ name: String) -> String { params.relativePath.isEmpty ? name : params.relativePath + "/" + name }
  private func press(_ id: String) {
    if id == "retry" { reload(); return }
    guard let entry = listing?.entries.first(where: { "entry:" + $0.name == id }) else { return }
    let path = join(entry.name)
    if entry.type == .directory {
      var next = params; next.relativePath = path
      LodyShell.shared.pushNative(FilesController(params: next, service: service), title: entry.name, from: self)
      return
    }
    guard !opening else { return }
    opening = true
    Task { [weak self, service, params] in
      guard let self else { return }
      await service.open(params.sessionId, path, self)
      opening = false
    }
  }
}
