import UIKit

@MainActor
final class MemoryDetailController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private let scope: SettingsActor
  private let expected: String
  private let workspaceId: String
  private let item: MemoryAssociation
  private let snapshot: MemorySnapshot
  private let service: MemoryService
  private let closed: @MainActor (Bool) -> Void
  private var busy = false
  private var failure = ""
  private var uncertain = false
  private var completed = false
  private var finished = false

  init(
    scope: SettingsActor, workspaceId: String, item: MemoryAssociation, snapshot: MemorySnapshot,
    service: @escaping MemoryService, closed: @escaping @MainActor (Bool) -> Void
  ) {
    self.scope = scope
    expected = scope.key
    self.workspaceId = workspaceId
    self.item = item
    self.snapshot = snapshot
    self.service = service
    self.closed = closed
    super.init(nibName: nil, bundle: nil)
    title = MemorySections.text("details")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private var current: Bool { scope.key == expected }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in self?.event(name, body) }
    scope.watch(self) { [weak self] in
      guard let self, !self.current else { return }
      SettingsPage.pop(self)
    }
    render()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    guard !finished, SettingsPage.leaving(self) || !current else { return }
    finished = true
    closed(completed)
  }

  private func render() {
    guard current else {
      list.setSections([])
      return
    }
    if !failure.isEmpty {
      list.setNotice(MemorySections.warning(failure, refresh: false))
    } else {
      list.setNotice(snapshot.cached ? MemorySections.cachedNotice() : nil)
    }
    list.setSections(MemorySections.detail(item, snapshot: snapshot, busy: busy, uncertain: uncertain))
  }

  private func event(_ name: String, _ body: [String: Any]) {
    guard name == "rowPress", body["id"] as? String == "memory-remove", !busy, !uncertain, !snapshot.cached else { return }
    SettingsPage.confirm(
      from: self, title: MemorySections.text("remove"),
      message: String.localizedStringWithFormat(String(localized: "settings.memory.removeConfirm", bundle: .lody), String(describing: item.name)),
      action: MemorySections.text("remove"), destructive: true
    ) { [weak self] in self?.remove() }
  }

  private func remove() {
    guard !busy, current, !uncertain else { return }
    busy = true
    render()
    let request = MemoryRequest(workspaceId: workspaceId, machineId: item.machineId, action: "remove", base: item)
    Task { [weak self, service] in
      let failure: MemoryFailure?
      do {
        _ = try await service(request)
        failure = nil
      } catch {
        failure = MemoryFailure(error)
      }
      guard let self else { return }
      self.busy = false
      guard self.current else { return self.render() }
      if let failure {
        self.failure = failure.text
        self.uncertain = failure.uncertain
        self.render()
      } else {
        self.completed = true
        SettingsPage.pop(self)
      }
    }
  }
}
