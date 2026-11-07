import LodyCore
import Foundation
var health = RuntimeHealth()
health.started(at: 100)
assert(!health.timedOut(at: 119.9))
assert(health.timedOut(at: 120))
health.acknowledged(at: 120)
assert(!health.timedOut(at: 127.9))
assert(health.timedOut(at: 128))
assert(health.allowRestart(at: 128))
health.started(at: 128)
assert(!health.timedOut(at: 136)) // A new process gets its full startup deadline.
assert(health.allowRestart(at: 140))
assert(health.allowRestart(at: 150))
assert(!health.allowRestart(at: 160)) // No infinite restart loop.
assert(health.allowRestart(at: 188))
health.started(at: 1000) // Foreground recreation must not charge time spent suspended.
assert(!health.timedOut(at: 1001))
health.acknowledged(at: 1001)
health.suspend()
assert(!health.timedOut(at: 5000))
health.resume(at: 5000)
assert(health.ready) // Retained WebView does not need another ready callback.
assert(!health.timedOut(at: 5007.9))
assert(health.timedOut(at: 5008)) // A genuinely wedged view still recovers.
print("PASS: startup/heartbeat deadlines, restart budget, foreground grace")
