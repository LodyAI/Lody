import Foundation

/// Own actual native calls until they return. No cancel/timeout releases a route.
/// Queue by account/workspace/genesis, so a replacement cannot overtake old work.
final class LodyKekCallQueue {
    static let shared = LodyKekCallQueue()
    private final class Entry {
        let queue = DispatchQueue(label: "ai.lody.mobile.e2ee.kek.call")
        var pending = 0
    }
    private let metadata = NSLock()
    private var entries: [String: Entry] = [:]
    // While a purge runs, new calls wait here in arrival order instead of reaching
    // half-purged custody. Depth lets overlapping purges hold one fence.
    private var fenceDepth = 0
    private var held: [(route: String, work: () -> Void)] = []

    func enqueue(route: String, _ work: @escaping () -> Void) {
        metadata.lock()
        if fenceDepth > 0 {
            held.append((route: route, work: work))
        } else {
            admit(route: route, work)
        }
        metadata.unlock()
    }

    /// Caller holds `metadata`. Enqueue under it to preserve same-route order.
    private func admit(route: String, _ work: @escaping () -> Void) {
        let entry = entries[route] ?? Entry()
        entries[route] = entry
        entry.pending += 1
        entry.queue.async {
            defer {
                self.metadata.lock()
                entry.pending -= 1
                if entry.pending == 0 { self.entries.removeValue(forKey: route) }
                self.metadata.unlock()
            }
            work() // No native work or callback runs under the metadata lock.
        }
    }

    /// Fences new calls, runs `work` on `queue` once every call already admitted on every
    /// route has returned, then admits the held calls in arrival order. The fence lifts after
    /// `work` returns, whatever it did, so held calls see the settled state, never a partial one.
    func fenced(on queue: DispatchQueue, _ work: @escaping () -> Void) {
        let group = DispatchGroup()
        metadata.lock()
        fenceDepth += 1
        for entry in entries.values {
            group.enter()
            entry.queue.async { group.leave() }
        }
        metadata.unlock()
        group.notify(queue: queue) {
            work()
            self.metadata.lock()
            self.fenceDepth -= 1
            if self.fenceDepth == 0 {
                let released = self.held
                self.held = []
                for call in released { self.admit(route: call.route, call.work) }
            }
            self.metadata.unlock()
        }
    }
}
