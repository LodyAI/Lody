import UIKit
import SwiftUI
import LodyDesignSystem

/// Offline fixture for the production list, including the family's real fold action.
@MainActor
final class ChatListPreviewController: UIViewController {
  override func loadView() {
    if LodyUIVerify.has("--ui-review-pr-icons") {
      let host = UIHostingController(rootView: PullRequestIconPreview())
      view = UIView()
      addChild(host)
      host.view.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(host.view)
      NSLayoutConstraint.activate([
        host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        host.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
        host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      ])
      host.didMove(toParent: self)
      return
    }
    let list = ChatListView(frame: .zero)
    view = list
    func row(_ id: String, _ title: String, tint: String = "", unread: Bool = false, project: String = "", pr: String = "", parent: String = "", last: Bool = false) -> LodyListRow {
      var row = LodyListRow()
      row.id = id; row.title = title; row.imageTint = tint; row.unread = unread
      row.place = project; row.prStatus = pr; row.prCI = "s"; row.value = "1h"
      row.parentId = parent; row.lastChild = last
      return row
    }
    var parent = row("list-review-parent", "Local-first attachments", tint: "blue", project: "Lody", pr: "open")
    parent.treeParent = true; parent.childCount = 3
    parent.collapsedImageTint = "warning"
    let rows = [
      row("list-review-unread", "Lody E2E improvements", unread: true, project: "Lody", pr: "merged"),
      parent,
      row("list-review-child-idle", "Review attachments PR", pr: "merged", parent: parent.id),
      row("list-review-child-waiting", "Confirm storage changes", tint: "warning", project: "Loro", pr: "open", parent: parent.id),
      row("list-review-child-failed", "Retry integration tests", tint: "danger", parent: parent.id, last: true),
      row("list-review-idle", "Native session synchronization", project: "Lody", pr: "open"),
      row("list-review-plain", "A conversation without extra details"),
    ]
    if LodyUIVerify.has("--ui-review-owners") {
      list.owners = Dictionary(rows.enumerated().map { index, row in
        (row.id, WorkspaceMember(id: "owner-\(index)", name: index % 2 == 0 ? "Leon" : "Alice", image: nil))
      }, uniquingKeysWith: { _, new in new })
    }
    if LodyUIVerify.has("--ui-review-pins") {
      let catalog = SessionCatalog(sessions: [
        SessionItem(id: "pinned", title: "Pinned conversation", status: "running", pinned: true, projectId: "p"),
        SessionItem(id: "regular", title: "Other conversation", projectId: "p"),
      ])
      list.setSections(InboxSections.home(catalog, grouping: .status))
      return
    }
    list.setSections([LodyListSection(id: "list-review", header: "Conversations", rows: rows)])
  }
}

private struct PullRequestIconPreview: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 28) {
      Text("PR / CI · Web parity").font(.headline)
      Text("None · Pass · Fail · Running · Expected").font(.caption)
      ForEach(["open", "draft", "merged", "closed"], id: \.self) { status in
        VStack(alignment: .leading, spacing: 12) {
          Text(status).font(.subheadline)
          HStack(spacing: 36) {
            ForEach(["", "s", "f", "p", "x"], id: \.self) { ci in
              LodyPullRequestIcon(status: status, ci: ci, size: 24)
            }
          }
        }
      }
      Spacer()
    }.padding(24)
  }
}
