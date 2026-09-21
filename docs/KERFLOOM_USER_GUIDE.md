# Kerfloom user guide

Kerfloom turns a photograph or prepared drawing into connected, manufacturing-aware geometry for CNC cutting. This guide describes the complete creative-to-CAM workflow, the meaning of the manufacturing checks, project synchronization, device linking, export, and recovery.

> **Scope of the checks**
>
> Kerfloom checks the geometry it can measure: connectivity, configured openings, finished metal widths, close cuts, and the selected panel construction. It does not certify material strength, machine setup, consumables, heat distortion, cut order, lead-ins, fixturing, or the safety of a finished installation. Treat **Ready for CAM review** as the start of operator review—not as “ready to cut.”

## 1. The working model

Dark geometry is retained material. Light geometry is removed material. Kerfloom rebuilds the result from separate, reversible inputs:

1. the source image and tonal interpretation;
2. the selected cut style and its controls;
3. panel size, artwork placement, frame, and construction;
4. manual Add/Remove edits;
5. manual or accepted smart supports;
6. an optional generated manufacturing-repair layer.

This separation is why changing a photograph does not permanently bake in a repair and why an automatic repair can be reviewed or removed later. A change to an earlier dependency can make later validation or repairs stale; Kerfloom will ask for a fresh check rather than silently treating the old result as current.

### Canvas views

| View | Use it for |
| --- | --- |
| **Original** | Check the imported source and crop/placement context. |
| **Tone** | Inspect the actual light, midtone, and shadow field used by photographic styles. Open **Adjust tone** to tune brightness, contrast, shadow detail, smoothing, and separation. |
| **Artwork** | Inspect the generated style before panel structure and manufacturing overlays. |
| **Material** | Read the current retained-metal/cut-out geometry. This is the main editing view. |
| **Back-lit** | Judge the visual result as illuminated openings. |
| **Problems** | Locate validation findings and review repair proposals. |

Processing a style is not the same as validating it. The canvas distinguishes a provisional preview from processed geometry; only a successful, current validation can enable manufacturing vector export.

## 2. Quick start

1. In **Prepare**, import a PNG, JPEG, or WebP image. A prepared black-and-white drawing can use **Line art**; a photograph can use any photographic style.
2. Inspect **Tone** before choosing a pattern. Adjust the tonal field until important facial or subject features are clear without excessive texture.
3. Choose a cut style and use its recommendation as a starting point. Save promising variations as **Candidates**.
4. In **Panel**, choose real stock dimensions and orientation, position the artwork, select frame/anchor edges, and confirm the cutting profile.
5. In **Support**, connect material that would otherwise fall out. Preview smart supports or add and edit them manually.
6. In **Validate**, run all checks. Locate blockers, preview reversible automatic repairs, and make manual corrections where needed.
7. In **Export**, perform CAM review, then download SVG or DXF. PNG remains available as a visual proof and is watermarked when validation is absent or stale.

## 3. Prepare: source, tone, and styles

### Source images

- PNG, JPEG, and WebP are supported. HEIC/HEIF must be converted first.
- Line art is thresholded locally in the browser. Photographic styles use Kerfloom's private analysis service.
- **Remove background** isolates the detected subject. **Include clothing** keeps shoulders/body where supported by the style.
- Use **Tone** to understand what the style receives. Fix the interpretation before trying to compensate with many manual edits.

### Choosing a style

| Family | Style | Best starting point |
| --- | --- | --- |
| Prepared artwork | **Line art** | Logos and already-clean black-and-white drawings. |
| Portrait and stencil | **Poster stencil** | Bold grouped light/dark shapes with a poster-like result. |
|  | **Icon stencil** | Broad retained shapes, carved detail, and optional halo. |
|  | **Graphic portrait** | Expressive face-aware shapes on a removed background. |
|  | **Silhouette** | One simplified subject outline. |
| Lines and engraving | **Negative-space linework** | Bright feature and fold lines cut into a solid plate. |
|  | **Icon / Woodcut** | Short tapered marks that follow local form and light. |
|  | **Flow engraving** | Long ribbons that bend with broad facial or subject forms. |
|  | **Contour bands** | Topographic bands around tonal transitions. |
| Geometric patterns | **Slats** | Parallel bars whose thickness carries the image. |
|  | **Hatch** | A regular line rhythm with light regions opened. |
|  | **Radial cuts** | Dashes radiating from a chosen focal point and solid hub. |
|  | **Variable dots** | Staggered circular openings sized by local light. |
| Decorative | **Ornamental symmetry** | Mirrored linework for a balanced motif. |

