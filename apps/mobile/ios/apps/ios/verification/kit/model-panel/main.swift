import UIKit
import MetalKit

let shaderURL = Bundle.main.url(forResource: "LodyKitShaders", withExtension: "bundle")!
let shaderBundle = Bundle(url: shaderURL)!
let device = MTLCreateSystemDefaultDevice()!
let library = try device.makeDefaultLibrary(bundle: shaderBundle)
precondition(library.makeFunction(name: "heatVertex") != nil && library.makeFunction(name: "heatFragment") != nil, "Packaged Metal library must expose the renderer entry points")
let panel = ChatComposerModelPanel()
panel.loadViewIfNeeded()
let options = try JSONDecoder().decode(ChatComposerOptions.self, from: Data(#"{"modelId":"gpt","models":[{"id":"gpt","title":"GPT"}],"effort":"medium","efforts":[{"id":"medium","title":"Medium"},{"id":"ultra","title":"Ultra"}]}"#.utf8))
panel.render(options)
let slider = panel.view.subviews.first { $0.accessibilityIdentifier == "composer-effort-slider" } as! UIControl
let model = panel.view.subviews.first { $0.accessibilityIdentifier == "composer-model-menu" } as! UIButton
precondition(model.configuration?.subtitle == "GPT" && model.configuration?.title == "Medium ›")
panel.render(ChatComposerOptions())
precondition(slider.isHidden, "Models without effort choices must hide the slider")
precondition(model.menu?.children.count == 1, "Replacing options must clear stale model choices")
print("PASS: extracted model panel renders choices and clears unavailable controls")
let fast = panel.view.subviews.first { $0.accessibilityIdentifier == "composer-fast" } as! UIButton
precondition(fast.isHidden, "Unsupported agents must not show Fast")
var fastOptions = options
fastOptions.fast = false
panel.render(fastOptions)
precondition(!fast.isHidden && !fast.accessibilityTraits.contains(.selected))
var fastChanged: Bool?
panel.onFast = { fastChanged = $0 }
panel.perform(NSSelectorFromString("toggleFast"))
precondition(fastChanged == true, "Fast must report the next value without changing effort")
fastOptions.fast = true
panel.render(fastOptions)
precondition(fast.accessibilityTraits.contains(.selected))
precondition(fast.configuration?.image != nil, "Fast must use a button configuration so symbol replace can run")
precondition(fast.configuration?.symbolContentTransition != nil, "Fast must replace bolt and bolt.fill")
panel.render(ChatComposerOptions())
fastChanged = nil
panel.perform(NSSelectorFromString("toggleFast"))
precondition(fastChanged == nil, "Unavailable Fast must not emit a choice")
print("PASS: Fast availability, toggle callback and selected state")
var grok = ChatComposerOptions()
grok.modelId = "grok-4.6"
grok.models = [ChatComposerOption(id: "grok-4.6", title: "Grok 4.6")]
grok.efforts = [
  ChatComposerOption(id: "xhigh", title: "xhigh"),
  ChatComposerOption(id: "high", title: "high"),
  ChatComposerOption(id: "medium", title: "medium"),
  ChatComposerOption(id: "low", title: "low"),
]
precondition(
  grok.orderedEfforts.map(\.id) == ["low", "medium", "high", "xhigh"],
  "Grok publishes extra-high first; the slider must still run low to extra high",
)
let effortSlider = slider as! ChatEffortSlider
var picked = ""
panel.onEffort = { picked = $0 }
panel.render(grok)
effortSlider.value = 0.25
panel.perform(NSSelectorFromString("changeEffort"))
precondition(picked == "low", "The first filled step must be the lowest effort, got \(picked)")
effortSlider.value = 1
panel.perform(NSSelectorFromString("changeEffort"))
precondition(picked == "xhigh", "A full slider must be the highest effort, got \(picked)")
picked = "unchanged"
grok.effort = "xhigh"
panel.render(grok)
precondition(model.configuration?.title == "Extra High ›")
precondition(effortSlider.value == 1, "Highest effort must sit at the full end of the slider")
panel.perform(NSSelectorFromString("changeEffort"))
precondition(picked == "unchanged", "Highest effort is already the full slider")
print("PASS: Grok menu-order efforts still fill the slider from low to extra high")

var deepseek = ChatComposerOptions()
deepseek.modelId = "deepseek"
deepseek.efforts = [
  ChatComposerOption(id: "high", title: "High"),
  ChatComposerOption(id: "off", title: "Off"),
]
panel.render(deepseek)
effortSlider.value = 0.5
panel.perform(NSSelectorFromString("changeEffort"))
precondition(picked == "off", "The first step after Default must select Off")
deepseek.effort = picked
panel.render(deepseek)
precondition(effortSlider.value == 0.5 && model.configuration?.title == "Off ›", "Off must restore at the lowest explicit effort")
effortSlider.value = 1
panel.perform(NSSelectorFromString("changeEffort"))
precondition(picked == "high", "Increasing from Off must select the higher effort")
effortSlider.value = 0
panel.perform(NSSelectorFromString("changeEffort"))
precondition(picked == "", "Default must remain distinct from Off")
print("PASS: DeepSeek Off selection, restored position, higher effort and Default")
