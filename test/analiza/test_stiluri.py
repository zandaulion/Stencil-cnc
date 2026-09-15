"""The styles, and the promise that makes them safe to cut.

Both families take the cutting limits as inputs rather than checking them after
the fact, so the tests are about what the geometry cannot do: a bar thinner
than the material holds, a gap narrower than the tool enters, a stroke the
machine would have to invent.
"""

import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "analiza"))

from stiluri import (  # noqa: E402
    _cap_din_subiect,
    _raze_adaptive,
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
    puncte_variabile,
    raze,
    sablon,
    sablon_icoana,
    punte_inainte_de_kerf,
    silueta,
)

MM_PE_PX = 0.5          # a 400 px sheet is 200 mm wide


def camp_uniform(inaltime, latime, cerneala):
    return np.full((inaltime, latime), cerneala, np.float32)


def secvente_pe_rand(masca, y):
    """Widths of the runs of material on one row, in pixels."""
    rand = masca[y]
    schimbari = np.flatnonzero(np.diff(rand.astype(np.int8)))
    margini = np.concatenate(([0], schimbari + 1, [rand.size]))
    return [int(margini[i + 1] - margini[i]) for i in range(len(margini) - 1)
            if rand[margini[i]]]


class TestCompensareKerf(unittest.TestCase):
    def test_puntea_desenata_lasa_latimea_finita_dupa_kerf(self):
        self.assertAlmostEqual(punte_inainte_de_kerf(3.0, 1.2), 4.2)

    def test_refuza_valori_fizice_imposibile(self):
        with self.assertRaises(ReglajImposibil):
            punte_inainte_de_kerf(0, 1.2)
        with self.assertRaises(ReglajImposibil):
            punte_inainte_de_kerf(3, -0.1)


class TestLinieArt(unittest.TestCase):
    def test_intunecatul_este_material_si_polaritatea_il_inverseaza(self):
        imagine = np.array([[[0, 0, 0], [255, 255, 255], [127, 127, 127]]], np.uint8)
        masca = linie_art(imagine, prag=0.5)
        self.assertEqual(masca.tolist(), [[True, False, True]])
        self.assertTrue(np.array_equal(linie_art(imagine, prag=0.5, inverseaza=True), ~masca))

    def test_pragul_si_contrastul_schimba_rezultatul(self):
        imagine = np.full((3, 3, 3), 150, np.uint8)
        self.assertFalse(linie_art(imagine, prag=0.5).any())
        self.assertTrue(linie_art(imagine, prag=0.7).all())
        self.assertFalse(linie_art(imagine, prag=0.6, contrast=100).any())

    def test_petele_retinute_mici_sunt_sterse(self):
        imagine = np.full((7, 7, 3), 255, np.uint8)
        imagine[1, 1] = 0
        imagine[3:6, 3:6] = 0
        masca = linie_art(imagine, pete_min_px2=4)
        self.assertFalse(masca[1, 1])
        self.assertTrue(masca[4, 4])

    def test_netezirea_pastreaza_dimensiunile(self):
        imagine = np.full((11, 17, 3), 255, np.uint8)
        self.assertEqual(linie_art(imagine, netezire_px=2).shape, (11, 17))


class TestLimiteFizice(unittest.TestCase):
    def test_o_gaura_sub_doi_mm_este_inchisa(self):
        masca = np.ones((31, 31), dtype=bool)
        masca[15:17, 15:17] = False  # 1 mm at 0.5 mm/px
        curata = aplica_limite_fizice(masca, MM_PE_PX, 3, 2)
        self.assertTrue(curata[15:17, 15:17].all())

    def test_doua_taieturi_cu_un_gap_sub_trei_mm_sunt_unite(self):
        masca = np.ones((41, 41), dtype=bool)
        masca[8:33, 3:18] = False
        masca[8:33, 23:38] = False  # 2.5 mm of metal between the cuts
        curata = aplica_limite_fizice(masca, MM_PE_PX, 3, 2)
        self.assertFalse(curata[20, 20], "the uncuttable web should become part of one cut")

    def test_detaliile_peste_limite_ramane(self):
        masca = np.ones((41, 41), dtype=bool)
        masca[10:31, 10:31] = False
        curata = aplica_limite_fizice(masca, MM_PE_PX, 3, 2)
        self.assertFalse(curata[20, 20])


