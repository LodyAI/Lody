import CoreGraphics
import Foundation
import LodyCore

struct ChatFileDiff: Decodable, Equatable {
  let path: String
  let add: Int?
  let del: Int?
  let status: String?
}

struct ChatEntry: Decodable {
  struct ModelInfo: Decodable {
    let modelId: String?
    let name: String?
    let thoughtLevel: String?

    var title: String {
      let name = self.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let model = name.isEmpty ? (modelId ?? "") : name
      return [model, thoughtLevel ?? ""]
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }.joined(separator: " · ")
    }
  }
  let id: String
  let role: String
  let status: String
  var finished: Bool
  let timestamp: String?
  let endedAt: Double?
  let startedAt: Double?
  var permissionWaitMs: Double? = nil
  var items: [ChatItem]
  let fileDiffs: [ChatFileDiff]?
  var inputConfig: ChatTurnInput? = nil
  var tokenUsage: ChatTurnUsage? = nil
  var modelInfo: ModelInfo? = nil
  var userTurnId: String? = nil
  /// A user turn's sender, for its avatar and name.
  var userId: String? = nil
  var executionId: String? = nil
  var executionFinished: Bool? = nil
  var steerCount: Int? = nil
  var delivery: String? = nil
  var inputState: String? = nil
  var inputRetryable: Bool? = nil
  var holdOpen: Bool? = nil
  var canSteer: Bool? = nil
  var isRunning: Bool { role == "assistant" && !finished }
  var isQueued: Bool { role == "user" && status == "queued" }
  /// A later visible process settles earlier prose, even while the turn runs.
  var textTailID: String? {
    guard let item = items.last(where: {
      !$0.hidesFromTranscript && !($0.type == "system_notice" && ($0.name == nil || $0.name == "agent_warning"))
    }), item.type == "text" || item.type == "thought" else { return nil }
    return item.itemId
  }
}

extension ChatEntry {
  /// Web `PlanExitBlock`: a plan-approval card (ACP `switch_mode`) that carries its plan
  /// (Claude's `rawInput.plan`, Kimi's content) shows it as the turn's plan, directly above the
  /// decision, with the same surface as a `proposed_plan`. A turn that already renders its own
  /// `proposed_plan` (Codex, web `hasSeparatePlanItem`) keeps only that one, or the plan would
  /// print twice. Idempotent: the inserted plan is itself a `proposed_plan`.
  static func showingCarriedPlans(_ entries: [ChatEntry]) -> [ChatEntry] {
    entries.map { entry in
      guard entry.role == "assistant",
            entry.items.contains(where: { $0.carriedPlan != nil }),
            !entry.items.contains(where: { $0.type == "proposed_plan" && !$0.hidesFromTranscript }) else { return entry }
      var result = entry
      result.items = entry.items.flatMap { item -> [ChatItem] in
        guard let markdown = item.carriedPlan else { return [item] }
        var plan = item
        plan.itemId = ChatItem.carriedPlanID(item.itemId)
        plan.type = "proposed_plan"
        plan.markdown = markdown
        plan.status = "completed"
        plan.isLatest = true
        plan.permission = nil
        plan.plan = nil
        return [plan, item]
      }
      return result
    }
  }
}

extension ChatItem {
  static func carriedPlanID(_ itemId: String) -> String { itemId + ":plan" }

  var carriedPlan: String? {
    guard type == "tool_call", kind == "switch_mode",
          let plan = plan?.trimmingCharacters(in: .whitespacesAndNewlines), !plan.isEmpty else { return nil }
    return plan
  }
}

struct ChatImage: Codable, Equatable {
  let id: String
  let fileName: String
  let storageSessionId: String?
  let width: Double?
  let height: Double?
}

struct ChatMessageAttachment: Decodable, Equatable {
  let id: String
  let fileName: String
  var image: ChatImage? = nil
  var localURI: String? = nil
  var localID: String? = nil
  var storageSessionId: String? = nil
  var transport: String? = nil
  var sizeBytes: Int? = nil
  var mimeType: String? = nil
}

struct ChatOperationCard: Decodable, Equatable {
  let id: String
  let kind: String
  let sessionId: String
  let label: String?
  let status: String
  let detail: String?
  let reply: String?
  var replyTruncated: Bool? = nil

  var statusLabel: String {
    let prefix = kind == "reply" ? "session.operation.reply." : "session.operation.status."
    return String(localized: String.LocalizationValue(prefix + status), bundle: .lody)
  }
  var opening: String {
    (detail ?? reply ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  }
}

struct ChatOperationPresentation: Decodable {
  struct Notice: Decodable {
    let kind: String
    let detail: String?
    let count: Int?
  }
  let cards: [ChatOperationCard]
  let notices: [Notice]

  func rows(entryID: String, itemID: String) -> [ChatRow] {
    let prefix = entryID + ":" + itemID
    var rows: [ChatRow] = []
    for (index, notice) in notices.enumerated() {
      var title = String(localized: String.LocalizationValue("session.operation." + notice.kind), bundle: .lody)
      if let count = notice.count { title = String.localizedStringWithFormat(title, count) }
      rows.append(ChatRow(id: prefix + ":notice:\(index)", entryID: entryID, kind: "operationNotice", text: title,
        itemID: itemID, detail: notice.detail ?? ""))
    }
    let created = cards.filter { $0.kind == "created" }
    if !created.isEmpty {
      rows.append(ChatRow(id: prefix + ":created", entryID: entryID, kind: "operationHeader",
        text: String.localizedStringWithFormat(String(localized: "session.operation.createdCount", bundle: .lody), created.count),
        itemID: itemID, actionable: created.count > 5))
    }
    for card in cards {
      rows.append(ChatRow(id: prefix + ":card:" + card.id, entryID: entryID, kind: "operationCard",
        text: card.label ?? "", itemID: itemID, actionable: true, operation: card, detail: card.opening))
    }
    return rows
  }

