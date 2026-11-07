import Foundation

enum ChatHaptics {
  static func shouldNotifyTurnCompletion(
    previousLive: String?,
    nextLive: String?,
    processEntryID: String,
    inWindow: Bool
  ) -> Bool {
    inWindow && processEntryID.isEmpty && previousLive != nil && previousLive != nextLive
  }
}

struct ChatReplyPulses: Sendable {
  struct Config: Sendable, Equatable {
    var window: TimeInterval = 5
    var duration: TimeInterval = 1.8
    var interval: TimeInterval = 0.07
    var count = 17
    var intensity: Float = 0.6
    var endIntensity: Float = 0.1
    var curve: Float = 0.6
    var sharpness: Float = 0.35
  }

  struct Pulse: Sendable, Equatable {
    let time: TimeInterval
    let intensity: Float
  }

  let config: Config
  let sentAt: TimeInterval
  private(set) var firstAt: TimeInterval?
  private var lastPulse = -TimeInterval.infinity
  private var count = 0

  init(config: Config = Config(), sentAt: TimeInterval) {
    self.config = config
    self.sentAt = sentAt
  }

  func isFinished(at now: TimeInterval) -> Bool {
    guard let firstAt else { return now - sentAt > config.window }
    return firstAt - sentAt > config.window || now - firstAt > config.duration || count >= config.count
  }

  mutating func textGrew(at now: TimeInterval) -> Pulse? {
    let first = firstAt ?? now
    firstAt = first
    guard first - sentAt <= config.window, now - first <= config.duration,
          count < config.count, now - lastPulse >= config.interval else { return nil }
    count += 1
    lastPulse = now
    let progress = config.duration > 0 ? Float(min(1, max(0, (now - first) / config.duration))) : 0
    let strength = config.endIntensity + (config.intensity - config.endIntensity) * pow(1 - progress, config.curve)
    return Pulse(time: now, intensity: strength)
  }

  static func schedule(chunks: [TimeInterval], config: Config) -> [Pulse] {
    var pulses = ChatReplyPulses(config: config, sentAt: 0)
    return chunks.compactMap { pulses.textGrew(at: $0) }
  }
}
