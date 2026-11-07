import Foundation

// The view and native behavior checks use the same projection.
enum MessageDetailsSections {
  static func make(model: String?, reasoning: String?, input: ChatTurnInput?, usage: ChatTurnUsage?) -> [LodyListSection] {
    var rows: [LodyListRow] = []
    func add(_ id: String, _ value: String?, title: String? = nil) {
      guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            !rows.contains(where: { $0.id == id }) else { return }
      var row = LodyListRow()
      row.id = id; row.title = title ?? text(id); row.value = value
      rows.append(row)
    }
    if let model, !model.isEmpty {
      var row = LodyListRow()
      row.id = "model"; row.title = text("model"); row.subtitle = model; row.wrapSubtitle = true
      rows.append(row)
    }
    add("reasoning", reasoning)
    if let mode = input?.modeId { add("mode", humanize(mode)) }
    let aliases = ["effort": "reasoning", "reasoning_effort": "reasoning", "thought_level": "reasoning",
                   "fast": "fast", "fast-mode": "fast", "plan_mode": "plan", "collaboration_mode": "plan"]
    for (key, raw) in (input?.options ?? [:]).sorted(by: { $0.key < $1.key }) {
      if key == "model" || key.hasSuffix("/model") { continue }
      let alias = aliases[key]
      var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if ["true", "on"].contains(value.lowercased()) { value = text("on") }
      if ["false", "off"].contains(value.lowercased()) { value = text("off") }
      add(alias ?? "config:\(key)", value, title: alias.map(text) ?? humanize(key))
    }
    if input?.modeId == "plan" { add("plan", text("on")) }
    var sections: [LodyListSection] = []
    if !rows.isEmpty { sections.append(section("configuration", rows: rows)) }
    if let values = usage?.values {
      rows = []
      let formatter = NumberFormatter()
      formatter.locale = LodyFormat.locale
      formatter.numberStyle = .decimal
      func number(_ value: Double) -> String { formatter.string(from: NSNumber(value: value))! }
      add("input", number(values["inputTokens"]!))
      add("output", number(values["outputTokens"]! + values["reasoningOutputTokens"]!))
      if values["reasoningOutputTokens"]! > 0 { add("reasoningTokens", number(values["reasoningOutputTokens"]!)) }
      add("cacheRead", number(values["cacheReadInputTokens"]!))
      add("cacheWrite", number(values["cacheCreationInputTokens"]!))
      sections.append(section("tokens", rows: rows, footer: text("explanation")))
    }
    return sections
  }

  private static func section(_ id: String, rows: [LodyListRow], footer: String = "") -> LodyListSection {
    var section = LodyListSection()
    section.id = id; section.header = text(id); section.rows = rows; section.footer = footer
    return section
  }
  private static func humanize(_ value: String) -> String {
    let spaced = value.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
      .replacingOccurrences(of: "[_/-]+", with: " ", options: .regularExpression)
    return spaced.prefix(1).uppercased() + spaced.dropFirst()
  }
  private static func text(_ key: String) -> String { String(localized: String.LocalizationValue("message.details." + key), bundle: .lody) }
}
