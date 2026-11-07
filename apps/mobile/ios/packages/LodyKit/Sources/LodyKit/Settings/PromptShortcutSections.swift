import Foundation
import LodyCore

typealias PromptShortcutEntry = RuntimeContract.PromptShortcutIndexEntry
typealias PromptShortcutValue = RuntimeContract.PromptShortcut

enum PromptShortcutRequest: Sendable {
  case list
  case read(PromptShortcutEntry)
  case save(entry: PromptShortcutEntry?, value: PromptShortcutValue, bodyDocId: String)
}

typealias PromptShortcutService = @MainActor (PromptShortcutRequest) async throws -> RuntimeContract.PromptShortcutsResult

enum PromptShortcutSections {
  static let promptLimit = 16000

  static func simple(scope: RuntimeContract.PromptShortcutScope, references: Int) -> Bool {
    scope.project == nil && scope.machineId == nil && scope.providerKey == nil && references == 0
  }

  static func viewOnly(_ entry: PromptShortcutEntry, userId: String) -> Bool {
    entry.ownerUserId != userId || !simple(scope: entry.scope, references: entry.dependencySummary.count)
  }

  // Mobile edits support 16,000 characters and no structured references.
  static func readOnly(_ value: PromptShortcutValue, userId: String) -> Bool {
    value.ownerUserId != userId || !simple(scope: value.scope, references: value.mentions.count)
      || value.prompt.utf16.count > promptLimit
  }

  static func validSlug(_ slug: String) -> Bool {
    slug.range(of: "^[a-z0-9][a-z0-9-]{0,39}\\z", options: .regularExpression) != nil
  }

  static func make(_ items: [PromptShortcutEntry], userId: String) -> [LodyListSection] {
    guard !items.isEmpty else { return [] }
    return ["private", "workspace"].map { visibility in
      var section = LodyListSection()
      section.id = visibility
      section.header = text(visibility)
      section.footer = visibility == "workspace" ? text("hintShort") : ""
      section.rows = items.filter { $0.visibility.rawValue == visibility }.map { item in
        var row = LodyListRow()
        row.id = item.id
        row.title = item.name
        row.subtitle = "/\(item.slug)"
        row.subtitleMono = true
        row.action = true
        row.disclosure = true
        if viewOnly(item, userId: userId) {
          row.trailingSymbol = "eye"
          row.trailingSymbolLabel = text("viewOnly")
        }
        return row
      }
      return section
    }
  }

  static func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings.shortcuts." + key), bundle: .lody) }
}
