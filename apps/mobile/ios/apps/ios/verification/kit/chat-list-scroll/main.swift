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

// The overlay appears only during native scrolling and owns only its painted bounds.
let recognizers = collection.gestureRecognizers?.count
let index = InboxProjectIndex(scroll: collection)
index.reduceMotion = { true }
controller.view.addSubview(index)
index.frame = window.bounds
var dismissals: [() -> Void] = []
index.scheduleDismiss = { delay, action in
  precondition(delay == 0.8)
  dismissals.append(action)
  return {} // Deliberately deliver cancelled callbacks to verify fencing.
}
let projects = (0..<5).map { InboxProjectIndex.Item(id: "project-\($0)", title: "Project \($0)", symbol: "", tint: "") }
index.update(projects)
index.refresh(current: projects[2].id)
precondition(index.isHidden)
precondition(collection.gestureRecognizers?.count == recognizers, "The index adds no recognizer to rows")
let originalWidth = collection.bounds.width
index.setScrolling(true)
precondition(!index.isHidden && collection.bounds.width == originalWidth)
precondition(index.hitTest(CGPoint(x: index.rail.midX, y: index.rail.midY), with: nil) === index)
precondition(index.hitTest(CGPoint(x: index.rail.minX - 1, y: index.rail.midY), with: nil) == nil)
precondition(index.hitTest(CGPoint(x: index.rail.midX, y: index.rail.minY - 1), with: nil) == nil)
var destination: String?
index.jump = { destination = $0 }
index.setScrolling(false)
let oldExpiry = dismissals.last!
index.begin(at: index.rail.minY + 10)
precondition(destination == projects.first?.id, "A direct tap selects immediately")
oldExpiry()
precondition(!index.isHidden, "A stale linger callback cannot dismiss an active scrub")
index.scrub(at: window.bounds.maxY)
precondition(destination == projects.last?.id)
index.scrub(at: 0)
precondition(destination == projects.first?.id)
index.endTouch()
precondition(!index.isHidden, "Release lingers")
dismissals.last!()
precondition(index.isHidden && index.hitTest(index.rail.origin, with: nil) == nil)
index.setScrolling(true)
index.setScrolling(false)
let previousScrollExpiry = dismissals.last!
index.setScrolling(true)
previousScrollExpiry()
precondition(!index.isHidden, "Renewed scrolling invalidates the old expiry")
index.begin(at: index.rail.midY)
index.update(Array(projects.reversed()))
precondition(index.isHidden && !index.touching)
destination = nil
index.scrub(at: 0)
precondition(destination == nil, "Snapshot replacement cancels the old touch")
index.refresh(current: projects[2].id)
index.setScrolling(true)
index.accessibilityIncrement()
precondition(destination == projects[1].id, "VoiceOver follows committed order")
NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
precondition(index.isHidden && !index.touching)
index.setScrolling(true)
index.removeFromSuperview()
precondition(index.isHidden)
controller.view.addSubview(index)
index.update([])
index.setScrolling(true)
precondition(index.isHidden)
index.update([projects[0]])
index.setScrolling(true)
precondition(index.isHidden)
print("PASS: scroll reveal, full-width list, bounded hit testing, direct tap/scrub, linger fencing, snapshot/background/detach cancellation and VoiceOver")

// Synthetic cached owner artwork exercises real image decoding without network IO.
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
index.setScrolling(true)
let surface = index.subviews.first!
let cells = surface.subviews.filter { $0.viewWithTag(2) != nil }
let photo = cells[0].viewWithTag(2) as! UIImageView
precondition(photo.image != nil && !photo.isHidden && photo.bounds.width == 24)
precondition(cells[0].viewWithTag(1)!.isHidden)
precondition((cells[1].viewWithTag(1) as! UILabel).text == "L")
precondition(surface.backgroundColor!.cgColor.alpha == 1 && surface.alpha == 1)
precondition(surface.subviews.allSatisfy { !($0 is UIVisualEffectView) })
print("PASS: visible full-color owner image, single-initial fallback and opaque surface")

