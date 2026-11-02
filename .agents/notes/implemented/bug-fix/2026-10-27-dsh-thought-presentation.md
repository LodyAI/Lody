# DSH thought presentation

Status: implemented
Translation: current

[中文](2026-10-27-dsh-thought-presentation.zh.md)

## Abstract

DeepSeek thought prose appeared brighter than its disclosure label and slightly indented. The thought row now aligns with that label and uses secondary text color while retaining answer-sized Markdown. This changes presentation only; code blocks keep their own syntax colors. The Storybook streaming example shows the real conversation renderer.

## Verification

The dark streaming story was inspected in Storybook alongside the plan example: thought, tool and answer share the left edge, and thought and answer code blocks share both edges. Desktop application and other themes were not separately verified.
