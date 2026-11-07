import UIKit

func row(_ id: String, parent: Bool = false, parentID: String = "", children: Bool = false) -> LodyListRow {
  var row = LodyListRow()
  row.id = id
  row.title = id
  row.parent = parent
  row.parentId = parentID
  row.collapsedValue = children ? "2 children" : ""
  return row
}

func section(_ id: String, rows: [LodyListRow], expanded: Bool = true) -> LodyListSection {
  var section = LodyListSection()
  section.id = id
  section.rows = rows
  section.headerExpanded = expanded
  return section
}

let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
let controller = UIViewController()
window.rootViewController = controller
let collection = UICollectionView(
  frame: window.bounds,
  collectionViewLayout: UICollectionViewCompositionalLayout.list(using: .init(appearance: .insetGrouped))
)
controller.view.addSubview(collection)
let registration = UICollectionView.CellRegistration<UICollectionViewListCell, String> { cell, _, id in
  var content = UIListContentConfiguration.cell()
  content.text = id
  cell.contentConfiguration = content
}
let dataSource = UICollectionViewDiffableDataSource<String, String>(collectionView: collection) { view, index, id in
  view.dequeueConfiguredReusableCell(using: registration, for: index, item: id)
}
var expansionEvents: [String] = []
dataSource.sectionSnapshotHandlers.willExpandItem = { expansionEvents.append("expand:\($0)") }
dataSource.sectionSnapshotHandlers.willCollapseItem = { expansionEvents.append("collapse:\($0)") }
window.makeKeyAndVisible()

func itemID(_ section: String, _ row: String) -> String { "\(section):\(row)" }

// Exercise the same section/main snapshot boundary as LodyGroupedList, using
// production hierarchy construction and transition fallback against real UIKit.
@MainActor func apply(_ sections: [LodyListSection], collapsed: Set<String> = []) {
  let previous = dataSource.snapshot()
  let outline = sections.contains { $0.rows.contains { $0.parent || !$0.collapsedValue.isEmpty } }
  if outline {
    if previous.sectionIdentifiers != sections.map(\.id) {
      var snapshot = NSDiffableDataSourceSnapshot<String, String>()
      snapshot.appendSections(sections.map(\.id))
      dataSource.apply(snapshot, animatingDifferences: false)
    }
    for section in sections {
      let snapshot = section.outlineSnapshot(collapsed: collapsed) { itemID(section.id, $0) }
      dataSource.apply(snapshot, to: section.id, animatingDifferences: false)
    }
  } else {
    let previousEventCount = expansionEvents.count
    LodyListSection.prepareForFlatSnapshot(in: dataSource)
    assert(expansionEvents.count == previousEventCount, "Flattening must not emit user expansion changes")
    var snapshot = NSDiffableDataSourceSnapshot<String, String>()
    for section in sections {
      snapshot.appendSections([section.id])
      snapshot.appendItems(section.rows.map { itemID(section.id, $0.id) }, toSection: section.id)
    }
    let existing = Set(previous.itemIdentifiers)
    snapshot.reconfigureItems(snapshot.itemIdentifiers.filter { existing.contains($0) })
    dataSource.apply(snapshot, animatingDifferences: true)
  }
  collection.layoutIfNeeded()
}

let nested = section("pinned", rows: [
  row("root", children: true), row("child-a", parentID: "root"), row("child-b", parentID: "root"),
])
let flat = section("pinned", rows: [row("root"), row("child-a"), row("child-b")])
let flatIDs = flat.rows.map { itemID(flat.id, $0.id) }

for _ in 0..<12 {
  apply([nested], collapsed: ["root"])
  assert(dataSource.snapshot().itemIdentifiers == ["pinned:root"], "The failure requires hidden children")
  assert(dataSource.snapshot(for: "pinned").items.count == 3, "Collapsed children must still exist in UIKit")
  collection.selectItem(at: dataSource.indexPath(for: "pinned:root"), animated: false, scrollPosition: [])
  apply([flat])
  assert(dataSource.snapshot().itemIdentifiers == flatIDs, "Flattening must reveal each child exactly once")
  assert(dataSource.snapshot(for: "pinned").rootItems == flatIDs, "Flattening must remove the old parent relationships")
  assert(collection.indexPathsForSelectedItems?.contains(dataSource.indexPath(for: "pinned:root")!) == true,
         "Replacing hierarchy must preserve the retained row selection")
  apply([flat])
  assert(dataSource.snapshot().itemIdentifiers == flatIDs)
}
print("PASS: repeated collapsed-to-flat transitions reveal children once and preserve selection")

apply([nested])
apply([flat])
assert(dataSource.snapshot().itemIdentifiers == flatIDs, "Expanded trees must flatten too")
apply([nested], collapsed: ["root"])
let pruned = section("pinned", rows: [row("root"), row("child-b")])
apply([pruned])
assert(dataSource.snapshot(for: "pinned").items == ["pinned:root", "pinned:child-b"],
       "A child removed while hidden must not survive in the section snapshot")
print("PASS: expanded trees flatten and removed hidden children do not reappear")

let project = section("project", rows: [row("project-header", parent: true), row("session")], expanded: false)
apply([project, nested], collapsed: ["root"])
apply([flat, section("today", rows: [row("other")])])
assert(dataSource.snapshot().sectionIdentifiers == ["pinned", "today"])
assert(dataSource.snapshot().itemIdentifiers == flatIDs + ["today:other"],
       "View changes must remove old sections and keep all target rows")
apply([])
assert(dataSource.snapshot().itemIdentifiers.isEmpty)
assert(dataSource.snapshot().sectionIdentifiers.isEmpty)
apply([flat])
assert(dataSource.snapshot().itemIdentifiers == flatIDs)
print("PASS: section replacement, empty catalogs and subsequent flat updates remain consistent")

withExtendedLifetime((window, controller, dataSource)) {}
