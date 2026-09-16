# ADR 0001: Finished-part boundaries with CAM kerf compensation

Date: 16 September 2026  
Status: Accepted

## Decision

For new projects, Kerfloom's raster artwork, SVG contours, and DXF contours describe the intended **finished-part boundaries**. Kerfloom does not bake a tool-centre offset into those contours. The CAM operator applies the configured kerf exactly once, using an outside offset for retained outer boundaries and an inside offset for openings.

This makes a configured 3 mm web mean 3 mm of finished metal everywhere: in generation, editing, repairs, validation, preview, and export. Kerf still constrains whether an internal compensated tool path can exist; the effective smallest opening is therefore at least the cutter diameter.

### Numerical examples with a 1.2 mm kerf

- **Outer boundary:** a required 100 × 50 mm finished plate is exported as a 100 × 50 mm contour. CAM places the tool centre 0.6 mm outside it. The swept cut leaves a 100 × 50 mm part.
- **Inner opening:** a required 20 mm finished circular opening is exported as a 20 mm circle. CAM places the tool centre on an 18.8 mm diameter path, 0.6 mm inside the opening boundary. The swept cut produces a 20 mm opening.
- **Adjacent cuts:** two opening boundaries separated by a required 3 mm finished web are exported 3 mm apart. CAM offsets each tool centre 0.6 mm into its opening. The centre paths are 4.2 mm apart; after the 1.2 mm cuts, 3 mm of metal remains.

Cutting the exported contours as uncompensated centre paths would be wrong for this contract: the outer part would be undersized, openings oversized, and webs narrowed. Applying compensation in both Kerfloom and CAM would also be wrong.

## Compatibility

Project schema version 3 records `manufacturing.geometryInterpretation`.

- `finished-boundary-cam-v1` is the default for new projects.
- Projects created by schema versions 0–2 migrate to `legacy-uncompensated-centerline-v1`. Their raster pixels are preserved and their validation certificate is invalidated. They continue to use the former full-kerf web allowance and erosion preview.

The editor labels legacy projects and explains that their exports expect the historical uncompensated workflow. Upgrading is explicit. If a source image is available, Kerfloom re-renders it under the finished-boundary contract; otherwise it preserves the existing raster and requires review and revalidation.

## Consequences

- Generated supports and repairs use requested finished widths, without an added full kerf for current projects.
- Finished-gap hard validation measures the distance between intended finished cut boundaries.
- The finished preview is identical to the design contour geometry when CAM compensation is active; the distinction is explained instead of showing a second artificial erosion.
- SVG and DXF remain blocked until the versioned geometry has a current passing validation. Export instructions tell the operator to apply inside/outside compensation once in CAM.
- Actual CAM import and a physical cut remain acceptance requirements before claiming machine-certified dimensional accuracy.
