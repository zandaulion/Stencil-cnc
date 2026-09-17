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


def ajusteaza_ton(
    camp: np.ndarray,
    luminozitate: float = 0.0,
    contrast: float = 0.0,
) -> np.ndarray:
    """Apply predictable photographic adjustments to a 0..1 darkness field.

    Positive brightness moves the result toward white (zero darkness), while
    positive contrast separates values around the middle of the tonal range.
    The bounded percentage controls are intentionally gentler than an image
    editor: their output becomes manufacturing geometry, not just a display.
    """
    if camp.ndim != 2 or not np.isfinite(camp).all():
        raise ValueError("Expected a finite two-dimensional tone field")
    if not np.isfinite(luminozitate) or not -50.0 <= luminozitate <= 50.0:
        raise ValueError("Tone brightness must be between -50 and 50")
    if not np.isfinite(contrast) or not -50.0 <= contrast <= 50.0:
        raise ValueError("Tone contrast must be between -50 and 50")

    valori = np.clip(camp.astype(np.float32), 0.0, 1.0)
    balans = luminozitate / 100.0
    if balans >= 0:
        valori = valori * (1.0 - balans)
    else:
        valori = valori + (1.0 - valori) * -balans

    factor = 2.0 ** (contrast / 50.0)
    return np.clip((valori - 0.5) * factor + 0.5, 0.0, 1.0).astype(np.float32)


def previzualizare_ton(
    camp: np.ndarray,
    zona: np.ndarray | None = None,
    latime_maxima: int = 900,
) -> tuple[np.ndarray, dict[str, float]]:
    """Render the exact 0..1 interpretation field as conventional greyscale.

    The filters read 1 as deepest ink/shadow and 0 as light/no mark. The user
    preview reverses that onto a white page, while the three percentages expose
    how much of the active picture falls into light, midtone, and dark bands.
    """
    if camp.ndim != 2 or not np.isfinite(camp).all():
        raise ValueError("Expected a finite two-dimensional tone field")
    if latime_maxima < 1:
        raise ValueError("Preview width must be positive")
    valori = np.clip(camp.astype(np.float32), 0.0, 1.0)
    if zona is not None:
        if zona.shape != camp.shape:
            raise ValueError("Tone preview zone must match the field")
        active = zona.astype(bool)
    else:
        active = np.ones(camp.shape, dtype=bool)
    esantion = valori[active]
    if esantion.size == 0:
        esantion = valori.reshape(-1)
    total = max(1, int(esantion.size))
    rezumat = {
        "light": round(float(np.count_nonzero(esantion < 1 / 3) / total), 4),
        "midtone": round(float(np.count_nonzero((esantion >= 1 / 3) & (esantion < 2 / 3)) / total), 4),
        "dark": round(float(np.count_nonzero(esantion >= 2 / 3) / total), 4),
    }
    imagine = np.rint((1.0 - valori) * 255.0).astype(np.uint8)
    if zona is not None:
        imagine = np.where(active, imagine, 255).astype(np.uint8)
    if imagine.shape[1] > latime_maxima:
        inaltime = max(1, round(imagine.shape[0] * latime_maxima / imagine.shape[1]))
        imagine = cv2.resize(imagine, (latime_maxima, inaltime), interpolation=cv2.INTER_AREA)
    return imagine, rezumat


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
