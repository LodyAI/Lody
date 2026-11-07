import LodyCore
import UIKit

extension DataRuntime {
  func handle(_ id: String, _ request: RuntimeContract.HostRequest) {
    switch request {
    case .grant:
      grantWaiters.append(id)
      fetchGrant()
    case .shortcutCloud(let params): shortcutCloud(id, params)
    case .githubMentions(let params): githubMentions(id, params)
    case .shareRequest(let params): shareRequest(id, params)
    }
  }
  private func shortcutCloud(_ id: String, _ params: RuntimeContract.ShortcutCloudParams) {
    typealias Call = RuntimeContract.HostCalls.ShortcutCloud
    guard let channel, githubTasks[id] == nil else { return }
    guard let workspace, let body = try? RuntimeJSON.object(params), body["workspaceId"] as? String == workspace,
          let operation = body["operation"] as? String, let args = body["args"] as? [String: Any],
          githubTasks.count < 8 else {
      channel.fail(id: id, method: Call.method, code: "shortcut_unavailable"); return
    }
    let user = userId
    githubTasks[id] = Task { [weak self] in
      var value: RuntimeContract.JSONValue?
      if let result = try? await PromptShortcutCloud.call(operation: operation, workspace: workspace, args: args) {
        value = try? RuntimeJSON.decode(RuntimeContract.JSONValue.self, from: result)
      }
      guard !Task.isCancelled, let self, self.channel === channel else { return }
      self.githubTasks.removeValue(forKey: id)
      if let value, self.workspace == workspace, self.userId == user { channel.reply(Call.self, id: id, .init(value: value)) }
      else { channel.fail(id: id, method: Call.method, code: "shortcut_unavailable") }
    }
  }
  private func githubMentions(_ id: String, _ params: RuntimeContract.GitHubMentionsParams) {
    typealias Call = RuntimeContract.HostCalls.GithubMentions
    guard let channel, githubTasks[id] == nil else { return }
    guard let workspace, params.workspaceId == workspace, githubTasks.count < 4 else {
      channel.fail(id: id, method: Call.method, code: "github_mentions_unavailable"); return
    }
    githubTasks[id] = Task { [weak self] in
      var catalog: RuntimeContract.GitHubMentionsResult?
      if let result = try? await GitHubMentions.load(workspace: workspace, repo: params.repoFullName) {
        catalog = try? RuntimeJSON.decode(RuntimeContract.GitHubMentionsResult.self, from: result)
      }
      guard !Task.isCancelled, let self, self.channel === channel else { return }
      self.githubTasks.removeValue(forKey: id)
      if let catalog, self.workspace == workspace { channel.reply(Call.self, id: id, catalog) }
      else { channel.fail(id: id, method: Call.method, code: "github_mentions_unavailable") }
    }
  }
  private func shareRequest(_ id: String, _ params: RuntimeContract.ShareRequestParams) {
    typealias Call = RuntimeContract.HostCalls.ShareRequest
    guard let channel, shareTasks[id] == nil else { return }
    guard let workspace, let body = try? RuntimeJSON.object(params), body["workspaceId"] as? String == workspace,
          let operation = body["operation"] as? String, let args = body["args"] as? [String: Any],
          shareTasks.count < 4 else {
      channel.fail(id: id, method: Call.method, code: "share_request_failed"); return
    }
    let user = userId
    shareTasks[id] = Task { [weak self] in
      var value: RuntimeContract.JSONValue?
      if let result = try? await SessionSharing.run(operation, args: args, workspace: workspace, userId: user, useLink: { action, url in
        if action == "copy" {
          UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: url.absoluteString]], options: [.localOnly: true])
        } else if action == "open" {
          guard await UIApplication.shared.open(url) else { throw SessionSharing.ManagementFailure(code: "shares_link_failed") }
        }
      }) {
        value = try? RuntimeJSON.decode(RuntimeContract.JSONValue.self, from: result)
      }
      guard !Task.isCancelled, let self, self.channel === channel else { return }
      self.shareTasks.removeValue(forKey: id)
      if let value, self.workspace == workspace, self.userId == user { channel.reply(Call.self, id: id, .init(value: value)) }
      else { channel.fail(id: id, method: Call.method, code: "share_request_failed") }
    }
  }
  private func fetchGrant() {
    guard grantTask == nil else { return }
    guard let workspace, let view = webView else { deliverGrant(nil); return }
    do {
      guard let token = try AuthKeychain.read() else { throw NSError(domain: "MissingAuth", code: 1) }
      var request = URLRequest(url: URL(string: "https://backend.lody.ai/api/loro-streams/token")!, timeoutInterval: 15)
      request.httpMethod = "POST"
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: ["workspaceId": workspace])
      grantTask = URLSession.shared.dataTask(with: request) { [weak self, weak view] data, response, error in
        DispatchQueue.main.async {
          guard let self, let view, self.webView === view else { return }
          self.grantTask = nil
          var grant: RuntimeContract.Grant?
          if error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let data,
             let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
             let token = value["token"] as? String, !token.isEmpty,
             let address = value["gatewayBaseUrl"] as? String,
             let url = URL(string: address), url.scheme == "https", url.user == nil, url.password == nil,
             let expiry = value["expiresIn"] as? Double, expiry > 0 {
            grant = .init(token: token, gatewayBaseUrl: address, expiresIn: expiry, shardHostSuffix: value["shardHostSuffix"] as? String)
          }
          self.deliverGrant(grant)
        }
      }
      grantTask?.resume()
    } catch { deliverGrant(nil) }
  }
  private func deliverGrant(_ grant: RuntimeContract.Grant?) {
    guard let channel else { return }
    let waiters = grantWaiters
    grantWaiters.removeAll()
    for id in waiters {
      if let grant { channel.reply(RuntimeContract.HostCalls.Grant.self, id: id, grant) }
      else { channel.fail(id: id, method: RuntimeContract.HostCalls.Grant.method, code: "grant_failed", retryable: true) }
    }
  }
}
