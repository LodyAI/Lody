import LodyCore
import UIKit

@MainActor
final class PromptShortcutsPreviewController: PromptShortcutsController {
  init() {
    let fixture = PromptShortcutsFixture()
    super.init(
      workspace: SettingsWorkspace(userId: "owner", workspaceId: "shortcuts-fixture"),
      service: { try await fixture.request($0) }
    )
    title = "Prompt Shortcuts"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

@MainActor
private final class PromptShortcutsFixture {
  private var failLoad = true
  private var failSave = true
  private var values = [
    PromptShortcutsFixture.value("review", owner: "owner", visibility: .private, name: "Review", slug: "review",
      prompt: "Review the current changes."),
    PromptShortcutsFixture.value("scoped", owner: "teammate", visibility: .workspace, name: "Project Review",
      slug: "project-review", prompt: "Machine-specific review.", machine: "m1"),
  ]

  func request(_ request: PromptShortcutRequest) async throws -> RuntimeContract.PromptShortcutsResult {
    switch request {
    case .list:
      if failLoad {
        failLoad = false
        throw CocoaError(.fileReadUnknown)
      }
      return .list(.init(entries: values.map(Self.index)))
    case .read(let entry):
      guard let value = values.first(where: { $0.id == entry.id }) else { throw CocoaError(.fileReadNoSuchFile) }
      return .read(.init(shortcut: value))
    case .save(_, let value, _):
      if failSave {
        failSave = false
        throw CocoaError(.fileWriteUnknown)
      }
      if let index = values.firstIndex(where: { $0.id == value.id }) {
        values[index] = value
      } else {
        values.append(value)
      }
      return .save(.init(entry: Self.index(value)))
    }
  }

  private static func index(_ value: PromptShortcutValue) -> PromptShortcutEntry {
    PromptShortcutEntry(
      v: value.v, id: value.id, workspaceId: value.workspaceId, ownerUserId: value.ownerUserId,
      visibility: value.visibility == .workspace ? .workspace : .private, name: value.name, emoji: value.emoji,
      slug: value.slug, description: value.description, scope: value.scope, revision: value.revision,
      createdAt: value.createdAt, updatedAt: value.updatedAt, bodyDocId: "body-\(value.id)",
      dependencySummary: value.mentions.map(\.target)
    )
  }

  private static func value(
    _ id: String, owner: String, visibility: RuntimeContract.PromptShortcutVisibility, name: String, slug: String,
    prompt: String, machine: String? = nil
  ) -> PromptShortcutValue {
    PromptShortcutValue(
      v: 1, id: id, workspaceId: "shortcuts-fixture", ownerUserId: owner, visibility: visibility, name: name,
      slug: slug, scope: RuntimeContract.PromptShortcutScope(machineId: machine), revision: "r1", createdAt: 1,
      updatedAt: 1, prompt: prompt, mentions: []
    )
  }
}
