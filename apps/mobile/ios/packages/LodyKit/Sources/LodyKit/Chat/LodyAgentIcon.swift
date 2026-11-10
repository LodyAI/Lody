import Foundation

/// Agent provider marks (`lody-agent-<name>` in AgentIcons.xcassets, imported from web's
/// `agent-icon.tsx` assets; Android converts the same SVGs, `android/scripts/agent-icons.mjs`).
enum LodyAgentIcon {
  /// A provider's mark: its asset, a terminal for custom commands, or the generic assistant.
  enum Mark: Equatable {
    case asset(String)
    case terminal
    case generic
  }

  /// Every asset in the catalog, by `<name>`; keep in step with AgentIcons.xcassets.
  private static let assets: Set<String> = [
    "agoragentic-acp", "amp-acp", "antigravity-acp", "auggie", "autohand", "bob", "bub", "claude", "cline",
    "codebuddy-code", "codex", "cortex-code", "corust-agent", "crow-cli", "cursor", "deepagents", "deepseek",
    "devin", "dimcode", "factory-droid", "fast-agent", "gemini", "github-copilot-cli", "glm-acp-agent", "glm",
    "goose", "grok", "harn", "junie", "kilo", "kimchi", "kimi", "mimo", "minimax-code", "minimax", "minion-code",
    "mistral-vibe", "nova", "openai", "opencode-v2", "opencode", "pi-acp", "poolside", "qoder", "qwen-code",
    "reasonix", "sigit", "stakpak",
  ]
  /// Agent types whose mark has another name (web `AgentIcon`'s special cases).
  private static let agentAliases: [String: String] = [
    "claude-p": "claude", "claude-code": "claude", "kimi-code": "kimi", "grok-build": "grok", "pi": "pi-acp",
  ]
  /// Brand words in model ids / names → mark.
  private static let modelKinds: Set<String> = [
    "claude", "codex", "kimi", "grok", "deepseek", "minimax", "glm", "mimo", "opencode", "gemini", "openai",
  ]
  private static let aliases: [String: String] = [
    "claude-p": "claude",
    "kimi-code": "kimi",
    "anthropic": "claude",
    "sonnet": "claude",
    "opus": "claude",
    "haiku": "claude",
    "chatgpt": "openai",
    "gpt": "openai",
    "o1": "openai",
    "o3": "openai",
    "o4": "openai",
    "xai": "grok",
    "gemma": "gemini",
    "moonshot": "kimi",
    "zhipu": "glm",
    "chatglm": "glm",
  ]

  /// Web `AgentIcon`: the provider of an agent config / session by its cliType and agentType.
  static func mark(cliType: String?, agentType: String?) -> Mark {
    if cliType == "custom" { return .terminal }
    let type = (agentType ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let name = agentAliases[type] ?? type
    return assets.contains(name) ? .asset("lody-agent-\(name)") : .generic
  }

  /// The mark's asset, nil for terminal and generic marks.
  static func asset(cliType: String?, agentType: String?) -> String? {
    if case .asset(let name) = mark(cliType: cliType, agentType: agentType) { return name }
    return nil
  }

  /// A model's brand from its id or display name ("claude-opus-4", "GPT-5"); nil when unknown.
  static func asset(modelId: String?, name: String?) -> String? {
    for raw in [modelId, name] {
      guard let raw else { continue }
      let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      if value.isEmpty { continue }
      if let asset = asset(for: value) { return asset }
      for token in value.split(whereSeparator: { !$0.isLetter && !$0.isNumber }) {
        if let asset = asset(for: String(token)) { return asset }
      }
    }
    return nil
  }

  private static func asset(for kind: String) -> String? {
    let canonical = aliases[kind] ?? kind
    return modelKinds.contains(canonical) ? "lody-agent-\(canonical)" : nil
  }
}
