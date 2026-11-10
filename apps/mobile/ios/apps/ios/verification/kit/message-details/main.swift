import Foundation
import UIKit

func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T { try! JSONDecoder().decode(type, from: Data(json.utf8)) }
let input = decode(ChatTurnInput.self, """
{"modeId":"plan","configOptionValues":{"effort":"low","fast":false,"api_token":"hidden","custom_mode":"on","model":"duplicate","invalid":42}}
""")
let usage = decode(ChatTurnUsage.self, """
{"inputTokens":1234,"outputTokens":6640,"reasoningOutputTokens":2000,"cacheReadInputTokens":120000,"cacheCreationInputTokens":4096}
""")
let sections = MessageDetailsSections.make(model: "id-only", reasoning: "High", input: input, usage: usage)
let rows = sections.flatMap(\.rows)
@MainActor func row(_ id: String) -> LodyListRow { rows.first { $0.id == id }! }
precondition(row("model").subtitle == "id-only" && row("model").wrapSubtitle)
precondition(row("reasoning").value == "High")
precondition(rows.filter { $0.id == "reasoning" }.count == 1)
precondition(row("fast").value == String(localized: "message.details.off", bundle: .lody))
precondition(row("plan").value == String(localized: "message.details.on", bundle: .lody))
precondition(row("output").value == "8,640")
precondition(row("cacheRead").value == "120,000")
precondition(input.options["api_token"] == nil && input.options["invalid"] == nil)
precondition(MessageDetailsSections.make(model: nil, reasoning: nil, input: nil, usage: nil).isEmpty)
for invalid in [-1, 1.5, true, "100", 9_007_199_254_740_992.0, NSNull()] as [Any] {
  var raw: [String: Any] = usage.values!
  raw["inputTokens"] = invalid
  let data = try! JSONSerialization.data(withJSONObject: raw)
  precondition(try! JSONDecoder().decode(ChatTurnUsage.self, from: data).values == nil)
}
precondition(decode(ChatTurnUsage.self, "{}").values == nil)
precondition(decode(ChatTurnUsage.self, "false").values == nil)
let zeros = decode(ChatTurnUsage.self, """
{"inputTokens":0,"outputTokens":0,"reasoningOutputTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}
""")
let zeroRows = MessageDetailsSections.make(model: nil, reasoning: nil, input: nil, usage: zeros).flatMap(\.rows)
precondition(zeroRows.first { $0.id == "input" }?.value == "0")
precondition(!zeroRows.contains { $0.id == "reasoningTokens" })
print("PASS: metadata precedence, exact usage, missing/invalid usage, zero usage and configuration filtering")

// Context is a session occupancy measurement, never the turn's billable token sum.
let sessionUsage = decode(ChatSessionUsage.self, """
{"context":{"used":84000,"size":200000},"modelLabel":" Claude Sonnet ","quota":{"windows":[{"usedPercent":63,"duration":18000,"resetsAt":1800000000},{"label":"All models","usedPercent":21,"duration":604800,"resetsAt":1800003600}]}}
""")
precondition(sessionUsage.visible && sessionUsage.percentage == 42)
precondition(sessionUsage.title == "Claude Sonnet")
precondition(sessionUsage.windows.map(\.percentage) == [21, 63])
precondition(ChatSessionUsage.label(sessionUsage.windows[0]).contains("All models"))
precondition(decode(ChatSessionUsage.self, "{}").visible == false)
precondition(decode(ChatSessionUsage.self, "{\"context\":{\"used\":50,\"size\":0}}").visible == false)
precondition(decode(ChatSessionUsage.self, "{\"context\":{\"used\":250,\"size\":200}}").percentage == 100)
precondition(decode(ChatSessionUsage.self, "{\"context\":{\"used\":-1,\"size\":200}}").percentage == 0)
precondition(decode(ChatSessionUsage.self, "{\"isContextCompacting\":true}").visible)
var quotaOnly = sessionUsage
quotaOnly.context = nil
precondition(!quotaOnly.visible)
quotaOnly.quotaEligible = true
precondition(quotaOnly.percentage == 63) // Five-hour trigger, longest window first in popup.
let now = Date(timeIntervalSince1970: 1_799_996_400)
var reset = ChatUsageReset()
let relative = reset.value(epoch: 1_800_000_000, now: now, locale: Locale(identifier: "en_US"), timeZone: TimeZone(secondsFromGMT: 0)!)
precondition(relative.contains("in 1 hour"))
reset.toggle()
let absolute = reset.value(epoch: 1_800_000_000, now: now, locale: Locale(identifier: "en_US"), timeZone: TimeZone(secondsFromGMT: 0)!)
precondition(absolute != relative && absolute.contains("2027"))
reset.toggle()
precondition(reset.value(epoch: 1_800_000_000, now: now, locale: Locale(identifier: "en_US")) == relative)
precondition(reset.value(epoch: 1_799_992_800, now: now, locale: Locale(identifier: "en_US")).contains("1 hour ago"))
print("PASS: session context occupancy, hidden unknown usage, window order, quota-only gating and reversible reset time")

let usagePanel = ChatUsagePanel(usage: sessionUsage, now: { now })
usagePanel.loadViewIfNeeded()
@MainActor func descendants(_ view: UIView) -> [UIView] { view.subviews.flatMap { [$0] + descendants($0) } }
let controls = descendants(usagePanel.view).compactMap { $0 as? UIButton }
precondition(controls.count == 2)
let toggle = controls[1]
let independentValue = controls[0].accessibilityValue
let relativeValue = toggle.accessibilityValue
precondition(relativeValue == ChatUsageReset().value(epoch: 1_800_000_000, now: now))
toggle.sendActions(for: .touchUpInside)
precondition(toggle.accessibilityValue != relativeValue)
precondition(controls[0].accessibilityValue == independentValue)
toggle.sendActions(for: .touchUpInside)
precondition(toggle.accessibilityValue == relativeValue)
precondition(usagePanel.preferredContentSize.height > 0)
print("PASS: production popup reset button updates date and toggles back")
