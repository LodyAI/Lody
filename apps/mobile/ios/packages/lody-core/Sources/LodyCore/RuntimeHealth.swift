import Foundation

public struct RuntimeHealth {
  public private(set) var lastAck: TimeInterval = 0
  public private(set) var ready = false
  private var suspended = false
  private var restarts: [TimeInterval] = []
  public init() {}
  public mutating func started(at now: TimeInterval) { lastAck = now; ready = false }
  public mutating func acknowledged(at now: TimeInterval) { lastAck = now; ready = true }
  public mutating func suspend() { suspended = true }
  public mutating func resume(at now: TimeInterval) { suspended = false; lastAck = now }
  public func timedOut(at now: TimeInterval) -> Bool { !suspended && now - lastAck >= (ready ? 8 : 20) }
  public mutating func allowRestart(at now: TimeInterval) -> Bool {
    restarts.removeAll { now - $0 >= 60 }
    guard restarts.count < 3 else { return false }
    restarts.append(now)
    return true
  }
}