class TestLamele(unittest.TestCase):
    def test_un_pas_fara_loc_e_refuzat(self):
        with self.assertRaises(ReglajImposibil) as ctx:
            lamele(camp_uniform(200, 200, 0.5), MM_PE_PX,
                   pas_mm=2, punte_min_mm=1.5, fanta_min_mm=1)
        self.assertIn("cel puţin", str(ctx.exception),
                      "the refusal should say what would work")

    def test_bara_ramane_intre_limita_materialului_si_a_sculei(self):
        masca = lamele(camp_uniform(200, 400, 1.0), MM_PE_PX,
                       pas_mm=10, punte_min_mm=2, fanta_min_mm=3)
        for latime in secvente_pe_rand(masca, 100):
            mm = latime * MM_PE_PX
            self.assertGreaterEqual(mm, 2 - 0.6, "a bar under the minimum web")
            self.assertLessEqual(mm, 7 + 0.6, "a gap under the minimum slot")

    def test_o_zona_deschisa_pastreaza_bara_minima(self):
        # Letting bars vanish in a highlight would drop the frame's grip on
        # everything below them.
        masca = lamele(camp_uniform(200, 400, 0.0), MM_PE_PX,
                       pas_mm=10, punte_min_mm=2, fanta_min_mm=3)
        secvente = secvente_pe_rand(masca, 100)
        self.assertEqual(len(secvente), 20, "one bar per pitch, even on bare sheet")

    def test_mai_multa_cerneala_da_bare_mai_late(self):
        lat = secvente_pe_rand(lamele(camp_uniform(200, 400, 0.9), MM_PE_PX,
                                      pas_mm=10, punte_min_mm=2, fanta_min_mm=3), 100)[0]
        ingust = secvente_pe_rand(lamele(camp_uniform(200, 400, 0.1), MM_PE_PX,
                                         pas_mm=10, punte_min_mm=2, fanta_min_mm=3), 100)[0]
        self.assertGreater(lat, ingust)

    def test_fiecare_bara_merge_pe_toata_inaltimea(self):
        # The property that makes this family safe: nothing here can float free
        # of the frame, so connectivity is the frame's job alone.
        masca = lamele(camp_uniform(200, 400, 0.5), MM_PE_PX,
                       pas_mm=10, punte_min_mm=2, fanta_min_mm=3)
        asteptat = len(secvente_pe_rand(masca, 0))
        self.assertGreater(asteptat, 0)
        for y in (0, 60, 120, 199):
            self.assertEqual(len(secvente_pe_rand(masca, y)), asteptat,
                             f"row {y} lost a bar")

    def test_orizontal_citeste_imaginea_invers(self):
        camp = np.zeros((200, 200), np.float32)
        camp[:100, :] = 1.0
        masca = lamele(camp, MM_PE_PX, pas_mm=10, punte_min_mm=2,
                       fanta_min_mm=3, orizontal=True)
        self.assertGreater(masca[:100].sum(), masca[100:].sum() * 1.4)

    def test_unghiul_diagonal_roteste_lamelele_fara_sa_roteasca_portretul(self):
        camp = np.zeros((240, 160), np.float32)
        camp[40:200, 50:110] = 0.85
        vertical = lamele(camp, MM_PE_PX, pas_mm=10, punte_min_mm=2,
                           fanta_min_mm=3, unghi=90)
        diagonal = lamele(camp, MM_PE_PX, pas_mm=10, punte_min_mm=2,
                           fanta_min_mm=3, unghi=-55)
        self.assertEqual(diagonal.shape, camp.shape)
        self.assertGreater(float((vertical != diagonal).mean()), 0.15)
        # Every diagonal bar is cut from an infinite line through the sheet,
        # so no component may float wholly inside the panel.
        numar, etichete = cv2.connectedComponents(diagonal.astype(np.uint8), 4)
        margine = np.unique(np.concatenate((
            etichete[0], etichete[-1], etichete[:, 0], etichete[:, -1],
        )))
        self.assertTrue(set(range(1, numar)).issubset(set(margine.tolist())))

    def test_unghiul_lamelelor_este_limitat(self):
        with self.assertRaises(ReglajImposibil):
            lamele(camp_uniform(100, 100, 0.5), MM_PE_PX, unghi=91)