The recommendation panel converts the current panel size and manufacturing limits into an explicit starting point. If Kerfloom clamps a pitch, width, or diameter to preserve a configured limit, it explains the adjustment beside the affected control. Recommendations remain creative starting points, not machine certification.

### Tone adjustments

- **Brightness** moves the overall interpretation lighter or darker.
- **Contrast** expands or compresses the tonal range.
- **Shadow detail** recovers or suppresses information in dark areas.
- **Surface smoothing** suppresses small texture so broader forms dominate.
- **Tone separation** makes the light/midtone/shadow groups more distinct.

The displayed dark/midtone/light percentages describe the interpreted image, not material percentages in the final panel. Re-render after a deliberate change and compare a saved Candidate before discarding a promising direction.

### Non-destructive material editing

Use **Add** to retain metal, **Remove** to create an opening, and **Restore** to reveal the generated artwork beneath earlier manual work. Each gesture is saved as an ordered operation in physical panel units instead of being baked into one bitmap. That means a later panel/raster refinement preserves stroke width and lets you correct one edit without undoing work that came after it.

- Freehand supports adjustable smoothing. It steadies the path, but does not change its physical width.
- Straight creates an exact capsule between two points. Hold Shift to constrain the direction to 15° increments.
- Region changes one connected area. Region edits can be hidden, changed, or deleted, but cannot be moved or resized like a stroke.
- Choose **Edit**, then select a stroke on the canvas or from **Manual edits**. Drag it, nudge it with Arrow/Shift+Arrow, change its action or width, temporarily hide it, or delete it.
- `[` and `]` change the active physical brush size; `X` swaps Add and Remove; holding Space temporarily pans.

The canvas HUD reports the active action and physical width. “Check after each edit” runs geometry review after release; it does not certify the result while the pointer is still moving. Restore affects the manual layer only—it does not delete generated artwork or silently remove accepted manufacturing repairs.

Projects created before this operation layer keep their existing painted pixels exactly as a compatible base. New edits are fully selectable; the older merged paint cannot be split into its historical individual strokes, but Restore can reveal generated artwork through it.

### Candidates

Candidates are creative checkpoints within the project. They preserve the style controls and enough derived state to restore the variation. Use them for alternatives such as “wide slats,” “soft face,” or “high contrast,” then Restore or Duplicate one. Candidates sync with the project; they are different from project Recovery points, which protect the broader editing workflow.

## 4. Panel: physical intent

### Dimensions, orientation, and placement

Set the real panel width and height before evaluating pitch, diameter, bridge width, or validation. Kerfloom preserves aspect ratio and does not intentionally stretch the source.

Use the artwork placement tool to:

- drag to position;
- zoom/scale within the panel;
- rotate freely;
- use arrow keys for 1 mm movement or Shift+Arrow for 10 mm movement;
- reset or fit when the composition is lost.

Unused letterbox area remains retained metal. Check the full sheet in **Material**, not only the subject crop.

### Cutting profile

Every saved project and retained export stores a snapshot of the active profile. Important fields are:

- **Kerf / tool diameter** — the expected removed path width, used for feasibility checks and legacy simulation.
- **Minimum gap between cuts / finished web** — the smallest strip of metal that should remain between separate cuts after machining.
- **Minimum opening** — the smallest removable feature the machine should be asked to produce.
- material, thickness, machine/consumable, support width/span assumptions, revision, and verification evidence.

