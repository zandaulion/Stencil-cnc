"""The wire format between the analysis service and the browser core.

The browser already owns everything downstream of a mask: frame, bridges,
connectivity, contour tracing, SVG and DXF, all of it tested. So the service's
whole job is to produce a `sourceMask` in the shape `decodeMask` expects, and
the boundary between Python and JavaScript is exactly one small JSON object.

The encoding is the run-length form `project.js` already uses for storing a
project, so a mask arriving from here and a mask restored from disk are the
same kind of thing. Getting this wrong is the one integration failure that
cannot be papered over later, which is why it lives alone in its own module
with its own test.
"""

from __future__ import annotations

import numpy as np

ENCODING = "rle-u1"


def codifica(mask: np.ndarray) -> dict:
    """Binary mask to the RLE object `decodeMask` reads.

    Runs alternate, starting from `startsWith`; the values themselves are never
    written down, only how long each stretch lasts.
    """
    if mask.ndim != 2:
        raise ValueError("A mask must be two-dimensional")
    inaltime, latime = mask.shape
    plat = (mask.reshape(-1) != 0).astype(np.uint8)
    if plat.size == 0:
        raise ValueError("A mask must not be empty")

    # Where the value changes, plus the two ends, gives the run boundaries.
    schimbari = np.flatnonzero(np.diff(plat)) + 1
    margini = np.concatenate(([0], schimbari, [plat.size]))
    runs = np.diff(margini)

    return {
        "encoding": ENCODING,
        "width": int(latime),
        "height": int(inaltime),
        "startsWith": int(plat[0]),
        "runs": [int(r) for r in runs],
    }


def decodifica(codificat: dict) -> np.ndarray:
    """The inverse, for tests: a round trip proves the two sides agree."""
    if codificat.get("encoding") != ENCODING:
        raise ValueError(f"Unknown encoding: {codificat.get('encoding')}")
    latime = int(codificat["width"])
    inaltime = int(codificat["height"])
    plat = np.zeros(latime * inaltime, np.uint8)
    valoare = int(codificat["startsWith"])
    pozitie = 0
    for run in codificat["runs"]:
        if valoare == 1:
            plat[pozitie:pozitie + run] = 1
        pozitie += run
        valoare = 1 - valoare
    if pozitie != plat.size:
        raise ValueError("The runs do not cover exactly width × height")
    return plat.reshape(inaltime, latime)