class TestRezolutie(unittest.TestCase):
    def test_o_limita_sub_un_pixel_e_refuzata(self):
        """A limit the raster cannot draw is not a limit.

        On a 1200 mm panel rendered at 900 px -- 1.33 mm per pixel -- a 1 mm
        minimum web came out as a dotted line rather than a bar, and the
        connectivity check then correctly reported three thousand single-pixel
        pieces that would fall out. Refusing is the honest answer: the fix is a
        smaller panel or a bigger limit, and only the operator can choose.
        """
        camp = camp_uniform(200, 200, 0.5)
        for fn, argumente in (
            (lamele, {"pas_mm": 6}),
            (hasura, {"pas_rand_mm": 6, "celula_mm": 6}),
        ):
            with self.subTest(stil=fn.__name__):
                with self.assertRaises(ReglajImposibil) as ctx:
                    fn(camp, 1.33, punte_min_mm=1.0, fanta_min_mm=1.2, **argumente)
                self.assertIn("pixeli", str(ctx.exception))
                self.assertIn("mm pe pixel", str(ctx.exception),
                              "the message should name the resolution that caused it")

    def test_aceleaşi_limite_trec_la_o_rezoluţie_potrivită(self):
        camp = camp_uniform(200, 200, 0.5)
        masca = lamele(camp, 0.4, pas_mm=6, punte_min_mm=1.0, fanta_min_mm=1.2)
        self.assertTrue(masca.any(), "a finer raster can draw the same limits")


class TestHasura(unittest.TestCase):
    def test_o_retea_fara_loc_e_refuzata(self):
        for cheie in ("pas_rand_mm", "celula_mm"):
            with self.subTest(cheie=cheie):
                with self.assertRaises(ReglajImposibil):
                    hasura(camp_uniform(200, 200, 0.5), MM_PE_PX,
                           fanta_min_mm=1, punte_min_mm=1.2, **{cheie: 1.5})

    def test_o_zona_aproape_neagra_ramane_placa_intreaga(self):
        masca = hasura(camp_uniform(300, 300, 0.99), MM_PE_PX,
                       pas_rand_mm=5, celula_mm=5, fanta_min_mm=2, punte_min_mm=1.5)
        self.assertTrue(masca.all(), "nothing should be cut in a nearly black area")

    def test_o_trasatura_porneste_de_la_minimul_sculei(self):
        # Measuring length from zero meant a cell needed roughly a quarter of
        # full ink before producing anything cuttable, so a real portrait --
        # mean ink 0.075 -- came back 98% solid plate.
        putin = 1.0 - hasura(camp_uniform(300, 300, 0.88), MM_PE_PX,
                             pas_rand_mm=4, celula_mm=4,
                             fanta_min_mm=0.8, punte_min_mm=1.0).mean()
        self.assertGreater(putin, 0.02,
                           "faint but real light must still cut something")

    def test_sub_prag_nu_se_taie_nimic(self):
        masca = hasura(camp_uniform(300, 300, 0.99), MM_PE_PX,
                       pas_rand_mm=4, celula_mm=4, fanta_min_mm=0.8,
                       punte_min_mm=1.0, prag=0.06)
        self.assertTrue(masca.all())

    def test_mai_multa_lumina_scoate_mai_mult_material(self):
        taiat = lambda c: 1.0 - hasura(camp_uniform(300, 300, c), MM_PE_PX,
                                       pas_rand_mm=5, celula_mm=5,
                                       fanta_min_mm=1, punte_min_mm=1.5).mean()
        self.assertGreater(taiat(0.0), taiat(0.6))

    def test_unghiul_chiar_roteste_trasaturile(self):
        camp = camp_uniform(300, 300, 0.0)
        drept = hasura(camp, MM_PE_PX, unghi=0, pas_rand_mm=6, celula_mm=6,
                       fanta_min_mm=1, punte_min_mm=1.5)
        inclinat = hasura(camp, MM_PE_PX, unghi=45, pas_rand_mm=6, celula_mm=6,
                          fanta_min_mm=1, punte_min_mm=1.5)
        diferite = float((drept != inclinat).mean())
        self.assertGreater(diferite, 0.05)

    def test_placa_porneste_intreaga(self):
        camp = np.ones((200, 200), np.float32)
        camp[:100, :] = 0.0
        masca = hasura(camp, MM_PE_PX, pas_rand_mm=5, celula_mm=5,
                       fanta_min_mm=1, punte_min_mm=1.5)
        self.assertTrue(masca[130:].all(), "a dark area returns untouched plate")

    def test_fundalul_din_afara_subiectului_nu_se_taie(self):
        camp = camp_uniform(160, 160, 0.0)
        zona = np.zeros((160, 160), dtype=bool)
        zona[40:120, 40:120] = True
        masca = hasura(camp, MM_PE_PX, pas_rand_mm=5, celula_mm=5,
                       fanta_min_mm=1, punte_min_mm=1.5, zona=zona)
        self.assertTrue(masca[10, 10])
        self.assertFalse(masca[40:120, 40:120].all())


