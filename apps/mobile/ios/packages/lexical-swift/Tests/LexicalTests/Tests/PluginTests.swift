/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

@testable import Lexical
import XCTest

final class TestPlugin: Lexical.Plugin {
  internal var listenerCount: Int = 0

  func setUp(editor: Editor) {
    _ = editor.registerUpdateListener { editorState, previousEditorState, dirtyNodes in
      self.listenerCount += 1
    }
  }

  func tearDown() {
  }
}

final class PluginTests: XCTestCase {

  func testPluginListener() throws {

    let plugin = TestPlugin()
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: [plugin]), featureFlags: FeatureFlags())

    // Note that Lexical may internally run some updates when setting itself up, so we fetch the baseline number here and compare later.
    let listenerCountBaseValue = plugin.listenerCount

    try view.editor.update {
    }
    try view.editor.update {
    }

    XCTAssertEqual(plugin.listenerCount, listenerCountBaseValue + 2, "Listener count should be 2 more after update")
  }
}
