"""The analysis service: a photograph in, a source mask out.

Deliberately the whole of its job. Everything downstream — frame, bridges,
connectivity, contour tracing, SVG and DXF — already exists in the browser core
and is tested there, so this service does not get to have opinions about it.
The contract is one JSON object in the run-length form `decodeMask` reads.

It carries no authentication of its own and must not be exposed: the Node app
in front holds the sessions, and this listens on the loopback only. Putting the
auth here as well would mean two places to get it right and one of them
untested.
"""

from __future__ import annotations

import base64
import io
import os

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from masca import codifica
from stiluri import (
    ReglajImposibil,
    aplica_limite_fizice,
    benzi_contur,
    centru_automat_raze,
    gravura,
    hasura,
    lamele,
    linie_art,
    linii_negative,
    ornament,
    portret_grafic,
    raze,
    sablon,
    sablon_icoana,
    silueta,
)
from subiect import FaraSubiect, aplica, subiect, subiect_icoana
from ton import portret, ton

# The working resolution is chosen per request, from the panel and the limits.
#
# A fixed raster was the wrong instinct. On a 1200 mm panel, 900 px gives
# 1.33 mm per pixel, and a 1.2 mm kerf is then not thin -- it is unrepresentable.
# The first version refused, which is honest but useless: the operator did not
# choose a strange resolution, they chose a panel and a tool, and both are
# reasonable. So the raster follows them.
#
# Bounded at both ends. Below the floor nothing is gained; above the ceiling a
# request costs seconds and memory for detail no cutter will honour.
LATIME_MIN = int(os.environ.get("LATIME_MIN", "900"))
LATIME_MAX = int(os.environ.get("LATIME_MAX", "2600"))

# How many pixels the smallest physical feature must span. Under about three the
# raster starts deciding the geometry instead of describing it.
PIXELI_PE_LIMITA = 3.0

# Where the picture is *understood*, as opposed to where it is drawn.
#
# Reading tone and finding the person are questions about content, and content
# is low-frequency: a cheek does not become a different cheek at four times the
# size. Drawing a 1.2 mm slot is a question about geometry, and that one does
# need the pixels. Doing both at the geometry raster cost 13 seconds on a
# 1200 mm panel -- twelve megapixels through a segmenter and a bilateral filter
# -- for detail that neither step could use.
LATIME_ANALIZA = int(os.environ.get("LATIME_ANALIZA", "900"))
MAX_FOTO = int(os.environ.get("MAX_FOTO", str(30 * 1024 * 1024)))

app = FastAPI(title="stencil-cnc analiză")


@app.get("/api/health")
def sanatate() -> dict:
    return {"ok": True}


def _latime_lucru(coala_lat_mm: float, limita_min_mm: float) -> int:
    """The raster width that can actually draw the smallest limit asked for."""
    if limita_min_mm <= 0:
        return LATIME_MIN
    ceruta = coala_lat_mm / limita_min_mm * PIXELI_PE_LIMITA
    return int(min(max(ceruta, LATIME_MIN), LATIME_MAX))


