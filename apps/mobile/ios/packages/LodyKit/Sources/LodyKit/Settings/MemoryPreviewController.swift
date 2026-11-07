import UIKit

@MainActor
final class MemoryPreviewController: MemorySettingsController {
  static let states = [
    "catalog_denied", "not_installed", "not_running", "unsupported", "error", "forbidden", "unknown", "cached", "empty",
  ]

  init(state: String? = nil) {
    let scope = SettingsActor(userId: "fixture", workspaceId: "offline-memory")
    let fixture = MemoryFixture(state: state) { scope.switchTo(userId: "settings-baseline-user", workspaceId: "settings-baseline") }
    super.init(scope: scope) { try await fixture.request($0) }
    title = state == nil ? "Memory" : "Memory States"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func scopeDidChange() {
    var row = LodyListRow()
    row.id = "memory-scope-switched"
    row.title = "Memory account switched"
    var section = LodyListSection()
    section.id = "scope"
    section.rows = [row]
    SettingsPage.apply(LodyListState(), to: list)
    list.setSections([section])
  }
}

@MainActor
private final class MemoryFixture {
  private let state: String?
  private let switchAccount: @MainActor () -> Void
  private var fail = true
  private var failRemove = true
  private var failImport = true
  private var parked: [CheckedContinuation<MemorySnapshot, Error>] = []
  private var entries = [
    MemoryAssociation(machineId: "studio", providerId: "nowledge-mem", memoryId: "review", name: "Reviewer",
                      description: "Code review preferences"),
    MemoryAssociation(machineId: "studio", providerId: "nowledge-mem", memoryId: "deleted", name: "Previous identity"),
  ]

  init(state: String?, switchAccount: @escaping @MainActor () -> Void) {
    self.state = state
    self.switchAccount = switchAccount
  }

  isolated deinit { parked.forEach { $0.resume(throwing: CancellationError()) } }

  private func park() async throws -> MemorySnapshot {
    switchAccount()
    return try await withCheckedThrowingContinuation { parked.append($0) }
  }

  func request(_ request: MemoryRequest) async throws -> MemorySnapshot {
    if state == "catalog_denied" { throw SettingsError("memory_forbidden") }
    if state == nil, request.action == "list", fail {
      fail = false
      throw SettingsError("offline")
    }
    let machineId = request.machineId ?? state ?? "studio"
    if request.action == "import", let memoryId = request.memoryId {
      if memoryId == "new", failImport {
        failImport = false
        throw SettingsError("memory_not_running")
      }
      if memoryId == "switch" { return try await park() }
      entries.append(MemoryAssociation(machineId: machineId, providerId: "nowledge-mem", memoryId: memoryId, name: "Reviewer",
                                       description: "Imported from provider"))
    }
    if request.action == "remove", let base = request.base {
      if base.memoryId == "new" { return try await park() }
      entries.removeAll { $0.memoryId == base.memoryId }
      if failRemove {
        failRemove = false
        throw SettingsError("memory_write_unknown")
      }
    }
    return snapshot(machineId)
  }

  private func snapshot(_ machineId: String) -> MemorySnapshot {
    let machines = state.map { [MemoryMachine(id: $0, name: "Studio")] }
      ?? [MemoryMachine(id: "studio", name: "Studio"), MemoryMachine(id: "laptop", name: "Laptop")]
    var status = "ready"
    if machineId == "laptop" { status = "offline" }
    let statuses = ["not_installed", "not_running", "unsupported", "error", "forbidden", "unknown"]
    if statuses.contains(machineId) { status = machineId }
    var result = MemorySnapshot(
      machines: machines, machineId: machineId, entries: machineId == "studio" ? entries : [], identities: [],
      status: status, cached: machineId == "cached"
    )
    if status == "ready" && machineId != "empty" {
      result.identities = [
        MemoryIdentity(id: "review", name: "Reviewer", description: "Code review preferences"),
        MemoryIdentity(id: "new", name: "Reviewer", description: "Another identity with the same name"),
        MemoryIdentity(id: "switch", name: "Switch account"),
      ]
    }
    if machineId == "laptop" || machineId == "cached" {
      result.entries = [MemoryAssociation(machineId: machineId, providerId: "nowledge-mem", memoryId: "review", name: "Reviewer",
                                          description: "A different computer’s identity")]
    }
    if machineId == "unsupported" {
      result.entries = [MemoryAssociation(machineId: machineId, providerId: "future-provider", memoryId: "future", name: "Other provider")]
    }
    return result
  }
}
