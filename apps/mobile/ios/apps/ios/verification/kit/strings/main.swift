import Foundation

let resources = Bundle(path: CommandLine.arguments[1])!
for (language, expected) in [
  ("en", ["0 files", "1 file", "2 files", "Preview attachment {name} 100%", "2 online / 5 devices"]),
  ("zh-Hans", ["0 个文件", "1 个文件", "2 个文件", "预览附件 {name} 100%", "2 台在线 / 共 5 台"]),
] {
  let bundle = Bundle(path: resources.path(forResource: language, ofType: "lproj")!)!
  for count in 0...2 {
    let value = String.localizedStringWithFormat(String(localized: "changes.fileCount", bundle: bundle), count)
    precondition(value == expected[count], "\(language) plural: \(value)")
  }
  let attachment = String.localizedStringWithFormat(
    String(localized: "native.chat.attachment.preview", bundle: bundle), "{name} 100%"
  )
  precondition(attachment == expected[3], "Arguments must remain literal: \(attachment)")
  let devices = String.localizedStringWithFormat(String(localized: "devices.summary", bundle: bundle), "2", "5")
  precondition(devices == expected[4], "\(language) argument order: \(devices)")
  let kind = "machine"
  let dynamic = String(localized: String.LocalizationValue("settings.remote." + kind), bundle: bundle)
  precondition(dynamic == String(localized: "settings.remote.machine", bundle: bundle), "Dynamic keys must be constructed before localization")
  precondition(dynamic != "settings.remote.machine")
  precondition(String(localized: "missing.localization.key", bundle: bundle) == "missing.localization.key")
}
print("PASS: compiled String Catalog resolves English/Chinese, plurals, arguments and missing keys")
