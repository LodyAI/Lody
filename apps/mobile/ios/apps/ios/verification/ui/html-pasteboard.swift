import UIKit
import UniformTypeIdentifiers

let html = "<meta charset=\"utf-8\"><p>Rich <b>bold</b> and <code>code</code></p><ul><li>item</li></ul>"
UIPasteboard.general.items = [[UTType.html.identifier: Data(html.utf8), UTType.utf8PlainText.identifier: "Rich bold and code\nitem"]]
print("READY")
fflush(stdout)
RunLoop.main.run(until: Date().addingTimeInterval(60))