The General plasma profile begins at a conservative 3 mm finished web and 2 mm opening. A 2 mm finished web is available as an exploration limit but must be confirmed for the actual machine, material, thickness, consumables, and cut strategy.

A profile is **Provisional** until an operator records its evidence from machine documentation or a shop test. Merely filling in ordinary dimensions does not verify the setup.

### Finished-edge CAM workflow

New Kerfloom geometry describes intended finished-part edges. Apply inside/outside kerf compensation exactly once in CAM. Do not compensate a second time because a kerf value is also present in the Kerfloom profile; that value supports checking and traceability.

### Frame, anchors, and construction

The frame defines retained material around the artwork. Anchor edges say which edges may structurally support retained geometry. In **One-piece panel**, every retained area must connect to the main panel/selected anchors. A future backed-panel construction may permit loose pieces, but it is not currently an alternative to validating a one-piece design.

## 5. Support: make the image hold together

An attractive cut pattern can still contain islands or very long unsupported slats. Supports add retained metal between otherwise separate or weak regions.

### Smart supports

**Suggest smart supports** produces a proposal, not an automatic final change. Review the dashed proposal and accept it only if it preserves the image.

- **Protect important detail** penalizes central and high-contrast portrait features.
- **Follow features** prefers dark areas and local structures such as brows, hair, folds, and shadows.
- **Follow filter direction** aligns ties appropriately for Slats, Hatch, or Radial cuts.
- **Stabilize long slats** adds sparse cross-ties when the configured span is exceeded.
- The aesthetic/secure strategy and organic variation change the balance between minimal structure and less-visible placement.

If no feature-aligned safe position exists, Kerfloom may show a fallback for review or decline to place a bridge. That is safer than claiming a poor placement is invisible.

### Manual supports

Choose **Support**, then drag from one attachment point to another or tap a start and end point. Select a support on the canvas or in the support list.

- Drag the centre to move it.
- Drag either endpoint freely to change both angle and length.
- Use the numeric controls for exact centre, angle, length, and width.
- Arrow keys move 1 mm; Shift+Arrow moves 10 mm.
- P/N moves to the previous/next support.
- Delete or Backspace removes the selected support.
- Escape clears the selected problem or support and cancels an unfinished support.

Endpoints should overlap retained material enough to survive the selected kerf and manufacturing process. Validation evaluates the combined result.

## 6. Manual editing

**Add** paints retained material; **Remove** paints cut-out. The physical brush size follows panel units. Freehand strokes, straight strokes, and connected-region edits are available from the tool settings.

A stroke may begin outside the visible sheet when the brush itself overlaps the panel; only the portion inside the panel changes geometry. One committed gesture creates one undo step. Enable the safety option when you want Kerfloom to report whether an edit leaves loose material.

Pan never edits geometry. Switch to **Pan** before navigating or using browser pinch zoom. Use Undo/Redo immediately when a gesture changes more than intended.

## 7. Validate and repair

### Run all checks

Validation examines the current combined geometry at the current physical scale. Findings are separated into:

- **Blocking errors** — must be resolved before SVG/DXF export.
- **Structural warnings** — advisory conditions that may benefit from strengthening or operator review.

Select **Locate** or a finding row to focus it. Next cycles through the individual occurrences. Escape clears the current highlight. After a manual Add/Remove or support correction, Kerfloom refreshes the affected review queue automatically; you should not need to rebuild the entire workflow after every fix.

### Common findings

- **Disconnected retained pieces** will not remain part of a one-piece panel. Connect them or remove them.
- **Opening too small** means a removed region is below the configured opening/tool-path limit. Enlarge or close it.
- **Cuts too close / insufficient finished web** means separate cuts leave less retained metal than configured. Add material locally, move a cut, or change the creative pattern.
- **Thin material outside a full-width core** identifies a bottleneck or region relying on material narrower than the configured web.
- **Long unsupported span** means a retained strip exceeds the configured stabilizer assumption.

Counts are grouped physical occurrences, not a promise that every pixel is an independent defect.

