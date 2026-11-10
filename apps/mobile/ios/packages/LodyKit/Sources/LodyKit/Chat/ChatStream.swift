import ChatKitCore
import Foundation

/// Presentation-only pacing, driven by elapsed time and input pressure.
/// Network history remains authoritative, including corrections and completion.
struct ChatStream {
  private struct ID: Hashable { let entry: String; let item: String }
  private var reveals: [ID: CKTextReveal] = [:]
  private var processTimes: [ID: (start: Double, end: Double?)] = [:]
  private var targets: [ChatEntry] = []
  private var initialized = false
  private var settling: Set<String> = []
  var hasPending: Bool { !settling.isEmpty || reveals.values.contains { $0.hasPending } }

  /// Keep offscreen Markdown geometry, but never hide permission/error/tool updates.
  static func deferringMarkdown(_ projected: [ChatRow], previous: [ChatRow]) -> [ChatRow] {
    let latest = Dictionary(projected.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    let ids = Set(previous.map(\.id))
    let retained = previous.compactMap { row -> ChatRow? in
      if row.kind == "text" || row.kind == "thought" { return row }
      return latest[row.id]
    }
    return retained + projected.filter { !ids.contains($0.id) && $0.kind != "text" && $0.kind != "thought" }
  }

  static func commitInterval(tailLength: Int) -> Double {
    min(0.096, 0.048 * (1 + Double(tailLength) / 256))
  }

  mutating func receive(_ entries: [ChatEntry], animate: Bool, deferredEntries: Set<String> = [], initialSnapshot: Bool = false, at time: Double = ProcessInfo.processInfo.systemUptime) {
    receiveProcessTimes(entries, at: time)
    let wasRunning = Set(targets.filter(\.isRunning).map(\.id))
    var retained: Set<ID> = []
    for entry in entries where entry.role != "user" {
      let tailID = entry.textTailID
      for item in entry.items where item.type == "text" || item.type == "thought" {
        let id = ID(entry: entry.id, item: item.itemId)
        retained.insert(id)
        var reveal = reveals[id] ?? CKTextReveal()
        let shouldAnimate = !initialSnapshot && initialized && animate && item.itemId == tailID && !deferredEntries.contains(entry.id) && entry.role == "assistant" && (entry.isRunning || wasRunning.contains(entry.id) || reveal.hasPending)
        reveal.receive(item.text ?? "", animate: shouldAnimate, at: time)
        reveals[id] = reveal
      }
    }
    reveals = reveals.filter { retained.contains($0.key) }
    targets = entries
    settling.formIntersection(entries.map(\.id))
    if !animate || initialSnapshot { settling.removeAll() }
    initialized = initialized || !entries.isEmpty || !animate || initialSnapshot
  }

  private mutating func receiveProcessTimes(_ entries: [ChatEntry], at time: Double) {
    var retained = Set<ID>()
    for entry in entries where entry.role == "assistant" {
      var start: ID?
      for item in entry.items {
        if item.hidesFromTranscript { continue }
        if item.type == "system_notice" && (item.name == nil || item.name == "agent_warning") { continue }
        if item.isProcess {
          if start == nil { start = ID(entry: entry.id, item: item.itemId) }
        } else if let id = start {
          retained.insert(id)
          if processTimes[id]?.end == nil { processTimes[id]?.end = time }
          start = nil
        }
      }
      if let id = start {
        retained.insert(id)
        if entry.isRunning {
          // shortcut: time observed live segments only, use persisted timing when the protocol provides it.
          if processTimes[id] == nil { processTimes[id] = (time, nil) }
        } else if processTimes[id]?.end == nil {
          processTimes[id]?.end = time
        }
      }
    }
    processTimes = processTimes.filter { retained.contains($0.key) }
  }

  mutating func advance(at time: Double = ProcessInfo.processInfo.systemUptime, animatingEntries: Set<String> = []) {
    let completed = Set(targets.filter { !$0.isRunning }.map(\.id))
    settling = animatingEntries.intersection(completed)
    for id in reveals.keys {
      let before = reveals[id]?.shown
      reveals[id]?.advance(at: time)
      // Let the final commit reach the renderer before asking whether it faded.
      if completed.contains(id.entry), before != reveals[id]?.shown { settling.insert(id.entry) }
    }
  }

  mutating func finish(entries: Set<String>? = nil) {
    if let entries { settling.subtract(entries) }
    else { settling.removeAll() }
    for id in reveals.keys where entries?.contains(id.entry) ?? true { reveals[id]?.finish() }
  }

  var presentation: [ChatEntry] {
    targets.map { target in
      var entry = target
      for index in entry.items.indices {
        let id = ID(entry: entry.id, item: entry.items[index].itemId)
        if let timing = processTimes[id], let end = timing.end {
          entry.items[index].processDurationMs = Int(max(0, end - timing.start) * 1000)
        }
        guard let reveal = reveals[id] else { continue }
        entry.items[index].text = reveal.shown
        // Completion folding waits for the visible tail, never the network ACK.
        if reveal.hasPending || settling.contains(entry.id) { entry.finished = false }
      }
      return entry
    }
  }
}

enum ChatScroll {
  static let resumeDistance: Double = 80

  // Time-based convergence keeps a moving destination continuous across updates
  // and behaves the same at 60 and 120 Hz. Snap only a subpixel remainder.
  static func advance(_ current: Double, toward target: Double, elapsed: Double, response: Double, minimumStep: Double = 0) -> Double {
    let next = current + (target - current) * (1 - exp(-max(0, elapsed) / response))
    // UIScrollView rounds offsets to its pixel grid. A step smaller than one
    // pixel can otherwise round back forever while the display link keeps firing.
    if elapsed > 0 && abs(next - current) < minimumStep { return target }
    return abs(target - next) <= 0.5 ? target : next
  }

  static func bottom(contentHeight: Double, viewportHeight: Double, topInset: Double, bottomInset: Double) -> Double {
    max(-topInset, contentHeight - viewportHeight + bottomInset)
  }
}
