# Session UI

- The compact Chats project index appears while scrolling over the full-width list, accepts direct tap/scrub only inside its visible opaque rail, and resolves jumps against committed rendered sections. Never attach an index long-press recognizer to the list. Linger dismissal must be invalidated by renewed scrolling/touch, snapshot replacement, backgrounding and detachment; search and other groupings retain their existing behavior.

- Project grouping may hide the repeated place label, but must retain raw repository identity for the index. Keep index artwork at 24 pt; overflow shows non-overlapping landmarks and the selected mark while scrubbing and accessibility retain every destination. The rail background must remain opaque in both light and dark appearances.

- Index entrance and exit use restrained movement with full opacity at rest. Disable hit targets when dismissal begins, fence interrupted animation completions, and skip movement under Reduce Motion. Lifecycle cancellation must stop animations and hide immediately.
