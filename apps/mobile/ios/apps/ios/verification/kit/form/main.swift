import UIKit

func descendants(_ view: UIView) -> [UIView] {
  view.subviews + view.subviews.filter { !($0 is UISwitch) }.flatMap(descendants)
}

func frame(_ inner: UIView, in outer: UIView) -> CGRect {
  inner.convert(inner.bounds, to: outer)
}

let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
let host = UIView(frame: window.bounds)
window.addSubview(host)
window.makeKeyAndVisible()

let name = LodyFormField(id: "name", label: "Name", text: "Release captain", limit: 60)
let summary = LodyFormField(id: "summary", label: "Description of the role", text: "Cuts releases", limit: 140)
let toggle = LodyFormToggle(id: "shared", title: "Shared with workspace", isOn: true)
let block = LodyFormGroup(header: "Identity", footer: "Visible to the workspace.", name, summary, toggle)
block.translatesAutoresizingMaskIntoConstraints = false
host.addSubview(block)
NSLayoutConstraint.activate([
  block.topAnchor.constraint(equalTo: host.topAnchor, constant: 100),
  block.leadingAnchor.constraint(equalTo: host.leadingAnchor),
  block.trailingAnchor.constraint(equalTo: host.trailingAnchor),
])
host.layoutIfNeeded()

let cards = descendants(block).filter { $0.layer.cornerRadius >= 20 || ($0.backgroundColor.map { $0.cgColor.alpha > 0.5 } ?? false) }
assert(cards.isEmpty, "Form groups draw rows on the ground, not in a card: \(cards)")

let labels = descendants(block).compactMap { $0 as? UILabel }
let header = labels.first { $0.text == "Identity" }!
assert(header.text == "Identity" && header.font.pointSize == 13, "Headers keep their case at 13 pt")
assert(header.textColor == UIColor.lodySecondary, "Headers use the secondary ink")
let nameLabel = labels.first { $0.text == "Name" }!
let summaryLabel = labels.first { $0.text == "Description of the role" }!
assert(abs(frame(nameLabel, in: block).minX - 16) < 0.5, "Inline labels start at 16, got \(frame(nameLabel, in: block))")
assert(abs(nameLabel.bounds.width - summaryLabel.bounds.width) < 0.5, "Labels in one block share a column width")
assert(nameLabel.bounds.width >= 96 && nameLabel.bounds.width <= 390 * 0.4 + 0.5, "The label column is 96 pt to 40% wide, got \(nameLabel.bounds.width)")
assert(nameLabel.textColor == UIColor.lodySecondary && nameLabel.font.pointSize == 15, "Labels are 15 pt secondary")

assert(name.textAlignment == .right && name.font?.pointSize == 15 && name.textColor == UIColor.lodyInk, "Values are right-aligned 15 pt ink")
let nameFrame = frame(name, in: block)
assert(abs(nameFrame.maxX - 374) < 0.5, "Values end at the trailing margin, got \(nameFrame)")
assert(nameFrame.minX > frame(nameLabel, in: block).maxX, "Values sit after the label column")
assert(name.isEnabled && name.accessibilityLabel == "Name", "The field stays the editable, labeled element")
assert(nameFrame.height >= 48 || (name.superview?.bounds.height ?? 0) >= 48, "Field rows are at least 48 pt")

let hairlines = descendants(block).filter { $0.bounds.height > 0 && $0.bounds.height <= 1 && $0.backgroundColor == UIColor.lodyLine }
assert(hairlines.count >= 2, "Rows are separated by hairlines")
assert(hairlines.allSatisfy { abs(frame($0, in: block).minX - 16) < 0.5 && abs(frame($0, in: block).maxX - 390) < 0.5 },
  "Hairlines run from 16 to the trailing edge")
assert(toggle.bounds.height >= 52, "Toggle rows are at least 52 pt")
let footer = labels.first { $0.text == "Visible to the workspace." }!
assert(abs(frame(footer, in: block).minX - 16) < 0.5 && footer.font.pointSize == 12.5 && footer.textColor == UIColor.lodySecondary,
  "Footers are 12.5 pt secondary at 16")

let notes = LodyFormTextView(id: "notes", label: "Instructions", text: "Ship it", limit: 100, minHeight: 120)
assert(notes.font?.pointSize == 15 && notes.textColor == UIColor.lodyInk, "Multi-line text is 15 pt ink")
let destructive = LodyFormButton.make(id: "delete", title: "Delete", destructive: true) {}
let danger = LodyFormGroup(destructive)
danger.translatesAutoresizingMaskIntoConstraints = false
host.addSubview(danger)
NSLayoutConstraint.activate([
  danger.topAnchor.constraint(equalTo: host.topAnchor, constant: 600),
  danger.leadingAnchor.constraint(equalTo: host.leadingAnchor),
  danger.trailingAnchor.constraint(equalTo: host.trailingAnchor),
])
host.layoutIfNeeded()
assert(destructive.contentHorizontalAlignment == .leading && destructive.bounds.height >= 48, "Destructive actions are leading 48 pt rows")
let readOnlyValue = UILabel()
readOnlyValue.text = "Claude Code"
let readOnly = LodyFormRow(label: "Target", content: readOnlyValue)
precondition(readOnly.isAccessibilityElement && readOnly.accessibilityLabel == "Target" && readOnly.accessibilityValue == "Claude Code",
  "A read-only row reads its visible label and value as one element")
readOnlyValue.text = "Codex"
precondition(readOnly.accessibilityValue == "Codex", "A read-only row reads its current value")
var pickerConfiguration = UIButton.Configuration.plain()
pickerConfiguration.title = "Claude Code"
let pickerRow = LodyFormRow(label: "Target", content: UIButton(configuration: pickerConfiguration), picker: true)
precondition(!pickerRow.isAccessibilityElement && pickerRow.label.isAccessibilityElement,
  "A picker row keeps its visible label for VoiceOver beside the button")
let fieldRow = LodyFormRow(label: "Name", content: LodyFormField(id: "name", label: "Name", text: "", limit: 40))
precondition(!fieldRow.isAccessibilityElement && !fieldRow.label.isAccessibilityElement,
  "A field row is read once through the field's own label")
let machineValue = UILabel()
machineValue.text = "machine-1"
let machineStack = UIStackView(arrangedSubviews: [machineValue, UIButton(configuration: .plain())])
let machineRow = LodyFormRow(label: "Machine ID", content: machineStack)
precondition(!machineRow.isAccessibilityElement && machineRow.label.isAccessibilityElement,
  "A row whose content holds a control keeps that control reachable and its label readable")
print("PASS: form groups draw inline-label rows with shared label columns on the ground")