  /// Keep large creation groups compact without losing their rows from history.
  static func visible(_ rows: [ChatRow], expanded: Set<String>, titles: [String: String]) -> [ChatRow] {
    var grouped: [ChatRow] = []
    var pending: [ChatRow] = []
    var groupForRow: [String: String] = [:]
    func flush() {
      guard var header = pending.first else { return }
      let cards = pending.filter { $0.operation != nil }
      let group = header.entryID + ":" + header.itemID
      header.text = String.localizedStringWithFormat(String(localized: "session.operation.createdCount", bundle: .lody), cards.count)
      header.actionable = cards.count > 5
      grouped.append(header)
      for card in cards { groupForRow[card.id] = group; grouped.append(card) }
      pending.removeAll()
    }
    for row in rows {
      if row.kind == "operationHeader" || row.operation?.kind == "created" { pending.append(row) }
      else { flush(); grouped.append(row) }
    }
    flush()
    var counts: [String: Int] = [:]
    return grouped.compactMap { source in
      var row = source
      let group = groupForRow[row.id] ?? (row.entryID + ":" + row.itemID)
      if row.kind == "operationHeader" { row.disclosed = expanded.contains(group) }
      if let card = row.operation {
        if card.kind == "created" {
          counts[group, default: 0] += 1
          if counts[group, default: 0] > 5 && !expanded.contains(group) { return nil }
        }
        row.text = titles[card.sessionId]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if row.text.isEmpty { row.text = card.label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
        if row.text.isEmpty { row.text = String(localized: "session.operation.untitled", bundle: .lody) }
        row.actionable = titles[card.sessionId] != nil
      }
      return row
    }
  }
}

struct ChatItem: Decodable {
  var references: [ChatTextReference]? = nil
  struct Permission: Decodable { let requestId: String; let pending: Bool }
  struct Plan: Decodable { let content: String; let status: String }
  struct NoticeMeta: Decodable, Equatable { let reason: String?; let code: String?; let message: String? }
  var operation: ChatOperationPresentation? = nil
  var meta: NoticeMeta? = nil
  /// An Agent's Role or schedule proposal carried by a `system_notice` (web proposal notices).
  var proposal: ChatProposal? = nil
  var isChatFailure: Bool { type == "system_notice" && name == "chat_failed" }
  var itemId: String
  var type: String
  let name: String?
  var text: String?
  let kind: String?
  let title: String?
  var status: String?
  let path: String?
  let hasDetail: Bool?
  var permission: Permission?
  /// Plan text a plan-approval card (`switch_mode`) carries (runtime `planExitMarkdown`).
  var plan: String? = nil
  let entries: [Plan]?
  let description: String?
  let actor: String?
  var markdown: String? = nil
  var isLatest: Bool? = nil
  var lastToolName: String? = nil
  var summary: String? = nil
  var error: String? = nil
  var isBackgrounded: Bool? = nil
  var skipTranscript: Bool? = nil
  var processDurationMs: Int? = nil
  var isProcess: Bool { operation == nil && proposal == nil && type != "text" && type != "proposed_plan" && !isAttachment && !isChatFailure && type != "subagent_task" }
  var hidesFromTranscript: Bool {
    if let operation { return operation.cards.isEmpty && operation.notices.isEmpty }
    if type == "proposed_plan" {
      return !["delta", "completed"].contains(status ?? "") || (markdown ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    return type == "subagent_task" && skipTranscript == true
  }
  var isLiveSubagent: Bool {
    type == "subagent_task" && skipTranscript != true && (status == "in_progress" || status == "pending")
  }
  let image: ChatImage?
  var file: ChatMessageAttachment? = nil
  var images: [ChatImage]? = nil
  var isImage: Bool { type == "image" || type == "image_group" }
  var isAttachment: Bool { isImage || type == "file" }
}

struct ChatRow: Equatable {
  let id: String
  let entryID: String
  var kind: String
  var text: String
  var references: [ChatTextReference] = []
  var errorMeta: ChatItem.NoticeMeta? = nil
  var errorRetry: ChatErrorRetryState? = nil
  var planIsLatest = true
  var planPermissionItemID = ""
  var planDecision: ChatPlanDecisionState? = nil
  var symbol = ""
  var itemID = ""
  var processStartID = ""
  var actionable = false
  var running = false
  var attention = false
  var streaming = false
  var localImageURI: String? = nil
  var image: ChatImage? = nil
  /// An `imageStack` row: the consecutive images it fans together, each keeping its own
  /// single-image row id so the preview, sharing and zoom sources address it individually.
  var stack: [ChatImagePreviewItem] = []
  var file: ChatMessageAttachment? = nil
  var fileDiff: ChatFileDiff? = nil
  var fileDiffs: [ChatFileDiff] = []
  var attachments: [ChatMessageAttachment] = []
  var uploadProgress: [String: ChatAttachmentUploadProgress] = [:]
  var workDurationMs: Int? = nil
  var imageAsset = ""
  var subagent: ChatSubagentCard? = nil
  var operation: ChatOperationCard? = nil
  var proposal: ChatProposal? = nil
  /// The signed-in user may decide this proposal (a Role proposal binds its requester).
  var proposalDecidable = false
  var proposalState: ChatProposalState? = nil
  var operationCurrent = false
  var operationPeers: [ChatOperationPeer] = []
  var operationCLIType: String? = nil
  var operationAgentType: String? = nil
  var detail = ""
  var treeChild = false
  var treeLast = false
  var treeDown = false
  var shines: Bool { running && kind != "duration" }
  /// `only` / `first` / `middle` / `last` for consecutive file rows in one group.
  var group = ""
  /// A "Worked for …" row whose folded work is open in place (its chevron points down).
  var disclosed = false
  /// A user turn's first row: its sender's user id (`ChatAuthors.unknownSender` when the turn
  /// predates the field or is a local send), when, and whether the agent picked it up
  /// (`seen` / `sent` / `queued` / `sending`), drawn above the bubble with the avatar beside it.
  var author = ""
  var authorImage = ""
  var authorName = ""
  var authorTime = ""
  var readState = ""
}

/// Formatting shared by user-turn headers and local sends.
enum ChatAuthors {
  /// Turns without a recorded sender: older history, and this device's own sends.
  static let unknownSender = "-"

  static func time(_ timestamp: String?) -> String {
    guard let timestamp,
      let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(timestamp)) ?? (try? Date.ISO8601FormatStyle().parse(timestamp))
    else { return "" }
    if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
    return date.formatted(.dateTime.month(.defaultDigits).day().hour().minute())
  }

  static func readState(_ status: String) -> String {
    switch status {
    // Execution outcomes acknowledge receipt even if the run failed or was canceled.
    case "seen", "processing", "handled", "failed", "canceled", "completed", "done": "seen"
    case "queued": "queued"
    default: "sent"
    }
  }
}

enum ChatMetaTime {
  static let relativeDayLimit = 7

  static func label(_ endedAt: Double?, now: Double, calendar: Calendar = .current) -> String {
    guard let endedAt, endedAt.isFinite, endedAt > 0, now.isFinite else { return "" }
    let ended = Date(timeIntervalSince1970: endedAt / 1000)
    let current = Date(timeIntervalSince1970: now / 1000)
    if calendar.isDate(ended, inSameDayAs: current) {
      return ended.formatted(date: .omitted, time: .shortened)
    }
    let days = calendar.dateComponents(
      [.day], from: calendar.startOfDay(for: ended), to: calendar.startOfDay(for: current)
    ).day
    guard let days, days >= 1, days < relativeDayLimit else {
      return ended.formatted(date: .abbreviated, time: .omitted)
    }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    return formatter.localizedString(from: DateComponents(day: -days))
  }
}

enum ChatWorkDuration {
  private static let fractionalTimestamp = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
  private static let timestamp = Date.ISO8601FormatStyle()

  static func startMilliseconds(for entry: ChatEntry) -> Double? {
    let parsedTimestamp = entry.timestamp.flatMap {
      (try? fractionalTimestamp.parse($0)) ?? (try? timestamp.parse($0))
    }
    return parsedTimestamp.map { $0.timeIntervalSince1970 * 1000 } ?? entry.startedAt
  }

