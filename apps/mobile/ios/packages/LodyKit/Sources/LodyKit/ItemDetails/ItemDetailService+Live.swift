import Foundation
import LodyCore

extension ItemDetailService {
  static func live(sessionId: String) -> Self {
    Self(load: { params in
      guard let runtime = DataRuntime.current, runtime.sessionId == params.sessionId else { throw OutboxError.scopeExpired }
      return try await runtime.perform(RuntimeContract.Calls.ItemDetail.self, params)
    }, observe: { receive in
      let observer = NotificationCenter.default.addObserver(forName: .lodyDataRuntimeEvent, object: nil, queue: .main) { note in
        let event = SessionRuntimeEvent(note.userInfo ?? [:])
        guard event.sessionId == nil || event.sessionId == sessionId else { return }
        MainActor.assumeIsolated { receive(event.generation, event.session) }
      }
      return { NotificationCenter.default.removeObserver(observer) }
    })
  }
}
