"""Tone rendered as cuttable geometry.

Two families, opposite in structure.

Slats are a positive cut: the drawing is the material. Every bar crosses the
full sheet at its chosen angle, so no bar can be an island and connectivity is
the frame's job alone.

Hatch is a negative cut: the plate stays whole and the drawing is the set of
slots taken out of it. That inversion is what makes light-on-dark references
cuttable — as positive geometry their strokes are hundreds of splinters, as
slots they are holes, and a hole cannot fall out of anything.

Both take the cutting limits as inputs rather than checking them afterwards. A
bar is clamped between what the material can hold and what the tool can enter
before it is drawn; a stroke below the tool's diameter is omitted rather than
shrunk. Generating freely and repairing later means fighting the repairer:
widening a bar narrows a gap, which the next pass widens back.
"""

from __future__ import annotations

import numpy as np
import cv2


class ReglajImposibil(ValueError):
    """The spacing asked for cannot hold both a cut and the material beside it."""


# The raster has to be able to draw the limits it is given. Below this many
# pixels a bar is not thin, it is a dotted line: measured on a 1200 mm panel at
# 900 px -- 1.33 mm per pixel -- a 1 mm minimum web produced three thousand
# single-pixel specks, each of which the connectivity check then correctly
# reported as a piece that would fall out.
MIN_PIXELI = 1.5


def _verifica_rezolutie(mm_pe_px: float, **limite_mm: float) -> None:
    for nume, valoare in limite_mm.items():
        if valoare / mm_pe_px < MIN_PIXELI:
            raise ReglajImposibil(
                f"{nume} de {valoare:g} mm iese sub {MIN_PIXELI} pixeli la "
                f"rezoluţia asta ({mm_pe_px:.2f} mm pe pixel). Micşorează panoul "
                f"sau măreşte limita la cel puţin {MIN_PIXELI * mm_pe_px:.1f} mm."
            )


def _sterge_componente_mici(masca: np.ndarray, arie_minima: int) -> np.ndarray:
    if arie_minima <= 1:
        return masca.astype(bool)
    numar, etichete, statistici, _ = cv2.connectedComponentsWithStats(masca.astype(np.uint8), 8)
    pastrate = [
        index for index in range(1, numar)
        if statistici[index, cv2.CC_STAT_AREA] >= arie_minima
    ]
    return np.isin(etichete, pastrate)


def linie_art(
    imagine: np.ndarray,
    prag: float = 0.5,
    contrast: float = 0.0,
    netezire_px: float = 0.0,
    pete_min_px2: float = 0.0,
    inverseaza: bool = False,
) -> np.ndarray:
    """Threshold prepared artwork at the server's manufacturing resolution.

    The controls deliberately mirror the immediate browser preview. ``True``
    means retained material: dark pixels are retained by default and polarity
    inversion swaps retained and removed regions.
    """
    if imagine.ndim != 3 or imagine.shape[2] != 3:
        raise ValueError("Imaginea pentru linie trebuie să fie BGR.")
    if not 0.0 <= prag <= 1.0:
        raise ReglajImposibil("Pragul liniei trebuie să fie între 0 şi 1.")
    if not -100.0 <= contrast <= 100.0:
        raise ReglajImposibil("Contrastul liniei trebuie să fie între -100 şi 100.")
    if netezire_px < 0 or pete_min_px2 < 0:
        raise ReglajImposibil("Netezirea şi aria petelor nu pot fi negative.")

    # Rec. 709 luminance, exactly like maskFromImageData in the browser.
    albastru, verde, rosu = cv2.split(imagine.astype(np.float32))
    gri = 0.2126 * rosu + 0.7152 * verde + 0.0722 * albastru
    reglaj = contrast / 100.0
    factor = 1.0 + reglaj * 2.0 if reglaj >= 0 else 1.0 + reglaj
    # Uint8ClampedArray rounds after contrast and after each blur pass.
    gri = np.rint(np.clip((gri - 128.0) * factor + 128.0, 0.0, 255.0))

    raza = int(round(netezire_px))
    if raza > 0:
        marime = raza * 2 + 1
        # The browser averages only the in-bounds samples at an edge. A sum
        # and a separately filtered count reproduce that instead of inventing
        # reflected pixels around the source image.
        for miez in ((marime, 1), (1, marime)):
            suma = cv2.boxFilter(
                gri, cv2.CV_32F, miez, normalize=False,
                borderType=cv2.BORDER_CONSTANT,
            )
            cate = cv2.boxFilter(
                np.ones_like(gri), cv2.CV_32F, miez, normalize=False,
                borderType=cv2.BORDER_CONSTANT,
            )
            gri = np.rint(suma / np.maximum(cate, 1.0))

    masca = gri <= int(np.floor(prag * 255.0 + 0.5))
    if inverseaza:
        masca = ~masca

    arie_minima = int(round(pete_min_px2))
    if arie_minima > 0:
        numar, etichete, statistici, _ = cv2.connectedComponentsWithStats(
            masca.astype(np.uint8), 4,
        )
        pastrate = [
            index for index in range(1, numar)
            if statistici[index, cv2.CC_STAT_AREA] >= arie_minima
        ]
        masca = np.isin(etichete, pastrate)
    return masca.astype(bool)


def _elipsa_mm(diametru_mm: float, mm_pe_px: float) -> np.ndarray:
    pixeli = max(1, int(np.ceil(diametru_mm / mm_pe_px))) | 1
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (pixeli, pixeli))