### Automatic repairs

Automatic repair is a previewable, reversible layer. Choose categories, build the preview, inspect the proposed geometry and counts, and accept or discard it. The planner protects long slat cuts from destructive whole-cut closure and can use small, local additions where they satisfy the configured finished web without erasing the pattern.

Each attempt remains available as a report, including attempts where no safe change was kept. **Physical effect** shows metal added and removed, total artwork area changed, finished-piece connectivity, and the area/components that survive the configured full-width-core check. The cell dimensions and diagonal state the raster sampling uncertainty; they are not machine tolerances. **Why planning stopped** distinguishes a completed pass, a safe partial result, rejected unsafe proposals, and the support-tie safety limit, then suggests the relevant manual or pattern-level next action. Expand **Planner diagnostics** to see considered, kept, and rejected candidate counts without recording the source image.

The preview records the exact cutting-profile revision, status, geometry interpretation, dimensions, limits, and validation-model version used to judge it. If one of those inputs changes, Kerfloom refuses to apply the old preview. Applied geometry is checked again under that same contract before it can participate in export readiness.

Manual corrections made after accepting repairs override only conflicting generated cells; unaffected automatic repairs stay active. Running checks again evaluates the combined result and does not, by itself, delete accepted repairs. Changing an upstream dependency—artwork, placement, panel geometry, polarity, or cutting limits—can invalidate that layer and require regeneration.

### Processing, cancellation, and device timings

Validation, repair planning, repair-choice evaluation, and smart-support planning run outside the interface thread. The progress card keeps the current geometry visible and offers **Cancel**; Escape also cancels while that card is active. Cancellation terminates the calculation and does not add geometry, Undo steps, recovery points, or save operations. A result computed for an older artwork revision, support configuration, repair plan, or cutting-profile contract is discarded automatically.

Processing failures stay visible with **Retry** and **Dismiss** instead of disappearing in a toast. Open **Help → Processing performance** to see the latest timings measured on that browser. Those local diagnostics store only task names, durations, outcomes, desktop/mobile layout, and timestamps—not artwork or geometry. Use them when reporting a slow operation. The deterministic repository baseline and physical acceptance checklist are in `docs/K16_PROCESSING_BASELINE.md`.

## 8. Export and CAM hand-off

- **PNG** is always available once geometry exists. If validation is missing, stale, or blocking, the PNG includes a visible validation watermark.
- **SVG** and **DXF** require a current validation with no blocking errors.
- SVG/DXF are exported in the selected drawing units and preserve true panel scale.
- Variable Dots retain true circle primitives in vector export when possible.
- The canvas status and Export stage show the effective X/Y millimetres per raster cell. This is the grid from which ordinary contour edges are traced; extra coordinate decimals do not create finer source geometry.
- Every newly retained PNG, SVG, and DXF includes an immutable release manifest in the encrypted project. It records hashes of the exact geometry and exported bytes, dimensions, units, cutting-profile snapshot, compensation contract, processing/validation versions, validation time and findings, and output identity. The manifest follows server sync and project sharing.
- File names include the project, panel size, style, frame choice, purpose, and a timestamp.
- An editable project download preserves settings and geometry but intentionally omits the original photograph. The encrypted server project retains the photograph when it was saved successfully.

Before sending geometry to the machine, confirm units, stock size/orientation, material polarity, frame, profile evidence, scale, duplicate contours, lead-ins, cut order, heat strategy, fixturing, and one—and only one—CAM kerf compensation step. Use a coupon or reduced-risk test for a new setup.

The release record makes an export identifiable and tamper-evident; it is not a machining certificate. Current SVG/DXF contours still follow grid-aligned raster boundaries except for preserved Variable Dot circle primitives. Optional curve fitting is not enabled until fitted vectors can be checked directly for topology and physical error.

## 9. Projects, autosave, and recovery

Open **Projects** from the desktop header or mobile tool rail. Cards show the generated artwork preview, panel size, style, validation state, time, and source availability. You can open, rename, duplicate, download, share, or move a project to Trash. Trash remains recoverable until **Delete forever**.