def _citeste(date: bytes, latime_lucru: int) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(date, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(415, "Fişierul nu e o imagine pe care s-o pot citi.")
    inaltime, latime = img.shape[:2]
    if latime != latime_lucru:
        img = cv2.resize(img, (latime_lucru, round(inaltime * latime_lucru / latime)),
                         interpolation=cv2.INTER_AREA)
    return img


def _citeste_linie(date: bytes, latime_lucru: int) -> np.ndarray:
    """Read line art while compositing transparency onto white like the PWA."""
    img = cv2.imdecode(np.frombuffer(date, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise HTTPException(415, "Fişierul nu e o imagine pe care s-o pot citi.")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.shape[2] == 4:
        alfa = img[:, :, 3:4].astype(np.float32) / 255.0
        img = np.clip(img[:, :, :3].astype(np.float32) * alfa + 255.0 * (1.0 - alfa), 0, 255).astype(np.uint8)
    elif img.shape[2] != 3:
        raise HTTPException(415, "Imaginea are un format de culoare neacceptat.")
    inaltime, latime = img.shape[:2]
    if latime != latime_lucru:
        img = cv2.resize(
            img, (latime_lucru, round(inaltime * latime_lucru / latime)),
            interpolation=cv2.INTER_AREA,
        )
    return img


def _raspuns_masca(
    masca: np.ndarray,
    coala_lat_mm: float,
    mm_pe_px: float,
    previzualizare: bool,
    info_suplimentar: dict | None = None,
) -> JSONResponse:
    inaltime, latime = masca.shape
    raspuns = {
        "sourceMask": codifica(masca),
        "sheet": {"widthMm": coala_lat_mm,
                  "heightMm": round(coala_lat_mm * inaltime / latime, 1)},
        "info": {
            "material": round(float(masca.mean()), 4),
            "mmPePixel": round(mm_pe_px, 4),
            "raster": [int(latime), int(inaltime)],
        },
    }
    if info_suplimentar:
        raspuns["info"].update(info_suplimentar)
    if previzualizare:
        ok, buf = cv2.imencode(".png", np.where(masca, 30, 245).astype(np.uint8))
        if ok:
            raspuns["preview"] = base64.b64encode(buf.tobytes()).decode()
    return JSONResponse(raspuns)


@app.post("/api/analizeaza")
async def analizeaza(
    foto: UploadFile = File(...),
    stil: str = Form("lamele"),
    coala_lat_mm: float = Form(200.0),
    fara_fundal: bool = Form(False),
    cu_haine: bool = Form(True),
    netezire: float = Form(0.55),
    castig: float = Form(2.2),
    gamma: float = Form(1.4),
    inverseaza: bool = Form(False),
    # line art (the browser renders these immediately, then asks for a finer copy)
    prag_linie: float = Form(0.5),
    contrast_linie: float = Form(0.0),
    netezire_linie_px: float = Form(0.0),
    pete_min_px2: float = Form(0.0),
    latime_baza_px: int = Form(900),
    # şablon portret
    prag_sablon: float = Form(0.50),
    contur: float = Form(0.60),
    # şablon icoană
    prag_icoana: float = Form(0.56),
    detaliu_icoana: float = Form(0.65),
    latime_linie_icoana_mm: float = Form(3.0),
    simplificare_icoana_mm: float = Form(3.0),
    aureola_icoana: bool = Form(True),
    scala_aureola_icoana: float = Form(1.35),
    # portret grafic
    prag_grafic: float = Form(0.50),
    detaliu_grafic: float = Form(0.70),
    simplificare_grafic_mm: float = Form(1.5),
    # linii negative / contur / ornament
    detaliu_linii: float = Form(0.40),
    latime_linie_mm: float = Form(2.0),
    niveluri_contur: int = Form(5),
    patru_directii: bool = Form(False),
    # gravură
    pas_gravura_mm: float = Form(12.0),
    lungime_gravura_mm: float = Form(20.0),
    # siluetă
    netezire_silueta_mm: float = Form(8.0),
    # raze
    numar_raze: int = Form(64),
    celula_raze_mm: float = Form(12.0),
    centru_raze_automat: bool = Form(True),
    centru_raze_x: float = Form(0.25),
    centru_raze_y: float = Form(0.50),
    prag_raze: float = Form(0.12),
    # lamele
    pas_mm: float = Form(38.0),
    orizontal: bool = Form(False),
    unghi_lamele: float | None = Form(None),
    # haşură
    unghi: float = Form(30.0),
    pas_rand_mm: float = Form(9.0),
    celula_mm: float = Form(12.0),
    # limite fizice
    punte_min_mm: float = Form(3.0),
    fanta_min_mm: float = Form(2.0),
    previzualizare: bool = Form(False),
) -> JSONResponse:
    date = await foto.read()
    if len(date) > MAX_FOTO:
        raise HTTPException(413, "Fotografie prea mare.")
    lat_geometrie = _latime_lucru(coala_lat_mm, min(punte_min_mm, fanta_min_mm))

    if stil == "linie_art":
        mare = _citeste_linie(date, lat_geometrie)
        mm_pe_px = coala_lat_mm / mare.shape[1]
        scala = mare.shape[1] / max(1, latime_baza_px)
        try:
            masca = linie_art(
                mare,
                prag=prag_linie,
                contrast=contrast_linie,
                netezire_px=netezire_linie_px * scala,
                pete_min_px2=pete_min_px2 * scala * scala,
                inverseaza=inverseaza,
            )
            masca = aplica_limite_fizice(masca, mm_pe_px, punte_min_mm, fanta_min_mm)
        except ReglajImposibil as e:
            raise HTTPException(422, str(e)) from e
        return _raspuns_masca(masca, coala_lat_mm, mm_pe_px, previzualizare)

    # Understood small, drawn large.
    mic = _citeste(date, min(LATIME_ANALIZA, lat_geometrie))
    masca_subiect = np.ones(mic.shape[:2], dtype=bool)
    # A silhouette has no meaningful whole-image fallback: without a detected
    # subject it would simply remove the entire artwork rectangle.
    if fara_fundal or stil in {"silueta", "grafic", "icoana"}:
        try:
            masca_subiect = (
                subiect_icoana(mic, cu_haine=cu_haine)
                if stil == "icoana"
                else subiect(mic, cu_haine=cu_haine)
            )
        except FaraSubiect as e:
            raise HTTPException(422, str(e)) from e
    if stil in {"sablon", "icoana", "grafic", "hasura", "linii", "gravura", "contururi", "raze", "ornament", "lamele"}:
        camp = portret(mic, masca=masca_subiect, castig=castig, netezire=netezire)
        if stil == "lamele" and fara_fundal:
            camp = aplica(camp, masca_subiect)
    else:
        camp = ton(mic, castig=castig, netezire=netezire)
        if fara_fundal:
            camp = aplica(camp, masca_subiect)
    if inverseaza:
        camp = np.where(masca_subiect, 1.0 - camp, camp).astype(np.float32)

    inaltime = round(mic.shape[0] * lat_geometrie / mic.shape[1])
    latime = lat_geometrie
    mm_pe_px = coala_lat_mm / latime
    if (latime, inaltime) != (camp.shape[1], camp.shape[0]):
        # Linear, not nearest: the tone field is a smooth quantity, and a
        # blocky one would print its own staircase into every bar edge.
        camp = cv2.resize(camp, (latime, inaltime), interpolation=cv2.INTER_LINEAR)
        masca_subiect = cv2.resize(
            masca_subiect.astype(np.uint8), (latime, inaltime), interpolation=cv2.INTER_NEAREST,
        ).astype(bool)

    info_suplimentar = None
    try:
        if stil == "sablon":
            masca = sablon(camp, masca_subiect, mm_pe_px, prag=prag_sablon, contur=contur,
                           punte_min_mm=punte_min_mm, fanta_min_mm=fanta_min_mm)
        elif stil == "icoana":
            masca = sablon_icoana(
                camp, masca_subiect, mm_pe_px,
                prag=prag_icoana,
                detaliu=detaliu_icoana,
                latime_linie_mm=max(latime_linie_icoana_mm, fanta_min_mm),
                simplificare_mm=simplificare_icoana_mm,
                aureola=aureola_icoana,
                scala_aureola=scala_aureola_icoana,
                punte_min_mm=punte_min_mm,
                fanta_min_mm=fanta_min_mm,
            )
        elif stil == "grafic":
            masca = portret_grafic(
                camp, masca_subiect, mm_pe_px, prag=prag_grafic,
                detaliu=detaliu_grafic, simplificare_mm=simplificare_grafic_mm,
                punte_min_mm=punte_min_mm,
            )
        elif stil == "lamele":
            masca = lamele(camp, mm_pe_px, pas_mm=pas_mm, punte_min_mm=punte_min_mm,
                           fanta_min_mm=fanta_min_mm, gamma=gamma, orizontal=orizontal,
                           unghi=unghi_lamele)
        elif stil == "hasura":
            masca = hasura(camp, mm_pe_px, unghi=unghi, pas_rand_mm=pas_rand_mm,
                           celula_mm=celula_mm, fanta_min_mm=fanta_min_mm,
                           punte_min_mm=punte_min_mm, gamma=gamma, zona=masca_subiect)
        elif stil == "linii":
            masca = linii_negative(camp, masca_subiect, mm_pe_px,
                                    detaliu=detaliu_linii,
                                    latime_mm=max(latime_linie_mm, fanta_min_mm))
        elif stil == "gravura":
            masca = gravura(camp, masca_subiect, mm_pe_px, pas_mm=pas_gravura_mm,
                             lungime_mm=lungime_gravura_mm, fanta_min_mm=fanta_min_mm,
                             punte_min_mm=punte_min_mm, gamma=gamma)
        elif stil == "silueta":
            masca = silueta(masca_subiect, mm_pe_px, netezire_mm=netezire_silueta_mm)
        elif stil == "contururi":
            masca = benzi_contur(camp, masca_subiect, mm_pe_px,
                                  niveluri=niveluri_contur,
                                  latime_mm=max(latime_linie_mm, fanta_min_mm))
        elif stil == "raze":
            centru_gasit = False
            raza_miez_mm = 0.0
            if centru_raze_automat:
                centru_raze_x, centru_raze_y, centru_gasit, raza_miez_mm = centru_automat_raze(
                    camp, masca_subiect, mm_pe_px, numar_raze=numar_raze,
                    celula_mm=celula_raze_mm, fanta_min_mm=fanta_min_mm,
                    punte_min_mm=punte_min_mm, prag_lumina=prag_raze,
                )
            masca = raze(camp, masca_subiect, mm_pe_px, numar_raze=numar_raze,
                          celula_mm=celula_raze_mm, centru_x=centru_raze_x,
                          centru_y=centru_raze_y, fanta_min_mm=fanta_min_mm,
                          punte_min_mm=punte_min_mm, gamma=gamma,
                          prag_lumina=prag_raze)
            info_suplimentar = {
                "radialCenter": {
                    "x": round(float(centru_raze_x), 5),
                    "y": round(float(centru_raze_y), 5),
                    "automatic": bool(centru_raze_automat),
                    "matchedMetal": bool(centru_gasit) if centru_raze_automat else None,
                    "hubRadiusMm": round(float(raza_miez_mm), 2) if centru_raze_automat else None,
                },
            }
        elif stil == "ornament":
            masca = ornament(camp, masca_subiect, mm_pe_px, detaliu=detaliu_linii,
                              latime_mm=max(latime_linie_mm, fanta_min_mm),
                              patru_directii=patru_directii)
        else:
            raise HTTPException(400, f"Stil necunoscut: {stil}")

        # Gridded styles construct their cut and web dimensions analytically.
        # Free-form masks need a final physical morphology pass so photographic
        # specks and near-touching contours cannot sneak beneath the plasma limits.
        if stil in {"sablon", "icoana", "grafic", "linii", "silueta", "contururi", "ornament"}:
            masca = aplica_limite_fizice(masca, mm_pe_px, punte_min_mm, fanta_min_mm)
    except ReglajImposibil as e:
        raise HTTPException(422, str(e)) from e

    return _raspuns_masca(
        masca, coala_lat_mm, mm_pe_px, previzualizare,
        info_suplimentar=info_suplimentar,
    )
