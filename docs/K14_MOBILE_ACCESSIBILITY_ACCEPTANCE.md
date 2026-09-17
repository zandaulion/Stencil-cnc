# K14 mobile and accessibility acceptance

K14 changes the narrow-screen editor from a long controls → canvas → review page into a canvas-first workspace. The canvas stays inside the available app viewport. Stage controls and Candidates/Problems open as compact bottom sheets, and the active stage remains reachable both from the numbered workflow tabs and the **Adjust** button over the canvas.

## Implemented contract

- Primary-action text contrast is 6.26:1 in the default state and 8.01:1 on hover against white text. The shared focus outline is an opaque 7.61:1 colour against white.
- Workflow, review, and Projects/Trash tab lists use one tab stop, Left/Right Arrow wrapping, Home, and End. Their selected state and controlled content stay synchronized.
- Toast results are visual only; the same text is retained in stable polite or urgent live regions so removing a toast does not remove the accessible result.
- At 720 px and below, controls and review are inert while closed. Opening a sheet moves focus to its close button; closing it from the button, backdrop, or Escape returns focus to the trigger when appropriate.
- Projects, sync state, Undo/Redo, and editing tools remain in the fixed bottom rail. Fit remains in the canvas toolbar. The rail and preview-mode row scroll horizontally rather than shrinking labels and targets indefinitely.
- Pan permits browser pinch zoom. Artwork positioning, Add material, Remove material, and Support reserve `touch-action: none` only while that editing mode owns the canvas. One primary pointer owns each gesture; secondary pointers are ignored, pointer capture preserves edge drags, and `pointercancel` releases ownership and commits the already-visible edit safely.
- Support work is not drag-only: tap-start/tap-end, the support list, numeric centre/length/angle/width controls, arrow movement, Select/Locate/Delete, Undo, and previous/next navigation remain available.
- The viewport metadata does not disable user scaling.

## Acceptance matrix

| Scenario | Automated/source evidence | Physical acceptance still required |
|---|---|---|
| 320, 390, and 430 px portrait | Fixed-height mobile shell, scrollable stage/view/tool rows, 44 px sheet actions, and source assertions | Inspect representative projects for clipped translated/localized copy and virtual-keyboard overlap |
| Phone landscape | Dedicated shorter chrome/tool sizing and sheet height cap | Android Chrome and iOS Safari/PWA rotation while a sheet and the software keyboard are open |
| Larger text / browser zoom | Rows scroll instead of compressing; app viewport remains bounded | 200% browser zoom and platform large-text settings with every stage, dialog, and long error message |
| Keyboard only | Core tests cover tab index calculation; source assertions cover roving tab state, Escape, visible focus, and non-drag support controls | Complete browser traversal, focus order, dialogs, and recovery after rerenders |
| Touch editing | Active-pointer ownership, pointer capture, mode-specific touch policy, and cancellation cleanup are regression-checked in source | Real Android and iOS: one-finger Pan, pinch zoom in Pan, OS interruption, edge drags, tap supports, and accidental second touch |
| Screen reader | Stable status/alert regions, labels, selected states, controlled relationships, and inert closed sheets are present | NVDA/Firefox or Chrome, VoiceOver/Safari, and TalkBack/Chrome announcement order and verbosity |

Do not mark the final column complete from responsive emulation alone. Record device, OS/browser/PWA mode, input method, project fixture, and observed failure. K14 does not claim full WCAG conformance; an assistive-technology audit and the physical checks above remain explicit release acceptance work.