Kerfloom saves every edit to a local IndexedDB cache first, then uploads a complete encrypted project bundle through a durable queue. The status distinguishes:

- **Saving…** — a local or server write is in progress;
- **Saved to server** — the server acknowledged the current revision;
- **changes waiting to sync / Offline** — the local copy is safe on this device and queued;
- **Server sync failed — Tap Sync** — the queue still needs attention;
- **Device storage full / local cache failed** — the latest edit may not be safely cached; stop and resolve this before closing.

`Ctrl/Cmd+S` requests an immediate save. Kerfloom also keeps up to ten Recovery points after important milestones such as validation, repair, accepted smart supports, and export. Recovery points restore an earlier project state; Candidates compare creative alternatives.

If concurrent edits cannot be reconciled, Kerfloom preserves work as a conflict copy rather than silently overwriting either version. Rename and compare the copies, then move the redundant one to Trash.

## 10. Linked devices and project sharing

### Work on the same projects

On an already linked device, open **Projects → Devices**, name the new device, and create a one-time link. Scan its QR code or send the link privately. Opening it on the phone/tablet/computer joins that browser to the same encrypted workspace, so both devices see the same project library after synchronization.

The invitation expires, can be cancelled before use, and can be claimed once. If the receiving browser already belongs to another workspace, Kerfloom asks before replacing that connection. Confirm that the current device says **Saved to server** before moving to another device, and tap Sync on the destination if needed.

The current device cannot accidentally revoke itself from the Devices screen. To move that browser to another workspace, open the new workspace's invitation and explicitly confirm the replacement. Do not clear site data until unsynced work is uploaded or downloaded as a project file; clearing storage removes the offline cache and queue.

### Give someone an independent copy

**Share** creates an encrypted server snapshot for one invited recipient. It can include the editable project, original source, candidates, edits, supports, repairs, recovery points, and retained export artefacts. The recipient imports an independent copy: later edits do not flow between owner and recipient.

Treat a share link like a secret. It expires after the selected period and can be revoked, but revocation cannot erase a copy already imported by the recipient.

## 11. Mobile and keyboard use

On a narrow screen, the canvas stays fixed in the available viewport. Tap a numbered stage to open its controls as a bottom sheet, close it to inspect the canvas, and open Candidates/Problems for review. The permanent bottom rail scrolls horizontally and keeps Projects, Sync, Undo/Redo, and editing tools available.

### Install the PWA

- **Windows:** open Kerfloom in Microsoft Edge or Google Chrome and choose the install icon in the address bar. The same action is available from the browser's Apps / Install menu.
- **Android:** open the browser menu and choose **Install app** or **Add to Home screen**.
- **iPhone/iPad:** open Kerfloom in Safari, choose **Share**, then **Add to Home Screen**.

After a Kerfloom update, open the installed app while online and allow it to refresh before relying on offline use. The app avoids replacing active code in the middle of a busy edit.

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+S | Save/sync now |
| Ctrl/Cmd+Z | Undo when canvas owns focus |
| Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z | Redo when canvas owns focus |
| F | Fit panel to view |
| + / − / 0 | Zoom in / out / reset |
| I | Apply/open Icon stencil |
| K / R / E / V / B | Add / Remove / Restore / Edit manual operations / Support |
| [ / ] | Decrease / increase physical brush size |
| X | Swap Add and Remove |
| Hold Space | Temporarily Pan while the canvas owns focus |
| P / N | Previous / next support |
| Delete / Backspace | Delete selected support or manual edit |
| Arrow keys | Move selected support, manual stroke, or artwork 1 mm |
| Shift+Arrow | Move selected support, manual stroke, or artwork 10 mm |
| Escape | Clear highlight/selection, cancel support, close tool settings, or return to Pan |

Native text-field undo always wins while a field is focused. Workflow, review, and project tabs support Left/Right Arrow, Home, and End. In Pan, browser pinch zoom remains available; editing tools reserve one primary pointer for a deliberate gesture.

