# K16 processing baseline and acceptance

Recorded on 21 September 2026 for the K16 responsiveness package.

## Automated synthetic baseline

Run `npm run benchmark:processing` from the repository root. The fixture is deterministic and contains no project artwork.

| Runtime | Architecture | Fixture | Raster cells | Validation |
| --- | --- | --- | ---: | ---: |
| Node 24.18.0 | ARM64 | A3 portrait, 420 × 594 cells | 249,480 | 247.9 ms |
| Node 24.18.0 | ARM64 | Large portrait, 450 × 900 cells | 405,000 | 250.3 ms |

These numbers are a repeatable host baseline, not a laptop, phone, browser-INP, or machining claim. They demonstrate that representative validation can exceed the 200 ms interaction target when performed on the interface thread and justify moving the geometry calculations to a Worker.

## In-app device measurements

The bundled handbook's **Processing performance** page reports the most recent render, validation, repair, support, local-save, and server-sync durations measured in that browser. It stores at most 40 small records locally and offers **Clear timing history**. Records contain only the task name, duration, outcome, desktop/mobile layout, and timestamp—never source pixels or geometry.

Use this view to record representative Windows/PWA and phone/PWA timings during physical acceptance. Report the operation, duration, device/browser, panel dimensions, and approximate geometry complexity.

## Implemented safety contract

- Validation, manufacturing-repair planning/evaluation, and smart-support planning execute in a module Web Worker.
- Cancel terminates the Worker immediately at the UI level.
- Newer work supersedes older work through a monotonically increasing generation identifier.
- Validation revision, repair-profile/model contract, repair-plan identity, and support-plan signature are checked again before accepting results.
- Current geometry stays visible while processing. A cancelled, failed, superseded, or stale result cannot enter geometry, Undo, recovery, or save history.
- Server rendering retains its abort controller and now has an explicit Cancel action.
- Failures remain visible beside the canvas with Retry and Dismiss actions. Success feedback may remain transient.
- K16 introduces no source/render asset cache; K19 remains the owner of that future identity and retention design.

## Physical acceptance still required

- Run a representative simple and fragmented project on the owner's Windows PWA and phone PWA.
- Confirm pan, tool selection, panel navigation, and text input remain responsive during each background task.
- Cancel each operation and confirm the previous geometry, Undo depth, current project revision, and queued-save state are unchanged.
- Change settings rapidly during work and confirm no old result replaces the newest state.
- Record timings from the in-app page and investigate any repeated slow task or failure.
