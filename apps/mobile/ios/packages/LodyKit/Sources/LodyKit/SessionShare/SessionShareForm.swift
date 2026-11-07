import SwiftUI

struct SessionShareForm: View {
  struct Configuration: Decodable {
    let title: String
    let loaded: Bool
    let active: Bool
    let canPublish: Bool
    let canReset: Bool
    let canRevoke: Bool
    let hasLink: Bool
    let childrenCount: Int
    let includeChildren: Bool
    let selectionAvailable: Bool
    let pending: Bool
    let busy: Bool
    let error: Bool
    let notice: String
    let progressText: String
    let percent: Double?
    let strings: [String: String]

    func text(_ key: String) -> String { strings[key] ?? key }
  }

  let configuration: Configuration?
  let action: (String, Bool?) -> Void
  @State private var confirmation: String?

  var body: some View {
    if let state = configuration {
      Form {
        if state.loaded {
          Section {
            VStack(alignment: .leading, spacing: 6) {
              Text(state.title).font(.headline)
              Label(state.text(state.active ? "shared" : "private"), systemImage: state.active ? "link" : "lock")
                .font(.subheadline).foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
          } footer: {
            VStack(alignment: .leading, spacing: 4) {
              Text(state.text("publicNotice"))
              if !state.canPublish {
                Text(state.text("snapshotNotice"))
                Text(state.text("attachments"))
              }
            }
          }

          if state.hasLink {
            Section {
              button("copy", symbol: "doc.on.doc", id: "share-copy", state: state)
              button("send", symbol: "square.and.arrow.up", id: "share-system", action: "share", state: state)
            } footer: {
              if !state.notice.isEmpty { Text(state.notice).accessibilityIdentifier("share-notice") }
            }
          } else if state.active {
            Section { Text(state.text("keyMissing")).foregroundStyle(.secondary) }
          }

          if state.canPublish {
            Section {
              if state.childrenCount > 0 {
                Toggle(state.text("children"), isOn: Binding(
                  get: { state.includeChildren },
                  set: { action("includeChildren", $0) }
                ))
                .disabled(state.busy || state.pending)
                .accessibilityIdentifier("share-include-children")
              }
              if !state.selectionAvailable {
                Text(state.text("sourceUnavailable")).foregroundStyle(.secondary)
              }
            } header: {
              Text(state.text("content"))
            } footer: {
              VStack(alignment: .leading, spacing: 4) {
                Text(state.text("snapshotNotice"))
                Text(state.text("attachments"))
                if state.childrenCount > 31 { Text(state.text("limit")) }
              }
            }
          }
        }

        Section {
          if state.busy {
            VStack(alignment: .leading, spacing: 8) {
              if let percent = state.percent {
                ProgressView(value: percent, total: 100) { Text(state.progressText) }
              } else {
                HStack(spacing: 12) {
                  ProgressView()
                  Text(state.progressText)
                }
              }
              if state.loaded { Text(state.text("keepOpen")).font(.footnote).foregroundStyle(.secondary) }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("share-progress")
          } else {
            if state.error {
              Text(state.text("failed")).foregroundStyle(.secondary)
                .accessibilityIdentifier("share-error")
              button("retry", symbol: "arrow.clockwise", id: "share-reload", state: state)
            } else if state.canPublish {
              button(publishTitle(state), symbol: "arrow.up.doc", id: "share-publish", action: "publish", state: state)
                .disabled(!state.selectionAvailable)
            }
            if !state.hasLink && !state.notice.isEmpty {
              Label(state.notice, systemImage: "checkmark.circle")
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("share-notice")
            }
            if state.pending {
              button("discard", symbol: "xmark.circle", id: "share-discard", state: state)
            }
          }
        } footer: {
          if state.active && state.canPublish { Text(state.text("updateNotice")) }
        }

        if state.active && (state.canReset || state.canRevoke) {
          Section(state.text("manage")) {
            if state.canReset {
              Button { confirmation = "reset" } label: {
                Label(state.text("reset"), systemImage: "arrow.clockwise")
              }
              .accessibilityIdentifier("share-reset")
            }
            if state.canRevoke {
              Button(role: .destructive) { confirmation = "revoke" } label: {
                Label(state.text("revoke"), systemImage: "xmark.circle")
              }
              .accessibilityIdentifier("share-revoke")
            }
          }
          .disabled(state.busy)
        }
      }
      .tint(.blue)
      .alert(state.text(confirmation ?? "reset"), isPresented: Binding(
        get: { confirmation != nil },
        set: { if !$0 { confirmation = nil } }
      )) {
        if let confirmation {
          Button(state.text(confirmation), role: .destructive) { action(confirmation, nil) }
        }
        Button(state.text("cancel"), role: .cancel) {}
      } message: {
        Text(state.text((confirmation ?? "reset") + "Confirm"))
      }
    } else {
      ProgressView()
    }
  }

  private func publishTitle(_ state: Configuration) -> String {
    if state.pending { return "retry" }
    if state.active { return "update" }
    return "publish"
  }

  private func button(_ title: String, symbol: String, id: String, action name: String? = nil, state: Configuration) -> some View {
    Button { action(name ?? title, nil) } label: {
      Label(state.text(title), systemImage: symbol)
        .frame(minHeight: 24, alignment: .leading)
    }
    .disabled(state.busy)
    .accessibilityIdentifier(id)
  }
}