class TestPuncteVariabile(unittest.TestCase):
    def test_un_pas_fara_loc_pentru_punct_si_punte_e_refuzat(self):
        with self.assertRaises(ReglajImposibil):
            puncte_variabile(
                camp_uniform(160, 160, 0.0), MM_PE_PX,
                pas_mm=4, diametru_max_mm=3,
                fanta_min_mm=2, punte_min_mm=3,
            )

    def test_mai_multa_lumina_produce_puncte_mai_mari(self):
        intunecat = puncte_variabile(
            camp_uniform(240, 240, 0.82), MM_PE_PX,
            pas_mm=12, diametru_max_mm=7,
            fanta_min_mm=2, punte_min_mm=3,
        )
        luminos = puncte_variabile(
            camp_uniform(240, 240, 0.0), MM_PE_PX,
            pas_mm=12, diametru_max_mm=7,
            fanta_min_mm=2, punte_min_mm=3,
        )
        self.assertGreater((~luminos).sum(), (~intunecat).sum() * 2)

    def test_umbra_sub_prag_ramane_metal_plin(self):
        masca = puncte_variabile(
            camp_uniform(160, 160, 0.95), MM_PE_PX,
            pas_mm=12, diametru_max_mm=7, prag=0.10,
            fanta_min_mm=2, punte_min_mm=3,
        )
        self.assertTrue(masca.all())

    def test_toate_deschiderile_sunt_cercuri_intregi_in_limitele_fizice(self):
        masca = puncte_variabile(
            camp_uniform(240, 240, 0.0), MM_PE_PX,
            pas_mm=12, diametru_max_mm=7,
            fanta_min_mm=2, punte_min_mm=3,
        )
        numar, _, statistici, _ = cv2.connectedComponentsWithStats((~masca).astype(np.uint8), 8)
        self.assertGreater(numar, 5)
        for index in range(1, numar):
            latime = statistici[index, cv2.CC_STAT_WIDTH]
            inaltime = statistici[index, cv2.CC_STAT_HEIGHT]
            self.assertEqual(latime, inaltime, "each opening must remain a complete circle")
            self.assertGreaterEqual(latime * MM_PE_PX, 2.0)
            self.assertLessEqual(latime * MM_PE_PX, 7.0)

    def test_fundalul_din_afara_subiectului_ramane_metal(self):
        camp = camp_uniform(200, 200, 0.0)
        zona = np.zeros((200, 200), dtype=bool)
        zona[50:150, 50:150] = True
        masca = puncte_variabile(
            camp, MM_PE_PX, pas_mm=12, diametru_max_mm=7,
            fanta_min_mm=2, punte_min_mm=3, zona=zona,
        )
        self.assertTrue(masca[10, 10])
        self.assertFalse(masca[70:130, 70:130].all())

    def test_unghiul_roteste_reteaua_fara_sa_schimbe_imaginea(self):
        camp = camp_uniform(220, 180, 0.0)
        drept = puncte_variabile(
            camp, MM_PE_PX, pas_mm=12, diametru_max_mm=6,
            fanta_min_mm=2, punte_min_mm=3, unghi=0,
        )
        inclinat = puncte_variabile(
            camp, MM_PE_PX, pas_mm=12, diametru_max_mm=6,
            fanta_min_mm=2, punte_min_mm=3, unghi=25,
        )
        self.assertGreater(float((drept != inclinat).mean()), 0.03)


