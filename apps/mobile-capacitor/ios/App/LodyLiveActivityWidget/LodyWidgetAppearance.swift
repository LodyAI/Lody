import SwiftUI
import WidgetKit

// One native palette and mark for the Home Screen widget and Live Activities.
enum LodyWidgetAppearance {
    static let background = Color(red: 0.04, green: 0.05, blue: 0.07)
    static let running = Color(red: 0.27, green: 0.70, blue: 1.0)
    static let waiting = Color(red: 1.0, green: 0.64, blue: 0.13)
    static let unread = Color(red: 0.24, green: 0.84, blue: 0.50)
    // The blue/teal ground used by Lody's sharing cards.
    static let brandTeal = Color(red: 53 / 255, green: 200 / 255, blue: 176 / 255)
    static let brandBlue = Color(red: 47 / 255, green: 119 / 255, blue: 191 / 255)
}

struct LodyLogoMark: View {
    let size: CGFloat

    var body: some View {
        if #available(iOS 18.0, *) {
            Image("LodyLogo", bundle: .main)
                .renderingMode(.original)
                .resizable()
                .widgetAccentedRenderingMode(.fullColor)
                .scaledToFit()
                .frame(width: size, height: size)
        } else {
            Image("LodyLogo", bundle: .main)
                .renderingMode(.original)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
        }
    }
}

struct LodyAgentLogo: View {
    let kind: String
    let text: String

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(agentLogoBackground(kind))

            switch kind {
            case "codex":
                AgentAssetImage(name: "AgentCodex")
            case "claude":
                AgentAssetImage(name: "AgentClaude")
            case "kimi":
                AgentAssetImage(name: "AgentKimi")
            case "deepseek":
                AgentAssetImage(name: "AgentDeepSeek")
            case "mimo":
                Text("mi")
                    .font(.system(size: 9, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
            case "minimax":
                AgentAssetImage(name: "AgentMinimax")
            default:
                Text(text)
                    .font(.system(size: 10, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: 22, height: 18)
    }
}

private struct AgentAssetImage: View {
    let name: String

    var body: some View {
        Image(name)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(.white)
            .frame(width: 12, height: 12)
    }
}

private func agentLogoBackground(_ kind: String) -> Color {
    switch kind {
    case "codex":
        return Color(red: 0.11, green: 0.15, blue: 0.14)
    case "claude":
        return Color(red: 0.82, green: 0.43, blue: 0.25)
    case "deepseek":
        return Color(red: 0.16, green: 0.40, blue: 0.90)
    case "mimo":
        return Color(red: 1.0, green: 0.42, blue: 0.0)
    case "minimax":
        return Color(red: 0.20, green: 0.22, blue: 0.88)
    default:
        return Color.white.opacity(0.12)
    }
}