  static func milliseconds(for entry: ChatEntry, now: Double, startOverride: Double? = nil) -> Int? {
    let start = startOverride ?? startMilliseconds(for: entry)
    let end = entry.finished ? entry.endedAt : now
    guard let start, let end, start.isFinite, end.isFinite, end >= start,
          end - start <= Double(Int.max) else { return nil }
    var wait = 0.0
    if let written = entry.permissionWaitMs, written.isFinite, written > 0,
       written <= Double(Int.max)
    {
      wait = written
    }
    return Int(max(0, end - start - wait))
  }

  static func needsTimer(_ rows: [ChatRow]) -> Bool {
    rows.contains { $0.kind == "duration" && $0.running && $0.workDurationMs != nil }
  }

  static func format(
    _ milliseconds: Int,
    hour: String,
    minute: String,
    second: String
  ) -> String {
    guard milliseconds >= 0 else { return "" }
    let totalSeconds = milliseconds / 1000
    let hours = totalSeconds / 3600
    let minutes = totalSeconds % 3600 / 60
    let seconds = totalSeconds % 60
    if hours > 0 {
      return "\(hours)\(hour) \(pad2(minutes))\(minute) \(pad2(seconds))\(second)"
    }
    if minutes > 0 {
      return "\(minutes)\(minute) \(pad2(seconds))\(second)"
    }
    return "\(seconds)\(second)"
  }

  private static func pad2(_ value: Int) -> String {
    value < 10 ? "0\(value)" : String(value)
  }

  static func label(_ milliseconds: Int) -> String {
    format(
      milliseconds,
      hour: String(localized: "native.chat.duration.hour", bundle: .lody),
      minute: String(localized: "native.chat.duration.minute", bundle: .lody),
      second: String(localized: "native.chat.duration.second", bundle: .lody)
    )
  }

  static func title(_ milliseconds: Int, running: Bool) -> String {
    let key = running ? "native.chat.transcript.status.workingFor" : "native.chat.transcript.status.workedFor"
    return String.localizedStringWithFormat(String(localized: String.LocalizationValue(key), bundle: .lody), label(milliseconds))
  }
}

/// Conversation stays readable on wide hosts; the scroll view itself stays full-bleed
/// so the vertical indicator remains on the screen edge.
enum ChatReadingColumn {
  static let maximumWidth: CGFloat = 800
  /// Web's mobile conversation inset.
  static let cellMargin: CGFloat = 16
  static let sectionTop: CGFloat = 4
  static let sectionBottom: CGFloat = 4

  static func columnWidth(in collectionWidth: CGFloat) -> CGFloat {
    min(max(1, collectionWidth), maximumWidth)
  }

  static func horizontalInset(in collectionWidth: CGFloat) -> CGFloat {
    (max(0, collectionWidth - columnWidth(in: collectionWidth)) / 2) + cellMargin
  }

  static func itemWidth(in collectionWidth: CGFloat) -> CGFloat {
    max(1, collectionWidth - horizontalInset(in: collectionWidth) * 2)
  }
}

enum ChatTranscriptPreviewMetrics {
  static let width: CGFloat = 320
  static let sectionInset: CGFloat = 16
  static let symbolGutter: CGFloat = 36

  static func itemWidth(collectionWidth: CGFloat) -> CGFloat {
    let width = collectionWidth > 1 ? collectionWidth : Self.width
    return max(1, width - sectionInset * 2)
  }

  static func textWidth(itemWidth: CGFloat, hasSymbol: Bool) -> CGFloat {
    if !hasSymbol { return itemWidth }
    return max(1, itemWidth - symbolGutter)
  }
}

/// Stable identities belong to the protocol, never to the streamed text.
struct ChatTranscript {
  var entries: [ChatEntry] = []
  /// Finished turns whose folded work the reader opened in place, by entry id.
  var expandedWork: Set<String> = []
  var expandedThoughts: Set<String> = []

  func liveSubagentItems() -> [ChatItem] {
    entries.flatMap(\.items).filter(\.isLiveSubagent)
  }

  private struct CachedEnvelope: Decodable {
    let entries: [ChatEntry]?
  }

  static func previewRows(from cache: String) -> [ChatRow] {
    guard let data = cache.data(using: .utf8) else { return [] }
    if let envelope = try? JSONDecoder().decode(CachedEnvelope.self, from: data),
       let entries = envelope.entries {
      return ChatTranscript(entries: ChatEntry.showingCarriedPlans(entries)).rows().filter { $0.kind != "meta" }
    }
    if let entries = try? JSONDecoder().decode([ChatEntry].self, from: data) {
      return ChatTranscript(entries: ChatEntry.showingCarriedPlans(entries)).rows().filter { $0.kind != "meta" }
    }
    return []
  }

  /// Provider-proven continuation groups retain original row identities. Only
  /// the finished presentation moves user bubbles above the combined process.
  func rows(
    processEntryID: String = "",
    processStartID: String = "",
    now: Double = Date().timeIntervalSince1970 * 1000,
    turnStartedAt: [String: Double] = [:]
  ) -> [ChatRow] {
    if processStartID == "__tasks__" {
      return entries.flatMap { entry in
        entry.items.compactMap { item -> ChatRow? in
          guard item.type == "subagent_task", item.skipTranscript != true else { return nil }
          return ChatTranscript.subagentRow(entry: entry, item: item)
        }
      }
    }
    let groups = Dictionary(grouping: entries.filter { $0.executionId != nil }, by: { $0.executionId! })
    if processStartID == "__execution__",
       let groupID = entries.first(where: { $0.id == processEntryID })?.executionId,
       let members = groups[groupID] {
      return executionProcess(members)
    }
    if !processEntryID.isEmpty {
      return entryRows(processEntryID: processEntryID, processStartID: processStartID, now: now, turnStartedAt: turnStartedAt,
        flatItems: processStartID == "__subagent__")
    }
    let ordinary = Dictionary(grouping: entryRows(now: now, turnStartedAt: turnStartedAt), by: \.entryID)
    var emitted = Set<String>()
    return entries.flatMap { entry -> [ChatRow] in
      if let groupID = entry.executionId, let members = groups[groupID],
         let tail = members.last(where: { $0.role == "assistant" }),
         tail.executionFinished == true, members.filter({ $0.role == "assistant" }).allSatisfy(\.finished), !executionResultIDs(tail).isEmpty {
        guard emitted.insert(groupID).inserted else { return [] }
        let users = members.filter { $0.role == "user" && $0.id == groupID }.flatMap {
          ChatTranscript(entries: [$0]).entryRows(now: now)
        }
        let process = executionProcess(members)
        var result = users
        if !process.isEmpty {
          result.append(ChatRow(id: groupID + ":execution", entryID: tail.id, kind: "summary",
            text: String.localizedStringWithFormat(String(localized: "native.chat.transcript.execution", bundle: .lody), String(describing: String(tail.steerCount ?? 0))),
            symbol: "", processStartID: "__execution__", actionable: true))
        }
        result += members.filter { $0.role == "assistant" }.flatMap {
          ChatTranscript(entries: [$0]).entryRows(processEntryID: $0.id, flatItems: true).filter { $0.kind == "proposed_plan" }
        }
        let ids = executionResultIDs(tail)
        result += ChatTranscript(entries: [tail]).entryRows(processEntryID: tail.id, flatItems: true).filter { ids.contains($0.itemID) }
        result += ChatTranscript(entries: [tail]).entryRows(now: now).filter { ["meta", "changesHeader", "changes"].contains($0.kind) }
        return result
      }
      var visible = entry
      if entry.holdOpen == true || entry.executionId != nil { visible.finished = false }
      var result = ChatTranscript(entries: [visible], expandedThoughts: expandedThoughts).entryRows(now: now, turnStartedAt: turnStartedAt)
      if entry.finished && !visible.finished {
        result.removeAll { $0.kind == "duration" }
        for index in result.indices {
          result[index].streaming = false
          result[index].running = false
        }
      }
      // Preserve existing duration attribution for ordinary conversation rows.
      if entry.executionId == nil && entry.holdOpen != true {
        return ChatTranscript.hangSubagents(ordinary[entry.id] ?? [])
      }
      return ChatTranscript.hangSubagents(result)
    }
  }

