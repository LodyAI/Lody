import UIKit

// Home decides the pinned label and its blur from header frames. Each frame must already
// match the offset, or small per-frame scroll steps flip that decision while dragging.
let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
let controller = UIViewController()
window.rootViewController = controller

let item = NSCollectionLayoutItem(layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .absolute(60)))
let group = NSCollectionLayoutGroup.vertical(
  layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .absolute(60)), subitems: [item])
let section = NSCollectionLayoutSection(group: group)
let header = NSCollectionLayoutBoundarySupplementaryItem(
  layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .absolute(44)),
  elementKind: UICollectionView.elementKindSectionHeader, alignment: .top)
header.pinToVisibleBounds = true
section.boundarySupplementaryItems = [header]

let collection = ChatListCollectionView(
  frame: window.bounds, collectionViewLayout: UICollectionViewCompositionalLayout(section: section))
collection.contentInsetAdjustmentBehavior = .never
controller.view.addSubview(collection)
let cell = UICollectionView.CellRegistration<UICollectionViewListCell, Int> { _, _, _ in }
let label = UICollectionView.SupplementaryRegistration<UICollectionReusableView>(
  elementKind: UICollectionView.elementKindSectionHeader) { _, _, _ in }
let dataSource = UICollectionViewDiffableDataSource<Int, Int>(collectionView: collection) { view, path, id in
  view.dequeueConfiguredReusableCell(using: cell, for: path, item: id)
}
dataSource.supplementaryViewProvider = { view, _, path in
  view.dequeueConfiguredReusableSupplementary(using: label, for: path)
}
var snapshot = NSDiffableDataSourceSnapshot<Int, Int>()
snapshot.appendSections([0])
snapshot.appendItems(Array(0..<40))
dataSource.applySnapshotUsingReloadData(snapshot)
window.makeKeyAndVisible()
collection.layoutIfNeeded()

var offsets: [CGFloat] = []
collection.onLayout = {
  let pinned = collection.visibleSupplementaryViews(ofKind: UICollectionView.elementKindSectionHeader)
  precondition(pinned.count == 1, "The fixture keeps one header in view")
  offsets.append(pinned[0].frame.minY - collection.contentOffset.y)
}
collection.contentOffset.y = 400
collection.layoutIfNeeded()
offsets = []
let steps = 40
for direction in [CGFloat(5), -5] {
  for _ in 0..<steps {
    collection.contentOffset.y += direction
    collection.layoutIfNeeded()
  }
}
precondition(offsets.count >= steps * 2, "Every scroll step must report a layout pass; got \(offsets.count)")
precondition(offsets.allSatisfy { abs($0) < 0.5 },
  "A pinned header must match the offset in both directions; got \(offsets.map(\.magnitude).max() ?? 0)")

print("PASS: the layout hook reads pinned header frames at the current offset in both scroll directions")

// Exercise the project scrollbar against a real scrolling collection.
let index = InboxProjectIndex(scroll: collection)
controller.view.addSubview(index)
index.frame = window.bounds
let projects = (0..<5).map { InboxProjectIndex.Item(id: "project-\($0)", title: "Project \($0)", symbol: "", tint: "") }
index.update(projects)
index.refresh(current: projects[2].id)
precondition(!index.isHidden)
precondition(index.accepts(CGPoint(x: index.thumb.midX, y: index.thumb.midY)))
precondition(!index.accepts(CGPoint(x: index.thumb.midX - 45, y: index.thumb.midY)), "Row long presses stay outside the thumb target")
precondition(!index.accepts(CGPoint(x: index.thumb.midX, y: index.thumb.maxY + 45)), "The empty track must not open the rail")
var destination: String?
index.jump = { destination = $0 }
// The current fixture's thumb spans several rail slots. Neither pressing near
// an end nor the first one-point movement may change the selected project.
precondition(index.thumb.height > 100)
for offset in [CGFloat(0), 400] {
  collection.contentOffset.y = offset
  index.refresh(current: projects[2].id)
  for y in [index.thumb.minY + 1, index.thumb.maxY - 1] {
    index.refresh(current: projects[2].id)
    destination = nil
    index.begin(at: y)
    precondition(destination == nil, "Expansion alone never navigates")
    index.scrub(at: y)
    index.scrub(at: y + 1)
    precondition(destination == nil, "Tall-thumb presses anchor the selected slot to the finger")
    index.scrub(at: y + 33)
    precondition(destination == projects[3].id, "Intentional scrubbing advances one slot")
    index.retract()
  }
}
collection.contentOffset.y = 400
index.refresh(current: projects[2].id)
index.begin()
precondition(index.expanded)
index.scrub(at: window.bounds.maxY)
precondition(destination == projects.last?.id, "Scrubbing below the rail clamps to the last rendered group")
index.scrub(at: 0)
precondition(destination == projects.first?.id)
index.retract()
precondition(!index.expanded, "Release retracts the rail")
index.begin()
index.cancel()
precondition(!index.expanded)
destination = nil
index.scrub(at: window.bounds.maxY)
precondition(destination == nil, "Cancelled gestures cannot jump")
index.begin()
index.update(Array(projects.reversed()))
precondition(!index.expanded, "Snapshot replacement retracts before identities move")
index.refresh(current: projects[2].id)
index.accessibilityIncrement()
precondition(destination == projects[1].id, "VoiceOver follows the new rendered order")
index.begin()
NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
precondition(!index.expanded, "Backgrounding ends scrubbing")
index.update([])
precondition(index.isHidden && !index.accepts(index.thumb.origin))
index.update([projects[0]])
precondition(index.isHidden, "One section needs no index")
print("PASS: project thumb targeting, scrub bounds, cancellation, replacement and VoiceOver order")

// A synthetic cached owner image must replace the initial without any network IO.
let avatarFile = FileManager.default.temporaryDirectory.appendingPathComponent("index-owner.png")
let avatar = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { context in
  UIColor.systemGreen.setFill()
  context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
}
try avatar.pngData()!.write(to: avatarFile)
let owner = RepositoryImages.url("synthetic-owner/project")!
LodyListPhoto.prime(owner, from: avatarFile)
try FileManager.default.removeItem(at: avatarFile)
index.update([
  .init(id: "repo", title: "Repository", symbol: "", tint: "", image: owner.absoluteString),
  .init(id: "local", title: "Local", symbol: "", tint: ""),
])
index.refresh(current: "repo")
index.begin()
let surface = index.subviews.compactMap { $0 as? UIVisualEffectView }.first!
let labels = surface.contentView.subviews.compactMap { $0 as? UILabel }
precondition((labels[0].viewWithTag(2) as? UIImageView)?.image != nil && labels[0].text == nil,
  "A cached repository owner image replaces its fallback")
precondition(labels[1].text == "L", "Projects without an owner image use one initial")
index.retract()
print("PASS: finger anchoring at both thumb ends and safe-area clamp; cached owner image and single-initial fallback")
