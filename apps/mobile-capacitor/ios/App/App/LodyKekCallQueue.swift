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

    func enqueue(route: String, _ work: @escaping () -> Void) {
        metadata.lock()
        let entry = entries[route] ?? Entry()
        entries[route] = entry
        entry.pending += 1
        // Enqueue under the short metadata lock to preserve same-route order.
        entry.queue.async {
            defer {
                self.metadata.lock()
                entry.pending -= 1
                if entry.pending == 0 { self.entries.removeValue(forKey: route) }
                self.metadata.unlock()
            }
            work() // No native work or callback runs under the metadata lock.
        }
        metadata.unlock()
    }
}