  private func executionResultIDs(_ entry: ChatEntry) -> Set<String> {
    var result = Set<String>()
    for item in entry.items.reversed() {
      if item.isAttachment || (item.type == "text" && !(item.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
        result.insert(item.itemId)
      } else { break }
    }
    return result
  }

  private func executionProcess(_ members: [ChatEntry]) -> [ChatRow] {
    let assistants = members.filter { $0.role == "assistant" }
    guard let tail = assistants.last else { return [] }
    let resultIDs = executionResultIDs(tail)
    return members.flatMap { entry -> [ChatRow] in
      if entry.role == "user" {
        // The execution ID identifies the initial prompt. Later user messages
        // are guides and belong at their original position in the process.
        guard entry.id != entry.executionId else { return [] }
        return ChatTranscript(entries: [entry]).entryRows()
      }
      return ChatTranscript(entries: [entry]).entryRows(processEntryID: entry.id, flatItems: true).filter {
        $0.kind != "proposed_plan" && (entry.id != tail.id || !resultIDs.contains($0.itemID))
      }
    }
  }

  private func entryRows(
    processEntryID: String = "",
    processStartID: String = "",
    now: Double = Date().timeIntervalSince1970 * 1000,
    turnStartedAt: [String: Double] = [:],
    flatItems: Bool = false
  ) -> [ChatRow] {
    entries.enumerated().flatMap { entryIndex, source -> [ChatRow] in
      var entry = source
      // Older cached projections omitted notice names. Neither these placeholders nor
      // agent warnings belong in the conversation's execution process.
      entry.items.removeAll { $0.hidesFromTranscript || ($0.type == "system_notice" && ($0.name == nil || $0.name == "agent_warning")) }
      let processOnly = !processEntryID.isEmpty
      if processOnly && entry.id != processEntryID { return [] }
      if entry.role == "user" {
        if processOnly || entry.isQueued { return [] }
        var result: [ChatRow] = []
        let attachments = entry.items.compactMap { item -> ChatMessageAttachment? in
          if let image = item.image, item.type == "image" {
            return ChatMessageAttachment(id: image.id, fileName: image.fileName, image: image)
          }
          return item.type == "file" ? item.file : nil
        }
        if !attachments.isEmpty {
          result.append(ChatRow(id: entry.id + ":user", entryID: entry.id, kind: "attachments", text: "", attachments: attachments))
        }
        var text = ""
        var references: [ChatTextReference] = []
        for item in entry.items where item.type == "text" {
          guard let value = item.text else { continue }
          if !text.isEmpty { text += "\n\n" }
          let offset = (text as NSString).length
          references += (item.references ?? []).map { reference in
            var shifted = reference
            shifted.start += offset; shifted.end += offset
            return shifted
          }
          text += value
        }
        if !text.isEmpty {
          result.append(ChatRow(id: entry.id + (result.isEmpty ? ":user" : ":user-text"), entryID: entry.id, kind: "user", text: text, references: references))
        }
        // The turn's first row (its attachments, else its bubble) carries its sender, time and
        // read state (web's header), so attachments read as part of the message.
        if !result.isEmpty {
          result[0].author = entry.userId ?? ChatAuthors.unknownSender
          result[0].authorTime = ChatAuthors.time(entry.timestamp)
          result[0].readState = entry.inputState == nil || entry.inputState == "confirmed" ? ChatAuthors.readState(entry.status) : "sending"
        }
        if entry.inputState == "unknown" {
          let label = String(localized: "send.status.unknown", bundle: .lody) + " · " + String(localized: "send.forget.hint", bundle: .lody)
          result.insert(ChatRow(id: entry.id + ":delivery", entryID: entry.id, kind: "delivery", text: label, actionable: true, attention: true), at: 0)
        }
        if entry.inputRetryable == true {
          result.insert(ChatRow(id: entry.id + ":retryPending", entryID: entry.id, kind: "delivery",
            text: String(localized: "native.chat.error.retry", bundle: .lody), actionable: true, attention: true), at: 0)
        }
        if let delivery = entry.delivery, delivery != "accepted" {
          let key = "native.chat.message.guide." + delivery
          result.insert(ChatRow(id: entry.id + ":delivery", entryID: entry.id, kind: "delivery",
            text: String(localized: String.LocalizationValue(key), bundle: .lody), attention: delivery == "rejected" || delivery == "unknown"), at: 0)
        }
        return result
      }
      let answer = ChatTranscript.answerRun(entry.items)
      // Web folds a finished turn only when something answers it below the fold; a cancelled or
      // tool-only turn stays expanded.
      let folds = entry.finished && entry.items.indices.contains { index in
        answer.contains(index) || entry.items[index].type == "proposed_plan" || entry.items[index].isAttachment || entry.items[index].isChatFailure
      }
      var visible: [Int] = []
      var groups: [Int: [Int]] = [:]
      if entry.role != "assistant" {
        if processOnly { return [] }
        visible = Array(entry.items.indices)
      } else if processOnly {
        if flatItems {
          visible = entry.items.indices.filter { !entry.items[$0].hidesFromTranscript }
        } else if !processStartID.isEmpty, let start = entry.items.firstIndex(where: { $0.itemId == processStartID }) {
          let toolGroup = entry.items[start].type == "tool_call"
          let end = entry.items.indices.dropFirst(start + 1).first {
            let item = entry.items[$0]
            if toolGroup { return item.type != "tool_call" || item.kind == "switch_mode" }
            return item.type == "text" || item.type == "proposed_plan" || item.isAttachment
          } ?? entry.items.endIndex
          visible = Array(start..<end).filter { entry.items[$0].type != "proposed_plan" && !entry.items[$0].isAttachment && !entry.items[$0].isChatFailure && !entry.items[$0].hidesFromTranscript }
        } else {
          visible = entry.items.indices.filter { !answer.contains($0) && entry.items[$0].type != "proposed_plan" && !entry.items[$0].isAttachment && !entry.items[$0].hidesFromTranscript }
        }
      } else if folds && !expandedWork.contains(entry.id) {
        let process = entry.items.indices.filter {
          !answer.contains($0) && entry.items[$0].type != "proposed_plan" && !entry.items[$0].isAttachment && !entry.items[$0].isChatFailure && entry.items[$0].type != "subagent_task" && entry.items[$0].operation == nil
        }
        if let first = process.first { groups[first] = process }
        visible = process.first.map { [$0] } ?? []
        visible.append(contentsOf: answer)
        visible.append(contentsOf: entry.items.indices.filter {
          entry.items[$0].type == "proposed_plan" || entry.items[$0].isAttachment || entry.items[$0].isChatFailure
            || entry.items[$0].operation != nil || (entry.items[$0].type == "subagent_task" && !entry.items[$0].hidesFromTranscript)
        })
        visible.sort()
      } else {
        // Keep prose in place, folding consecutive runs of thoughts and tools separately.
        var toolStart: Int?
        var thoughtStart: Int?
        for index in entry.items.indices {
          let item = entry.items[index]
          if item.hidesFromTranscript || (item.type == "tool_call" && item.kind == "think") { continue }
          if item.type == "thought" {
            toolStart = nil
            if let start = thoughtStart {
              groups[start, default: []].append(index)
            } else {
              thoughtStart = index
              groups[index] = [index]
              visible.append(index)
            }
          } else if item.type == "tool_call", item.kind != "switch_mode" {
            thoughtStart = nil
            if let start = toolStart {
              groups[start, default: []].append(index)
            } else {
              toolStart = index
              groups[index] = [index]
              visible.append(index)
            }
          } else {
            toolStart = nil
            thoughtStart = nil
            visible.append(index)
          }
        }
      }
      var result: [ChatRow] = []
      var absorbed: Int?
      if entry.role == "assistant", !processOnly {
        let turn: ChatEntry?
        if let userTurnID = entry.userTurnId {
          // A reply may arrive before its input; never borrow a neighboring turn's clock.
          turn = entries.first { $0.role == "user" && $0.id == userTurnID }
        } else {
          turn = entries[..<entryIndex].last { $0.role == "user" }
        }
        let turnID = entry.userTurnId ?? turn?.id ?? entry.id
        let start = turnStartedAt[turnID] ?? turn.flatMap(ChatWorkDuration.startMilliseconds)
        if let duration = ChatWorkDuration.milliseconds(for: entry, now: now, startOverride: start) {
          var row = ChatRow(
            id: turnID + ":duration",
            entryID: entry.id,
            kind: "duration",
            text: ChatWorkDuration.title(duration, running: entry.isRunning),
            running: entry.isRunning,
            workDurationMs: duration
          )
          if folds {
            // "Worked for …" opens its folded work in place, below itself.
            row.actionable = true
            row.processStartID = "__work__"
            row.disclosed = expandedWork.contains(entry.id)
            // Only the collapsed whole-turn placeholder belongs to the duration row.
            // Expanded tool groups stay after their preceding prose and open their own calls.
            if !row.disclosed { absorbed = groups.keys.min() }
          } else if !entry.finished, entry.holdOpen != true, entry.executionId == nil,
                    let first = visible.first(where: { entry.items[$0].type != "subagent_task" }),
                    let indices = groups[first], entry.items[first].type != "thought" {
            let process = indices.map { entry.items[$0] }
            let tail = entry.items.indices.last {
              let item = entry.items[$0]
              return !item.hidesFromTranscript && !(item.type == "tool_call" && item.kind == "think")
            }
            let live = entry.isRunning && indices.last == tail
            row.detail = ChatProcessSummary.title(items: process, running: live)
            row.actionable = true
            row.processStartID = entry.items[first].itemId
            absorbed = first
          }
          result.append(row)
        }
      }
      for index in visible {
        if let indices = groups[index] {
          if index == absorbed { continue }
          let process = indices.map { entry.items[$0] }
          let needsPermission = process.contains { $0.permission?.pending == true }
          let tail = entry.items.indices.last {
            let item = entry.items[$0]
            return !item.hidesFromTranscript && !(item.type == "tool_call" && item.kind == "think")
          }
          let running = entry.isRunning && indices.last == tail
          let firstGroup = index == groups.keys.min()
          // Only a step waiting on the person flags the summary; a failed command needs no special
          // treatment (its own row says it failed).
          let attention = needsPermission
          var title = ChatProcessSummary.title(items: process, running: running)
          if !running, !folds, let duration = process.first?.processDurationMs {
            let summary = ChatProcessSummary.title(items: process, running: false, includesThought: false)
            title = ChatWorkDuration.title(duration, running: false)
            if !summary.isEmpty { title += " · " + summary }
          }
          let isThoughtGroup = process.allSatisfy { $0.type == "thought" } && !(folds && !expandedWork.contains(entry.id))
          var groupRow = ChatRow(id: entry.id + ":process" + (firstGroup ? "" : ":" + entry.items[index].itemId), entryID: entry.id, kind: "summary",
            text: title,
            symbol: ChatProcessSummary.mark(attention: attention),
            processStartID: isThoughtGroup ? "__thought__" : (folds && !expandedWork.contains(entry.id) ? "" : entry.items[index].itemId),
            actionable: true, running: running, attention: attention)
          groupRow.disclosed = isThoughtGroup && expandedThoughts.contains(groupRow.id)
          result.append(groupRow)
          if groupRow.disclosed {
            for item in process {
              result.append(ChatRow(id: entry.id + ":" + item.itemId, entryID: entry.id, kind: "thought",
                text: item.text ?? "", symbol: "brain", itemID: item.itemId,
                streaming: entry.isRunning && item.itemId == entry.textTailID))
            }
          }
          continue
        }
        let item = entry.items[index]
        if let operation = item.operation {
          result += operation.rows(entryID: entry.id, itemID: item.itemId)
          continue
        }
        if item.isImage {
          let images = item.type == "image" ? item.image.map { [$0] } ?? [] : item.images ?? []
          for (imageIndex, image) in images.enumerated() {
            result.append(ChatRow(id: entry.id + ":" + item.itemId + ":image:\(imageIndex)",
              entryID: entry.id, kind: "image", text: "", itemID: item.itemId, image: image))
          }
          continue
        }
        let attention = item.permission?.pending == true
        var row = ChatRow(id: entry.id + ":" + item.itemId, entryID: entry.id,
          kind: item.type, text: item.text ?? "", itemID: item.itemId,
          running: entry.isRunning && item.status == "in_progress", attention: attention,
          streaming: entry.isRunning && item.itemId == entry.textTailID)
        switch item.type {
        case "system_notice" where item.proposal != nil:
          row.kind = "proposal"
          row.proposal = item.proposal
          row.text = item.proposal?.headline ?? ""
          row.actionable = false
        case "system_notice" where item.isChatFailure:
          row.kind = "chat_failed"
          row.text = ChatFailure.title(item.meta)
          row.symbol = "exclamationmark.circle"
          row.attention = true
          row.errorMeta = item.meta
          row.actionable = false
        case "file":
          guard let file = item.file else { continue }
          row.file = file
          row.text = file.fileName
          row.symbol = "doc"
          row.actionable = true
        case "proposed_plan":
          row.text = item.markdown ?? ""
          row.streaming = item.status == "delta"
          row.planIsLatest = item.isLatest == true
          if row.planIsLatest {
            row.planPermissionItemID = entry.items.first {
              $0.type == "tool_call" && $0.kind == "switch_mode" && $0.permission?.pending == true
            }?.itemId ?? ""
          }
        case "text": break
        case "thought": row.symbol = "brain"
        case "tool_call":
          row.symbol = ["read": "doc.text.magnifyingglass", "search": "magnifyingglass", "edit": "square.and.pencil",
            "write": "square.and.pencil", "execute": "terminal", "bash": "terminal", "fetch": "globe"][item.kind ?? ""] ?? "wrench.and.screwdriver"
          row.text = item.title.flatMap { $0.isEmpty ? nil : $0 } ?? item.path ?? String(localized: "native.chat.transcript.tool", bundle: .lody)
          if item.permission?.pending == true { row.text = String.localizedStringWithFormat(String(localized: "native.chat.transcript.pending", bundle: .lody), String(describing: row.text)) }
          else if item.status == "failed" { row.text = String.localizedStringWithFormat(String(localized: "native.chat.transcript.failed", bundle: .lody), String(describing: row.text)) }
          row.actionable = item.hasDetail == true || item.permission?.pending == true
        case "plan":
          row.text = (item.entries ?? []).map { planPrefix($0.status) + $0.content }.joined(separator: "\n")
        case "subagent_task":
          row = ChatTranscript.subagentRow(entry: entry, item: item)
        default:
          row.text = item.title ?? String(localized: "native.chat.transcript.event", bundle: .lody)
          row.symbol = "info.circle"
        }
        if !row.text.isEmpty { result.append(row) }
      }
      if entry.role == "assistant", entry.finished, !processOnly {
        // The turn's output card: one row for its changed files (the task row joins it in
        // `hangSubagents`); the view folds its bounded file list beneath this row.
        let files = (entry.fileDiffs ?? []).filter { !$0.path.isEmpty }
        if !files.isEmpty {
          let add = files.reduce(0) { $0 + ($1.add ?? 0) }
          let del = files.reduce(0) { $0 + ($1.del ?? 0) }
          var header = ChatRow(
            id: entry.id + ":changes", entryID: entry.id, kind: "changesHeader",
            text: String.localizedStringWithFormat(String(localized: "native.chat.transcript.fileCount", bundle: .lody), files.count),
            actionable: true,
            fileDiff: ChatFileDiff(path: "", add: add, del: del, status: nil)
          )
          header.group = "only"
          result.append(header)
        }
        // Time follows the actions; model and reasoning remain in turn information.
        let finishedAt = ChatMetaTime.label(entry.endedAt, now: now)
        if !finishedAt.isEmpty || entry.items.contains(where: { $0.type == "text" || $0.isImage }) {
          result.append(ChatRow(id: entry.id + ":meta", entryID: entry.id, kind: "meta", text: finishedAt))
        }
      }
      return Self.stackImages(result)
    }
  }
}

extension ChatTranscript {
  /// Images of one turn that only tool work separates (an agent uploading several images, one
  /// image group, or repeated upload calls) become ONE fanned `imageStack` row instead of a long
  /// column of photos. The stack sits where its first image was; the process rows between its
  /// images follow it. Prose or any other row ends the stack. The stack's id derives from its
  /// first image, so it stays stable while later images join; a lone image keeps its `image` row.
  static func stackImages(_ rows: [ChatRow]) -> [ChatRow] {
    let transparent: Set<String> = ["summary", "tool_call", "thought"]
    var result: [ChatRow] = []
    var run: [ChatRow] = []
    var between: [ChatRow] = []
    func flush() {
      defer { run = []; between = [] }
      guard let first = run.first else { result += between; return }
      if run.count == 1 {
        result.append(first)
      } else {
        var row = ChatRow(id: first.id + ":stack", entryID: first.entryID, kind: "imageStack", text: "", itemID: first.itemID)
        row.stack = run.compactMap { image in
          image.image.map { ChatImagePreviewItem(id: image.id, image: $0, localURI: image.localImageURI) }
        }
        result.append(row)
      }
      result += between
    }
    for row in rows {
      let isImage = row.kind == "image" && row.image != nil
      if isImage, let first = run.first, first.entryID == row.entryID {
        run.append(row)
      } else if isImage {
        flush()
        run.append(row)
      } else if !run.isEmpty, transparent.contains(row.kind), row.entryID == run[0].entryID {
        between.append(row)
      } else {
        flush()
        result.append(row)
      }
    }
    flush()
    return result
  }

