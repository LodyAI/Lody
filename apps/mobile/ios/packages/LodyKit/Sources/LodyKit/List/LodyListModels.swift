import UIKit

struct LodyListAction {
  var id: String = ""
  var title: String = ""
  var symbol: String = ""
  var tint: String = ""
  var destructive: Bool = false
  var selected: Bool = false
}

struct LodyListValueSegment {
  var text: String = ""
  var tint: String = ""
}

struct LodyListRow {
  var id: String = ""
  var title: String = ""
  var subtitle: String = ""
  var modelName: String = ""
  var value: String = ""
  var progress: Double? = nil
  var valueSegments: [LodyListValueSegment] = []
  var image: String = ""
  var imageAsset: String = ""
  var imageOriginal: Bool = false
  var filePath: String = ""
  var imageTint: String = ""
  var subtitleMono: Bool = false
  var wrapSubtitle: Bool = false
  var highlight: String = ""
  var unread: Bool = false
  var badge: String = ""
  var diff: [String: Int] = [:]
  var action: Bool = false
  var selected: Bool = false
  var accessibilityValue: String = ""
  var toggle: Bool? = nil
  var navigates: Bool = false
  var disclosure: Bool = false
  var destructive: Bool = false
  var parent: Bool = false
  var parentId: String = ""
  var lastChild: Bool = false
  /// Has nested rows right below it (`SessionRows.treeRows`); Home draws the tree trunk from it.
  var treeParent: Bool = false
  /// How many nested rows a tree parent has (its "4 ›" count).
  var childCount: Int = 0
  var collapsedValue: String = ""
  var collapsedBadge: String = ""
  var collapsedImageTint: String = ""
  var monogram: String = ""
  var pinned: Bool = false
  var actions: [LodyListAction] = []
  var leadingActions: [LodyListAction] = []
  var menuActions: [LodyListAction] = []
  var options: [LodyListAction] = []
  var preview: String = ""
  var status: String = ""
  var trailingSymbol: String = ""
  var trailingSymbolLabel: String = ""
  var valueSymbol: String = ""
  /// Chat list second line (`ChatListView`): project name, whether it is a GitHub repository,
  /// branch, and the latest pull request state (open / merged / closed / draft).
  var place: String = ""
  var placeIsRepo: Bool = false
  var repository: String = ""
  var branch: String = ""
  var prStatus: String = ""
  /// CI on the PR head: pass / fail / pending, empty when unknown.
  var prCI: String = ""
}

struct LodyListVisualItem {
  var id: String = ""
  var label: String = ""
  var value: String = ""
  var amount: Double = 0
  var detail: String = ""
  var percent: String = ""
  var fraction: Double = 0
  var caption: String = ""
  var accessibilityLabel: String = ""
  var accessibilityValue: String = ""
  var pace: Double? = nil
  var tone: String = ""
  var cost: Double? = nil
  var axisLabel: String = ""
}

struct LodyListVisual {
  var type: String = ""
  var title: String = ""
  var summary: String = ""
  var dimmed: Bool = false
  var metrics: [String] = []
  var costTitle: String = ""
  var costSummary: String = ""
  var items: [LodyListVisualItem] = []
}

struct LodyListNotice {
  var symbol: String = ""
  var text: String = ""
  var tint: String = ""
  var actionSymbol: String = ""
  var actionLabel: String = ""
}

struct LodyListUnavailable {
  var symbol: String = ""
  var title: String = ""
  var message: String = ""
  var actionTitle: String = ""
}

struct LodyListSection {
  var id: String = ""
  var header: String = ""
  var headerValue: String = ""
  var headerActionId: String = ""
  var headerExpanded: Bool? = nil
  var headerProminent: Bool = false
  var headerStatus: String = ""
  var footer: String = ""
  var rows: [LodyListRow] = []
  var visual: LodyListVisual? = nil
  var gap: LodyListGap = .section
}

enum LodyListGap {
  case section, group
}

// Both native list hosts share hierarchy, while keeping their own layout and selection.
extension LodyListSection {
  @MainActor
  static func prepareForFlatSnapshot<Item: Hashable & Sendable>(
    in dataSource: UICollectionViewDiffableDataSource<String, Item>
  ) {
    // The main snapshot omits collapsed children, but UIKit still owns them in
    // its section snapshots. Replace that hierarchy explicitly before returning
    // to flat updates; rebasing a flat snapshot can insert those children twice.
    let visible = dataSource.snapshot()
    for id in visible.sectionIdentifiers {
      let snapshot = dataSource.snapshot(for: id)
      guard snapshot.items.count != snapshot.rootItems.count else { continue }
      var flat = NSDiffableDataSourceSectionSnapshot<Item>()
      flat.append(visible.itemIdentifiers(inSection: id))
      dataSource.apply(flat, to: id, animatingDifferences: false)
    }
  }

  func outlineSnapshot<Item: Hashable & Sendable>(
    collapsed: Set<String>, itemID: (String) -> Item
  ) -> NSDiffableDataSourceSectionSnapshot<Item> {
    var snapshot = NSDiffableDataSourceSectionSnapshot<Item>()
    let sectionParent = rows.first.flatMap { $0.parent ? itemID($0.id) : nil }
    for row in rows {
      let item = itemID(row.id)
      let parent = row.parentId.isEmpty ? sectionParent : itemID(row.parentId)
      let availableParent = parent.flatMap { snapshot.contains($0) ? $0 : nil }
      snapshot.append([item], to: availableParent)
    }
    for row in rows {
      if row.parent {
        if headerExpanded ?? true { snapshot.expand([itemID(row.id)]) }
      } else if !row.collapsedValue.isEmpty && !collapsed.contains(row.id) {
        snapshot.expand([itemID(row.id)])
      }
    }
    return snapshot
  }
}

extension LodyListSection {
  // Record fields are reference boxes; a copy made by assignment would share
  // them, so the synthetic row goes into a freshly built section.
  func prepending(_ row: LodyListRow) -> LodyListSection {
    var copy = LodyListSection()
    copy.id = id
    copy.header = header
    copy.headerValue = headerValue
    copy.headerActionId = headerActionId
    copy.headerExpanded = headerExpanded
    copy.headerProminent = headerProminent
    copy.headerStatus = headerStatus
    copy.footer = footer
    copy.visual = visual
    copy.rows = [row] + rows
    return copy
  }

  static func synthetic(id: String, rowID: String, visual: LodyListVisual? = nil) -> LodyListSection {
    var row = LodyListRow()
    row.id = rowID
    var section = LodyListSection()
    section.id = id
    section.visual = visual
    section.rows = [row]
    return section
  }
}

extension LodyListRow {
  func displayingCollapsed(_ collapsed: Bool, keepingTime: Bool = false) -> LodyListRow {
    guard collapsed, !collapsedValue.isEmpty else { return self }
    var copy = self
    if !keepingTime { copy.value = collapsedValue }
    copy.badge = collapsedBadge
    copy.imageTint = collapsedImageTint
    return copy
  }
}