def aplica_limite_fizice(
    masca: np.ndarray,
    mm_pe_px: float,
    punte_min_mm: float = 3.0,
    fanta_min_mm: float = 2.0,
) -> np.ndarray:
    """Remove geometry that a cutter cannot leave or enter.

    ``True`` is retained metal. Opening the cut phase removes holes and cut
    tendrils narrower than ``fanta_min_mm``; opening the material phase merges
    cuts separated by a web narrower than ``punte_min_mm``. Structured filters
    normally satisfy these limits while drawing, while photographic and line
    artwork use this as a final deterministic safety pass.
    """
    if masca.ndim != 2:
        raise ValueError("Masca trebuie să aibă două dimensiuni.")
    if punte_min_mm <= 0 or fanta_min_mm <= 0:
        raise ReglajImposibil("Limitele fizice trebuie să fie pozitive.")
    _verifica_rezolutie(mm_pe_px, **{
        "Puntea": punte_min_mm,
        "Fanta": fanta_min_mm,
    })

    material = masca.astype(bool)
    taiat = cv2.morphologyEx(
        (~material).astype(np.uint8),
        cv2.MORPH_OPEN,
        _elipsa_mm(fanta_min_mm, mm_pe_px),
        borderType=cv2.BORDER_CONSTANT,
        borderValue=0,
    ).astype(bool)
    material = ~taiat
    return cv2.morphologyEx(
        material.astype(np.uint8),
        cv2.MORPH_OPEN,
        _elipsa_mm(punte_min_mm, mm_pe_px),
        borderType=cv2.BORDER_CONSTANT,
        borderValue=0,
    ).astype(bool)


