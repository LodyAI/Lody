import Foundation

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
