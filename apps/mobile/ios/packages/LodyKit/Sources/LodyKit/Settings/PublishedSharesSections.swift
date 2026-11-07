import Foundation

struct PublishedShare: Codable, Equatable, Sendable {
  var shareId: String
  var rootSessionId: String
  var publisherUserId: String
  var status: String
  var title: String
  var revision: Int
  var credentialVersion: Int
  var createdAt: Double
  var updatedAt: Double
  var totalBytes: Double?
  var conversationCount: Double?
  var canManage: Bool
  var canRevoke: Bool
  var hasLocalLink: Bool

  var valid: Bool {
    let counts = [Double(revision), createdAt, updatedAt, totalBytes ?? 0, conversationCount ?? 0]
    return shareId.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil
      && !rootSessionId.isEmpty && !publisherUserId.isEmpty && ["active", "revoked"].contains(status)
      && title.count <= 4096 && credentialVersion >= 1
      && counts.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 9_007_199_254_740_991 && $0.rounded() == $0 }
  }
}

struct PublishedSharePage: Codable, Equatable, Sendable {
  var workspaceId: String
  var userId: String
  var page: [PublishedShare]
  var isDone: Bool
  var continueCursor: String

  var valid: Bool {
    !workspaceId.isEmpty && !userId.isEmpty && page.count <= 20 && continueCursor.count <= 4096 && page.allSatisfy(\.valid)
  }
}

struct PublishedSharesRequest: Encodable, Equatable, Sendable {
  var workspaceId: String
  var action: String
  var cursor: String?
  var shareId: String?
  var rootSessionId: String?
  var expectedRevision: Int?

  static func list(_ workspaceId: String, cursor: String?) -> PublishedSharesRequest {
    PublishedSharesRequest(workspaceId: workspaceId, action: "list", cursor: cursor)
  }

  static func entry(_ workspaceId: String, _ action: String, _ entry: PublishedShare, revision: Int?) -> PublishedSharesRequest {
    PublishedSharesRequest(
      workspaceId: workspaceId, action: action, shareId: entry.shareId, rootSessionId: entry.rootSessionId,
      expectedRevision: revision
    )
  }
}

typealias PublishedSharesService = @MainActor (PublishedSharesRequest) async throws -> PublishedSharePage

enum PublishedSharesSections {
  static let knownErrors = [
    "shares_forbidden", "shares_conflict", "shares_unavailable", "shares_write_unknown", "shares_link_unavailable",
    "shares_link_failed",
  ]

  static func message(_ error: Error) -> String { "\(error) \((error as NSError).localizedDescription)" }

  static func errorText(_ error: Error) -> String {
    let described = message(error)
    for code in ["forbidden", "conflict", "write_unknown", "link_unavailable", "link_failed"] where described.contains("shares_\(code)") {
      return text("error.\(code)")
    }
    return text("error.unavailable")
  }

  static func title(_ entry: PublishedShare) -> String { entry.title.isEmpty ? text("untitled") : entry.title }

  static func date(_ value: Double) -> String {
    DateFormatter.localizedString(from: Date(timeIntervalSince1970: value / 1000), dateStyle: .short, timeStyle: .medium)
  }

  static func list(_ snapshot: PublishedSharePage?, pages: Int, busy: Bool, failed: Bool) -> [LodyListSection] {
    guard let snapshot else { return [] }
    var shares = section("shares", header: text("title"), footer: text("scope"))
    shares.rows = snapshot.page.map { entry in
      let summary = String.localizedStringWithFormat(String(localized: "settings.shares.summary", bundle: .lody), String(describing: Int(entry.conversationCount ?? 0)), String(describing: Int(((entry.totalBytes ?? 0) / 1024).rounded(.up))))
      var line = row("share:\(entry.shareId)", title(entry), subtitle: [
        status(entry.status), entry.publisherUserId, date(entry.createdAt), summary,
      ].joined(separator: " · "))
      line.action = !busy && !failed
      line.disclosure = true
      line.navigates = true
      return line
    }
    if shares.rows.isEmpty { shares.rows = [row("shares-empty", text("empty"))] }
    var sections = [shares]
    if pages > 1 || !snapshot.isDone {
      var pagination = section("pagination", footer: String.localizedStringWithFormat(String(localized: "settings.shares.page", bundle: .lody), String(describing: pages)))
      if pages > 1 {
        var previous = row("shares-previous", text("previous"))
        previous.action = !busy
        pagination.rows.append(previous)
      }
      if !snapshot.isDone {
        var next = row("shares-next", text("next"))
        next.action = !busy
        pagination.rows.append(next)
      }
      sections.append(pagination)
    }
    sections.append(section("static", footer: text("static")))
    return sections
  }

  static func detail(_ entry: PublishedShare, actor: String, busy: Bool, blocked: Bool) -> [LodyListSection] {
    var details = section("details", footer: text("static"))
    details.rows = [
      row("share-title", title(entry), subtitle: entry.shareId, wrap: true),
      row("share-status", status(entry.status), subtitle: blocked ? text("lastConfirmed") : "", wrap: true),
      row("share-publisher", text("publisher"), subtitle: entry.publisherUserId, wrap: true),
      row("share-created", text("created"), subtitle: date(entry.createdAt)),
      row("share-updated", text("updated"), subtitle: date(entry.updatedAt)),
      row("share-source", text("source"), subtitle: entry.rootSessionId, wrap: true),
    ]
    let active = entry.status == "active"
    var link = section("link")
    if entry.hasLocalLink && active {
      var open = row("share-open", text("open"))
      open.image = "safari"
      var copy = row("share-copy", text("copy"))
      copy.image = "doc.on.doc"
      open.action = !busy && !blocked
      copy.action = !busy && !blocked
      link.rows = [open, copy]
    } else if !active {
      link.footer = text("linkRevoked")
    } else {
      link.footer = text(entry.publisherUserId == actor ? "linkMissing" : "linkOtherPublisher")
    }
    var sections = [details, link]
    if active && entry.canRevoke {
      var revoke = section("revoke", footer: text("revokeHint"))
      var button = row("share-revoke", text("revoke"))
      button.action = !busy && !blocked
      button.destructive = true
      revoke.rows = [button]
      sections.append(revoke)
    }
    return sections
  }

  static func status(_ value: String) -> String { String(localized: String.LocalizationValue("settings.shares.status." + value), bundle: .lody) }

  static func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings.shares." + key), bundle: .lody) }

  private static func section(_ id: String, header: String = "", footer: String = "") -> LodyListSection {
    var section = LodyListSection()
    section.id = id
    section.header = header
    section.footer = footer
    return section
  }

  private static func row(_ id: String, _ title: String, subtitle: String = "", wrap: Bool = false) -> LodyListRow {
    var row = LodyListRow()
    row.id = id
    row.title = title
    row.subtitle = subtitle
    row.wrapSubtitle = wrap
    return row
  }
}