  /// Web `getFinalTextRunStart`: the answer is the final contiguous run of text before the
  /// never-folded tail (plans, attachments, failures, sub-tasks, plan approvals), not just the
  /// last text item. Empty when the turn ends in work.
  static func answerRun(_ items: [ChatItem]) -> [Int] {
    func neverFolded(_ item: ChatItem) -> Bool {
      item.type == "proposed_plan" || item.type == "plan" || item.isAttachment || item.isChatFailure
        || item.type == "subagent_task" || (item.type == "tool_call" && item.kind == "switch_mode")
    }
    func prose(_ item: ChatItem) -> Bool { item.type == "text" && !(item.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var index = items.count - 1
    while index >= 0 && neverFolded(items[index]) { index -= 1 }
    guard index >= 0, prose(items[index]) else { return [] }
    var start = index
    while start > 0 && items[start - 1].type == "text" { start -= 1 }
    return (start...index).filter { prose(items[$0]) }
  }

  /// Web's task panel, compact: ONE inset card row after the turn's answer ("Waiting on N tasks"
  /// while any runs, "N tasks" once settled; the newest running task's latest step as its detail).
  /// The tasks themselves live in the task sheet it opens (`TasksController`), never inline.
  /// Neutral: no attention mark on the card.
  static func hangSubagents(_ rows: [ChatRow]) -> [ChatRow] {
    let tasks = rows.filter { $0.kind == "subagent_task" }
    var result = rows.filter { $0.kind != "subagent_task" }
    guard let first = tasks.first else { return rows }
    let running = tasks.filter(\.running).count
    let background = tasks.allSatisfy { $0.subagent?.background == true }
    let key: String
    switch (running > 0, background) {
    case (true, true): key = "native.chat.tasks.waitingBackground"
    case (true, false): key = "native.chat.tasks.waiting"
    case (false, true): key = "native.chat.tasks.countBackground"
    case (false, false): key = "native.chat.tasks.count"
    }
    var header = ChatRow(
      id: first.entryID + ":tasks", entryID: first.entryID, kind: "tasksHeader",
      text: String.localizedStringWithFormat(String(localized: String.LocalizationValue(key), bundle: .lody), running > 0 ? running : tasks.count),
      actionable: true, running: running > 0
    )
    header.detail = tasks.last { $0.running && !($0.subagent?.detail ?? "").isEmpty }?.subagent?.detail ?? ""
    // The output card: tasks first, then the changed files row when the turn has one; the meta
    // line stays last.
    let files = result.firstIndex { $0.kind == "changesHeader" }
    header.group = files == nil ? "only" : "first"
    if let files { result[files].group = "last" }
    let anchor = files ?? result.firstIndex { $0.kind == "meta" } ?? result.endIndex
    result.insert(header, at: anchor)
    return result
  }

  fileprivate static func subagentRow(entry: ChatEntry, item: ChatItem) -> ChatRow {
    let actor = item.actor?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let description = item.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let tool = item.lastToolName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let summary = item.summary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let error = item.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let running = item.status == "in_progress" || item.status == "pending"
    var detail = ""
    if item.status == "in_progress", !tool.isEmpty {
      detail = String.localizedStringWithFormat(String(localized: "native.chat.subagent.runningTool", bundle: .lody), String(describing: tool))
    } else if item.status == "completed" {
      detail = summary
    } else if item.status == "failed" {
      detail = error
    }
    let card = ChatSubagentCard(
      actor: actor.isEmpty ? String(localized: "native.chat.transcript.subtask", bundle: .lody) : actor,
      description: description == actor ? "" : description,
      status: item.status ?? "pending",
      detail: detail,
      background: item.isBackgrounded == true
    )
    var row = ChatRow(
      id: entry.id + ":" + item.itemId,
      entryID: entry.id,
      kind: "subagent_task",
      text: [card.actor, card.description, detail].filter { !$0.isEmpty }.joined(separator: " · "),
      itemID: item.itemId,
      running: running,
      attention: item.status == "failed"
    )
    row.symbol = "point.3.connected.trianglepath.dotted"
    row.actionable = true
    row.subagent = card
    return row
  }
}

struct ChatSubagentCard: Equatable {
  var actor: String
  var description: String
  var status: String
  var detail: String
  var background: Bool
}

enum ChatProcessSummary {
  /// No pip for a process (the row's shine shows it is live); a mark only while a step waits on the
  /// person's permission.
  static func mark(attention: Bool) -> String {
    attention ? "exclamationmark.triangle.fill" : ""
  }

  static func title(items: [ChatItem], running: Bool, includesThought: Bool = true) -> String {
    var readPaths = Set<String>()
    var editPaths = Set<String>()
    var readWithout = 0
    var editWithout = 0
    var commands = 0
    var searches = 0
    var fetches = 0
    var others = 0
    var hasThought = false
    for item in items {
      if item.type == "thought" || item.kind == "think" {
        hasThought = true
        continue
      }
      guard item.type == "tool_call" else { continue }
      switch item.kind {
      case "execute", "bash":
        commands += 1
      case "read":
        if let path = item.path, !path.isEmpty { readPaths.insert(path) }
        else { readWithout += 1 }
      case "edit", "write", "delete", "move":
        if let path = item.path, !path.isEmpty { editPaths.insert(path) }
        else { editWithout += 1 }
      case "search":
        searches += 1
      case "fetch":
        fetches += 1
      default:
        others += 1
      }
    }
    var parts: [String] = []
    if hasThought && includesThought {
      parts.append(String(localized: String.LocalizationValue(running
          ? "native.chat.transcript.activity.thinking"
          : "native.chat.transcript.activity.thought"), bundle: .lody))
    }
    add(&parts, "native.chat.transcript.activity.commands", commands)
    add(&parts, "native.chat.transcript.activity.readFiles", readPaths.count + readWithout)
    add(&parts, "native.chat.transcript.activity.editedFiles", editPaths.count + editWithout)
    add(&parts, "native.chat.transcript.activity.searches", searches)
    add(&parts, "native.chat.transcript.activity.fetches", fetches)
    add(&parts, "native.chat.transcript.activity.tools", others)
    if parts.isEmpty && includesThought {
      return String(localized: "native.chat.transcript.status.done", bundle: .lody)
    }
    return parts.joined(separator: " · ")
  }

  private static func add(_ parts: inout [String], _ key: String, _ count: Int) {
    guard count > 0 else { return }
    parts.append(String.localizedStringWithFormat(String(localized: String.LocalizationValue(key), bundle: .lody), count))
  }
}


private func planPrefix(_ status: String?) -> String {
  switch status {
  case "completed": return "✓ "
  case "in_progress": return "› "
  default: return "○ "
  }
}

extension ChatPendingSend {
  static func hidingStatus(_ rows: [ChatRow], inFlight: Set<String>) -> [ChatRow] {
    guard !inFlight.isEmpty else { return rows }
    return rows.filter { row in
      switch row.kind {
      case "duration", "pending":
        return !inFlight.contains(row.entryID)
      default:
        return true
      }
    }
  }

  func rows(entries: [ChatEntry]) -> [ChatRow] {
    guard (queue != true || failed == true), !entries.contains(where: { $0.id == id && $0.isQueued }) else { return [] }
    var result: [ChatRow] = []
    if !entries.contains(where: { $0.id == id }) {
      let media = attachments.compactMap { attachment -> ChatMessageAttachment? in
        guard URL(string: attachment.uri)?.isFileURL == true else { return nil }
        let image = attachment.kind == "image"
          ? ChatImage(id: attachment.id, fileName: attachment.name, storageSessionId: nil, width: nil, height: nil)
          : nil
        return ChatMessageAttachment(id: attachment.id, fileName: attachment.name, image: image, localURI: attachment.uri)
      }
      if !media.isEmpty {
        result.append(ChatRow(id: id + ":user", entryID: id, kind: "attachments", text: status,
          running: failed != true && reconnect != true && !["accepted", "uploaded", "unknown"].contains(phase ?? ""),
          attachments: media, uploadProgress: uploadProgress ?? [:]))
      }
      let body = displayText ?? text
      if !body.isEmpty {
        result.append(ChatRow(id: id + (result.isEmpty ? ":user" : ":user-text"), entryID: id, kind: "user", text: body,
          references: displayText == nil ? [] : references ?? []))
      }
      // A local send in flight is the signed-in user's own turn; its first row carries the header.
      if !result.isEmpty {
        result[0].author = ChatAuthors.unknownSender
        result[0].authorTime = ChatAuthors.time(Date().ISO8601Format())
        result[0].readState = "sending"
      }
    }
    if failed == true {
      result.append(ChatRow(id: id + ":pending", entryID: id, kind: "pending", text: status,
        actionable: true, attention: true))
      return result
    }
    var precedingUserID: String?
    let hasReply = entries.contains { entry in
      if entry.role == "user" { precedingUserID = entry.id }
      return entry.role == "assistant" && (entry.userTurnId ?? precedingUserID) == id
    }
    let hasDelivery = entries.contains { $0.id == id && $0.delivery != nil }
    let acknowledged = phase == "accepted"
    if !hasReply && !acknowledged && !hasDelivery {
      let delivery = status.isEmpty ? String(localized: "send.status.awaitingConnection", bundle: .lody) : status
      let label = phase == "unknown" ? delivery + " · " + String(localized: "send.forget.hint", bundle: .lody) : delivery
      result.insert(ChatRow(id: id + ":delivery", entryID: id, kind: "delivery", text: label,
        actionable: phase == "unknown", attention: phase == "unknown"), at: 0)
    }
    if !hasReply && acknowledged && !hasDelivery {
      let now = Date().timeIntervalSince1970 * 1000
      let start = startedAt.flatMap { $0.isFinite && $0 <= now ? $0 : nil } ?? now
      let duration = Int(now - start)
      result.append(ChatRow(
        id: id + ":duration",
        entryID: id,
        kind: "duration",
        text: ChatWorkDuration.title(duration, running: true),
        running: true,
        workDurationMs: duration
      ))
    }
    return result
  }
}

// Unknown reasons retain their payload in the detail page and use a localized fallback.
enum ChatFailure {
  static func title(_ meta: ChatItem.NoticeMeta?) -> String {
    if meta?.code == "git_executable_not_found" {
      return String(localized: "native.chat.error.git_executable_not_found", bundle: .lody)
    }
    let known: Set<String> = ["unknown", "session_archived", "agent_type_mismatch", "session_init_failed", "session_restore_failed", "session_not_found", "memory_pressure", "acp_not_ready", "agent_disconnected", "agent_no_output", "turn_pre_prompt_failed", "message_delivery_failed", "machine_access_denied", "acp_auth_required", "acp_internal_error", "acp_upstream_api_error", "acp_provider_overloaded", "acp_session_storage_incompatible", "acp_resource_not_found", "acp_request_cancelled", "acp_method_not_found", "acp_invalid_params", "acp_invalid_request", "acp_parse_error", "acp_unknown_error"]
    let reason = meta?.reason ?? "unknown"
    return String(localized: String.LocalizationValue("native.chat.error." + (known.contains(reason) ? reason : "unknown")), bundle: .lody)
  }
}


struct ChatErrorRetryState: Decodable, Equatable {
  let entryId: String
  let itemId: String
  let enabled: Bool
  let pending: Bool
  let visible: Bool
  let message: String
}

extension ChatFailure {
  static func hasDetail(_ meta: ChatItem.NoticeMeta?) -> Bool {
    [meta?.message, meta?.code].contains { !($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  }
  static func summary(_ meta: ChatItem.NoticeMeta?) -> String {
    if meta?.code == "git_executable_not_found" { return String(localized: "native.chat.error.gitSummary", bundle: .lody) }
    let descriptions = ["acp_provider_overloaded": "capacitySummary", "acp_auth_required": "authSummary", "machine_access_denied": "accessSummary"]
    if let key = descriptions[meta?.reason ?? ""] { return String(localized: String.LocalizationValue("native.chat.error." + key), bundle: .lody) }
    let message = (meta?.message ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if message.isEmpty || message.hasPrefix("{") || message.hasPrefix("[") { return String(localized: "native.chat.error.summary", bundle: .lody) }
    return String(message.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ").prefix(260))
  }
}

struct ChatPlanDecisionState: Decodable, Equatable {
  let entryId: String
  let itemId: String
  let enabled: Bool
  let pending: Bool
  let message: String
}

struct ChatOperationPeer: Equatable {
  var card: ChatOperationCard
  var text: String
  var detail: String
  var actionable: Bool
  var cliType: String?
  var agentType: String?
  var current = false
}

enum ChatOperationGrouping {
  /// Group only adjacent receipts in the same turn; never cross a notice or reorder history.
  static func rows(_ rows: [ChatRow], roots: [String: String], opened: Set<String>) -> [ChatRow] {
    var result: [ChatRow] = []
    var index = 0
    while index < rows.count {
      var row = rows[index]
      guard let card = row.operation else { result.append(row); index += 1; continue }
      let root = roots[card.sessionId] ?? card.sessionId
      var group = [row]
      index += 1
      while index < rows.count, let next = rows[index].operation,
        rows[index].entryID == row.entryID, (roots[next.sessionId] ?? next.sessionId) == root {
        group.append(rows[index]); index += 1
      }
      row.treeChild = group.contains { $0.operation?.sessionId == root } && opened.contains(root)
      if group.count > 1 {
        row.operationPeers = group.compactMap { member in
          guard let card = member.operation else { return nil }
          return ChatOperationPeer(card: card, text: member.text, detail: member.detail, actionable: member.actionable,
            cliType: member.operationCLIType, agentType: member.operationAgentType, current: member.operationCurrent)
        }
      }
      result.append(row)
    }
    for index in result.indices where result[index].operation != nil {
      result[index].treeLast = index + 1 == result.count || !result[index + 1].treeChild || result[index + 1].entryID != result[index].entryID
    }
    return result
  }
}

/// web `AgentRoleProposalMeta` / `ScheduleProposalMeta` as the runtime presents them.
struct ChatProposal: Decodable, Equatable {
  struct Fields: Decodable, Equatable {
    var name: String? = nil
    var description: String? = nil
    var promptPrefix: String? = nil
  }
  let kind: String
  var action: String? = nil
  var roleId: String? = nil
  var requesterUserId: String? = nil
  var fields: Fields? = nil
  var before: Fields? = nil
  var outcome: String? = nil
  var proposalId: String? = nil
  var title: String? = nil
  var prompt: String? = nil
  var rule: RuntimeContract.ScheduleRule? = nil
  var destination: String? = nil
  var scheduleId: String? = nil

  var isRole: Bool { kind == "agent_role" }
  var decided: Bool { outcome != nil }

  /// The card's heading: the question while open, the receipt once decided.
  var headline: String {
    let key: String
    switch (kind, outcome, action) {
    case (_, "dismissed"?, _): key = "native.chat.proposal.dismissed"
    case ("agent_role", "saved"?, _): key = "native.chat.proposal.role.saved"
    case ("agent_role", _, "update"?): key = "native.chat.proposal.role.update"
    case ("agent_role", _, _): key = "native.chat.proposal.role.create"
    case (_, "created"?, _): key = "native.chat.proposal.schedule.created"
    default: key = "native.chat.proposal.schedule.title"
    }
    return String(localized: String.LocalizationValue(key), bundle: .lody)
  }
}

/// A decision in flight or its failure, kept by the chat view per proposal row.
struct ChatProposalState: Equatable {
  var pending = false
  var message = ""
}
