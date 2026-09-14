"""Which pixels are the person.

The browser version guessed from colour: sample the frame's border as
background, the middle as subject, judge every pixel by resemblance. It worked
on a portrait against a plain wall and left a notch in the crown where a
highlight in the hair happened to match the wall — because colour similarity is
a proxy for "is this a person", and proxies fail at exactly the awkward places.

Here the question is asked directly, of a model trained on it. That removes the
notch, the strictness knob that barely turned, and the assumption that the
subject is conveniently centred. What it costs is a 16 MB model file, which is
the kind of thing a server carries without noticing and a phone does not.

The classes are the segmenter's own: hair and skin are the person, everything
else is the room. Clothing is deliberately left out — a jumper's weave was one
of the things spending material on nothing.
"""

from __future__ import annotations

import os

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

MODELE = os.environ.get("MODEL_DIR", "models")

# selfie_multiclass: 0 background, 1 hair, 2 body skin, 3 face skin,
# 4 clothes, 5 others.
PAR = 1
PIELE_CORP = 2
PIELE_FATA = 3
HAINE = 4


class _Segmentator:
    """Loaded once; the model costs more to open than to run."""

    def __init__(self) -> None:
        self._seg = None

    @property
    def seg(self):
        if self._seg is None:
            self._seg = vision.ImageSegmenter.create_from_options(
                vision.ImageSegmenterOptions(
                    base_options=BaseOptions(
                        model_asset_path=f"{MODELE}/selfie_multiclass.tflite"),
                    output_category_mask=True,
                )
            )
        return self._seg


MODEL = _Segmentator()


class FaraSubiect(Exception):
    """The photograph has no person in it, or too little of one to cut."""


def _categorii(bgr: np.ndarray) -> np.ndarray:
    rezultat = MODEL.seg.segment(
        mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    )
    return np.squeeze(rezultat.category_mask.numpy_view()).copy()


def pastreaza_persoanele(masca: np.ndarray, maxim: int = 6) -> np.ndarray:
    """Keep every substantial person-shaped component, not only the largest.

    Couple and group portraits are normal input for the reference-panel style.
    Tiny disconnected detections are still noise; a component must occupy at
    least half a percent of the image and at least a tenth of the largest one.
    """
    binara = masca.astype(np.uint8)
    numar, etichete, statistici, _ = cv2.connectedComponentsWithStats(binara)
    if numar <= 1:
        return binara.astype(bool)
    componente = [
        (index, int(statistici[index, cv2.CC_STAT_AREA]))
        for index in range(1, numar)
    ]
    componente.sort(key=lambda item: (-item[1], item[0]))
    cea_mare = componente[0][1]
    minim = max(int(np.ceil(masca.size * 0.005)), int(np.ceil(cea_mare * 0.1)))
    pastrate = [index for index, arie in componente[:maxim] if arie >= minim]
    return np.isin(etichete, pastrate)


def _finalizeaza_subiect(
    masca: np.ndarray,
    forma: tuple[int, int],
    netezire_px: int = 0,
) -> np.ndarray:
    inaltime, latime = forma
    if tuple(masca.shape) != tuple(forma):
        raise ValueError("Masca subiectului nu are mărimea imaginii.")
    masca = masca.astype(np.uint8)

    if masca.sum() < 0.01 * masca.size:
        raise FaraSubiect(
            "Nu am găsit o persoană în fotografie, sau ocupă prea puţin din cadru."
        )

    nucleu = max(3, int(round(min(inaltime, latime) * 0.01)) | 1)
    masca = cv2.morphologyEx(masca, cv2.MORPH_CLOSE, np.ones((nucleu, nucleu), np.uint8))

    masca = pastreaza_persoanele(masca).astype(np.uint8)

    if netezire_px > 0:
        k = max(3, int(netezire_px) | 1)
        masca = cv2.morphologyEx(masca, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
        masca = cv2.morphologyEx(masca, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))

    return masca.astype(bool)


def subiect(bgr: np.ndarray, cu_haine: bool = False, netezire_px: int = 0) -> np.ndarray:
    """Boolean mask of the person.

    ``cu_haine`` extends the subject to clothing, which suits a full figure and
    ruins a head-and-shoulders portrait: a patterned jumper generates more
    structure than the face does, and every bit of it becomes real geometry.
    """
    categorii = _categorii(bgr)
    clase = [PAR, PIELE_CORP, PIELE_FATA] + ([HAINE] if cu_haine else [])
    return _finalizeaza_subiect(
        np.isin(categorii, clase), bgr.shape[:2], netezire_px=netezire_px,
    )


def rafineaza_subiect_icoana(
    bgr: np.ndarray,
    categorii: np.ndarray,
    cu_haine: bool = True,
    netezire_px: int = 0,
) -> np.ndarray:
    """Remove halo/background colour that the clothing class absorbed.

    Pale icon backgrounds and pale veils are a difficult semantic boundary.
    The multiclass model sometimes labels a connected patch of the background
    as clothing; ordinary component filtering then has to keep it because it is
    attached to the real figure.  GrabCut supplies the missing image evidence:
    hair and skin are certain foreground seeds, the model's background is a
    certain background seed, and clothing is allowed to follow whichever colour
    model it actually resembles.  This preserves a real veil while rejecting a
    same-colour background lobe before the geometric halo is added.
    """
    if bgr.ndim != 3 or bgr.shape[2] != 3 or categorii.shape != bgr.shape[:2]:
        raise ValueError("Imaginea şi clasele semantice trebuie să aibă aceeaşi mărime.")
    clase = [PAR, PIELE_CORP, PIELE_FATA] + ([HAINE] if cu_haine else [])
    probabil = np.isin(categorii, clase)
    sigur = np.isin(categorii, [PAR, PIELE_CORP, PIELE_FATA])
    fundal = ~probabil

    # GrabCut needs examples of both classes.  The semantic mask remains the
    # conservative fallback for a tightly cropped face or an unusual icon with
    # no visible skin/hair seed.
    if not sigur.any() or not fundal.any():
        return _finalizeaza_subiect(probabil, bgr.shape[:2], netezire_px=netezire_px)

    initial = np.full(categorii.shape, cv2.GC_BGD, dtype=np.uint8)
    initial[probabil] = cv2.GC_PR_FGD
    initial[sigur] = cv2.GC_FGD
    model_fundal = np.zeros((1, 65), np.float64)
    model_prim_plan = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(
            bgr, initial, None, model_fundal, model_prim_plan, 5,
            cv2.GC_INIT_WITH_MASK,
        )
        rafinata = np.isin(initial, [cv2.GC_FGD, cv2.GC_PR_FGD])
    except cv2.error:
        rafinata = probabil
    return _finalizeaza_subiect(rafinata, bgr.shape[:2], netezire_px=netezire_px)


def subiect_icoana(
    bgr: np.ndarray,
    cu_haine: bool = True,
    netezire_px: int = 0,
) -> np.ndarray:
    """Person mask refined for pale icon backgrounds and veils."""
    return rafineaza_subiect_icoana(
        bgr, _categorii(bgr), cu_haine=cu_haine, netezire_px=netezire_px,
    )


def aplica(camp: np.ndarray, masca: np.ndarray) -> np.ndarray:
    """Silences a tone field outside the subject.

    Zero is the right neutral for both polarities: a positive style draws no
    material there, a negative one cuts no slot, so neither needs to know that
    a background ever existed.
    """
    if camp.shape != masca.shape:
        raise ValueError("The tone field and the subject mask must be the same size")
    return np.where(masca, camp, 0.0).astype(np.float32)
