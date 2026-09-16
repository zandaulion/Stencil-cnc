# Kerfloom: workflow audit and implementation action plan

Date: 16 September 2026. Repository examined: `/home/opc/projects/stencil-cnc`, commit `87429e2`.


## Start here: handoff to Sol

Owner's goal: **frictionless creative workflow, guided and bound by material/CNC limitations.**

This is the durable, self-contained handoff. Read the findings before treating recommendations as requirements. The repository is still named `stencil-cnc`; the product is Kerfloom.

- [Scope and evidence confidence](#scope-and-confidence)
- [All 28 usage patterns](#usage-pattern-inventory-and-audit)
- [Evidence register F1–F11](#evidence-register-findings-that-should-drive-priorities)
- [Proposed user experience](#proposed-user-experience-to-discuss)
- [Implementation guardrails and decisions](#implementation-guardrails-and-decisions)
- [Prioritized work packages K01–K21](#implementation-backlog)
- [Verification and handoff requirements](#verification-and-handoff-requirements)
- [Suggested starting prompt](#suggested-starting-prompt-for-sol)

**Implementation status (16 September 2026): the trust milestone through K08 and K07 are deployed. A first K12 tone-interpretation increment is implemented in this release.** K01 remains the continuing regression workstream. The exact status and remaining tests are recorded below. Line references to audit evidence identify the original audited commit and must be rechecked as the code moves.

The owner should select a bounded batch for implementation. Recommended first batch: regression fixtures for that batch, browser workspace isolation, sync correctness, and the false structural warning. Resolve the kerf/CAM decision in parallel before changing that geometry contract. Do not attempt all packages as one rewrite.

## Executive assessment

Kerfloom has a useful foundation: physical-unit pattern generation, editable supports, nondestructive repair layers, grouped defect locations, server-backed projects, and export tied to the validated geometry. These should be retained.

The main obstacle to frictionless creation is not a shortage of filters. It is confidence: whether measurements mean what they say, whether warnings are real, whether a saved variation restores the same artwork, and whether “Saved to server” means the latest edit reached the server.

Recommended product direction: **a creative workspace guided by a remembered cutting profile, with reversible experiments and an explicit manufacturing-release review**. Most constraints should guide generation; repairs should handle exceptions. Drafts should remain easy to save, compare, and share without implying they are ready to cut.

This document began as the audit and proposed implementation handoff for Sol. The implementation record below now distinguishes subsequent code changes from the original findings. The trust milestone through K08 was deployed on 2026-09-16; each later item states whether it is only local. No production project data or hostname migration was changed. Decision-gated work below still requires the indicated agreement; recommendations are not evidence of completed fixes.

### First trust milestone implementation record

This repository now contains the following implementation increments:

- **K02 — implemented, real-browser acceptance pending.** Browser databases are named by the server-verified workspace identifier. Offline startup requires a previously verified identifier. The former origin-wide database is quarantined and can only be copied into the current workspace through an explicit, reversible Projects-library action; it is never auto-uploaded. Every project API request also carries its originating workspace identity; the server rejects a stale tab after another tab changes the authentication cookie. A fresh-browser Chromium check verified separate A/B project stores and deliberate legacy import; HTTP integration tests verify the stale-session fence.
- **K03 — implemented, real-browser acceptance pending.** Queued operations carry immutable IDs and workspace ownership. Server acknowledgement atomically removes only the exact operation or rebases a newer pending edit. Per-project writers use local serialization plus Web Locks where available. Actual upload/download responses provide the recorded revision. A conflict copy that cannot upload remains visibly queued. Tests now cover independent-tab serialization, an edit racing permanent deletion, tombstones, lost upload/delete responses, content-hash acknowledgement recovery, stale list metadata, and offline conflict copies. A physical two-tab/browser run plus quota and partial-cache interruption remain open.
- **K06 — verified for the selected regression.** A solid panel in no-anchor/single-piece mode no longer receives an invented narrow-connection warning, while a real narrow-neck fixture still warns. The wider repair-count and multi-resolution matrix remains open.
- **K08 — implemented, real-browser acceptance pending.** New candidates use a versioned complete snapshot containing style state, manual edits, supports, manufacturing repairs, raster-coordinate provenance, and a deterministic final-geometry fingerprint. Restore preserves those layers, verifies the resulting geometry, invalidates the old validation certificate, and remains one Undo step. Version-1 projects migrate without inventing repairs for legacy candidates; those candidates are labelled as legacy recipes requiring review. The outer project schema is now version 2 so an older offline client fails safely instead of silently rewriting and truncating the new candidate payload.
- **K01 — partial, continuing.** Twenty-one JavaScript tests were added for the selected storage/sync/geometry/candidate/export defects. Later kerf-contract, broader browser interaction, quota, and cache-durability fixtures remain pending.
- **K07 — deployed.** New projects use finished-part boundaries with compensation applied once in CAM. Generation, repair targets, preview, validation, and export copy share that contract. Project schema version 3 retains older rasters as explicit legacy uncompensated geometry until the owner upgrades them. Numerical regressions cover below/at/above-minimum gaps, zero/nonzero kerf, anisotropic cells, rotated cuts, bridge width, and migration.
- **K12 — partial, implemented in this release.** The canvas now exposes an explicit Tone view between Original and Artwork. Photograph renders return the exact normalized tonal field used by the selected generator, plus dark/midtone/light proportions; line art shows its actual treated grayscale field. The interpretation controls are labelled as a distinct stage and remain reversible. Style thumbnails and A/B comparison remain open.
- **K09 — partial.** Permanent-delete copy now states the server-workspace/all-linked-device effect. Other truth-in-copy items remain pending.
- **K17 — deployed, app-level browser acceptance pending.** PNG preview is available whenever artwork geometry exists. A preview without a current passing validation receives a branded, high-contrast “not validated for cutting” watermark and a `draft-preview` filename; SVG and DXF remain blocked. Validated PNG remains unwatermarked. The existing artifact path retains and synchronizes either PNG through the authoritative project save flow. A Chromium rasterization smoke test verified that the watermark is visibly drawn and the canvas encodes a non-empty PNG.
- **K04 — implementation complete; physical suspension acceptance remains.** Downloaded project, source, checkpoint, and retained-export data is staged before replacement and committed through one multi-store IndexedDB transaction. The editor writes locally after a short independent debounce, queues the immutable generation without starting network I/O, and uploads after a longer debounce. Backgrounding triggers a local-only flush, while a durable change marker makes an edit recoverable on reopening even if suspension happened before its outbox entry was written. A mobile startup follow-up reopens the complete cached project before background reconciliation and gzip-compresses large complete-project uploads; this addresses an observed 34.9 MB request abort without changing canonical bundle hashes or revision checks. Transient failures now use a deduplicated five-attempt 5-second-to-5-minute backoff while the app is active, with a visible pending-project count and explicit syncing, queued, offline, and action-required states. Quota failures preserve the last committed project/outbox, prevent remote reconciliation over an uncached in-memory edit, and give persistent recovery guidance. Synchronization now contains download, queue, and upload failures to the affected project; it rebuilds damaged outbox entries from complete local projects, assigns retries a deterministic conflict-copy identity, atomically moves the outbox operation, and rebinds the open/last project when a conflict copy replaces it. Unrelated permanent failures are reported as amber attention rather than falsely marking the current server-saved project red.

Latest verification before this sync-hardening deployment: **196/196 JavaScript tests passed** and **74/74 Python tests passed**. Syntax and diff checks passed. Client tests verify gzip round-tripping, durable pending-count recovery, bounded/deduplicated retry policy, per-project failure isolation, damaged-outbox reconstruction, and deterministic conflict retry. HTTP integration verifies server-side decompression before encrypted storage. The isolated Chromium workspace/legacy-import, draft-watermark rasterization/PNG-encoding, IndexedDB replacement rollback, and reopen-without-outbox recovery smoke tests passed. The existing `portfolio-screenshots/` assets were left untouched.

## Scope and confidence

Reviewed the current UI, editor, image-processing configuration, geometry, validation, repairs, export, persistence, synchronization, authentication, sharing, and deployment documentation. Historical screenshots provided context; findings were checked against the current source.

Verification performed during the preceding audit (not rerun merely to create this document):

- Existing JavaScript suite: 140 tests passed.
- Existing Python suite: 71 tests passed.
- Two isolated geometry reproductions demonstrated validation defects.
- Three isolated, in-memory synchronization reproductions demonstrated revision, queue, and workspace-isolation defects.
- Local Chromium layout checks at 1366 × 768 and 390 × 844, with fresh temporary storage, APIs blocked, and the editor in offline mode. This checked layout, not authenticated production behavior.

Evidence labels below distinguish **reproduced**, **confirmed in code**, **design opportunity**, and **needs operational/device verification**. Passing tests do not establish fabrication safety, production security, or a complete accessible experience. No actual metal was cut, no target CAM import was performed, no production penetration test was attempted, and no backup was restored.

The benchmark is deliberately mixed: WCAG provides accessibility criteria; OWASP provides security guidance; manufacturer/fabricator guidance informs process constraints; usability research informs interaction design. Not every recommendation is a formal standard or a compliance requirement.

## Usage-pattern inventory and audit

### A. Start and explore

| Pattern / user intent | What works | Best-practice comparison and proposed direction |
|---|---|---|
| 1. Open or resume a project | Projects, thumbnails, recovery points, last-project reopening. | Fast resumption should not require the entire library. Startup currently waits for sequential synchronization of full project bundles. Show metadata first, open the current project promptly, download other assets on demand. |
| 2. Import and prepare a photo/drawing | Drop zone, file metadata, polarity, background removal, portrait options. | Supported input formats and privacy statements must match behavior. HEIC is advertised but omitted from the picker’s accepted types; verify the full conversion path. “Your source stays on this machine” is outdated now that analysis and project storage are server-side. |
| 3. Explore visual styles | Thirteen styles, grouped chooser, contextual parameters, retained per-style settings. | Recognition is easier than recalling text descriptions. Add representative style thumbnails, then test whether same-photo previews and A/B comparison justify their rendering cost. This is a design opportunity, not a confirmed usability failure. |
| 4. Tune visual detail | Physical pitch/diameter controls, tone controls, constrained generation, stale-response protection. | Make automatic adjustments visible beside the affected control. Explain “raised pitch to preserve the selected web” and offer reversible alternatives. A short toast should not be the only record of an important adjustment. |
| 5. Keep and compare alternatives | Named candidates, thumbnails, duplicate and restore. | A candidate should reproduce its thumbnail. Current candidates omit manufacturing repairs and restore clears them. Fix snapshot fidelity first; then consider comparison and rename. |
| 6. Undo an experiment | Undo/redo, gesture-level history, repair-layer undo. | Text editing and geometry editing need separate undo contexts. Ctrl/Cmd+Z currently reaches project history before checking whether the user is typing in a field. |

Relevant benchmarks: visible state, consistent actions, recovery, and recognition in [Nielsen Norman Group’s usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/); keeping secondary controls available without crowding the primary task in [progressive disclosure guidance](https://www.nngroup.com/articles/progressive-disclosure/). The specific changes above are audit recommendations, not prescribed UI layouts from those sources.

### B. Work within material and machine limits

| Pattern / user intent | What works | Best-practice comparison and proposed direction |
|---|---|---|
| 7. Choose fabrication constraints | Kerf, opening, finished web, and support width use physical units. | One disabled Plasma profile and global 2 mm/3 mm floors do not describe a particular machine, material, or thickness. Introduce remembered, versioned shop profiles with provenance and an explicitly provisional custom profile. |
| 8. Size and place the panel | ISO presets, custom size, orientation, frame/margins, fit-to-frame, units. | Physical feedback must follow the actual sheet and viewport. The ruler labels are hardcoded to the original 1250 × 2500 layout; the separate scale indicator is dynamic. Fix the rulers. Warn clearly when resizing invalidates manufacturing assumptions or changes pattern density. |
| 9. Paint or place manual material | Live stroke feedback, pointer capture, add/remove operations. | Keep operations reversible and separate tool choice from style choice. The “Icon” toolbar command changes the cut style, rather than selecting an editing tool. Clarify or relocate it. |
| 10. Generate smart supports | Minimal/Aesthetic/Secure, feature preference, filter alignment, post-kerf checks, stale-support detection. | Appearance-sensitive automatic edits benefit from a preview and an explanation of unavoidable bright-area placements. Offer preview/accept/regenerate without forcing a confirmation dialog for every small edit. Structure takes precedence over darkness preference. |
| 11. Select and adjust one support | Enlarged hit zones, free endpoint rotation, length/angle/width fields, keyboard nudging once selected. | Selection is still pointer-only; dragging in Pan mode over a support can move it. Provide explicit selection rules, a selectable support list or next/previous navigation, and tap/numeric alternatives for placement and translation. |
| 12. Understand fabrication feasibility | Before/after-kerf views, material/back-lit/problem views, full-width-core approximation. | Connected geometry is not a strength prediction. Clearly separate topology, profile-specific manufacturability, and unmodelled heat/handling/mounting effects. Never present an arbitrary allowance as universally “safe.” |

Process limits vary with material thickness and cutting setup; they should come from the owner’s machine documentation, shop experience, and test coupons, not universal ratios. See [Hypertherm’s hole-quality guidance](https://www.hypertherm.com/resources/system-support/maintenance-and-use/cut-quality/hole-quality/). Kerf compensation, lead-ins, and sequencing also need an explicit division of responsibility with CAM: [Hypertherm’s CAM overview](https://www.hypertherm.com/solutions/technology/cam-software/).

### C. Inspect, correct, and deliver

| Pattern / user intent | What works | Best-practice comparison and proposed direction |
|---|---|---|
| 13. Validate and locate problems | Grouped counts, location cycling, kerf connectivity checks, revision-bound export validation. | Trust is presently impaired by a reproduced finished-gap check inconsistency and a reproduced false full-width-core warning. Fix these before optimizing repair counts. “The panel holds together” overstates the result of geometric checks. |
| 14. Fix blocking defects in bulk | Preview, apply/discard, bounded planning, reversible repair layer, revalidation. | Preserve these safeguards. Explain why a run stopped: budget exhausted, no candidate met constraints, changes would damage detail, or a manual decision is needed. “No change kept” does not prove no repair exists. |
| 15. Optionally reduce structural warnings | Separate warning step after blocking errors, opt-in geometry changes. | Measure physical improvement and visual loss, not just numbers of segmented warning locations. Keep advisories distinct from failures. Allow users to inspect and intentionally accept remaining advisory risks without calling them resolved. |
| 16. Share an unfinished visual | PNG export and preview-oriented filenames exist. | PNG is gated by the same validation condition as CNC files. Permit draft previews whenever artwork exists, visibly labelled unvalidated. Do not relax the manufacturing-export gate to achieve this. |
| 17. Export for fabrication | SVG/DXF closed contours, explicit units, timestamps, stale validation blocks export. | Define whether contours are finished boundaries or torch centre paths. Report effective geometric resolution, profile revision, warnings, units, and CAM assumptions. Raster stair steps are not smooth curves; decimal formatting is not machining tolerance. |
| 18. Reproduce an earlier fabrication result | Project bundles, checkpoints, retained export artifacts. | Treat each manufacturing release as immutable: final geometry, export, profile, processing version, and validation report should identify the same revision. Verify reopening and re-export round trips, rather than assuming parameter similarity means identical output. |

The existing closed-contour/unit handling is aligned with fabrication preflight. Excessive nodes, dimensions, and features still need CAM/fabricator review; see [SendCutSend’s file checklist](https://sendcutsend.com/faq/do-you-have-a-file-setup-checklist/). Draft sharing and manufacturing release should be separate user intents, even when they originate from the same artwork.

### D. Preserve, synchronize, and share work

| Pattern / user intent | What works | Best-practice comparison and proposed direction |
|---|---|---|
| 19. Organize projects and recover deletions | Search, status, thumbnails, rename, duplicate, Trash, versions. | Permanent-delete confirmation currently says “from this device” but deletes the server project for the workspace. Distinguish offline-cache removal, Trash, and deletion everywhere. |
| 20. Autosave and work through disconnection | Local cache/outbox, server revisions, retry controls, save indicators. | A reproduced acknowledgement race can discard newer queued work, and checkpoints can cause false conflicts. Centralize saving, acknowledge exact operation generations, and keep local durability independent of networking. |
| 21. Continue on another device or tab | Workspace-based server projects and optimistic revision checks. | Browser storage is not workspace-scoped. A reproduced workspace change uploads old cached projects into the new workspace. Scope cache, queue, and last-opened state to verified workspace identity; coordinate writes across tabs. |
| 22. Send an editable project to another person | Complete snapshot bundles, authenticated recipients, expiry and revocation. | Shares are owned by a device while projects are owned by a workspace. Another linked device cannot manage those outgoing shares. Make the sharing model explicit: editable copy versus collaborative project; retain immutable snapshots by default. |
| 23. Control access and understand privacy | Authenticated APIs, hashed random tokens, secure HttpOnly cookie, authenticated encryption, storage quotas. | Need visible linked-device management, revocation/recovery, accurate photo-storage copy, and a deliberate token lifetime/rotation policy. Server authorization does not compensate for cross-workspace browser-cache mixing. |
| 24. Survive host, storage, or browser failure | Backup requirements are documented; encrypted bundles and checkpoints exist. | Atomic replacement, key recovery, and tested off-host backups need evidence before the server is treated as the sole durable copy. No restore drill was verified. External backup automation may exist outside the repository. |

Benchmarks: [OWASP workspace/tenant isolation guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html), [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), and [OWASP cryptographic storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html). Cache and queued operations need the same identity boundary as the server; encryption also requires a recoverable key lifecycle.

### E. Cross-cutting usage: phone, accessibility, responsiveness

| Pattern / user intent | What works | Best-practice comparison and proposed direction |
|---|---|---|
| 25. Create on a phone/tablet | Installable PWA, persistent project/sync/undo controls, responsive dialogs. | Parameters and results are far apart vertically. At 390 × 844, even an empty Line art workspace places the canvas about 1380 CSS px below the page top. Test a canvas-first workspace with collapsible control sheets. Toolbar labels are about 7.7 px and visually crowded. |
| 26. Use touch, keyboard, or assistive technology | Native controls/dialogs, labels, status announcements, reduced-motion support. | White text on primary orange is about 3.51:1, below 4.5:1 for normal text. Support selection lacks keyboard access; global single-character shortcuts are not canvas-scoped; tablists lack expected keyboard behavior. Multi-pointer ownership and touch navigation require real-device tests. |
| 27. Stay in the creative loop during processing | Async server rendering, stale-result protection, live painting. | Heavy repair and support planning still run synchronously after a paint yield; no cancelable worker-based execution. Save/render transfers also resend large data. Measure real interaction latency before choosing an optimization target. |
| 28. Understand failure and find the next action | Progress messages, help entry points, grouped errors, retry actions. | Important failures/help disappear after about 4.2 seconds. Keep actionable messages beside affected controls, with a persistent explanation and a useful next step. Avoid requiring users to interpret thousands of raster locations unaided. |

Accessibility benchmarks: [WCAG contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [non-drag alternatives](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html), [keyboard access](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html), [character shortcuts](https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html), and [ARIA tab behavior](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/). Measured mobile toolbar buttons were roughly 32 × 52 px; their small labels do not by themselves establish failure of WCAG’s 24 px minimum target criterion.

For responsiveness, [web.dev’s INP guidance](https://web.dev/articles/optimize-inp) provides a useful real-user target of at most 200 ms at the 75th percentile. This audit did not measure Kerfloom’s INP. [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) are a suitable option for heavy computation, with cancellation and stale-result handling designed into the protocol.

## Evidence register: findings that should drive priorities

### F1. A below-minimum finished gap can pass — reproduced, high priority

The UI defines the minimum as finished metal remaining after kerf, but the hard cut-gap check measures the original cut regions against that minimum. Later post-kerf morphology produces advisories rather than necessarily blocking the export.

Synthetic reproduction: a 100 × 100 mm panel with two rectangular openings separated by 4 mm, a 2 mm kerf, and a 3 mm minimum finished web. The simulated web is 2 mm, but validation returns `valid: true`, no errors, and structural warnings.

Evidence: [gap check](/home/opc/projects/stencil-cnc/web/core/validation.js:182), [UI definition](/home/opc/projects/stencil-cnc/web/index.html:223), [editor validation options](/home/opc/projects/stencil-cnc/web/editor.js:1229).

Resolve the intended kerf/CAM dimensional model first. Then make generation, repairs, preview, and hard validation agree. Under the current erosion model, either measure after kerf or include kerf in the pre-cut spacing requirement. Do not merely promote every morphological warning into an error: rounded edges and raster uncertainty need different treatment.

### F2. A solid panel receives a weak-connection warning — reproduced, high priority

Using the editor’s configuration (`anchorBoundary:false`, `requireAnchored:false`, `requireSingleComponent:true`), a completely solid 100 × 100 mm mask produces one full-width core and zero thin pixels, yet reports a region relying on a narrow connection.

The connectivity helper calls unanchored components “islands.” Validation interprets those as disconnected minimum-width cores, even though this editor mode intentionally requires no external anchor.

Evidence: [island definition](/home/opc/projects/stencil-cnc/web/core/connectivity.js:58), [warning condition](/home/opc/projects/stencil-cnc/web/core/validation.js:232).

This explains a baseline false warning and can inflate larger counts; it does not prove all warnings on earlier user images were false. Establish the correct main-core/baseline connectivity before evaluating weakening. Add a solid-panel no-warning regression test.

### F3. Save/revision handling is not reliable enough — reproduced, high priority

Three related sequences matter:

1. Normal save records revision 1. Creating a checkpoint uploads revision 2 without updating the editor’s revision. The next ordinary edit submits revision 1 and forks a conflict copy, despite no other device editing.
2. Upload A is in flight. Edit B replaces the pending operation. A completes and unconditionally deletes the project’s pending entry. B is not uploaded, but its cached record is stamped with A’s revision.
3. A conflict copy upload can remain queued, but its result is relabelled `conflict`, which the editor treats as saved. Separately, downloads can associate a newer bundle with stale metadata from an earlier list request.

The first two were reproduced in isolated sync-module harnesses. The third is confirmed in source, not a production incident claim.

Evidence: [acknowledgement and outbox deletion](/home/opc/projects/stencil-cnc/web/project-sync.js:260), [checkpoint sync](/home/opc/projects/stencil-cnc/web/editor.js:2895), [export artifact sync](/home/opc/projects/stencil-cnc/web/editor.js:4908), [conflict status](/home/opc/projects/stencil-cnc/web/project-sync.js:197), [download metadata](/home/opc/projects/stencil-cnc/web/project-sync.js:137).

Recommendation: one save/revision service, immutable operation generations, compare-before-acknowledging, response-authoritative revisions, and per-project write serialization across callers/tabs. [MDN Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) describes coordination across same-origin tabs; this is one implementation option, not the only one.

### F4. Changing workspace can mix private projects — reproduced, high priority

IndexedDB contains one origin-wide project library/outbox without a workspace key. Library sync treats cached projects missing from the authenticated server workspace as data to recover/upload. The isolated reproduction populated two workspace-A projects and returned an empty workspace-B library; both A projects were uploaded into B.

Evidence: [storage namespace](/home/opc/projects/stencil-cnc/web/storage.js:1), [automatic recovery/upload](/home/opc/projects/stencil-cnc/web/project-sync.js:326), [authentication handoff](/home/opc/projects/stencil-cnc/web/app.js:116).

This is a conditional privacy defect for switching workspace identity in the same browser, not evidence that the server lets arbitrary outsiders read projects. Scope local data and queued work to verified identity; require a deliberate import decision for legacy unowned data. Keep hostname migration deferred as requested.

### F5. Restoring a candidate can change the saved appearance — confirmed in code, high priority

Candidate thumbnails are generated from final design geometry, but their saved payload excludes manufacturing repairs. Restore explicitly clears those repairs.

Evidence: [candidate capture](/home/opc/projects/stencil-cnc/web/editor.js:4045), [candidate restore](/home/opc/projects/stencil-cnc/web/editor.js:4095).

A creative snapshot must preserve the complete appearance-producing state. Validation can be rerun after restore; silently losing visible repairs is different from invalidating a validation certificate. Add a repaired-candidate round-trip test comparing final geometry, not only controls.

Local implementation status: K08 now stores the repair layer and final-geometry fingerprint, reproduces that geometry in core round-trip tests, and gives legacy candidates explicit review-required copy. A real-browser candidate save/restore acceptance pass remains open under K01.

### F6. Some physical and editing feedback is misleading — confirmed in code

- Ruler ticks remain the original 1250 × 2500 labels: [HTML rulers](/home/opc/projects/stencil-cnc/web/index.html:1024). The separate [scale indicator](/home/opc/projects/stencil-cnc/web/editor.js:2307) does update. Generate ticks from sheet units and viewport transforms.
- Text-field undo is intercepted before editable-target handling: [keyboard handler](/home/opc/projects/stencil-cnc/web/editor.js:6178).
- Icon acts as an apply-style command in the tool rail: [tool behavior](/home/opc/projects/stencil-cnc/web/editor.js:5015).
- Permanent deletion describes a device-only effect but invokes server deletion: [confirmation and deletion](/home/opc/projects/stencil-cnc/web/editor.js:3317).

These are small interfaces with disproportionate effects on confidence. The deletion wording deserves immediate attention; the others should be fixed alongside interaction regression tests.

### F7. Manufacturing semantics and precision need an explicit contract — confirmed design gaps

The current profile has no material, stock thickness, machine/consumable, or verification provenance: [profile model](/home/opc/projects/stencil-cnc/web/core/project.js:17), [disabled selector](/home/opc/projects/stencil-cnc/web/index.html:210). Global opening/web floors are enforced in [editor constraints](/home/opc/projects/stencil-cnc/web/editor.js:247).

Generators reserve kerf allowance; validation erodes retained metal; export emits un-eroded contours while the interface says to leave compensation to CAM. Depending on the CAM offset setting, physical output can differ from the erosion preview. This is an unresolved contract, not proof every exported file cuts incorrectly. See [export controls](/home/opc/projects/stencil-cnc/web/index.html:885).

SVG traces pixel edges and removes collinear points, not staircase curvature; DXF uses the same contour geometry: [SVG tracing](/home/opc/projects/stencil-cnc/web/core/svg.js:17), [DXF polylines](/home/opc/projects/stencil-cnc/web/core/dxf.js:83). Analysis targets three pixels per smallest limit and caps width at 2600: [resolution policy](/home/opc/projects/stencil-cnc/analiza/app.py:58). For a 1250 mm analysis width with a 2 mm minimum, 1875 cells correspond to roughly 0.667 mm per cell. Final effective spacing must be calculated from actual mask dimensions and placement.

Proposed handoff: desired dimensions, units, selected/versioned cutting profile, compensation responsibility, effective resolution/tolerance, validation revision, remaining advisories, and final contour count. If curve fitting is added, revalidate the fitted vectors, not only the source raster. Verify exports in the actual target CAM before promising machining accuracy.

### F8. Mobile and accessibility need a workflow pass — measured layout plus code findings

The local 390 × 844 layout has about 1259 px of controls before a 430 px canvas, with the Problems pane after it. Long filter controls increase the tune-scroll-inspect loop. Current layout evidence: [responsive styling](/home/opc/projects/stencil-cnc/web/app.css:4639).

Primary orange `#e45f35` with white normal-size text calculates to about 3.51:1: [color](/home/opc/projects/stencil-cnc/web/app.css:11), [button text](/home/opc/projects/stencil-cnc/web/app.css:492). Darken the fill or change the label color to meet the intended contrast criterion.

Support selection, global character shortcuts, and tab keyboard handling need alternatives. No active-pointer-ID ownership or touch-action policy was found for drawing; browser gesture cancellation and two-finger interaction still require physical Android/iOS testing. Do not claim a complete WCAG audit or confirmed pinch bug from source inspection alone.

### F9. Sync efficiency and durability have further gaps — code-confirmed risks, not demonstrated production losses

Every autosave rebuilds a bundle containing the source photo, retained exports, and checkpoints; startup awaits the full library: [bundle creation](/home/opc/projects/stencil-cnc/web/project-sync.js:65), [startup](/home/opc/projects/stencil-cnc/web/editor.js:6288). Store immutable assets once, sync state separately, and fetch heavy data on demand. Actual mobile throughput was not benchmarked.

Downloaded bundle replacement clears old assets and writes replacements in separate operations, with revision recorded before all imports complete: [cache replacement](/home/opc/projects/stencil-cnc/web/project-sync.js:108). Stage and atomically commit the new cache. [IndexedDB transaction guidance](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB) supports combining replacement operations in one transaction.

The 1.2-second save debounce lacks a visibility-change local flush. An edit immediately followed by mobile app backgrounding needs a dedicated test. [MDN’s beforeunload guidance](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event) explains why relying on that event is unreliable on phones.

Server file replacement and SQLite commit are separate crash boundaries: [server save](/home/opc/projects/stencil-cnc/server/projects.js:203). Postcommit backup cleanup shares rollback handling, which also deserves correction. Immutable revision files plus transactional metadata pointers would simplify recovery. [SQLite backup guidance](https://www.sqlite.org/backup.html) and [durability settings](https://www.sqlite.org/pragma.html#pragma_synchronous) inform this assessment; no host crash test was run.

### F10. Security operations and ownership need to match server-first projects

Preserve the good fundamentals: authenticated workspace-derived server queries, hashed random credentials, secure HttpOnly cookies, revision checks, AES-GCM bundles, expiry/revocation of shares, quotas, and an unexposed analysis service in the documented deployment.

Remaining concerns:

- Encryption can derive from an admin secret if no dedicated key is set; changing that secret without re-encryption breaks access. Bundles do not identify a key version. [Key configuration](/home/opc/projects/stencil-cnc/server/index.js:78). Production key selection was not inspected.
- Backup and restore requirements are documented, but no external backup schedule or successful restore was verified. [Deployment recovery instructions](/home/opc/projects/stencil-cnc/deploy/README.md:59). Verify database, bundles, and keys recover together.
- Device cookies last up to 400 days; server tokens do not have their own expiry/renewal check. Logout clears the cookie without invalidating the token. [Token validation](/home/opc/projects/stencil-cnc/server/auth.js:299), [logout](/home/opc/projects/stencil-cnc/server/index.js:381). Choose a low-friction trusted-device lifecycle with visible revocation rather than arbitrary disruptive short timeouts.
- Outgoing shares are authorized by device rather than workspace. [Share ownership](/home/opc/projects/stencil-cnc/server/shares.js:289). Linked-device share management should follow the project’s ownership boundary.

### F11. Repair and rendering interaction should communicate their limits

Repairs are intentionally bounded and reject regressions; that is valuable. However, warning acceptance relies on location counts alongside core and pixel counts: [warning acceptance](/home/opc/projects/stencil-cnc/web/core/repairs.js:786). Segmentation can increase location count even if an important physical dimension improves. Consider minimum surviving width, affected physical area, connectivity, and visual-detail change together.

Planning yields for painting and then runs synchronously: [repair planning](/home/opc/projects/stencil-cnc/web/editor.js:1535). A worker with cancelable requests would permit responsive progress and parameter changes. First measure representative small, large, and highly fragmented artwork; no timing claim is made here.

## Proposed user experience to discuss

The app should be permissive about drafts and precise about fabrication claims.

1. **Choose or remember a cutting profile.** Show material, thickness, process/machine, and panel size compactly. Permit “exploring / setup not confirmed” so onboarding does not become a long form. Do not call that provisional state cut-ready.
2. **Create with the result in view.** Offer useful style presets derived from scale and profile. Show constrained ranges and explain automatic adjustments. Prefer a fast visual preview followed by clearly marked final processing.
3. **Refine reversibly.** Separate artwork, manual supports, automatic supports, and repair layers. Provide before/after comparison. Save a candidate that actually restores the current appearance.
4. **Review a small, actionable manufacturing summary.** Blockers first; optional strengthening second. Every issue group should explain physical meaning, show affected geometry, and offer relevant bulk actions or parameter changes.
5. **Choose the delivery intent.** Share a draft PNG or editable snapshot at any stage. Export cutting geometry only for the current validated revision and confirmed profile, with explicit CAM assumptions. “Ready for CAM review” is more accurate than a promise of structural safety.

The proposed sequence does not require extra wizard steps. Profile and validation status can remain small persistent summaries while the canvas remains the main workspace.

## Priority order

### First: make core promises true

Address F1–F4 (validation and sync/isolation), candidate fidelity, destructive confirmation wording, and verified backup recovery. Add regressions before changing behavior. Clarify the kerf/CAM contract with the actual cutting workflow.

### Next: shorten the creative loop

Remembered profile-aware presets; clear constraints and status wording; correct rulers and undo contexts; canvas-centred mobile adjustments; support selection alternatives; draft PNG export; contrast/keyboard fixes. Keep good reversible repair behavior.

### Then: strengthen production and collaboration

Asset-based synchronization and fast library opening; workspace-owned shares/device management; measured and cancelable processing; vector fidelity/tolerance improvements; immutable manufacturing releases; target-CAM and real-cut verification.

Do not expand the app into full CAM unless that is a deliberate product choice. Toolpaths, feeds, piercing, leads, sequencing, and heat management can remain in CAM, with a clear handoff.

## Acceptance tests for any future improvement work

| Journey | Observable success criterion |
|---|---|
| Import → choose three styles → compare → return to first | Can identify and restore the exact prior appearance, including supports and repairs. |
| Change from a large panel to A3 | Rulers, units, minimum features, pattern spacing, and validation all refer to the new physical size; changes are explained. |
| Solid panel / known gap fixtures | No invented weak-core warning; below-profile post-kerf gaps cannot be presented as passing the promised gap constraint. |
| Add, select, rotate, move, delete support | Works with mouse and touch; non-drag and keyboard paths exist for non-freehand actions; Undo restores the prior geometry. |
| Repair many repeated issues | Accurate before/after physical results; preview/discard; no false “all solved”; clear reason when planning stops. |
| Save repaired candidate → restore | Final geometry matches the saved candidate; validation state is handled explicitly. |
| Save → validate/checkpoint → edit → export | No phantom conflicts; one authoritative revision sequence; artifacts match the correct project revision. |
| Upload A → queue B → acknowledge A | B remains pending and is eventually acknowledged independently. |
| Two tabs/devices edit concurrently | No silent overwrite; understandable recoverable conflict, not unnecessary duplicates. |
| Switch workspace in one browser | No other workspace’s photos/projects appear or upload; pending work stays with its owner. |
| Edit → background phone / disconnect / restart | Latest locally saved edit survives; pending status remains accurate; retries do not require redoing work. |
| Share and revoke from another linked device | Sharing is discoverable and controlled at workspace level with clear copy-versus-collaboration semantics. |
| Export SVG/DXF and import in target CAM | Dimensions/units/closed contours verified; compensation matches the intended result; node density is usable. |
| Calibrated cut coupon and representative artwork | Shop verifies actual hole/web capability for material/thickness/setup; settings are versioned as a verified profile. |
| Restore from backup on an isolated service | Database, project files, source images, exports, and encryption keys recover together and can be opened. |

Suggested user-test measures: time to first recognizable design; number of scrolls between adjustment and result; support-edit completion without assistance; ability to explain warnings; exact-restore success; latest-revision recovery; and successful target-CAM preflight. Performance targets should be measured on representative laptops and phones, not inferred from desktop unit-test speed.

The central discussion is not whether to add more restrictions. It is how to make the cutting profile a helpful creative guide, while reserving firm gates for claims the software can actually verify.

## Implementation guardrails and decisions

### Non-negotiable preservation and scope

1. Reinspect current code and `git status` before editing. Preserve unrelated changes. At audit time, `portfolio-screenshots/` and `portfolio-screenshots.zip` were existing untracked user artifacts.
2. Preserve projects, source photographs, masks, supports, repair layers, candidates, checkpoints, exports, and unsent edits. Do not clear IndexedDB or server storage as a workaround.
3. Use versioned, additive, idempotent migrations. Test legacy fixtures, interruption, rollback/recovery, and retry. Do not rerender old artwork or silently reinterpret saved physical parameters on load.
4. Unknown local ownership must never be inferred from whichever workspace happens to be logged in. Preserve legacy data separately until ownership is verified or the user deliberately imports a copy.
5. Keep repairs previewable and reversible. Do not remove failing checks, suppress genuine defects, or promote every approximate warning to a blocker to make tests appear successful.
6. Preserve authentication, workspace authorization, quotas, integrity checks, and encrypted storage. Do not expose project images/tokens in logs or use private user photos as committed fixtures.
7. Do not rotate an active encryption key without a tested, recoverable re-encryption plan. Adding a new dedicated key can make old data unreadable if the old key was previously derived from another secret.
8. No deployment, push, production migration, destructive cleanup, credentials changes, or live cut is authorized merely by this document. Obtain the necessary user instruction for those actions.
9. **Hostname migration remains deferred:** do not redirect or transfer browser data between the two existing URLs as part of this work.
10. Keep the application a design/preflight tool unless the owner deliberately expands it into CAM. Do not promise strength certification or invent machine limits.

### Decision register

| ID | Decision / evidence needed | Proposed direction, not silently assumed | Affected work |
|---|---|---|---|
| D01 | What does an exported contour mean, and how is compensation configured in the actual CAM package? | Explicitly select finished-part boundaries with CAM compensation, or uncompensated centre paths. Preview, validation, generation, repairs, inner/outer contours, and export must use the same interpretation. Record it in a short architecture decision before changing numerical rules. | K07, K11, K18 |
| D02 | Which material, thickness, machine/consumable, and process are supported initially? | Start with the owner's plasma setup, plus an honestly labelled provisional custom profile. Obtain real limits from the owner/cut charts/coupons. Do not automatically certify existing 2 mm/3 mm defaults or silently lower them. | K11, K12, K18, K21 |
| D03 | What verified workspace identity can the client obtain, and how should legacy unowned browser data be claimed? | Namespace by server-verified identity; offer explicit legacy import/recovery without deleting the old copy. A new client-supplied workspace field must not become an authorization source. | K02, K03, K19, K20 |
| D04 | What is the supported sharing model and trusted-device lifetime? | Retain editable snapshot copies by default; make shares workspace-owned. Defer live simultaneous collaboration unless requested. Decide expiration/recovery without introducing disruptive short timeouts. | K20 |
| D05 | Where are backups kept; what recovery-point and recovery-time objectives are acceptable? | Encrypted off-host backup with separately protected recoverable keys and an isolated restore drill. Inspect existing operations before adding competing automation. | K05, K21 |
| D06 | Which mobile interaction layout should become the default? | Prototype canvas-first controls with collapsible sheets. Compare against the present workflow on actual phones before committing to a large redesign. | K14 |

If a decision is unresolved, stop only the affected change, document the question, and continue independent approved tasks. For D01, regression fixtures and characterization tests can be written before the final contract is agreed; tests must not enshrine an unapproved new manufacturing meaning.

## Implementation backlog

Priorities: **P0** means protect privacy or the latest durable work; **P1** means correctness, trustworthy fabrication feedback, or core usability; **P2** means workflow/performance improvement after foundations. These are implementation priorities, not security CVSS scores.

Checkboxes and status notes record verified local increments, not deployment. Split large packages into reviewable increments; do not treat each heading as permission for a broad rewrite.

| Package | Priority | Focus / evidence | Prerequisites |
|---|---|---|---|
| K01 | P0/P1 | Behavioral regression foundations | None |
| K02 | P0 | Workspace-scoped browser data — F4 | K01; D03 for migration |
| K03 | P0 | Authoritative revisions and exact-operation acknowledgement — F3 | K01; coordinate with K02 |
| K04 | P1 | Atomic local replacement and offline durability — F9 | K02–K03 |
| K05 | P0 | Server durability, key safety, and restore evidence — F9–F10 | K01; D05 before operational changes |
| K06 | P1 | False minimum-width-core warnings — F2 | K01 |
| K07 | P1 | Consistent kerf and finished-gap validation — F1/F7 | K01; D01 |
| K08 | P1 | Exact candidate and project restoration — F5 | K01; coordinate schemas with K02–K04 |
| K09 | P1 | Truthful deletion, saving, privacy, and readiness copy — F6/F10 | Sync-dependent claims follow K03 |
| K10 | P1 | Rulers, undo contexts, and consistent tool roles — F6 | K01 |
| K11 | P1 | Versioned manufacturing profiles — F7 | D01–D02; preserve legacy values |
| K12 | P2 | Profile-guided style exploration and comparison | K08, K11 |
| K13 | P1/P2 | Support selection, editing, and suggestion preview | K06–K08; D01 for physical checks |
| K14 | P1/P2 | Mobile, touch, keyboard, and contrast — F8 | D06 for large layout change |
| K15 | P1/P2 | Explainable, physically meaningful repairs — F11 | K06–K07, K11 |
| K16 | P2 | Responsive/cancelable processing and durable feedback — F11 | K01; measured performance baseline |
| K17 | P1 | Draft PNG independent of manufacturing release | K01; K03 for retained/synchronized artifacts; retain SVG/DXF validation gate |
| K18 | P1/P2 | Vector precision and manufacturing handoff — F7 | K07, K11; D01–D02 |
| K19 | P2 | Asset-based sync and fast project opening — F9 | K02–K05; migration design |
| K20 | P1/P2 | Workspace sharing and trusted-device lifecycle — F10 | K02–K03; D04 |
| K21 | P1 | Real-device, CAM, and recovery acceptance | Relevant packages; owner/operator participation |

### K01 — Establish failing behavioral tests before fixes

K01 is a continuing test workstream: implement only the fixtures needed for the selected batch, and track later fixtures as pending. Demonstrate a regression against the old code, then deliver it passing with its associated fix. Do not leave the maintained suite knowingly failing or expand the batch just to fix unrelated new tests.

- [x] Record current commit, test counts, and existing dirty files; run the baseline commands in the verification section for this batch.
- [x] Add synthetic geometry fixtures for the reproduced solid-panel warning and 4 mm / 2 mm kerf / 3 mm minimum gap. **The K06 solid-panel, narrow-neck, anchor, no-core, diagonal-contact, legacy post-kerf, and multi-resolution fixtures are complete. K07 adds below/at/above-minimum, zero/nonzero kerf, anisotropic-cell, and rotated-gap fixtures.**
- [x] Add deterministic sync tests with deferred responses and isolated browser storage for the selected acknowledgement, response-revision, and conflict-queue defects. Existing server tests still do not cover the client's complete lifecycle.
- [ ] Add browser interaction tests for candidate restoration, editable-field undo, rulers, preview export, and later mobile changes. Do not rely solely on HTML/source regular-expression assertions.
- [ ] Keep fixtures synthetic or explicitly licensed; use semantic selectors and geometry assertions rather than brittle timing or pixel-only expectations.

Start with `test/core/bridges-validation.test.js`, `test/core/connectivity.test.js`, `test/core/repairs.test.js`, `test/projects.test.js`, and `test/workflow.test.js`. Add a focused client-sync suite and browser harness if needed; these are proposed additions, not existing coverage.

Done for a batch when its defect regressions fail under the old implementation, pass after the fixes, and the test environment cannot contact production or inspect real user libraries. Record which K01 fixtures remain for later batches.

### K02 — Isolate local state by workspace

- [x] Obtain a stable workspace identifier from the authenticated server session; isolate the complete local database, including project, asset, outbox, metadata, and last-opened state, by that identifier.
- [x] Capture workspace ownership on queued work and direct completion into its originating workspace database; changing active workspace requires a reload.
- [x] Stage legacy unowned records without auto-upload; provide explicit copy/import while retaining originals.
- [x] Scope local enumeration, cleanup, recovery, and cache keys through the workspace database rather than only filtering the visible project list.

**Status:** implemented locally—real-browser verification pending. The isolated Chromium A/B/legacy-import smoke test passed. The project API now rejects a missing or stale workspace header, preventing an old tab from writing into a newly authenticated workspace. Repeat import and the identity fence are automated; offline A → B → A and physical multi-tab interaction still need browser acceptance coverage before marking the package verified.

Start at `web/storage.js`, `web/project-sync.js`, `web/app.js`, and authenticated session endpoints in `server/index.js`.

Done when A → B → A switching, offline startup, two tabs, and an in-flight identity switch neither expose nor upload another workspace's data. Repeat the migration twice without duplicates or lost artifacts. Awaiting identity is not permission to default to a global cache.

### K03 — Make save acknowledgements and revisions authoritative

- [x] Route edit, checkpoint, validation, repair, export-artifact, and library writes through revision-aware synchronization and propagate acknowledged revision to the open editor.
- [x] Give each queued operation an immutable generation/ID and captured payload. Acknowledging A removes only A; a newer B is rebased atomically and remains pending.
- [x] Serialize per-workspace/project writers in-page and across supporting tabs with Web Locks; retain server conditional writes as the final concurrency guard.
- [x] Take revision/hash from the actual response. A checkpoint/export save advances the revision the editor uses.
- [x] Preserve queued status when a conflict copy cannot upload; do not present that state as server-saved.
- [x] Test deletes/tombstones and offline edits explicitly. The server refuses reuse of a permanently deleted ID; the client preserves a racing or offline edit under a new conflict-copy ID. Lost delete responses reconcile from the tombstone.

**Status:** implemented locally—real-browser verification pending. Focused tests cover exact-operation acknowledgement, A-in-flight/B-queued, independent module/tab writers, response ETags, lost-response recovery, tombstones, delete/edit races, stale-session rejection, and queued conflict copies. Physical two-tab contention, unauthorized expiry during an active write, quota failure, and partial local-cache replacement remain acceptance requirements.

Start at `web/project-sync.js`, `web/storage.js`, and `persist`, `createRecoveryPoint`, and export handling in `web/editor.js`.

Done when: save → checkpoint → edit creates no false conflict; A-in-flight/B-queued retains B after A's acknowledgement; queued conflict copies never display server-saved; two-tab conflicts preserve both edits; list/download races use the downloaded revision; and unauthorized/failed requests cannot advance acknowledgement state.

### K04 — Make the offline copy durable and atomically replaceable

- [x] Separate rapid local persistence from debounced network upload; flush pending local state at lifecycle transitions without depending on `beforeunload`.
- [x] Stage complete incoming bundles and validate their assets before replacing a usable local copy in a multi-store transaction.
- [x] Record a server revision as locally complete only after all corresponding assets/checkpoints are committed.
- [x] Add bounded retries/backoff while active and an honest unsynced count. Retain a manual retry option.
- [x] Handle quota failure explicitly without deleting the last good copy or clearing the outbox.

**Status:** implementation is deployed; physical mobile suspension acceptance remains. Replacement failures roll back atomically and leave queued edits untouched. Normal project and current-project-pointer writes are also one transaction. Local saves use a 160 ms debounce, server upload uses a separate 1.2-second debounce, and `visibilitychange`/`pagehide` initiate a local-only flush while pausing network retry. Each local edit has a durable identity and pending marker; an older acknowledgement cannot clear a newer unqueued edit, and startup reconstructs a missing outbox operation instead of downloading over it. Retries are bounded and pause while hidden/offline; manual retry resets the budget. A Chromium reopen simulation verified that a local edit with no outbox entry uploads and clears its marker. Forced operating-system suspension and a physical low-storage device remain acceptance checks rather than implemented behavior gaps.

Sync hardening follow-up (2026-09-16): workspace reconciliation now continues past an individual project's malformed download, local queue failure, or rejected upload. A malformed queued package is rebuilt from the complete cached project where possible; otherwise it remains preserved and is named as needing attention. Conflict copies derive a stable ID from the workspace, original project, and immutable local change, and the original-to-conflict outbox transition is atomic. The active editor and last-project pointer follow that replacement. This prevents one legacy entry from holding the whole workspace in a red state and prevents retries or another tab from creating a succession of equivalent conflict projects.

Start at `web/storage.js`, `cacheBundle` in `web/project-sync.js`, and save/lifecycle handlers in `web/editor.js`.

Done when interruption, quota error, app backgrounding, network timeout, and reopening cannot turn an incomplete cache into a “current” record. Physical mobile suspension tests are required before claiming immediate-background resilience.

### K05 — Protect server commits and recoverability

- [x] Characterize crash points between encrypted file creation, file replacement, DB commit, and cleanup.
- [x] Design immutable revision files or an equivalent recoverable write protocol with a transactional metadata reference; separate postcommit cleanup from rollback logic.
- [x] Add startup/orphan recovery and conservative garbage collection. Do not remove files unless ownership and committed references are established.
- [x] Verify the active encryption-key source privately. Introduce key IDs/rotation support through compatible, tested migration; never print keys or swap environment values blindly.
- [x] Inspect current backup arrangements, document recovery objectives, and rehearse restore to an isolated service using matching database, files, and keys.

**Status:** implementation and restore evidence are complete. New saves publish a flushed, immutable encrypted revision before atomically switching SQLite's pointer; cleanup runs only after commit and is best-effort. Startup repairs legacy `.bak` crash states and garbage-collects only recognized, unreferenced files after a 24-hour grace period. Injected precommit, postcommit, and cleanup failures retain a readable old or new revision. SQLite now uses `synchronous=FULL`. Version-2 envelopes identify their key, legacy version-1 envelopes try the retained key ring, and an explicit migration command rewrites live pointers without exposing secrets. The active production source was privately verified as `admin-derived-v1`; no dedicated project/share key is currently configured.

On 2026-09-16, a cold snapshot of the live volume was restored outside the live path and verified with the matching key: 16/16 active projects opened, including 16 sources, 8 checkpoints, and 2 exports. The temporary archive was then removed. No Kerfloom backup was found in user or host systemd timers, so off-host automation remains an explicit D05 operational decision. The runbook proposes RPO <= 1 hour and RTO <= 4 hours but does not claim those objectives are currently met.

Start at `server/projects.js`, `server/db.js`, key setup in `server/index.js`, and `deploy/README.md`.

Done when injected failure before/after commit yields a readable complete old or new revision, cleanup failure cannot roll back an already committed file incorrectly, and a documented isolated restore opens sources and exports. Production migration/deployment is a separate authorization gate.

### K06 — Correct minimum-width-core connectivity semantics

- [x] Distinguish unanchored components from components separated by insufficient-width connections for the editor's no-anchor mode.
- [x] In single-component/no-anchor mode, compare full-width components against the main core rather than counting every unanchored core as a warning.
- [x] Keep genuine multiple-core bottlenecks, no-surviving-core cases, post-kerf separation, and explicitly anchored designs diagnosable.
- [x] Recheck warning counts consumed by repairs and issue-location navigation.

**Status:** complete. Connectivity now exposes a main component and detached components independently from external anchor support. In no-anchor/single-piece mode, minimum-width cores are compared with the largest core; anchored mode still checks every core against its explicit support. A no-surviving-core condition is one grouped, locatable warning rather than a duplicate no-core plus thin-zone pair. Thin cells are grouped by their structural post-kerf material component, so a physical dumbbell produces the same occurrence count at 1×, 2×, and 4× raster resolution instead of fragmenting from 1 warning location into 9. The editor and repair planner now share the same occurrence-count helper. Regressions cover solid panels, genuine bottlenecks, absent cores, explicit anchors, post-kerf separation, diagonal point contact, repair consumption, and location bounds.

Start at `web/core/connectivity.js` and `web/core/validation.js`.

Done when a sufficiently thick solid panel has no invented weakness warning, a known narrow-neck panel still warns, and genuine disconnected pieces still block. Test diagonal contact and multiple physical resolutions.

### K07 — Align generation, validation, repair, and CAM kerf semantics

- [x] Resolve D01 in a short decision record, with an inner opening, outer boundary, and adjacent cuts illustrated numerically.
- [x] Fix the reproduced finished-gap inconsistency according to that contract; test below/at/above minimum, zero/nonzero kerf, anisotropic raster cells, and rotated shapes.
- [x] Update generators, repair targets, preview labels, and export instructions consistently; avoid double kerf compensation.
- [x] Version the validation/geometry interpretation. Invalidate stale certificates without silently modifying old artwork; explain how legacy exports should be interpreted.

**Status:** deployed. New projects store intended finished-part boundaries and require exactly one inside/outside offset in CAM. Kerf is no longer added to generated webs and then subtracted again during validation; it remains an opening-path feasibility input. Repairs and supports target the same versioned raster width. Project schema version 3 migrates versions 0–2 to an explicit legacy interpretation without changing their stored pixels, clears stale validation readiness, and offers an explicit re-rendering upgrade. Preview and export instructions disclose which interpretation is active. See `docs/decisions/0001-finished-boundaries-and-cam-kerf.md`.

Start at `web/core/validation.js`, `web/core/repairs.js`, `web/core/morphology.js`, `analiza/app.py`, `analiza/stiluri.py`, and export controls.

Done when the agreed physical model produces the same dimensions in generation, simulation, accepted repair, and documented CAM setup. Tests must not merely remove the visible warning or tighten all checks indiscriminately.

### K08 — Restore complete creative state

- [x] Version candidate payloads to include all appearance-producing layers, including manufacturing repairs and their source/signature metadata.
- [x] Preserve compatibility with old candidates; never fabricate missing repairs or silently replace a candidate thumbnail with a different claimed state.
- [x] Compare final geometry across save → serialize → reopen → restore, and provide reversible restoration.
- [x] Keep validation certificates separate: invalidating an outdated certificate should not destroy the saved look.

Implementation note (2026-09-16): candidate payload version 2 captures style recipes, base raster, touch-ups, raster key, supports, repair-layer state, and an FNV-1a final-mask fingerprint. Project schema version 2 protects that nested contract from older writers; project version 1 migrates additively and its candidates remain truthful legacy recipes. Restore checks the fingerprint, clears validation through the normal rebuild path, and records the restoration in history. Core tests compare final mask pixels across save/serialize/reopen reconstruction; workflow wiring tests cover restore, validation invalidation, and Undo. Browser interaction acceptance remains listed in K01.

Start at `saveCurrentCandidate`, `restoreCandidate`, project encoding, and repair-layer restoration in `web/editor.js` / `web/core/project.js`.

Done when repaired candidates restore pixel-identical geometry at the same settings, and complete/share/server bundle round trips preserve sources, supports, repairs, and selected candidate metadata. Lightweight project downloads must retain their documented omission of source photographs unless that privacy/packaging contract is separately changed with the owner's approval.

### K09 — Make important claims accurate

- [x] State that permanent deletion affects the workspace and all linked devices; distinguish it from removing an offline copy.
- [ ] Replace outdated local-only photo/candidate copy with the actual server/offline behavior.
- [ ] Show “Saved to server” only for the latest server-acknowledged state (K03).
- [ ] Replace unconditional structural assurances with precise geometry-check results, visible advisory counts, and “Ready for CAM review” where appropriate.
- [ ] Replace universal “Safe” allowance wording with a numerical, profile-dependent margin description.
- [ ] Check HEIC/HEIF end-to-end: if supported, align picker types; otherwise explain unsupported conversion. Do not advertise support by adding an extension alone.

Done when UI, download/share dialogs, error messages, and help agree with tested behavior. Local-only saving, revoked access, and pending conflict uploads must remain distinguishable.

### K10 — Correct physical feedback and editing contexts

- [ ] Derive ruler ticks and units from the same physical-to-screen transform as the drawing; cover fit, pan, zoom, A3/large panels, orientation, and inches.
- [ ] Leave native undo/redo to inputs, textareas, and contenteditable elements; apply project undo only in the editing context.
- [ ] Restrict single-character shortcuts to a suitable focused context or provide disable/remapping.
- [ ] Move “Icon” into style commands or label its apply-style action explicitly; do not disguise a rerender as selecting a harmless pointer tool.

Done when dimensional labels align with known coordinates at multiple viewports and Ctrl/Cmd+Z while renaming cannot change geometry.

### K11 — Introduce a versioned cutting profile

- [ ] Capture process, material, thickness, machine/consumable identity where relevant, kerf, opening, finished web, support/span assumptions, provenance, revision, and provisional/verified status.
- [ ] Store a profile snapshot on each project/release, not just a mutable preset name. An edited preset must not retroactively certify an old project.
- [ ] Migrate old numeric settings as an explicit legacy/provisional profile, preserving values and artwork.
- [ ] Keep a compact summary near creation; place advanced setup behind secondary controls.
- [ ] Treat verification as owner/shop evidence. Do not infer verified status from completing a form.

Done when defaults can be reused quickly, profile changes invalidate affected validation, and users can still explore drafts before machine setup is confirmed. D02 determines the supported initial profile range.

### K12 — Make exploration visibly guided

- [x] Expose the actual grayscale/tone interpretation before pattern generation, with dark/midtone/light proportions and a reversible reset for interpretation controls.
- [ ] Add representative thumbnails and clear style descriptions; prototype same-source previews only after measuring their cost.
- [ ] Derive recommended starting values from panel/profile constraints and explain auto-adjustments beside changed controls.
- [ ] Add candidate rename and before/after or A/B comparison after K08's snapshot fidelity is fixed.
- [ ] Show provisional preview versus final processed geometry explicitly; a draft image must not be mistaken for a manufacturing result.

**Status:** partial, implemented in this release. Tone is now a first-class canvas view between Original and Artwork. The server returns the exact normalized tone field consumed by photograph generators rather than a cosmetic grayscale approximation; line art uses the browser's exact treated field. Background-removal/subject masks are reflected in the preview and excluded from its proportions. Broader style thumbnails and A/B comparison remain open.

Done when a user can compare three styles, return to the exact first version, and explain why a spacing limit changed without searching through help. Avoid gratuitous new wizard steps.

### K13 — Improve manual and automatic support interaction

- [ ] Add keyboard-accessible support selection/next/previous navigation and a concise list with select, locate, and delete.
- [ ] Provide tap-start/tap-end creation and numeric/tap movement alternatives; retain unrestricted orientation, length, width, and undo.
- [ ] Make Pan-versus-select behavior explicit and consistent; preserve dragging beyond canvas through pointer capture.
- [ ] Preview smart-support suggestions with counts, affected areas, and fallback reasons. Accept as one undoable action.
- [ ] Test feature preference against connectivity/span requirements; avoid moving a support into dark hair when it no longer supports the required geometry.

Done when mouse, keyboard, and touch users can independently select, rotate, resize, move, delete, undo, and inspect support rationale.

### K14 — Shorten the mobile loop and improve accessibility

- [ ] Fix primary-action contrast to at least 4.5:1 for normal text, including relevant interaction states.
- [ ] Implement appropriate tab keyboard behavior, visible focus, labels, and persistent accessible result/error announcements.
- [ ] Prototype canvas-first mobile adjustments with compact sheets; retain visible Projects, sync status, Undo/Redo, Fit, and a discoverable path to all stages.
- [ ] Define active-pointer ownership, cancellation, and drawing-versus-navigation gestures. Do not disable browser accessibility zoom indiscriminately.
- [ ] Check 320/390/430 px layouts, landscape, larger text, keyboard-only use, and real Android/iOS touch. Small labels and target dimensions are separate issues.

Done when a user can tune a parameter and inspect the result without repeatedly traversing a long page, and non-freehand support operations have non-drag/keyboard alternatives. Document untested assistive technologies rather than declaring blanket WCAG compliance.

### K15 — Make corrections measurable and explainable

- [ ] Keep blocking repair before optional warning reduction; retain preview/apply/discard and layer undo.
- [ ] Report actual physical effects: surviving width/connectivity, affected area, changed artwork, and remaining uncertainty, not only segmented location counts.
- [ ] Add clear termination reasons and relevant next actions: adjust size/density/profile, selected manual support, or review remaining advisories.
- [ ] Track planner limits and rejected candidates for local diagnostics without logging photos.
- [ ] Revalidate accepted geometry using the same versioned profile/model as export; a cosmetic score cannot override structural regressions.

Done when known repairable cases improve, unsafe changes are rejected, and exhausted budgets are distinguished from impossible geometry. Do not claim a universal automatic solution.

### K16 — Measure and preserve responsiveness

- [ ] Capture representative laptop/phone timings and input responsiveness for rendering, validation, support planning, repairs, and saving.
- [ ] Move demonstrated blocking geometry work to a worker or equivalent cooperative path with progress, cancellation, generation IDs, and stale-response rejection.
- [ ] Retain old geometry until a new result is accepted; cancelled work must not apply later or enter undo/save history.
- [ ] Keep actionable failures beside controls until resolved/dismissed; transient success toasts may remain.
- [ ] Coordinate render/source caching with K19; do not build a second incompatible asset identity system.

Done when interaction remains responsive on representative large/fragmented fixtures, cancellation is immediate at the UI level, and stale computations cannot overwrite newer edits. The 200 ms INP guidance is a target to measure, not a claimed baseline.

### K17 — Separate draft preview from cutting export

- [x] Allow PNG preview when artwork exists, even with blockers or missing validation.
- [x] Distinguish draft/unvalidated output clearly in the UI, filename, and a visible marking or accompanying presentation agreed with the owner.
- [x] Preserve strict current-revision checks for SVG/DXF; do not make “Export all” bypass them.
- [x] Ensure generating/retaining a preview artifact uses K03's authoritative save path.

Implementation note (2026-09-16): `currentGeometryIsValidated` is the single current-revision gate. It controls clean PNG, SVG, and DXF, while draft PNG bypasses only the cutting-export gate. Draft PNGs receive a diagonal `KERFLOOM DRAFT · NOT VALIDATED FOR CUTTING` band and `draft-preview` filename; the same downloaded blob continues through recovery-point, artifact, and project synchronization. Core tests cover watermark drawing, workflow tests cover gating/copy/filename wiring, and Chromium verified real canvas rasterization and PNG encoding. A complete click-through with a disconnected saved project remains an acceptance follow-up.

Done when a disconnected draft exports a clearly labelled PNG while SVG/DXF remain unavailable, and a validated final preview accurately matches the current appearance.

### K18 — Improve precision and manufacturing release records

- [ ] Display effective mm/cell and explain approximation limits; do not imply coordinate decimal places are machining accuracy.
- [ ] Design optional simplification/curve fitting using a physical error tolerance, preserving contour nesting and topology.
- [ ] Validate actual output vectors after transformation/fitting before claiming they satisfy constraints. If that validator is not implemented, do not enable topology-changing fitting on trusted cutting exports.
- [ ] Save an immutable release manifest with geometry/export hashes, profile snapshot, units, compensation contract, processing/validation versions, timestamp, warnings, and output artifacts.
- [ ] Verify known dimensions and small features in the owner's target CAM.

Done when output round trips preserve units/topology within the stated tolerance and the release record identifies exactly what was checked. Physical machining acceptance remains K21, not a numerical-formatting test.

### K19 — Reduce sync transfer and startup friction

- [ ] Design workspace-authorized immutable source/export assets plus a small versioned state manifest.
- [ ] Scope content addressing and authorization correctly; a guessed hash must not grant another workspace's asset access or existence information.
- [ ] Load metadata/thumbnails first and prioritize the active project; fetch other originals/exports on demand with an explicit offline-availability option.
- [ ] Migrate existing bundles without discarding old versions until completeness and rollback are verified.
- [ ] Define asset retention, reference tracking, quotas, and conservative cleanup for candidates, shares, and release records.

Done when an ordinary parameter edit does not reupload the original photo/all exports, opening one project does not require the entire library, and offline/recovery behavior remains correct.

### K20 — Align sharing and device access with workspaces

- [ ] Move share management to workspace ownership with appropriate authorization and legacy-share migration.
- [ ] Let another linked device list/revoke shares without exposing stored secret hashes or inventing unrecoverable link secrets.
- [ ] Clarify editable snapshot copy versus shared ongoing editing. Do not build live collaboration without approval.
- [ ] Add a compact linked-device surface for naming, linking, last activity, revoke, sign-out, and recovery.
- [ ] Implement the agreed server-enforced expiry/rotation/sign-out lifecycle, with explicit offline behavior and preserved unsynced data.

Done when shares can be managed from a second authorized device, revoked tokens fail online requests, copied snapshots remain independent, and cross-workspace access tests still fail closed.

### K21 — Verify the whole workflow with the owner/operator

- [ ] Run the journey matrix in “Acceptance tests for any future improvement work” on laptop mouse/keyboard and actual phone touch.
- [ ] Import final SVG/DXF in the target CAM; verify size, units, boundaries, compensation, contour count, and lead/sequence responsibility.
- [ ] Have a qualified operator test suitable coupons and representative artwork under the chosen material/machine setup. Record results as profile evidence; do not initiate machinery from this task.
- [ ] Perform the isolated backup restore and confirm originals, versions, candidates, repairs, and exports.
- [ ] Record remaining limitations and require explicit release/deployment approval.

Done when demonstrated results, not only unit-test success, support the user-facing claims.

## Verification and handoff requirements

Run from the repository root:

```bash
npm test
.venv/bin/python -m unittest discover -s test/analiza -p 'test_*.py'
```

The audit baseline was 140 JavaScript tests and 71 Python tests. Test counts may increase; do not target those numbers by deleting coverage. If the virtual environment or browser dependencies are unavailable, report the missing prerequisite. Keep network-dependent setup and any sandbox approval separate from test assertions.

Minimum regression matrix for the first correctness batch:

| Fixture / sequence | Required result |
|---|---|
| Thick solid mask in single-component/no-anchor mode | No invented narrow-connection warning |
| Real narrow-neck and disconnected retained material | Genuine warning/error remains visible |
| Known pre/post-kerf gap near threshold | Outcome matches D01 and claimed finished-web semantics |
| Save → checkpoint/export artifact → next edit | One project; authoritative revision advances |
| A upload → B edit queued → A ack | B remains pending and is uploaded separately |
| Queued conflict-copy upload | Never falsely labelled server-saved |
| Workspace changes while a request is in flight | Completion stays with its originating identity |
| Two tabs + offline reconnection | No silent overwrite or queue loss |
| Tombstone + stale cache + new offline edit | No silent resurrection; new edit preserved through explicit recovery/conflict rules |
| Partial download/quota failure | Last complete local revision survives |
| Repaired candidate save/reopen/restore | Exact final geometry; no obsolete valid certificate |
| Permanent delete and cancel | Correct workspace-wide warning; cancel performs no deletion |
| Draft PNG with blockers | Preview allowed and labelled; cutting exports remain gated |

For each package, Sol should update its status to **in progress**, **implemented—verification pending**, **verified**, or **blocked on Dxx**, and record:

- Code/doc changes and migration implications.
- Tests added and actual results, including browser/device/CAM checks not run.
- Any deviation from the proposed approach and why it preserves the required invariant.
- Remaining risks, owner decisions, and the next bounded package.
- Deployment status explicitly; local implementation is not production deployment.

Prefer small reviewable changes. Independent geometry and data-safety tracks can proceed in parallel, but coordinate shared edits to `web/editor.js`, `web/storage.js`, and schema definitions. Do not assign two agents overlapping persistence migrations without one integration owner.

## Suggested starting prompt for Sol

> Read `docs/KERFLOOM_AUDIT_AND_ACTION_PLAN.md` completely and inspect the current repository state. Implement a first correctness batch: K02, K03, and K06, plus only the K01 regression fixtures needed for those packages, resolving D03 with me before any ambiguous legacy-data assignment. Preserve all existing projects, sources, candidates, repairs, exports, and queued edits. Reproduce each defect in isolated tests before fixing it. Coordinate persistence changes through one owner; geometry work can run independently. Do not change kerf/CAM semantics without D01, deploy, rotate keys, delete user data, or start the deferred hostname migration. Report tests and remaining decisions, update package statuses, and stop for review after this batch.

This prompt is a proposed handoff the owner may use. It is not an instruction to execute implementation during the documentation task.
