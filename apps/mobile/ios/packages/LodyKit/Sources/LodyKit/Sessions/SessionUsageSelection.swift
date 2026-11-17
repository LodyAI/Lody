import Foundation

/// Mirrors web resolveAgentRateLimitForModel; never substitute another configured account.
enum SessionUsageSelection {
  static func quota(_ usage: AgentUsage?, configId: String?, provider: String, model: String?) -> AgentQuota? {
    guard let usage, let config = usage.configs.first(where: { $0.id == configId }),
          config.provider == provider, config.eligible, config.rateLimitsAvailable == true else { return nil }
    let entries = usage.quotas.filter { $0.provider == provider && $0.agentConfigId == configId }
    let model = normalize(model)
    if !model.isEmpty {
      let named = entries.filter {
        let name = normalize($0.name)
        return !name.isEmpty && (name == model || (name.count >= 4 && model.contains(name)) || (model.count >= 4 && name.contains(model)))
      }.sorted { normalize($0.name).count > normalize($1.name).count }
      if let match = named.first { return match }
      if let match = entries.first(where: { normalize($0.id) == model }) { return match }
      if provider == "codex", model.contains("spark") {
        return entries.first { $0.id == "codex_bengalfox" || normalize($0.name).contains("spark") }
      }
    }
    if let generic = entries.first(where: { $0.id.isEmpty || $0.id == provider }) { return generic }
    return model.isEmpty ? entries.first : nil
  }
  private static func normalize(_ value: String?) -> String {
    (value ?? "").lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "", options: .regularExpression)
  }
}
