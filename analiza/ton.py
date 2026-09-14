"""Photograph to ink density.

Two corrections over the browser version, and the first is the reason the
results were unusably dense.

The baseline is zero, not a half. Local contrast was written as
`0.5 + difference`, which makes a featureless wall ask for half the ink in the
sheet: measured on a real portrait the mean tone came out 0.499, with 61% of
every pixel sitting between 0.4 and 0.6. A flat area has no structure and
should ask for nothing, so ink is `max(0, darker than surroundings)` and the
bare sheet is the default rather than the exception.

And the skin is flattened before anything is measured. A bilateral filter
smooths within a region while leaving its border alone, so pores, stubble and
blemishes stop generating structure while the jaw line stays exactly as sharp
as it was. That is the part a browser cannot do well at full resolution, and
the whole reason this step moved to the server.
"""

from __future__ import annotations

import cv2
import numpy as np

# Neighbourhood radius as a fraction of the shorter side. Wide enough to span a
# cheek, narrow enough that a cheek does not become its own background.
RAZA_IMPLICITA = 0.06

# How hard local differences are pushed apart before clipping.
CASTIG_IMPLICIT = 2.2


def ton(
    bgr: np.ndarray,
    raza: float = RAZA_IMPLICITA,
    castig: float = CASTIG_IMPLICIT,
    netezire: float = 0.55,
) -> np.ndarray:
    """Ink density in ``0..1``; zero is bare sheet.

    ``netezire`` is how strongly the skin is flattened first, ``0`` disabling
    it. It is expressed relative to the picture, not in pixels, so the same
    number means the same thing on a phone snap and a camera file.
    """
    if bgr.ndim != 3 or bgr.shape[2] != 3:
        raise ValueError("Expected a colour image")
    inaltime, latime = bgr.shape[:2]
    latura = min(inaltime, latime)

    lucru = bgr
    if netezire > 0:
        # Diameter from the picture's size; the colour sigma decides what counts
        # as "the same surface", the space sigma how far that reaches.
        d = max(5, int(round(latura * 0.012 * netezire / 0.35)) | 1)
        lucru = cv2.bilateralFilter(bgr, d, 45 * netezire / 0.35, d * 1.5)

    gri = cv2.cvtColor(lucru, cv2.COLOR_BGR2GRAY).astype(np.float32)
    interval = float(gri.max() - gri.min())
    if interval < 1e-6:
        return np.zeros((inaltime, latime), np.float32)

    k = max(3, int(round(raza * latura)) | 1)
    vecinatate = cv2.blur(gri, (k, k))

    # Positive where the pixel is darker than what surrounds it. Everything
    # lighter is bare sheet, not "a little ink".
    diferenta = np.clip((vecinatate - gri) / interval * castig, 0.0, None)

    # Then stretched so the darkest structure reaches full ink.
    #
    # Moving the baseline to zero also collapsed the top: on a real portrait
    # the mean fell to 0.04 and almost nothing reached 1, which the styles read
    # as "barely any ink anywhere". Slats coped, because a bar has a minimum
    # width; hatch did not, because every stroke came out shorter than the tool
    # can cut and was rightly omitted — a plate with no slots at all.
    #
    # The high percentile rather than the maximum: one specular highlight in an
    # eye should not decide the scale for the whole face.
    varf = float(np.percentile(diferenta[diferenta > 0], 99)) if (diferenta > 0).any() else 0.0
    if varf > 1e-6:
        diferenta = diferenta / varf
    return np.clip(diferenta, 0.0, 1.0).astype(np.float32)


def portret(
    bgr: np.ndarray,
    masca: np.ndarray | None = None,
    castig: float = CASTIG_IMPLICIT,
    netezire: float = 0.55,
) -> np.ndarray:
    """Absolute portrait darkness enriched with local facial detail.

    Portrait slats and classic stencils need to know that hair is dark and skin
    is light, while still retaining eyes, nostrils and mouth. Robust percentiles
    stop one highlight or black corner from setting that balance.
    """
    if bgr.ndim != 3 or bgr.shape[2] != 3:
        raise ValueError("Expected a colour image")
    lucru = bgr
    if netezire > 0:
        latura = min(bgr.shape[:2])
        d = max(5, int(round(latura * 0.012 * netezire / 0.35)) | 1)
        lucru = cv2.bilateralFilter(bgr, d, 45 * netezire / 0.35, d * 1.5)
    gri = cv2.cvtColor(lucru, cv2.COLOR_BGR2GRAY).astype(np.float32)
    valori = gri[masca] if masca is not None and np.any(masca) else gri.reshape(-1)
    jos, sus = np.percentile(valori, [3, 97])
    if sus - jos < 1e-6:
        intuneric = np.zeros_like(gri, np.float32)
    else:
        intuneric = np.clip((sus - gri) / (sus - jos), 0.0, 1.0)
    detaliu = ton(bgr, castig=castig, netezire=netezire)
    return np.clip(0.72 * intuneric + 0.65 * detaliu, 0.0, 1.0).astype(np.float32)
