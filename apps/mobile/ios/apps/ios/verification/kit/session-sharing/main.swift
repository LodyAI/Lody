import Foundation
import os

enum AuthKeychain { static func read() throws -> String? { "synthetic-app-credential" } }
enum SessionAttachments {
  static func imageDownloadURL(workspace: String, session: String, imageId: String) -> URL {
    URL(string: "https://api.lody.ai/api/workspaces/\(workspace)/session-images/\(session)/\(imageId)")!
  }
}
final class ShareProtocol: URLProtocol {
  static let calls = OSAllocatedUnfairLock(initialState: [String]())
  static let denied = OSAllocatedUnfairLock(initialState: false)
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let host = request.url!.host!
    Self.calls.withLock { $0.append(host) }
    var body: [String: Any]
    let token = request.value(forHTTPHeaderField: "Authorization")
    if host == "backend.lody.ai" {
      precondition(token == "Bearer synthetic-app-credential")
      body = ["token": "synthetic-jwt"]
    } else {
      precondition(host == "convex.lody.ai" && token == "Bearer synthetic-jwt")
      var data = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count <= 0 { break }
          data.append(contentsOf: buffer.prefix(count))
        }
      }
      let payload = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      let path = payload["path"] as! String
      precondition(["sessionSharing:getManagement", "sessionSharing:list", "sessionSharing:revoke"].contains(path))
      precondition(request.url!.path == (path.hasSuffix("revoke") ? "/api/mutation" : "/api/query"))
      body = ["status": "success", "value": NSNull()]
      if path.hasSuffix("list") {
        body["value"] = ["page": [], "isDone": true, "continueCursor": ""]
        if Self.denied.withLock({ $0 }) { body = ["status":"error", "errorData":["code":"share_forbidden","message":"must-not-leave-native"]] }
      }
      if path.hasSuffix("revoke") { body = ["status": "error", "errorMessage": "forbidden"] }
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
@main @MainActor struct Check {
  static func managementChecks() async throws {
    var row: [String: Any] = ["shareId":"share", "rootSessionId":"source-deleted", "publisherUserId":"user",
      "status":"active", "revision":1, "credentialVersion":2, "title":"Static copy", "createdAt":1000, "updatedAt":2000,
      "totalBytes":128, "conversationCount":2, "canManage":true, "canRevoke":true,
      "credentialHash":"must-not-leave-native", "url":"must-not-leave-native", "transcript":"must-not-leave-native"]
    @MainActor final class Delivery { var lostAck=false; var readbackDenied=false }
    let delivery=Delivery()
    var secretReads=0, mutations=0, opens=0, scopeValid=true
    var requests: [String] = []
    let key = String(repeating:"a",count:64)
    let call: SessionSharing.ManagementCall = { method, fields in
      requests.append(method)
      if method == "list" {
        precondition(fields["workspaceId"] as? String == "workspace")
        let options = fields["paginationOpts"] as! [String:Any]
        precondition(options["numItems"] as? Int == 20 && options["cursor"] as? String == "cursor-one")
        return ["page":[row], "isDone":true, "continueCursor":""]
      }
      if method == "getManagement" {
        precondition(fields["shareId"] as? String == "share" && fields["rootSessionId"] as? String == "source-deleted")
        if delivery.readbackDenied && mutations >= 2 { throw SessionSharing.ManagementFailure(code:"shares_forbidden") }
        return row
      }
      precondition(method == "revoke" && fields["expectedRevision"] as? Int == row["revision"] as? Int)
      mutations += 1;row["revision"] = (row["revision"] as! Int)+1;row["status"]="revoked"
      if delivery.lostAck { throw URLError(.networkConnectionLost) }
      return row
    }
    @MainActor func run(_ action:String, revision:Int=1, reader:String="user") async throws -> [String:Any] {
      try await SessionSharing.management(["workspaceId":"workspace", "action":action, "shareId":"share",
        "rootSessionId":"source-deleted", "expectedRevision":revision, "cursor":"cursor-one"],
        workspace:"workspace",userId:reader, check:{ if !scopeValid {throw URLError(.cancelled)} }, call:call,
        secret:{ share,version in precondition(share=="share" && version==2);secretReads += 1;return key },
        useLink:{ action,url in
          precondition(["copy","open"].contains(action) && url.host=="share.lody.ai" && url.path=="/s/share")
          precondition(url.fragment=="access=v1."+key && url.query==nil);opens += 1
        })
    }
    let list = try await run("list")
    let serialized = String(decoding:try JSONSerialization.data(withJSONObject:list),as:UTF8.self)
    precondition(!serialized.contains(key) && !serialized.contains("must-not-leave-native"))
    precondition((list["page"] as! [[String:Any]])[0]["hasLocalLink"] as? Bool == true)
    _ = try await run("copy");_ = try await run("open")
    precondition(opens==2 && mutations==0)
    let before=secretReads
    let admin=try await run("detail",reader:"administrator")
    precondition(secretReads==before && (admin["page"] as! [[String:Any]])[0]["hasLocalLink"] as? Bool==false)
    do {_=try await run("copy",reader:"administrator");fatalError("Admin obtained publisher bearer")} catch let e as SessionSharing.ManagementFailure {precondition(e.code=="shares_link_unavailable")}
    precondition(secretReads==before && opens==2)
    let foreignSecretReads=secretReads-before
    row["canRevoke"]=false
    do {_=try await run("revoke");fatalError("Read-only share revoked")} catch let e as SessionSharing.ManagementFailure {precondition(e.code=="shares_forbidden")}
    row["canRevoke"]=true
    do {_=try await run("revoke",revision:0);fatalError("Stale revision revoked")} catch let e as SessionSharing.ManagementFailure {precondition(e.code=="shares_conflict")}
    precondition(mutations==0)
    scopeValid=false
    do {_=try await run("revoke");fatalError("Changed scope wrote")} catch {}
    precondition(mutations==0);scopeValid=true
    delivery.lostAck=true
    do {_=try await run("revoke",reader:"administrator");fatalError("Lost ACK reported success")} catch let e as SessionSharing.ManagementFailure {precondition(e.code=="shares_write_unknown")}
    precondition(mutations==1)
    let recovered=try await run("detail")
    precondition((recovered["page"] as! [[String:Any]])[0]["status"] as? String=="revoked")
    precondition(mutations==1 && row["rootSessionId"] as? String=="source-deleted")
    row["status"]="active";row["revision"]=3;delivery.lostAck=false;delivery.readbackDenied=true
    do {_=try await run("revoke",revision:3);fatalError("Denied readback reported definite failure")} catch let e as SessionSharing.ManagementFailure {precondition(e.code=="shares_write_unknown")}
    precondition(mutations==2);delivery.readbackDenied=false
    row["status"]="active";row["revision"]=5
    let revoked=try await run("revoke",revision:5)
    let confirmed=(revoked["page"] as! [[String:Any]])[0]
    precondition(mutations==3 && confirmed["status"] as? String=="revoked" && confirmed["revision"] as? Int==6)
    // Unknown response fields never become list data, even when a trusted endpoint evolves.
    let bad:SessionSharing.ManagementCall = { _,_ in ["page":[row,row],"isDone":true,"continueCursor":""] }
    do {
      _=try await SessionSharing.management(["workspaceId":"workspace","action":"list"],workspace:"workspace",userId:"user",check:{},call:bad,secret:{_,_ in nil})
      fatalError("Duplicate share identities accepted")
    } catch {}
    let stalled:SessionSharing.ManagementCall = { _,_ in ["page":[],"isDone":false,"continueCursor":"same"] }
    do {
      _=try await SessionSharing.management(["workspaceId":"workspace","action":"list","cursor":"same"],workspace:"workspace",userId:"user",check:{},call:stalled,secret:{_,_ in nil})
      fatalError("Stalled cursor accepted")
    } catch {}
    row["status"]="active"
    let missing = try await SessionSharing.management(["workspaceId":"workspace","action":"detail","shareId":"share","rootSessionId":"source-deleted"],
      workspace:"workspace",userId:"user",check:{},call:call,secret:{_,_ in nil})
    precondition((missing["page"] as! [[String:Any]])[0]["hasLocalLink"] as? Bool==false)
    let observation: [String:Any] = ["observation":"published-shares-boundary", "inventory":list,
      "requestMethods":requests, "nativeLinkActions":opens, "foreignSecretReads":foreignSecretReads,
      "revokeAttempts":mutations, "confirmedRevocation":confirmed, "lostAckReadback":(recovered["page"] as! [[String:Any]])[0],
      "sourceSessionId":row["rootSessionId"]!, "automaticReplays":requests.filter {$0=="revoke"}.count-mutations]
    print(String(decoding:try JSONSerialization.data(withJSONObject:observation,options:[.sortedKeys]),as:UTF8.self))
  }
  static func main() async throws {
    try await managementChecks()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ShareProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let result = try await SessionSharing.run("api", args: ["method": "getManagement", "args": ["workspaceId": "workspace", "rootSessionId": "root"]], workspace: "workspace", userId: "user", session: session)
    precondition(result is NSNull, "A missing share is not an active link")
    let inventory = try await SessionSharing.run("management", args:["workspaceId":"workspace","action":"list"],workspace:"workspace",userId:"user",session:session) as! [String:Any]
    precondition((inventory["page"] as? [Any])?.isEmpty==true)
    ShareProtocol.denied.withLock { $0=true }
    let denied = try await SessionSharing.run("management", args:["workspaceId":"workspace","action":"list"],workspace:"workspace",userId:"user",session:session) as! [String:Any]
    precondition(denied["error"] as? String=="shares_forbidden" && denied.count==1)
    ShareProtocol.denied.withLock { $0=false }
    let before = ShareProtocol.calls.withLock { $0.count }
    do {
      _ = try await SessionSharing.run("api", args: ["method": "getManagement", "args": ["workspaceId": "other", "rootSessionId": "root"]], workspace: "workspace", userId: "user", session: session)
      fatalError("Cross-workspace request accepted")
    } catch {}
    do {
      _ = try await SessionSharing.run("api", args: ["method": "anything", "args": [:]], workspace: "workspace", userId: "user", session: session)
      fatalError("Arbitrary backend mutation accepted")
    } catch {}
    precondition(ShareProtocol.calls.withLock { $0.count } == before)
    do {
      _ = try await SessionSharing.run("api", args: ["method": "revoke", "args": ["shareId": "share", "expectedRevision": 1]], workspace: "workspace", userId: "user", session: session)
      fatalError("Rejected mutation reported success")
    } catch { precondition(error.localizedDescription == "share_unavailable") }
    precondition(ShareProtocol.calls.withLock { $0.count } == before + 2, "Never replay a mutation")
    print("Sharing native boundary passed: scoped operations, native-only credentials, null state, rejected mutation and no replay")
  }
}
