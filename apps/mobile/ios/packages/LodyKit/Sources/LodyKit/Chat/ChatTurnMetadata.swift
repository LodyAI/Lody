import Foundation

// Optional metadata comes from peer history. Invalid usage is absent, never zero.
struct ChatTurnUsage: Decodable {
  let values: [String: Double]?
  private enum Key: String, CodingKey, CaseIterable {
    case inputTokens, outputTokens, reasoningOutputTokens, cacheReadInputTokens, cacheCreationInputTokens
  }

  init(from decoder: Decoder) throws {
    guard let container = try? decoder.container(keyedBy: Key.self) else { values = nil; return }
    var raw: [String: Double] = [:]
    for key in Key.allCases {
      guard let value = try? container.decode(Double.self, forKey: key),
            value >= 0, value <= 9_007_199_254_740_991, value.rounded() == value else { values = nil; return }
      raw[key.rawValue] = value
    }
    values = raw
  }
}

struct ChatTurnInput: Decodable {
  let modeId: String?
  let options: [String: String]

  private enum Keys: String, CodingKey { case modeId, configOptionValues }
  private struct Option: Decodable {
    let value: String?
    init(from decoder: Decoder) throws {
      let container = try decoder.singleValueContainer()
      if let boolean = try? container.decode(Bool.self) { value = String(boolean) }
      else { value = try? container.decode(String.self) }
    }
  }

  init(from decoder: Decoder) throws {
    let container = try? decoder.container(keyedBy: Keys.self)
    modeId = (try? container?.decode(String.self, forKey: .modeId))?.trimmingCharacters(in: .whitespacesAndNewlines)
    let raw = (try? container?.decode([String: Option].self, forKey: .configOptionValues)) ?? [:]
    options = raw.reduce(into: [:]) { result, pair in
      let (key, option) = pair
      guard key.count <= 160, key.range(of: "secret|token|password|credential", options: [.regularExpression, .caseInsensitive]) == nil,
            let value = option.value, value.count <= 512 else { return }
      result[key] = value
    }
  }
}
