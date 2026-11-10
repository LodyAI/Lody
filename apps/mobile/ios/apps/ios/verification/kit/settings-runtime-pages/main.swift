import Foundation

struct Failure: Error, CustomStringConvertible { let description: String }

func share(_ id: String, publisher: String = "me", status: String = "active", link: Bool = true, revoke: Bool = true) -> PublishedShare {
  PublishedShare(shareId: id, rootSessionId: "source", publisherUserId: publisher, status: status, title: id == "untitled" ? "" : "Title",
                 revision: 1, credentialVersion: 1, createdAt: 0, updatedAt: 0, totalBytes: 1500, conversationCount: 2,
                 canManage: true, canRevoke: revoke, hasLocalLink: link)
}
let page = PublishedSharePage(workspaceId: "w", userId: "me", page: [share("own"), share("untitled")], isDone: false, continueCursor: "c")
let shares = PublishedSharesSections.list(page, pages: 1, busy: false, failed: false)
precondition(shares.map(\.id) == ["shares", "pagination", "static"])
precondition(shares[0].rows.map(\.id) == ["share:own", "share:untitled"] && shares[0].rows[1].title == "settings.shares.untitled")
precondition(shares[0].rows[0].subtitle.hasPrefix("settings.shares.status.active · me · "))
precondition(shares[1].rows.map(\.id) == ["shares-next"], "First page offers only Next")
precondition(PublishedSharesSections.list(page, pages: 2, busy: false, failed: false)[1].rows.map(\.id) == ["shares-previous", "shares-next"])
precondition(!PublishedSharesSections.list(page, pages: 1, busy: false, failed: true)[0].rows[0].action)
var last = page
last.isDone = true
last.page = []
let empty = PublishedSharesSections.list(last, pages: 1, busy: false, failed: false)
precondition(empty.map(\.id) == ["shares", "static"] && empty[0].rows.map(\.id) == ["shares-empty"])

let own = PublishedSharesSections.detail(share("own"), actor: "me", busy: false, blocked: false)
precondition(own.map(\.id) == ["details", "link", "revoke"] && own[1].rows.map(\.id) == ["share-open", "share-copy"])
let blocked = PublishedSharesSections.detail(share("own"), actor: "me", busy: false, blocked: true)
precondition(blocked[0].rows[1].subtitle == "settings.shares.lastConfirmed" && blocked[1].rows.allSatisfy { !$0.action })
let missingLink = PublishedSharesSections.detail(share("own", link: false), actor: "me", busy: false, blocked: false)
precondition(missingLink[1].rows.isEmpty && missingLink[1].footer == "settings.shares.linkMissing")
let teammate = PublishedSharesSections.detail(share("t", publisher: "teammate", link: false), actor: "me", busy: false, blocked: false)
precondition(teammate[1].footer == "settings.shares.linkOtherPublisher")
let revoked = PublishedSharesSections.detail(share("r", status: "revoked"), actor: "me", busy: false, blocked: false)
precondition(revoked.map(\.id) == ["details", "link"] && revoked[1].footer == "settings.shares.linkRevoked" && revoked[1].rows.isEmpty)
precondition(PublishedSharesSections.detail(share("o", revoke: false), actor: "me", busy: false, blocked: false).count == 2)

precondition(PublishedSharesSections.errorText(Failure(description: "shares_conflict")) == "settings.shares.error.conflict")
precondition(PublishedSharesSections.errorText(Failure(description: "offline")) == "settings.shares.error.unavailable")
precondition(page.valid)
var bad = page
bad.page[0].shareId = "bad id"
precondition(!bad.valid)
bad = page
bad.page[0].credentialVersion = 0
precondition(!bad.valid)
let list = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(PublishedSharesRequest.list("w", cursor: nil))) as! [String: String]
precondition(list == ["workspaceId": "w", "action": "list"])

print("PASS: published share sections, paging and validation")
