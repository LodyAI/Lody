import UIKit

@MainActor
final class PublishedSharesPreviewController: PublishedSharesController {
  static let states = ["empty", "denied", "readonly", "readback-denied"]

  init(state: String? = nil) {
    let scope = SettingsActor(userId: "published-shares-user", workspaceId: "offline-shares")
    let fixture = PublishedSharesFixture(state: state, userId: scope.userId) {
      scope.switchTo(userId: "settings-baseline-user", workspaceId: "settings-baseline")
    }
    super.init(scope: scope) { try await fixture.request($0) }
    title = "Published Shares"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func scopeDidChange() {
    var row = LodyListRow()
    row.id = "shares-scope-switched"
    row.title = "Share account switched"
    var section = LodyListSection()
    section.id = "scope"
    section.rows = [row]
    SettingsPage.apply(LodyListState(), to: list)
    list.setRefreshing(false)
    list.setSections([section])
  }
}

@MainActor
private final class PublishedSharesFixture {
  private let state: String?
  private let userId: String
  private let switchAccount: @MainActor () -> Void
  private var firstRead = true
  private var secondPage = true
  private var revokes = 0
  private var parked: [CheckedContinuation<PublishedSharePage, Error>] = []
  private var entries: [PublishedShare]

  init(state: String?, userId: String, switchAccount: @escaping @MainActor () -> Void) {
    self.state = state
    self.userId = userId
    self.switchAccount = switchAccount
    func share(_ id: String, _ source: String, _ publisher: String, _ title: String, revision: Int, created: Double = 1792000000000,
               bytes: Double = 1024, count: Double = 1, manage: Bool = true, revoke: Bool = true, link: Bool = true,
               status: String = "active") -> PublishedShare {
      PublishedShare(
        shareId: id, rootSessionId: source, publisherUserId: publisher, status: status, title: title, revision: revision,
        credentialVersion: 1, createdAt: created, updatedAt: 1792000100000, totalBytes: bytes, conversationCount: count,
        canManage: manage, canRevoke: revoke, hasLocalLink: link
      )
    }
    entries = [
      share("own", "source", userId, "Shared research", revision: 1, count: 2, revoke: state != "readonly"),
      share("teammate", "removed-source", "teammate", "Shared research", revision: 2, bytes: 2048, count: 3, manage: false,
            link: false),
      share("old", "old-source", "teammate", "Previous publication", revision: 3, created: 1791000000000, manage: false,
            revoke: false, link: false, status: "revoked"),
      share("missing", "deleted-source", userId, "Published on another device", revision: 1, link: false),
      share("switch", "switch-source", userId, "Account boundary", revision: 1),
    ]
  }

  isolated deinit { parked.forEach { $0.resume(throwing: CancellationError()) } }

  func request(_ request: PublishedSharesRequest) async throws -> PublishedSharePage {
    if state == "denied" { throw SettingsError("shares_forbidden") }
    if state == "readback-denied", revokes > 0, request.action == "detail" { throw SettingsError("shares_forbidden") }
    if state == nil, request.action == "list" {
      if firstRead {
        firstRead = false
        throw SettingsError("offline")
      }
      if request.cursor != nil, secondPage {
        secondPage = false
        throw SettingsError("offline")
      }
    }
    if request.action == "list" {
      if state == "empty" { return page([], done: true) }
      if state != nil { return page(Array(entries.prefix(1)), done: true) }
      let paged = request.cursor != nil
      return page(Array(entries[paged ? 3..<5 : 0..<3]), done: paged, cursor: paged ? "" : "page-two")
    }
    guard let index = entries.firstIndex(where: { $0.shareId == request.shareId }) else {
      throw SettingsError("shares_unavailable")
    }
    if request.action == "revoke" {
      revokes += 1
      entries[index].revision += 1
      if revokes == 1 && state == nil { throw SettingsError("shares_conflict") }
      entries[index].status = "revoked"
      entries[index].hasLocalLink = false
      throw SettingsError("shares_write_unknown")
    }
    if request.action == "copy", entries[index].shareId == "switch" {
      switchAccount()
      return try await withCheckedThrowingContinuation { parked.append($0) }
    }
    return page([entries[index]], done: true)
  }

  private func page(_ items: [PublishedShare], done: Bool, cursor: String = "") -> PublishedSharePage {
    PublishedSharePage(workspaceId: "offline-shares", userId: userId, page: items, isDone: done, continueCursor: cursor)
  }
}
