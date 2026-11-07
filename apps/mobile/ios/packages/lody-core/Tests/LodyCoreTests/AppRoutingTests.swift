import XCTest
@testable import LodyCore

final class AppRoutingTests: XCTestCase {
  func testSessionLinksDecodeSegmentsWithoutAllowingPathInjection() {
    XCTAssertEqual(AppLink.parse("lody://team/sessions/session%201"), .session(workspace: "team", session: "session 1"))
    for path in ["lody://team/sessions/a%2Fb", "lody://team/sessions/%2e%2e", "https://team/sessions/a", "lody://team/sessions/a/extra"] {
      XCTAssertNil(AppLink.parse(path), path)
    }
  }

  func testShareWakeRequiresAnInboxIdentifier() {
    XCTAssertEqual(AppLink.parse("lody://share/90A118A4-1FBC-4459-9D23-D32ED9BD8FCA"), .share)
    XCTAssertNil(AppLink.parse("lody://share/arbitrary"))
  }

  func testNotificationCannotCrossAccountsOrInventSessions() {
    var state = NotificationNavigation.Context(ready: true, userId: "alice", workspaces: [("w", "team")],
      selectedId: "w", loading: false, connected: true, sessionIds: ["s"])
    XCTAssertEqual(NotificationNavigation.resolve(route: "/team/sessions/s", recipient: "bob", context: state), .discard(.wrongAccount))
    XCTAssertEqual(NotificationNavigation.resolve(route: "/team/sessions/s", recipient: "alice", context: state), .session("s"))
    XCTAssertEqual(NotificationNavigation.resolve(route: "/team/sessions/missing", recipient: "alice", context: state), .discard(.sessionMissing))
    state.connected = false
    XCTAssertEqual(NotificationNavigation.resolve(route: "/team/sessions/missing", recipient: "alice", context: state), .wait)
  }

  func testNotificationSwitchesWorkspaceBeforeResolvingItsCatalog() {
    let state = NotificationNavigation.Context(ready: true, userId: "alice", workspaces: [("w", "team")],
      selectedId: "other", loading: false, connected: true, sessionIds: ["s"])
    XCTAssertEqual(NotificationNavigation.resolve(route: "/team/sessions/s", recipient: "alice", context: state), .workspace("w"))
  }
  func testColdStartLinkWaitsForRestorationWithoutAnAccountFence() {
    var state = NotificationNavigation.Context(ready: false, userId: "", workspaces: [],
      selectedId: "", loading: true, connected: false, sessionIds: [])
    XCTAssertEqual(NotificationNavigation.resolve(route: "/team/sessions/s", recipient: nil, context: state), .wait)
    state = .init(ready: true, userId: "alice", workspaces: [("w", "team")],
      selectedId: "w", loading: false, connected: true, sessionIds: ["s"])
    XCTAssertEqual(NotificationNavigation.resolve(route: "/team/sessions/s", recipient: nil, context: state), .session("s"))
  }

  func testShareInboxDiscardsOtherAccountsAndRemovedWorkspaces() {
    XCTAssertEqual(ShareInboxRouting.resolve(user: "alice", workspaces: ["w"], selected: "w", loading: false,
      entryUser: "bob", entryWorkspace: "w"), .discard)
    XCTAssertEqual(ShareInboxRouting.resolve(user: "alice", workspaces: ["w"], selected: "w", loading: false,
      entryUser: "alice", entryWorkspace: "removed"), .discard)
  }

  func testShareInboxSwitchesBeforeWaitingForTheTargetCatalog() {
    XCTAssertEqual(ShareInboxRouting.resolve(user: "alice", workspaces: ["w"], selected: "other", loading: true,
      entryUser: "alice", entryWorkspace: "w"), .workspace("w"))
    XCTAssertEqual(ShareInboxRouting.resolve(user: "alice", workspaces: ["w"], selected: "w", loading: true,
      entryUser: "alice", entryWorkspace: "w"), .wait)
    XCTAssertEqual(ShareInboxRouting.resolve(user: "alice", workspaces: ["w"], selected: "w", loading: false,
      entryUser: "alice", entryWorkspace: "w"), .deliver)
  }

}