class TestSablon(unittest.TestCase):
    def test_fundalul_ramane_placa_si_zonele_deschise_se_taie(self):
        camp = np.zeros((120, 160), np.float32)
        persoana = np.zeros_like(camp, dtype=bool)
        persoana[20:100, 40:120] = True
        masca = sablon(camp, persoana, MM_PE_PX, prag=0.5, contur=0,
                       punte_min_mm=2, fanta_min_mm=2)
        self.assertTrue(masca[5, 5], "outside the portrait remains retained plate")
        self.assertFalse(masca[60, 80], "a broad light area becomes an opening")

    def test_trasaturile_intunecate_ramane_material(self):
        camp = np.zeros((120, 160), np.float32)
        persoana = np.zeros_like(camp, dtype=bool)
        persoana[20:100, 40:120] = True
        camp[55:65, 50:110] = 1
        masca = sablon(camp, persoana, MM_PE_PX, prag=0.5, contur=0,
                       punte_min_mm=2, fanta_min_mm=2)
        self.assertTrue(masca[60, 80])

    def test_o_deschidere_sub_scula_dispare(self):
        camp = np.ones((80, 80), np.float32)
        persoana = np.ones_like(camp, dtype=bool)
        camp[39:41, 39:41] = 0
        masca = sablon(camp, persoana, MM_PE_PX, prag=0.5, contur=0,
                       punte_min_mm=2, fanta_min_mm=4)
        self.assertTrue(masca.all(), "an opening narrower than the cutter is not proposed")


class TestSablonIcoana(unittest.TestCase):
    def test_placa_ramane_solida_in_afara_figurii(self):
        camp = np.zeros((180, 220), np.float32)
        persoana = np.zeros_like(camp, dtype=bool)
        persoana[25:165, 55:165] = True
        masca = sablon_icoana(
            camp, persoana, MM_PE_PX, prag=0.56, detaliu=0,
            simplificare_mm=0, aureola=False,
            punte_min_mm=2, fanta_min_mm=2,
        )
        self.assertTrue(masca[5, 5])
        self.assertFalse(masca[90, 110], "the light figure should be a broad back-lit opening")

    def test_aureola_taie_numai_in_jurul_capului_si_lasa_bare(self):
        camp = np.ones((280, 220), np.float32)
        persoana = np.zeros_like(camp, dtype=np.uint8)
        cv2.circle(persoana, (110, 55), 26, 1, -1)
        cv2.rectangle(persoana, (65, 78), (155, 260), 1, -1)
        persoana = persoana.astype(bool)
        fara = sablon_icoana(
            camp, persoana, MM_PE_PX, detaliu=0, simplificare_mm=0,
            aureola=False, punte_min_mm=2, fanta_min_mm=2,
        )
        cu = sablon_icoana(
            camp, persoana, MM_PE_PX, detaliu=0, simplificare_mm=0,
            aureola=True, scala_aureola=1.2,
            punte_min_mm=2, fanta_min_mm=2,
        )
        fundal_sus = ~persoana[:100]
        self.assertTrue(fara[:100][fundal_sus].all())
        self.assertGreater((~cu[:100][fundal_sus]).sum(), 20,
                           "the halo must open a visible disk behind the head")
        centru_x, centru_y, raza = _cap_din_subiect(persoana)
        raza *= 1.2
        x_bara = round(centru_x + raza * 0.82)
        y_bara = round(centru_y)
        y_deschis = round(centru_y - raza * 0.18)
        self.assertFalse(persoana[y_bara, x_bara])
        self.assertTrue(cu[y_bara, x_bara], "the horizontal halo bar remains metal")
        self.assertFalse(cu[y_deschis, x_bara], "the area beside the halo bar remains open")

    def test_detaliul_deschide_un_fald_fara_sa_gaureasca_tot_materialul(self):
        camp = np.full((200, 200), 0.70, np.float32)
        camp[:, 97:103] = 0.58
        zona = np.ones_like(camp, dtype=bool)
        simplu = sablon_icoana(
            camp, zona, MM_PE_PX, prag=0.56, detaliu=0,
            latime_linie_mm=2, simplificare_mm=0, aureola=False,
            punte_min_mm=2, fanta_min_mm=2,
        )
        detaliat = sablon_icoana(
            camp, zona, MM_PE_PX, prag=0.56, detaliu=1,
            latime_linie_mm=2, simplificare_mm=0, aureola=False,
            punte_min_mm=2, fanta_min_mm=2,
        )
        self.assertTrue(simplu[100, 100])
        self.assertFalse(detaliat[100, 100], "a light valley in a broad dark robe becomes a cut fold")
        self.assertTrue(detaliat[100, 70], "the surrounding dark mass remains material")


