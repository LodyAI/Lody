import Foundation

@MainActor
struct PermissionSource {
  var observe: (@escaping @MainActor (PermissionProjection.State) -> Void) -> (() -> Void)

  static func live(sessionId: String) -> Self {
    Self { receive in
      guard let runtime = DataRuntime.current, runtime.sessionId == sessionId else {
        receive(.ready(nil))
        return {}
      }
      let userId = runtime.userId, workspace = runtime.workspace
      var projection = PermissionProjection()
      let publish: @MainActor (SessionRuntimeEvent) -> Void = { [weak runtime] event in
        guard let runtime, runtime === DataRuntime.current, runtime.sessionId == sessionId,
              runtime.userId == userId, runtime.workspace == workspace else {
          receive(.ready(nil))
          return
        }
        guard event.sessionId == nil || event.sessionId == sessionId else { return }
        projection.receive(generation: event.generation, phase: event.state, json: event.session)
        receive(projection.state)
      }
      let observer = NotificationCenter.default.addObserver(forName: .lodyDataRuntimeEvent, object: nil, queue: .main) { note in
        let event = SessionRuntimeEvent(note.userInfo ?? [:])
        MainActor.assumeIsolated { publish(event) }
      }
      publish(SessionRuntimeEvent(generation: runtime.generation, state: runtime.status()["state"] as! String,
                                  sessionId: sessionId, session: runtime.sessionSnapshot?.json))
      return { NotificationCenter.default.removeObserver(observer) }
    }
  }
}
