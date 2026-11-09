import UIKit
import XCTest
@testable import LodyKit

@MainActor
private final class InlineCompletionDataSource: UICollectionViewDiffableDataSource<String, String> {
  var depth = 0
  var nestedApply = false
  var onFirstCompletion: (() -> Void)?
  var onSecondCompletion: (() -> Void)?
  var applications = 0

  override func apply(
    _ snapshot: NSDiffableDataSourceSnapshot<String, String>,
    animatingDifferences: Bool = true,
    completion: (() -> Void)? = nil
  ) {
    depth += 1
    nestedApply = nestedApply || depth > 1
    applications += 1
    let application = applications
    // UIKit permits an inline completion. Force that timing while still applying
    // the real snapshot to UIKit, so the regression does not depend on scheduling.
    super.apply(snapshot, animatingDifferences: false)
    if application == 1 { onFirstCompletion?() }
    completion?()
    if application == 2 { onSecondCompletion?() }
    depth -= 1
  }
}

@MainActor
final class ChatSnapshotReentrancyTests: XCTestCase {
  func testInlineSnapshotCompletionDefersReentrantUpdate() async throws {
    let view = LodyChatView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    view.collection.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "test")
    let source = InlineCompletionDataSource(collectionView: view.collection) { collection, index, _ in
      collection.dequeueReusableCell(withReuseIdentifier: "test", for: index)
    }
    view.dataSource = source
    let first = try entries("first")
    let latest = try entries("latest")
    view.transcript.entries = first
    let completed = expectation(description: "queued snapshot committed")
    var enteredCompletion = false
    source.onFirstCompletion = {
      enteredCompletion = true
      XCTAssertTrue(view.applying)
      view.transcript.entries = latest
      view.applyRows()
      XCTAssertTrue(view.needsApply)
    }
    source.onSecondCompletion = { completed.fulfill() }
    view.applyRows()
    XCTAssertTrue(enteredCompletion, "The test must inject its update inside the first apply")
    await fulfillment(of: [completed], timeout: 5)
    XCTAssertFalse(source.nestedApply, "A completion must not start another snapshot before apply returns")
    let actual = source.snapshot().itemIdentifiers.compactMap { view.rows[$0]?.text }
    XCTAssertTrue(actual.contains("latest"), "The queued snapshot must contain the newest transcript")
    XCTAssertFalse(actual.contains("first"))
  }

  private func entries(_ text: String) throws -> [ChatEntry] {
    let json = """
    [{"id":"message","role":"user","status":"completed","finished":true,
      "items":[{"itemId":"text","type":"text","text":"\(text)"}]}]
    """
    return try JSONDecoder().decode([ChatEntry].self, from: Data(json.utf8))
  }
}