def _muchii_taiate(
    camp: np.ndarray,
    zona: np.ndarray,
    mm_pe_px: float,
    detaliu: float,
    latime_mm: float,
) -> np.ndarray:
    """Extract stable, tool-sized feature lines as openings in a plate."""
    if camp.shape != zona.shape:
        raise ValueError("Câmpul şi zona trebuie să aibă aceeaşi mărime.")
    if not 0.0 <= detaliu <= 1.0:
        raise ReglajImposibil("Detaliul trebuie să fie între 0 şi 1.")
    _verifica_rezolutie(mm_pe_px, **{"Linia": latime_mm})
    imagine = np.clip(camp * 255, 0, 255).astype(np.uint8)
    sus = int(round(230 - 170 * detaliu))
    muchii = cv2.Canny(imagine, max(10, sus // 2), max(20, sus)) > 0
    latime_px = max(1, int(np.ceil(latime_mm / mm_pe_px)))
    muchii = _sterge_componente_mici(muchii & zona.astype(bool), max(2, latime_px * 2))
    return cv2.dilate(muchii.astype(np.uint8), _elipsa_mm(latime_mm, mm_pe_px)).astype(bool) & zona


def linii_negative(
    camp: np.ndarray,
    subiect: np.ndarray,
    mm_pe_px: float,
    detaliu: float = 0.4,
    latime_mm: float = 2.0,
) -> np.ndarray:
    """Sparse facial and clothing contours cut from an otherwise solid plate."""
    return ~_muchii_taiate(camp, subiect.astype(bool), mm_pe_px, detaliu, latime_mm)


def gravura(
    camp: np.ndarray,
    subiect: np.ndarray,
    mm_pe_px: float,
    pas_mm: float = 12.0,
    lungime_mm: float = 20.0,
    fanta_min_mm: float = 2.0,
    punte_min_mm: float = 3.0,
    gamma: float = 1.4,
) -> np.ndarray:
    """Woodcut-like marks that follow the local tangent of the photograph."""
    if pas_mm < fanta_min_mm + punte_min_mm:
        raise ReglajImposibil(
            f"Un pas de {pas_mm:g} mm nu poate ţine o fantă de {fanta_min_mm:g} mm "
            f"şi o punte de {punte_min_mm:g} mm."
        )
    if lungime_mm < fanta_min_mm:
        raise ReglajImposibil("Trăsătura trebuie să fie cel puţin cât fanta minimă.")
    _verifica_rezolutie(mm_pe_px, **{"Puntea": punte_min_mm, "Fanta": fanta_min_mm})
    zona = subiect.astype(bool)
    lumina = np.clip(1.0 - camp, 0.0, 1.0)
    gx = cv2.Sobel(camp, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(camp, cv2.CV_32F, 0, 1, ksize=3)
    pas = max(2, int(round(pas_mm / mm_pe_px)))
    minim = max(1, int(np.ceil(fanta_min_mm / mm_pe_px)))
    maxim = max(minim, int(round(lungime_mm / mm_pe_px)))
    grosime = minim
    taiat = np.zeros(camp.shape, np.uint8)
    start = pas // 2
    for y in range(start, camp.shape[0], pas):
        for x in range(start, camp.shape[1], pas):
            if not zona[y, x] or lumina[y, x] < 0.06:
                continue
            unghi = np.arctan2(float(gy[y, x]), float(gx[y, x])) + np.pi / 2
            lungime = minim + float(lumina[y, x] ** gamma) * (maxim - minim)
            dx = np.cos(unghi) * lungime / 2
            dy = np.sin(unghi) * lungime / 2
            cv2.line(taiat, (round(x - dx), round(y - dy)), (round(x + dx), round(y + dy)),
                     1, thickness=grosime, lineType=cv2.LINE_AA)
    taiat = (taiat > 0) & zona
    return ~taiat


def silueta(
    subiect: np.ndarray,
    mm_pe_px: float,
    netezire_mm: float = 8.0,
) -> np.ndarray:
    """One clean, back-lit subject opening with a physically smoothed edge."""
    taiat = subiect.astype(np.uint8)
    if netezire_mm > 0:
        miez = _elipsa_mm(netezire_mm, mm_pe_px)
        taiat = cv2.morphologyEx(taiat, cv2.MORPH_CLOSE, miez)
        taiat = cv2.morphologyEx(taiat, cv2.MORPH_OPEN, miez)
    return ~(taiat > 0)


def benzi_contur(
    camp: np.ndarray,
    subiect: np.ndarray,
    mm_pe_px: float,
    niveluri: int = 5,
    latime_mm: float = 2.5,
) -> np.ndarray:
    """Iso-tone contour bands, like topographic lines over the portrait."""
    if not 2 <= int(niveluri) <= 16:
        raise ReglajImposibil("Numărul de contururi trebuie să fie între 2 şi 16.")
    zona = subiect.astype(bool)
    taiat = np.zeros(camp.shape, dtype=bool)
    miez = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    for nivel in np.linspace(0.1, 0.9, int(niveluri)):
        banda = ((camp >= nivel) & zona).astype(np.uint8)
        taiat |= cv2.morphologyEx(banda, cv2.MORPH_GRADIENT, miez) > 0
    _verifica_rezolutie(mm_pe_px, **{"Linia": latime_mm})
    taiat = cv2.dilate(taiat.astype(np.uint8), _elipsa_mm(latime_mm, mm_pe_px)).astype(bool)
    return ~(taiat & zona)


def _raza_miez_raze_px(
    mm_pe_px: float,
    numar_raze: int,
    celula_mm: float,
    fanta_min_mm: float,
    punte_min_mm: float,
) -> float:
    """Radius of the disk that the polar grid necessarily leaves uncut."""
    perioada = 2 * np.pi / int(numar_raze)
    celula = max(2.0, celula_mm / mm_pe_px)
    fanta = fanta_min_mm / mm_pe_px
    punte = punte_min_mm / mm_pe_px
    # A sector first becomes wide enough for a slot at the inner edge of this
    # ring. Even there, the radial mark is kept half a web away from that edge,
    # so the disk below remains solid for every possible source tone.
    primul_inel = int(np.ceil((fanta + punte) / (celula * perioada)))
    return primul_inel * celula + punte / 2


def centru_automat_raze(
    camp: np.ndarray,
    subiect: np.ndarray,
    mm_pe_px: float,
    numar_raze: int = 64,
    celula_mm: float = 12.0,
    fanta_min_mm: float = 2.0,
    punte_min_mm: float = 3.0,
    prag_lumina: float = 0.12,
) -> tuple[float, float, bool, float]:
    """Place the radial hub inside existing metal, nearest the image centre.

    ``metal_planificat`` is the binary, pre-pattern interpretation of the
    photograph: the darker half is metal, the lighter half is open. A Euclidean
    distance field then shrinks that region by the hub radius. Every surviving
    point is therefore a centre whose *entire* hub is covered by an existing
    metal mass, not merely a centre that happens to land on a dark pixel.

    Returns normalized x/y, whether such a region was found, and hub radius in
    millimetres. The deterministic fallback requested by the editor is 1/4
    from the left and 1/2 from the top.
    """
    if camp.ndim != 2 or camp.shape != subiect.shape:
        raise ValueError("Câmpul şi subiectul trebuie să aibă aceeaşi mărime.")
    if not 6 <= int(numar_raze) <= 96:
        raise ReglajImposibil("Numărul de raze trebuie să fie între 6 şi 96.")
    if celula_mm < fanta_min_mm + punte_min_mm:
        raise ReglajImposibil("Celula radială nu poate ţine fanta şi puntea cerute.")
    if not 0 <= prag_lumina < 1:
        raise ReglajImposibil("Pragul de lumină trebuie să fie între 0 şi 1.")

    h, w = camp.shape
    raza_miez_px = _raza_miez_raze_px(
        mm_pe_px, numar_raze, celula_mm, fanta_min_mm, punte_min_mm,
    )
    # Half tone is the same natural dark/light split used by the portrait
    # styles. Using the much stricter radial cutoff here would reject ordinary
    # hair and clothing: it describes whether an individual slot starts, not
    # whether the photograph planned a dark metal mass. The subject constraint
    # prevents an untouched removed-background surround from being mistaken
    # for image material.
    metal_planificat = (camp >= 0.5) & subiect.astype(bool)
    # Pad with non-metal so a region touching the raster boundary cannot claim
    # room for the part of the hub that would lie outside the artwork.
    distanta = cv2.distanceTransform(
        np.pad(metal_planificat.astype(np.uint8), 1),
        cv2.DIST_L2,
        cv2.DIST_MASK_PRECISE,
    )[1:-1, 1:-1]
    candidati = distanta >= raza_miez_px

    if not candidati.any():
        return 0.25, 0.5, False, raza_miez_px * mm_pe_px

    # Find the Euclidean-nearest eligible pixel without materialising an Nx2
    # coordinate array for a multi-megapixel manufacturing raster. For each
    # row, only its eligible x nearest the centre can possibly win.
    tinta_x = (w - 1) / 2
    tinta_y = (h - 1) / 2
    cel_mai_bun: tuple[float, int, int] | None = None
    for y in np.flatnonzero(candidati.any(axis=1)):
        xs = np.flatnonzero(candidati[y])
        pozitie = int(np.searchsorted(xs, tinta_x))
        for index in (pozitie - 1, pozitie):
            if not 0 <= index < xs.size:
                continue
            x = int(xs[index])
            scor = (x - tinta_x) ** 2 + (int(y) - tinta_y) ** 2
            propunere = (scor, int(y), x)
            if cel_mai_bun is None or propunere < cel_mai_bun:
                cel_mai_bun = propunere

    assert cel_mai_bun is not None
    _, y, x = cel_mai_bun
    centru_x = x / (w - 1) if w > 1 else 0.5
    centru_y = y / (h - 1) if h > 1 else 0.5
    return centru_x, centru_y, True, raza_miez_px * mm_pe_px


def raze(
    camp: np.ndarray,
    subiect: np.ndarray,
    mm_pe_px: float,
    numar_raze: int = 64,
    celula_mm: float = 12.0,
    centru_x: float = 0.45,
    centru_y: float = 0.42,
    fanta_min_mm: float = 2.0,
    punte_min_mm: float = 3.0,
    gamma: float = 1.4,
    prag_lumina: float = 0.12,
) -> np.ndarray:
    """A radial halftone whose cells visibly carry the source photograph.

    Both dimensions of every polar mark follow the local light value. The old
    renderer changed only dash length while every ray stayed one tool-width
    wide; at panel scale those tiny differences disappeared and the result read
    as an unmodulated sunburst. Wider light cells and small or absent dark cells
    preserve the radial rhythm while making the image legible from a distance.

    Radial and tangential marks leave ``punte_min_mm`` between neighbouring
    cells. The innermost rings that cannot fit both a cut and a web remain a
    solid hub rather than creating sub-tool geometry around the focal point.
    """
    if not 6 <= int(numar_raze) <= 96:
        raise ReglajImposibil("Numărul de raze trebuie să fie între 6 şi 96.")
    if celula_mm < fanta_min_mm + punte_min_mm:
        raise ReglajImposibil("Celula radială nu poate ţine fanta şi puntea cerute.")
    if not 0 <= centru_x <= 1 or not 0 <= centru_y <= 1:
        raise ReglajImposibil("Centrul razelor trebuie să fie în fotografie.")
    if not 0 <= prag_lumina < 1:
        raise ReglajImposibil("Pragul de lumină trebuie să fie între 0 şi 1.")
    _verifica_rezolutie(mm_pe_px, **{"Puntea": punte_min_mm, "Fanta": fanta_min_mm})
    h, w = camp.shape
    yy, xx = np.mgrid[0:h, 0:w]
    dx = xx - centru_x * (w - 1)
    dy = yy - centru_y * (h - 1)
    raza = np.hypot(dx, dy)
    perioada = 2 * np.pi / int(numar_raze)
    unghi = np.mod(np.arctan2(dy, dx), 2 * np.pi)
    sector = np.floor(unghi / perioada).astype(np.int64)
    celula = max(2.0, celula_mm / mm_pe_px)
    radial = np.floor(raza / celula).astype(np.int64)
    identificator = radial * int(numar_raze) + sector
    numar = int(identificator.max()) + 1
    lumina = np.clip(1.0 - camp, 0.0, 1.0)
    zona = subiect.astype(bool)
    sume = np.bincount(identificator[zona], weights=lumina[zona], minlength=numar)
    cate = np.bincount(identificator[zona], minlength=numar)
    medie = np.divide(sume, cate, out=np.zeros(numar), where=cate > 0)
    ton_celula = np.power(
        np.clip((medie - prag_lumina) / (1.0 - prag_lumina), 0.0, 1.0),
        gamma,
    )

    fanta = fanta_min_mm / mm_pe_px
    punte = punte_min_mm / mm_pe_px

    # Radially, every mark is centred in a cell and stops one web short of the
    # next. Tangentially, sector width grows with radius. Use the inner edge of
    # the radial cell for the maximum mark width; that is the narrowest point
    # and therefore guarantees the requested web throughout the entire cell.
    indice_radial = np.arange(numar, dtype=np.int64) // int(numar_raze)
    raza_interioara = indice_radial.astype(np.float64) * celula
    latime_max = raza_interioara * perioada - punte
    viabil = latime_max >= fanta
    latime = fanta + ton_celula * np.maximum(0.0, latime_max - fanta)

    lungime_max = celula - punte
    lungime = fanta + ton_celula * max(0.0, lungime_max - fanta)
    exista = viabil & (ton_celula > 0)
    latime[~exista] = 0.0
    lungime[~exista] = 0.0

    abatere_unghi = np.abs(np.mod(unghi + perioada / 2, perioada) - perioada / 2)
    abatere_tangentiala = abatere_unghi * np.maximum(raza, 1)
    pozitie_radiala = np.mod(raza, celula) - celula / 2
    jumatate_lungime = lungime[identificator] / 2
    jumatate_latime = latime[identificator] / 2
    taiat = ((abatere_tangentiala <= jumatate_latime)
             & (np.abs(pozitie_radiala) <= jumatate_lungime))
    taiat &= zona & (jumatate_latime > 0)
    return ~taiat


def ornament(
    camp: np.ndarray,
    subiect: np.ndarray,
    mm_pe_px: float,
    detaliu: float = 0.4,
    latime_mm: float = 2.0,
    patru_directii: bool = False,
) -> np.ndarray:
    """Mirror one half of extracted linework into a deliberate ornament."""
    muchii = _muchii_taiate(camp, subiect.astype(bool), mm_pe_px, detaliu, latime_mm)
    h, w = muchii.shape
    samanta = np.zeros_like(muchii)
    samanta[:, : (w + 1) // 2] = muchii[:, : (w + 1) // 2]
    simetric = samanta | np.fliplr(samanta)
    if patru_directii:
        sus = np.zeros_like(simetric)
        sus[: (h + 1) // 2] = simetric[: (h + 1) // 2]
        simetric = sus | np.flipud(sus)
    return ~simetric


def sablon(
    camp: np.ndarray,
    subiect: np.ndarray,
    mm_pe_px: float,
    prag: float = 0.50,
    contur: float = 0.60,
    punte_min_mm: float = 3.0,
    fanta_min_mm: float = 2.0,
) -> np.ndarray:
    """Bold light/dark portrait cut from a solid plate.

    ``True`` is retained metal. The area outside the detected people remains
    plate; light regions become openings, while dark features and a configurable
    amount of their edge structure remain. Tool-sized morphology makes the
    proposed openings and outline strokes physically meaningful before the
    browser performs its exact connectivity validation.
    """
    if camp.shape != subiect.shape:
        raise ValueError("Câmpul şi masca subiectului trebuie să aibă aceeaşi mărime.")
    if not 0.0 <= prag <= 1.0 or not 0.0 <= contur <= 1.0:
        raise ReglajImposibil("Pragul şi conturul trebuie să fie între 0 şi 1.")
    _verifica_rezolutie(mm_pe_px, **{"Puntea": punte_min_mm, "Fanta": fanta_min_mm})

    subiect = subiect.astype(bool)
    intunecat = (camp >= prag) & subiect

    # Dark features are material. Give them at least the requested web width;
    # this also turns thin facial edges into manufacturable strokes.
    web_px = max(1, int(np.ceil(punte_min_mm / mm_pe_px)))
    intunecat = _sterge_componente_mici(intunecat, max(2, web_px * web_px // 2))
    if web_px > 1:
        k_web = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (web_px | 1, web_px | 1))
        intunecat = cv2.dilate(intunecat.astype(np.uint8), k_web).astype(bool) & subiect

    if contur > 0:
        imagine = np.clip(camp * 255, 0, 255).astype(np.uint8)
        # Lower high threshold means more feature edges. The range deliberately
        # avoids texture noise at the weak end of the gradient.
        sus = int(round(220 - 130 * contur))
        muchii = cv2.Canny(imagine, max(12, sus // 2), max(24, sus)) > 0
        muchii = _sterge_componente_mici(muchii & subiect, max(2, web_px * 2))
        grosime = max(1, int(round(web_px * (0.55 + 0.45 * contur)))) | 1
        k_contur = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grosime, grosime))
        intunecat |= cv2.dilate(muchii.astype(np.uint8), k_contur).astype(bool) & subiect

    taiat = subiect & ~intunecat
    opening_px = max(1, int(np.ceil(fanta_min_mm / mm_pe_px))) | 1
    if opening_px > 1:
        k_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (opening_px, opening_px))
        taiat = cv2.morphologyEx(taiat.astype(np.uint8), cv2.MORPH_OPEN, k_open).astype(bool)
    return ~taiat


def _cap_din_subiect(subiect: np.ndarray) -> tuple[float, float, float]:
    """Estimate a head centre and radius from the upper part of a person mask.

    Icon photographs are commonly full figures, so using the complete subject
    bounds would size a halo from the shoulders or robe.  The upper quarter is
    still dominated by the head on both busts and full-length portraits.  A
    percentile span is less sensitive than a bounding box to an isolated hand,
    staff, or segmentation pixel.
    """
    ys, xs = np.nonzero(subiect)
    if xs.size == 0:
        raise ReglajImposibil("Nu pot aşeza aureola fără un subiect detectat.")

    sus, jos = int(ys.min()), int(ys.max())
    inaltime = max(1, jos - sus + 1)
    banda = (ys <= sus + 0.28 * inaltime)
    xs_cap = xs[banda]
    ys_cap = ys[banda]
    if xs_cap.size < 8:
        xs_cap, ys_cap = xs, ys

    stanga, dreapta = np.percentile(xs_cap, [8, 92])
    centru_x = float(np.median(xs_cap))
    centru_y = float(np.percentile(ys_cap, 52))
    latime_cap = max(1.0, float(dreapta - stanga))
    raza = max(latime_cap * 0.62, inaltime * 0.115)
    raza = min(raza, inaltime * 0.24, subiect.shape[1] * 0.34)
    return centru_x, centru_y, max(1.0, raza)


def sablon_icoana(
    camp: np.ndarray,
    subiect: np.ndarray,
    mm_pe_px: float,
    prag: float = 0.56,
    detaliu: float = 0.65,
    latime_linie_mm: float = 3.0,
    simplificare_mm: float = 3.0,
    aureola: bool = True,
    scala_aureola: float = 1.15,
    punte_min_mm: float = 3.0,
    fanta_min_mm: float = 2.0,
) -> np.ndarray:
    """A broad, back-lit icon stencil with restrained internal linework.

    The plate begins solid.  Light areas of the isolated figure become broad
    openings, dark features and their outlines remain metal, and sparse light
    valleys are widened into deliberate robe/hair cuts only where a surrounding
    dark mass has enough room to survive.  An optional segmented halo is cut
    behind the estimated head; its cross bars remain material and therefore
    look intentional while also providing useful structure.

    ``True`` always means retained material.
    """
    if camp.ndim != 2 or camp.shape != subiect.shape:
        raise ValueError("Câmpul şi masca subiectului trebuie să aibă aceeaşi mărime.")
    if not 0.0 <= prag <= 1.0 or not 0.0 <= detaliu <= 1.0:
        raise ReglajImposibil("Pragul şi detaliul icoanei trebuie să fie între 0 şi 1.")
    if latime_linie_mm <= 0 or simplificare_mm < 0:
        raise ReglajImposibil("Linia icoanei trebuie să fie pozitivă, iar simplificarea nu poate fi negativă.")
    if not 0.75 <= scala_aureola <= 1.6:
        raise ReglajImposibil("Mărimea aureolei trebuie să fie între 75% şi 160%.")
    _verifica_rezolutie(mm_pe_px, **{
        "Puntea": punte_min_mm,
        "Fanta": fanta_min_mm,
        "Linia": max(latime_linie_mm, fanta_min_mm),
    })

    zona = subiect.astype(bool)
    if not zona.any():
        raise ReglajImposibil("Nu pot construi o icoană fără un subiect detectat.")

    # Smooth only at the requested physical scale.  This removes painted or
    # photographic grain while preserving the large folds that define an icon.
    lucru = camp.astype(np.float32)
    if simplificare_mm > 0:
        diametru = max(1, int(round(simplificare_mm / mm_pe_px))) | 1
        lucru = cv2.GaussianBlur(lucru, (diametru, diametru), 0)

    web_px = max(1, int(np.ceil(punte_min_mm / mm_pe_px)))
    linie_mm = max(latime_linie_mm, fanta_min_mm)

    # The poster layer: broad light openings surrounded by retained dark mass.
    material_portret = (lucru >= prag) & zona
    if simplificare_mm > 0:
        diametru = min(max(mm_pe_px, simplificare_mm), punte_min_mm)
        miez = _elipsa_mm(diametru, mm_pe_px)
        material_portret = cv2.morphologyEx(
            material_portret.astype(np.uint8), cv2.MORPH_OPEN, miez,
        )
        material_portret = cv2.morphologyEx(
            material_portret, cv2.MORPH_CLOSE, miez,
        ).astype(bool)

    # Retained contours recover eyes, mouth, fingers, veil edges and garment
    # boundaries inside otherwise open light shapes.
    imagine = np.clip(lucru * 255, 0, 255).astype(np.uint8)
    sus_canny = int(round(220 - 145 * detaliu))
    contururi = cv2.Canny(
        imagine, max(10, sus_canny // 2), max(20, sus_canny),
    ) > 0
    contururi = _sterge_componente_mici(
        contururi & zona, max(2, web_px * 2),
    )
    contururi = cv2.dilate(
        contururi.astype(np.uint8), _elipsa_mm(punte_min_mm, mm_pe_px),
    ).astype(bool) & zona
    material_portret |= contururi

    # Light valleys inside sufficiently broad dark masses become a small number
    # of cut folds.  Requiring room on both sides prevents a decorative line
    # from severing a narrow retained feature.
    vecinatate_mm = max(linie_mm * 4.0, simplificare_mm * 3.0, 12.0)
    inchidere = cv2.morphologyEx(
        lucru, cv2.MORPH_CLOSE, _elipsa_mm(vecinatate_mm, mm_pe_px),
    )
    vai_luminoase = inchidere - lucru
    prag_vale = 0.20 - 0.13 * detaliu
    anvelopa_intunecata = (lucru >= max(0.16, prag * 0.42)) & zona
    distanta = cv2.distanceTransform(anvelopa_intunecata.astype(np.uint8), cv2.DIST_L2, 5)
    rezerva_px = (linie_mm / 2.0 + punte_min_mm) / mm_pe_px
    falduri = (vai_luminoase >= prag_vale) & (distanta >= rezerva_px)
    falduri = _sterge_componente_mici(
        falduri, max(2, int(np.ceil(linie_mm / mm_pe_px)) * 2),
    )
    falduri = cv2.dilate(
        falduri.astype(np.uint8), _elipsa_mm(linie_mm, mm_pe_px),
    ).astype(bool) & anvelopa_intunecata

    taiat = zona & ~material_portret
    taiat |= falduri

    if aureola:
        centru_x, centru_y, raza = _cap_din_subiect(zona)
        raza *= scala_aureola
        yy, xx = np.ogrid[:zona.shape[0], :zona.shape[1]]
        disc = (xx - centru_x) ** 2 + (yy - centru_y) ** 2 <= raza ** 2
        # The figure is in front of the halo.  Only its surround is opened here;
        # portrait tones continue to describe the face, hair, and veil.
        taiat |= disc & ~zona

        # A halo-sized cross is retained metal, with at least the configured web
        # width.  Besides matching the reference language, it divides a very
        # large opening into calmer, more easily supported quadrants.
        jumatate_bara = max(web_px / 2.0, raza * 0.025)
        cruce = disc & ~zona & (
            (np.abs(xx - centru_x) <= jumatate_bara)
            | (np.abs(yy - centru_y) <= jumatate_bara)
        )
        taiat &= ~cruce

    return ~taiat


def portret_grafic(
    camp: np.ndarray,
    subiect: np.ndarray,
    mm_pe_px: float,
    prag: float = 0.5,
    detaliu: float = 0.70,
    simplificare_mm: float = 1.5,
    punte_min_mm: float = 3.0,
) -> np.ndarray:
    """Positive two-tone portrait in the visual language of the references.

    Unlike :func:`sablon`, the background is removed. Absolute dark regions
    carry hair and clothing while manufactured-width feature lines recover
    eyes, brows, nose, mouth, beard and folds from otherwise light skin.
    """
    if camp.shape != subiect.shape:
        raise ValueError("Câmpul şi masca subiectului trebuie să aibă aceeaşi mărime.")
    if not 0.0 <= prag <= 1.0 or not 0.0 <= detaliu <= 1.0:
        raise ReglajImposibil("Pragul şi detaliul trebuie să fie între 0 şi 1.")
    _verifica_rezolutie(mm_pe_px, **{"Puntea": punte_min_mm})
    zona = subiect.astype(bool)
    material = (camp >= prag) & zona

    imagine = np.clip(camp * 255, 0, 255).astype(np.uint8)
    sus = int(round(225 - 155 * detaliu))
    muchii = cv2.Canny(imagine, max(10, sus // 2), max(20, sus)) > 0
    web_px = max(1, int(np.ceil(punte_min_mm / mm_pe_px)))
    muchii = _sterge_componente_mici(muchii & zona, max(2, web_px * 2))
    material |= cv2.dilate(
        muchii.astype(np.uint8), _elipsa_mm(punte_min_mm, mm_pe_px),
    ).astype(bool) & zona

    if simplificare_mm > 0:
        # A small opening removes camera texture, then closing reconnects the
        # intended brush shapes. Never use a kernel wider than the structural
        # web: simplification should not invent a different portrait.
        diametru = min(simplificare_mm, punte_min_mm)
        miez = _elipsa_mm(diametru, mm_pe_px)
        material = cv2.morphologyEx(material.astype(np.uint8), cv2.MORPH_OPEN, miez)
        material = cv2.morphologyEx(material, cv2.MORPH_CLOSE, miez).astype(bool)

    material &= zona
    return _sterge_componente_mici(material, max(2, web_px * web_px // 2))


def lamele(
    camp: np.ndarray,
    mm_pe_px: float,
    pas_mm: float = 38.0,
    punte_min_mm: float = 3.0,
    fanta_min_mm: float = 2.0,
    gamma: float = 1.4,
    orizontal: bool = False,
    unghi: float | None = None,
) -> np.ndarray:
    """Parallel bars whose width follows the ink.

    ``unghi`` is measured from the image's horizontal axis. The legacy
    ``orizontal`` switch remains as an API compatibility fallback when no
    angle is supplied: horizontal is 0 degrees and vertical is 90 degrees.
    The tone field is turned into bar coordinates, rendered there with the
    physical pitch/web limits, then mapped back without rotating the portrait.
    """
    if pas_mm < punte_min_mm + fanta_min_mm:
        raise ReglajImposibil(
            f"Un pas de {pas_mm} mm nu poate ţine o punte de {punte_min_mm} mm "
            f"şi o fantă de {fanta_min_mm} mm; foloseşte cel puţin "
            f"{punte_min_mm + fanta_min_mm:.2f} mm."
        )
    _verifica_rezolutie(mm_pe_px, **{"Puntea": punte_min_mm, "Fanta": fanta_min_mm})
    if unghi is None:
        unghi = 0.0 if orizontal else 90.0
    if not np.isfinite(unghi) or not -90.0 <= unghi <= 90.0:
        raise ReglajImposibil("Unghiul lamelelor trebuie să fie între -90 şi 90 de grade.")

    # Preserve the exact old horizontal/vertical paths. Apart from being
    # faster, this keeps existing project output bit-for-bit stable.
    intoarcere = None
    if abs(abs(unghi) - 90.0) < 1e-9:
        lucru = camp
    elif abs(unghi) < 1e-9:
        lucru = camp.T
        intoarcere = "transpose"
    else:
        inaltime_sursa, latime_sursa = camp.shape
        rad = np.radians(unghi)
        sinus, cosinus = np.sin(rad), np.cos(rad)
        # Destination X is across the bars; destination Y runs along them.
        # This orthonormal mapping preserves millimetres in both directions.
        matrice = np.array([
            [-sinus, cosinus, 0.0],
            [cosinus, sinus, 0.0],
        ], dtype=np.float64)
        colturi = np.array([
            [0.0, 0.0],
            [float(latime_sursa), 0.0],
            [0.0, float(inaltime_sursa)],
            [float(latime_sursa), float(inaltime_sursa)],
        ])
        rotite = colturi @ matrice[:, :2].T
        minim = np.floor(rotite.min(axis=0))
        maxim = np.ceil(rotite.max(axis=0))
        matrice[:, 2] = -minim
        latime_rotita = max(1, int(maxim[0] - minim[0]))
        inaltime_rotita = max(1, int(maxim[1] - minim[1]))
        lucru = cv2.warpAffine(
            camp, matrice, (latime_rotita, inaltime_rotita),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0.0,
        )
        intoarcere = (cv2.invertAffineTransform(matrice), latime_sursa, inaltime_sursa)
    inaltime, latime = lucru.shape

    pas = pas_mm / mm_pe_px
    punte_min = punte_min_mm / mm_pe_px
    punte_max = (pas_mm - fanta_min_mm) / mm_pe_px
    if pas < 2:
        raise ReglajImposibil(
            f"Un pas de {pas_mm} mm iese sub doi pixeli la rezoluţia asta."
        )

    numar = max(1, int(latime // pas))
    margine = (latime - numar * pas) / 2
    masca = np.zeros((inaltime, latime), np.uint8)

    for indice in range(numar):
        centru = margine + (indice + 0.5) * pas
        st = max(0, int(centru - pas / 2))
        dr = min(latime, int(np.ceil(centru + pas / 2)))
        if dr <= st:
            continue
        cerneala = lucru[:, st:dr].mean(axis=1)
        latimi = punte_min + np.power(cerneala, gamma) * (punte_max - punte_min)
        de_la = np.round(centru - latimi / 2)[:, None]
        pana_la = np.round(centru + latimi / 2)[:, None]

        # Only the columns this bar can possibly reach. Comparing against the
        # whole sheet width instead meant every bar walked all 2600 columns:
        # four hundred bars times twelve megapixels, for geometry confined to a
        # dozen columns each. On a 1200 mm panel that was most of eight seconds.
        fs = max(0, int(centru - punte_max / 2) - 1)
        fd = min(latime, int(np.ceil(centru + punte_max / 2)) + 1)
        if fd <= fs:
            continue
        fereastra = np.arange(fs, fd)[None, :]
        masca[:, fs:fd] |= ((fereastra >= de_la) & (fereastra < pana_la)).astype(np.uint8)

    if intoarcere == "transpose":
        return masca.T.astype(bool)
    if intoarcere is not None:
        inversa, latime_sursa, inaltime_sursa = intoarcere
        return cv2.warpAffine(
            masca, inversa, (latime_sursa, inaltime_sursa),
            flags=cv2.INTER_NEAREST,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        ).astype(bool)
    return masca.astype(bool)


def hasura(
    camp: np.ndarray,
    mm_pe_px: float,
    unghi: float = 30.0,
    pas_rand_mm: float = 9.0,
    celula_mm: float = 12.0,
    fanta_min_mm: float = 2.0,
    punte_min_mm: float = 3.0,
    gamma: float = 1.4,
    prag: float = 0.06,
    zona: np.ndarray | None = None,
) -> np.ndarray:
    """Short back-lit slots: light tone is cut, dark tone remains plate."""
    for nume, valoare in (("Rândurile", pas_rand_mm), ("Celulele", celula_mm)):
        if valoare < fanta_min_mm + punte_min_mm:
            raise ReglajImposibil(
                f"{nume} la {valoare} mm nu pot ţine o fantă de {fanta_min_mm} mm "
                f"şi o punte de {punte_min_mm} mm; foloseşte cel puţin "
                f"{fanta_min_mm + punte_min_mm:.2f} mm."
            )
    _verifica_rezolutie(mm_pe_px, **{"Puntea": punte_min_mm, "Fanta": fanta_min_mm})
    inaltime, latime = camp.shape
    pas_rand = pas_rand_mm / mm_pe_px
    celula = celula_mm / mm_pe_px
    fanta_min = fanta_min_mm / mm_pe_px
    lungime_max = (celula_mm - punte_min_mm) / mm_pe_px
    latime_fanta = max(fanta_min, (pas_rand_mm - punte_min_mm) / mm_pe_px)
    if pas_rand < 2 or celula < 2:
        raise ReglajImposibil("Reţeaua de trăsături iese sub doi pixeli la rezoluţia asta.")

    rad = np.radians(unghi)
    cos, sin = np.cos(rad), np.sin(rad)
    yy, xx = np.mgrid[0:inaltime, 0:latime]
    dx = xx - latime / 2
    dy = yy - inaltime / 2
    u = dx * cos + dy * sin
    v = -dx * sin + dy * cos

    # Which stroke each pixel belongs to, and where it sits inside it.
    iu = np.floor(u / celula).astype(np.int64)
    iv = np.floor(v / pas_rand).astype(np.int64)
    iu -= iu.min()
    iv -= iv.min()
    coloane = int(iu.max()) + 1
    identificator = (iv * coloane + iu).reshape(-1)

    # Brightness determines the opening: the cut is what glows when the
    # finished panel is back-lit, while dark portrait features remain metal.
    lumina = 1.0 - camp
    numar = int(identificator.max()) + 1
    sume = np.bincount(identificator, weights=lumina.reshape(-1), minlength=numar)
    cate = np.bincount(identificator, minlength=numar)
    pe_celula = np.divide(sume, cate, out=np.zeros(numar), where=cate > 0)

    # A stroke starts at the tool's minimum and grows from there, the way a bar
    # starts at the minimum web. Measuring the length from zero instead meant a
    # cell needed roughly a quarter of full ink before it produced anything
    # cuttable at all, so on a real portrait -- mean light 0.075 -- the plate came
    # back 98% solid. What decides whether a stroke exists is the light, not the
    # arithmetic of a length that happens to land under the cutter.
    lungimi = fanta_min + np.power(pe_celula, gamma) * (lungime_max - fanta_min)
    lungimi[pe_celula < prag] = 0.0

    du = u - (np.floor(u / celula) + 0.5) * celula
    dv = v - (np.floor(v / pas_rand) + 0.5) * pas_rand
    jumatate = (lungimi[identificator] / 2).reshape(inaltime, latime)

    taiat = (np.abs(du) <= jumatate) & (np.abs(dv) <= latime_fanta / 2) & (jumatate > 0)
    if zona is not None:
        if zona.shape != camp.shape:
            raise ValueError("Zona de haşură trebuie să aibă aceeaşi mărime ca tonul.")
        taiat &= zona.astype(bool)
    return ~taiat