## 12. Privacy and security

- Linked devices use a secure HttpOnly device credential. The browser also keeps non-secret workspace metadata so an already-authorized installed PWA can open its encrypted local cache while offline.
- Complete server project bundles and share packages are encrypted at rest.
- Photograph styles send the source to the private analysis service; they are not purely local operations.
- One-time device secrets and project-share secrets are carried in the URL fragment so they are not sent as ordinary request paths or query strings.
- A disconnected or revoked device loses future server access when it next connects. No web service can remotely erase project data already cached while that device remains offline.

Protect the operating-system account, use HTTPS, keep invitation/share links private, revoke lost devices from another linked device, and avoid shared browser profiles for sensitive artwork.

## 13. Troubleshooting

### Sync spins for a long time or turns red

Keep the app open and online, tap **Sync**, and check whether the pending count falls. One damaged/older project should not block healthy projects, but the status may remain red while any queued item fails. Open Projects to identify conflict copies. Do not clear browser data as a first response.

### A project is missing on another device

Confirm both devices appear in **Projects → Devices**, the source device says **Saved to server**, and the destination has completed Sync. Sharing a project does not link workspaces; it creates a separate copy.

### Tone controls are not visible

Select **Tone**. The Prepare panel opens the Image interpretation controls; expand **Adjust tone** if it is collapsed. Tone is meaningful for photographic styles and still available for inspecting their input.

### A repair layer needs regeneration

An upstream input changed after the repair was planned. Remove/regenerate the repair preview against the current artwork and profile. Do not rely on a hidden stale layer.

### SVG/DXF is disabled

Import or generate geometry, run all checks, and resolve every blocking error. A PNG proof is still available and will carry a watermark when the state is not validated.

### The canvas seems lost or zoomed into the wrong place

Select Pan and press **F** or the **Fit** button. For project thumbnails and identification, Kerfloom fits the entire generated panel rather than intentionally cropping to a detail.

### Smart support cannot find a placement

Relax non-structural aesthetic preferences, add a manual support in a less visible dark feature, widen the available retained attachment area, or revise the pattern. Do not lower manufacturing limits only to make the proposal succeed unless the new values are verified for the real process.

## 14. Final release checklist

Before committing a panel to CAM:

- [ ] The intended project and latest revision are open.
- [ ] Panel size, orientation, units, polarity, frame, and artwork placement are correct.
- [ ] The cutting profile matches the real process, material, thickness, machine, and consumables.
- [ ] Important details remain recognizable in Material and Back-lit views.
- [ ] Smart and manual supports are visually acceptable and have adequate attachment.
- [ ] Validation is current; blockers are zero; warnings were reviewed deliberately.
- [ ] Automatic repairs were inspected at useful zoom and did not erase the creative pattern.
- [ ] SVG/DXF scale and contours were checked in CAM.
- [ ] Kerf compensation is applied exactly once, in CAM.
- [ ] Lead-ins, cut order, heat, fixturing, and safe machine operation were reviewed by the operator.
- [ ] A test coupon or low-risk trial is planned for a new profile.

## Glossary

- **Retained material** — metal that remains in the finished panel.
- **Opening / cut-out** — material removed from the panel.
- **Kerf** — width removed by the cutting process.
- **Finished web / gap between cuts** — retained metal between neighboring cuts after machining.
- **Support / bridge / tie** — added retained material connecting geometry.
- **Anchor edge** — a panel edge allowed to support connected retained material.
- **Candidate** — a saved creative alternative inside a project.
- **Recovery point** — a project checkpoint created at a significant workflow event.
- **Repair layer** — reversible automatic additions/removals generated to address selected findings.
- **Current validation** — checks performed on the exact geometry and profile now being exported.
- **Provisional profile** — useful starting limits without recorded machine documentation or test evidence.
- **Ready for CAM review** — Kerfloom found no blocking geometry errors; operator/CAM responsibilities remain.
