import CoreHaptics
import QuartzCore
import UIKit

@MainActor
final class ChatReplyHaptics {
  static let preview = ChatReplyHaptics()

  private var engine: CHHapticEngine?
  private var player: CHHapticPatternPlayer?
  private var pulses: ChatReplyPulses?

  var armed: Bool { pulses != nil }

  func arm(config: ChatReplyPulses.Config = ChatReplyPulses.Config()) {
    pulses = ChatReplyPulses(config: config, sentAt: CACurrentMediaTime())
    _ = startedEngine()
  }

  func disarm() {
    pulses = nil
  }

  func textGrew() {
    guard var pulses else { return }
    let now = CACurrentMediaTime()
    let pulse = pulses.textGrew(at: now)
    self.pulses = pulses.isFinished(at: now) ? nil : pulses
    if let pulse {
      play([ChatReplyPulses.Pulse(time: 0, intensity: pulse.intensity)], sharpness: pulses.config.sharpness)
    }
  }

  @discardableResult
  func play(_ pulses: [ChatReplyPulses.Pulse], sharpness: Float) -> Bool {
    try? player?.stop(atTime: CHHapticTimeImmediate)
    player = nil
    guard !pulses.isEmpty, UIApplication.shared.applicationState == .active, let engine = startedEngine() else { return false }
    let events = pulses.map {
      CHHapticEvent(
        eventType: .hapticTransient,
        parameters: [
          CHHapticEventParameter(parameterID: .hapticIntensity, value: $0.intensity),
          CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
        ],
        relativeTime: $0.time
      )
    }
    do {
      let next = try engine.makePlayer(with: CHHapticPattern(events: events, parameters: []))
      try next.start(atTime: CHHapticTimeImmediate)
      player = next
      return true
    } catch {
      return false
    }
  }

  // Suspension or a media-server reset stops the engine; restarting before each
  // player is cheaper than tracking its handlers, which arrive off the main thread.
  private func startedEngine() -> CHHapticEngine? {
    guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return nil }
    if engine == nil {
      guard let made = try? CHHapticEngine() else { return nil }
      made.isAutoShutdownEnabled = true
      made.playsHapticsOnly = true
      engine = made
    }
    do {
      try engine?.start()
      return engine
    } catch {
      engine = nil
      return nil
    }
  }
}
