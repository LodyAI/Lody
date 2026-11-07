import Foundation

enum AuthKeychain { static func read() throws -> String? { "fixture" } }
@MainActor enum GitHubCloud {
  static func validRepository(_ value:String)->Bool { value.contains("/") }
  static func failure() -> NSError { NSError(domain:"fixture", code:1) }
  static func request(_ path:String, token:String) async throws -> Any { throw failure() }
  static func call(_ kind:String, path:String, args:[String:Any]) async throws -> Any { throw failure() }
}

@main struct SettingsCheck {
  @MainActor static func main() async throws {
    var rows:[[String:Any]] = [
      ["machineId":"m1","localProjectId":"same","ownerUserId":"owner","sharedWithTeam":false,"updatedAt":1.0],
      ["machineId":"m2","localProjectId":"same","ownerUserId":"teammate","sharedWithTeam":true,"updatedAt":1.0]
    ]
    var writes=0,failWrite=false,failReadbackAfter:Int?=nil
    let call:WorkspaceSettingsCloud.Call = { kind,path,args in
      if kind=="query" {
        if let after=failReadbackAfter, writes>=after {throw GitHubCloud.failure()}
        return rows
      }
      precondition(path=="localProjects:setLocalProjectSharedWithTeam")
      writes += 1
      if failWrite {throw GitHubCloud.failure()}
      let index=rows.firstIndex {$0["machineId"] as? String==args["machineId"] as? String}!
      rows[index]["sharedWithTeam"]=args["sharedWithTeam"]
      return ["success":true,"sharedWithTeam":args["sharedWithTeam"]!]
    }
    let read=try await WorkspaceSettingsCloud.execute(["page":"projects","action":"list"],workspace:"w",user:"owner",call:call)
    precondition((read["rows"] as? [[String:Any]])?.count==2 && writes==0)
    let target:[String:Any] = ["page":"projects","action":"set","machineId":"m2","localProjectId":"same","sharedWithTeam":false]
    do { _=try await WorkspaceSettingsCloud.execute(target,workspace:"w",user:"owner",call:call);fatalError("foreign write allowed") } catch {}
    precondition(writes==0)
    var own=target;own["machineId"]="m1";own["sharedWithTeam"]=true
    let saved=try await WorkspaceSettingsCloud.execute(own,workspace:"w",user:"owner",call:call)
    precondition(writes==1 && (saved["rows"] as? [[String:Any]])?[0]["sharedWithTeam"] as? Bool==true)
    precondition(rows[1]["sharedWithTeam"] as? Bool==true)
    failWrite=true
    do {_=try await WorkspaceSettingsCloud.execute(own,workspace:"w",user:"owner",call:call);fatalError("unknown write reported success")} catch {}
    precondition(writes==2,"Unknown writes must never replay")
    failWrite=false;failReadbackAfter=writes+1
    do {_=try await WorkspaceSettingsCloud.execute(own,workspace:"w",user:"owner",call:call);fatalError("failed readback reported success")} catch {}
    precondition(writes==3, "Readback failure must happen after the mutation")
    failReadbackAfter=nil
    var missing=own;missing["localProjectId"]="unregistered"
    do {_=try await WorkspaceSettingsCloud.execute(missing,workspace:"w",user:"owner",call:call);fatalError("unregistered write allowed")} catch {}

    var repoEnabled=true,githubWrites=0,authState="expired",personalEnabled=true
    let github:WorkspaceSettingsCloud.Call = { kind,path,args in
      if path=="github:listWorkspaceReposWithStatus" {return [["repoFullName":"LodyAI/Lody","name":"Lody","repositoryId":1,"private":false,"enabled":repoEnabled,"token":"must-not-leave-native"]]}
      if path=="github:getPersonalOperationSettings" {return ["enabled":personalEnabled,"authorization":["state":authState,"githubAccountId":"fixture","token":"must-not-leave-native"]] as [String:Any]}
      if kind=="mutation" {githubWrites += 1;if path=="github:setRepoEnabled" {repoEnabled=args["enabled"] as! Bool;return ["updated":true]};personalEnabled=args["enabled"] as! Bool;return NSNull()}
      if path=="github:createGitHubInstallState" {return ["state":"fixture&injection=no"]}
      throw GitHubCloud.failure()
    }
    let repo:[String:Any] = ["page":"github","action":"repository","repoFullName":"LodyAI/Lody","enabled":false]
    do {_=try await WorkspaceSettingsCloud.execute(repo,workspace:"w",user:"owner",role:"member",call:github);fatalError("member managed repo")} catch {}
    precondition(githubWrites==0)
    let repository=try await WorkspaceSettingsCloud.execute(repo,workspace:"w",user:"owner",role:"admin",call:github)
    precondition(githubWrites==1 && (repository["repositories"] as? [[String:Any]])?[0]["enabled"] as? Bool==false)
    precondition((repository["repositories"] as? [[String:Any]])?[0]["token"]==nil)
    let personal:[String:Any] = ["page":"github","action":"preference","enabled":true]
    do {_=try await WorkspaceSettingsCloud.execute(personal,workspace:"w",user:"owner",role:"admin",call:github);fatalError("expired identity enabled")} catch {}
    precondition(githubWrites==1)
    authState="authorized"
    _=try await WorkspaceSettingsCloud.execute(personal,workspace:"w",user:"owner",role:"admin",call:github)
    precondition(githubWrites==2)
    let installation=try await WorkspaceSettingsCloud.execute(["page":"github","action":"install"],workspace:"w",user:"owner",role:"owner",call:github)
    let url=URLComponents(string:installation["url"] as! String)!
    precondition(url.host=="github.com" && url.queryItems?.first?.value=="fixture&injection=no")
    print("GitHub role fences, independent identity state and bounded installation URL passed")

    let total:[String:Any] = ["tokens":20,"costUSD":NSNull()]
    let bucket:[String:Any] = ["bucketStartMs":0,"tokens":20,"costUSD":NSNull(),"byUser":[["userId":"private","tokens":20]]]
    let usage:[String:Any] = ["workspaceId":"w","range":"day","totals":total,"startMs":0,"endMs":1000,"bucketSizeMs":1000,"buckets":[bucket],"users":["private":["email":"never@project.example"]],"byUser":[["userId":"private","tokens":20]]]
    let projected=try WorkspaceUsage.projection(usage,workspace:"w",range:"day",timeline:true)
    precondition(projected["users"]==nil && projected["byUser"]==nil)
    precondition((projected["buckets"] as? [[String:Any]])?[0]["byUser"]==nil)
    precondition((projected["totals"] as? [String:Any])?["costUSD"] is NSNull)
    precondition(WorkspaceUsage.cost(0) as? Double==0)
    precondition(WorkspaceUsage.cost(-1) is NSNull)
    var duplicate=usage;duplicate["buckets"]=[bucket,bucket]
    do {_=try WorkspaceUsage.projection(duplicate,workspace:"w",range:"day",timeline:true);fatalError("duplicate bucket accepted")} catch {}
    do {_=try WorkspaceUsage.projection(usage,workspace:"another",range:"day",timeline:true);fatalError("foreign workspace accepted")} catch {}
    var endBucket=bucket;endBucket["bucketStartMs"]=1001
    var boundary=usage;boundary["buckets"]=[endBucket]
    do {_=try WorkspaceUsage.projection(boundary,workspace:"w",range:"day",timeline:true);fatalError("out-of-range bucket accepted")} catch {}
    let partial=try await WorkspaceUsage.run(["action":"list","range":"day"],workspace:"w") { _,path,_ in
      if path=="usage:getWorkspaceUsageSummary" {throw GitHubCloud.failure()}
      return usage
    }
    precondition(partial["errors"] as? [String]==["summary"] && partial["summary"] is NSNull && partial["timeline"] is [String:Any])
    let encoded=try JSONSerialization.data(withJSONObject:partial)
    let decoded=try JSONSerialization.jsonObject(with:encoded) as! [String:Any]
    let retrieved=(decoded["retrievedAt"] as! NSNumber).doubleValue
    precondition(retrieved.rounded()==retrieved,"Native timestamps must match the app wire schema")
    print("Usage boundaries, unknown costs, partial failure and member privacy passed")
    print("Owner fencing, machine identity, readback and uncertain-write behavior passed")
  }
}
