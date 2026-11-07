import UIKit
import Loro

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let view = UIViewController()
    view.view.backgroundColor = .systemBackground
    let label = UILabel(frame: CGRect(x: 24, y: 150, width: 350, height: 350))
    label.numberOfLines = 0
    view.view.addSubview(label)
    window = UIWindow(frame: UIScreen.main.bounds)
    window?.rootViewController = view
    window?.makeKeyAndVisible()
    do {
      struct Fixture: Decodable { let snapshot: Data; let updates: [Data]; let expectedText: String }
      let data = try Data(contentsOf: Bundle.main.url(forResource: "fixtures", withExtension: "json")!)
      let fixture = try JSONDecoder().decode(Fixture.self, from: data)
      let expected: LoroValue = .map(value: ["body": .string(value: fixture.expectedText), "meta": .map(value: ["status": .string(value: "ready")])])
      for updates in [fixture.updates, fixture.updates.reversed().map { $0 } + fixture.updates] {
        let doc = LoroDoc()
        _ = try doc.import(bytes: fixture.snapshot)
        for update in updates { _ = try doc.import(bytes: update) }
        guard doc.getDeepValue() == expected else { throw NSError(domain: "NativeProjectionMismatch", code: 1) }
      }
      let doc = LoroDoc()
      _ = try doc.import(bytes: fixture.snapshot)
      _ = try doc.importBatch(bytes: fixture.updates)
      let version = doc.oplogVv()
      try doc.getText(id: "body").insert(pos: UInt32(fixture.expectedText.utf16.count), s: " native")
      let update = try doc.export(mode: .updates(from: version))
      do {
        _ = try LoroDoc().import(bytes: Data([0, 1, 2, 3]))
        throw NSError(domain: "AcceptedMalformedData", code: 1)
      } catch let error as NSError where error.domain == "AcceptedMalformedData" { throw error }
        catch { /* A malformed packet must report an error across FFI, not crash. */ }
      try save(["ok": true, "update": update.base64EncodedString()])
      label.text = "PASS\nSwift → UniFFI → Rust\nSnapshot + concurrent updates\nDeletion / duplicates / reverse order\nMalformed input rejected\nNative update exported"
    } catch {
      try? save(["ok": false, "error": String(describing: error)])
      label.text = "FAIL: \(error)"
    }
    return true
  }
  func save(_ value: [String: Any]) throws {
    let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("result.json")
    try JSONSerialization.data(withJSONObject: value).write(to: path, options: .atomic)
  }
}
