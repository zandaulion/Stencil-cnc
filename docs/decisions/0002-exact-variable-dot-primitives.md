# ADR 0002: Preserve exact Variable Dot primitives

## Decision

Variable Dots are generated as physical circles with continuous centres and
radii. Kerfloom stores those primitives alongside the binary manufacturing
raster in source-normalized coordinates.

The raster remains the conservative input for connectivity, minimum-web, and
repair planning. It is a sampled representation, not the master description of
an unchanged dot. Preview maps the primitives through the same content crop and
panel placement as the raster. SVG replaces matching sampled hole contours with
two exact circular arcs; DXF replaces them with `CIRCLE` entities. PNG renders
the same primitives with browser antialiasing at an enlarged preview resolution.

Contour replacement is deliberately match-based. If a support, touch-up, or
repair changes a dot, the changed contour remains raster geometry rather than
being overwritten by a stale ideal circle. Unchanged matching dots can remain
exact in vector exports.

## Physical contract

- Circle diameter is never quantized to an integer pixel radius.
- Maximum diameter is bounded by `pitch - minimum web`.
- Minimum diameter is the configured minimum opening.
- Centres use the triangular lattice's continuous coordinates.
- The validation raster samples each exact circle at pixel centres.
- Project schema version 4 and candidate payload version 3 preserve the exact
  source-space primitives through save, server sync, share, and restore.

This is not post-hoc curve fitting. The circle is the generated geometry; the
raster is derived from it. Other free-form styles continue to export their
validated raster contours until they receive an equivalent native-vector
geometry contract.
