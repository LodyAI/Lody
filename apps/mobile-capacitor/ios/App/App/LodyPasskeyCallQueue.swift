import Foundation

/// Keep the system ceremony owned until its real delegate completion. No timer releases it.
@MainActor
final class LodyPasskeyCallQueue {
    static let shared = LodyPasskeyCallQueue()
    private var pending: [() -> Void] = []
    private var running = false

    func enqueue(_ work: @escaping () -> Void) {
        pending.append(work)
        startNext()
    }

    func finished() {
        precondition(running)
        running = false
        startNext()
    }

    private func startNext() {
        guard !running, !pending.isEmpty else { return }
        running = true
        pending.removeFirst()()
    }
}