let light = surface.backgroundColor!.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
let dark = surface.backgroundColor!.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
precondition(light.cgColor.alpha == 1 && dark.cgColor.alpha == 1 && light != dark)
let dense = (0..<100).map { InboxProjectIndex.Item(id: "dense-\($0)", title: "Project \($0)", symbol: "folder", tint: "") }
index.frame.size.height = 300
index.update(dense)
index.refresh(current: dense[50].id)
index.setScrolling(true)
let denseCells = surface.subviews.filter { $0.viewWithTag(2) != nil }
precondition(denseCells.filter { !$0.isHidden }.count < dense.count)
// Every displayed landmark has a full 48 pt target. Test taps near both edges,
// where absolute proportional mapping used to jump after tiny finger motion.
for height: CGFloat in [300, 540, 874] {
  index.frame.size.height = height
  index.refresh(current: dense[50].id)
  let landmarks = denseCells.indices.filter { !denseCells[$0].isHidden }
  for landmark in landmarks {
    index.refresh(current: dense[50].id)
    let cell = denseCells[landmark]
    precondition(cell.frame.size == CGSize(width: 48, height: 48))
    precondition(cell.frame.minY >= 12 && cell.frame.maxY <= surface.bounds.height - 12)
    for offset: CGFloat in [-22, 0, 22] {
      index.refresh(current: dense[50].id)
      let y = index.rail.minY + cell.frame.midY + offset
      index.begin(at: y)
      precondition(destination == dense[landmark].id, "A landmark's whole target selects that destination")
      for drift: CGFloat in [-7, -1, 0, 1, 7] {
        index.scrub(at: y + drift)
        precondition(destination == dense[landmark].id, "Small movement stays anchored to the tapped landmark")
      }
      index.endTouch()
    }
  }
  index.begin(at: index.rail.midY)
  var reached = Set<String>()
  for step in 0...4000 {
    index.scrub(at: index.rail.minY + CGFloat(step) / 4000 * index.rail.height)
    reached.insert(destination!)
    precondition(denseCells.indices.filter { !denseCells[$0].isHidden } == landmarks,
      "Scrubbing must not replace or move the displayed landmarks")
    let visible = denseCells.filter { !$0.isHidden }
    for (position, cell) in visible.enumerated() {
      precondition(cell.viewWithTag(2)!.bounds.size == CGSize(width: 24, height: 24))
      precondition(cell.frame.size == CGSize(width: 48, height: 48))
      precondition(surface.bounds.contains(cell.frame))
      precondition(visible.dropFirst(position + 1).allSatisfy { !cell.frame.intersects($0.frame) })
    }
  }
  precondition(reached == Set(dense.map(\.id)), "Overflow retains every scrub destination")
  index.endTouch()
  index.refresh(current: dense[0].id)
  for item in dense.dropFirst() {
    index.accessibilityIncrement()
    precondition(destination == item.id, "VoiceOver reaches every dense destination in order")
  }
  for item in dense.dropLast().reversed() {
    index.accessibilityDecrement()
    precondition(destination == item.id)
  }
}
print("PASS: 48 pt targets, capsule insets, fixed landmarks, stable taps with finger drift, opaque themes and every dense destination via scrub/VoiceOver")


// Drive UIKit animator completions explicitly; no wall-clock waits.
index.cancel()
index.reduceMotion = { false }
index.setScrolling(true)
let entrance = index.visibilityAnimator!
entrance.stopAnimation(false)
entrance.finishAnimation(at: .end)
precondition(!index.isHidden && surface.alpha == 1 && surface.transform == .identity)
index.setScrolling(false)
dismissals.last!()
precondition(!index.isHidden && !index.isUserInteractionEnabled)
precondition(index.hitTest(CGPoint(x: index.rail.midX, y: index.rail.midY), with: nil) == nil)
let exitingDestination = destination
index.begin(at: index.rail.midY)
index.accessibilityIncrement()
precondition(destination == exitingDestination && !index.touching)
let exit = index.visibilityAnimator!
index.setScrolling(true)
precondition(index.isUserInteractionEnabled && !index.isHidden && exit.state == .inactive)
let renewed = index.visibilityAnimator!
renewed.stopAnimation(false)
renewed.finishAnimation(at: .end)
precondition(!index.isHidden && surface.alpha == 1 && surface.transform == .identity)
index.setScrolling(false)
dismissals.last!()
let completedExit = index.visibilityAnimator!
completedExit.stopAnimation(false)
completedExit.finishAnimation(at: .end)
precondition(index.isHidden && index.visibilityAnimator == nil)
index.reduceMotion = { true }
index.setScrolling(true)
precondition(index.visibilityAnimator == nil && !index.isHidden && surface.transform == .identity && surface.alpha == 1)
index.setScrolling(false)
dismissals.last!()
precondition(index.isHidden && index.visibilityAnimator == nil)
index.reduceMotion = { false }
index.setScrolling(true)
index.cancel()
precondition(index.isHidden && index.visibilityAnimator == nil && !index.isUserInteractionEnabled)
print("PASS: restrained entrance/exit, opaque resting capsule, disabled exit hit targets, interruption, immediate cancellation and Reduce Motion")
