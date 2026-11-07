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