class TestStiluriDinReferinte(unittest.TestCase):
    def setUp(self):
        self.camp = np.zeros((180, 220), np.float32)
        self.zona = np.zeros_like(self.camp, dtype=bool)
        self.zona[20:160, 30:190] = True
        self.camp[45:135, 65:155] = 0.85
        self.camp[70:85, 80:140] = 0.1

    def test_liniile_negative_taie_detalii_dar_nu_fundalul(self):
        masca = linii_negative(self.camp, self.zona, MM_PE_PX,
                                detaliu=0.7, latime_mm=2)
        self.assertTrue(masca[5, 5])
        self.assertFalse(masca.all(), "feature transitions should become openings")

    def test_portretul_grafic_scoate_fundalul_si_pastreaza_formele_negre(self):
        masca = portret_grafic(self.camp, self.zona, MM_PE_PX, prag=0.55,
                                detaliu=0.65, simplificare_mm=1,
                                punte_min_mm=2)
        self.assertFalse(masca[5, 5], "the reference style has a removed background")
        self.assertTrue(masca[60, 100], "dark portrait regions become retained material")
        self.assertFalse(masca[100, 50], "broad light skin remains open")

    def test_gravura_urmareste_tonul_intr_o_placa_retinuta(self):
        masca = gravura(self.camp, self.zona, MM_PE_PX, pas_mm=6,
                         lungime_mm=10, fanta_min_mm=1.5, punte_min_mm=1.5)
        self.assertTrue(masca[5, 5])
        self.assertFalse(masca[20:160, 30:190].all())

    def test_silueta_devine_o_singura_deschidere_curata(self):
        masca = silueta(self.zona, MM_PE_PX, netezire_mm=2)
        self.assertTrue(masca[5, 5])
        self.assertFalse(masca[90, 110])

    def test_benzile_de_contur_urmeaza_mai_multe_niveluri(self):
        masca = benzi_contur(self.camp, self.zona, MM_PE_PX,
                              niveluri=5, latime_mm=2)
        self.assertTrue(masca[5, 5])
        self.assertFalse(masca.all())

    def test_razele_sunt_intr_o_zona_si_lasa_punti_intre_celule(self):
        masca = raze(self.camp, self.zona, MM_PE_PX, numar_raze=24,
                      celula_mm=10, fanta_min_mm=1.5, punte_min_mm=1.5)
        self.assertTrue(masca[5, 5])
        self.assertFalse(masca[20:160, 30:190].all())
        self.assertTrue(masca[20:160, 30:190].any())

    def test_razele_folosesc_diametrul_real_cerut_pentru_miez(self):
        camp = np.zeros((400, 400), np.float32)
        zona = np.ones_like(camp, dtype=bool)
        masca = raze(
            camp, zona, MM_PE_PX, numar_raze=64, celula_mm=10,
            diametru_miez_mm=30, centru_x=0.5, centru_y=0.5,
            fanta_min_mm=1.5, punte_min_mm=1.5,
        )
        yy, xx = np.mgrid[:400, :400]
        distanta_mm = np.hypot(xx - 199.5, yy - 199.5) * MM_PE_PX
        self.assertTrue(masca[distanta_mm < 14.5].all())
        prima_taiere_mm = float(distanta_mm[~masca].min())
        self.assertGreaterEqual(prima_taiere_mm, 14.5)
        self.assertLess(prima_taiere_mm, 16.5)

    def test_razele_se_dubleaza_ordonat_spre_exterior(self):
        numere = _raze_adaptive(
            64,
            np.array([20.0, 40.0, 80.0]),
            fanta_px=3.0,
            punte_px=3.0,
        )
        self.assertEqual(numere.tolist(), [16, 32, 64])

    def test_razele_refuza_un_miez_mai_mic_decat_o_fanta_si_o_punte(self):
        with self.assertRaises(ReglajImposibil):
            raze(
                self.camp, self.zona, MM_PE_PX,
                diametru_miez_mm=1, fanta_min_mm=2, punte_min_mm=3,
            )

    def test_razele_redau_tonul_prin_suprafata_celulelor_polare(self):
        camp = np.full((400, 400), 0.9, np.float32)
        camp[:, 200:] = 0.1
        zona = np.ones_like(camp, dtype=bool)
        masca = raze(camp, zona, MM_PE_PX, numar_raze=48,
                      celula_mm=10, fanta_min_mm=1.5, punte_min_mm=1.5,
                      prag_lumina=0.2)
        taiat_intunecat = (~masca[:, :180]).mean()
        taiat_luminos = (~masca[:, 220:]).mean()
        self.assertLess(taiat_intunecat, 0.001)
        self.assertGreater(taiat_luminos, 0.15,
                           "bright source regions need visibly broader radial marks")

    def test_pragul_razelor_trebuie_sa_fie_valid(self):
        with self.assertRaises(ReglajImposibil):
            raze(self.camp, self.zona, MM_PE_PX, prag_lumina=1.0)

    def test_centrul_automat_ascunde_intregul_miez_in_material(self):
        camp = np.zeros((161, 181), np.float32)
        zona = np.ones_like(camp, dtype=bool)
        # The small dark patch at image centre cannot contain the whole hub;
        # the larger patch to its right can.
        cv2.circle(camp, (90, 80), 5, 1.0, -1)
        cv2.circle(camp, (135, 80), 28, 1.0, -1)
        x, y, gasit, raza_mm = centru_automat_raze(
            camp, zona, MM_PE_PX, numar_raze=12, celula_mm=6,
            diametru_miez_mm=20,
            fanta_min_mm=1.5, punte_min_mm=1.5, prag_lumina=0.12,
        )
        self.assertTrue(gasit)
        centru = (round(x * (camp.shape[1] - 1)), round(y * (camp.shape[0] - 1)))
        raza_px = int(np.floor(raza_mm / MM_PE_PX))
        yy, xx = np.ogrid[:camp.shape[0], :camp.shape[1]]
        miez = (xx - centru[0]) ** 2 + (yy - centru[1]) ** 2 <= raza_px ** 2
        self.assertTrue((camp[miez] >= 0.88).all())
        self.assertGreater(centru[0], 90, "the undersized central patch must not be selected")
        self.assertAlmostEqual(raza_mm, 10.0)

    def test_centrul_automat_foloseste_rezerva_ceruta_daca_nu_are_loc(self):
        camp = np.zeros((100, 200), np.float32)
        zona = np.ones_like(camp, dtype=bool)
        x, y, gasit, _ = centru_automat_raze(camp, zona, MM_PE_PX)
        self.assertEqual((x, y, gasit), (0.25, 0.5, False))

    def test_ornamentul_este_exact_simetric(self):
        masca = ornament(self.camp, self.zona, MM_PE_PX, detaliu=0.7,
                          latime_mm=2, patru_directii=True)
        np.testing.assert_array_equal(masca, np.fliplr(masca))
        np.testing.assert_array_equal(masca, np.flipud(masca))


if __name__ == "__main__":
    unittest.main()
