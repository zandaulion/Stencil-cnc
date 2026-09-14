"""Tone, and the two mistakes that made the first results unusable.

Both are asserted here rather than described, because both looked correct in
isolation and only showed up as "the pieces are far too dense" on a photograph.
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "analiza"))

from ton import portret, ton  # noqa: E402


def plan(inaltime, latime, valoare):
    return np.full((inaltime, latime, 3), valoare, np.uint8)


class TestTon(unittest.TestCase):
    def test_o_suprafata_plata_nu_cere_cerneala(self):
        # The first mistake: local contrast written as `0.5 + difference`, which
        # makes a featureless wall ask for half the sheet. Measured on a real
        # portrait the mean came out 0.499 with 61% of pixels between 0.4 and
        # 0.6, and every style inherited that as density.
        for nivel in (20, 128, 240):
            with self.subTest(nivel=nivel):
                camp = ton(plan(120, 120, nivel), netezire=0)
                self.assertLess(float(camp.mean()), 0.02,
                                "a surface with no structure must ask for nothing")

    def test_ce_e_mai_inchis_decat_vecinatatea_primeste_cerneala(self):
        img = plan(160, 160, 235)
        img[60:100, 60:100] = 120
        camp = ton(img, netezire=0)
        # Two pixels inside the border the window straddles it, so the contrast
        # is partial by construction. What the test is about is the gap between
        # structure and plain ground, not an absolute level.
        margine = float(camp[62, 80])
        fundal = float(camp[8, 8])
        self.assertGreater(margine, 0.35, "the patch's edge is structure")
        self.assertLess(fundal, 0.05, "the plain ground is not")
        self.assertGreater(margine, fundal * 5, "and they must not be close")

    def test_interiorul_unei_pete_mari_nu_are_contrast_local(self):
        """Local contrast sees edges, not areas -- and that has a real cost.

        Well inside a uniform region the neighbourhood window lies entirely
        within it, so the mean equals the pixel and the difference is zero. It
        is the honest answer to "is this darker than its surroundings", but it
        means a large dark mass renders only as its own outline. On a portrait
        that is exactly why hair fades away from the silhouette: the strands
        are one dark area, not structure against something lighter.

        Written down as behaviour rather than a bug, because fixing it needs a
        second scale of measurement, not a different constant.
        """
        img = plan(160, 160, 235)
        img[40:120, 40:120] = 120
        camp = ton(img, netezire=0)
        self.assertLess(float(camp[80, 80]), 0.05, "the middle of the mass is flat")
        self.assertGreater(float(camp[42, 80]), 0.4, "its border is not")

    def test_ce_e_mai_deschis_nu_primeste_nimic(self):
        # Only darker-than-surroundings is ink. A highlight is bare sheet, not
        # "a little material", or every catchlight becomes geometry.
        img = plan(160, 160, 90)
        img[60:100, 60:100] = 220
        camp = ton(img, netezire=0)
        self.assertLess(float(camp[80, 80]), 0.05)

    def test_varful_scalei_ajunge_la_cerneala_plina(self):
        # The second mistake: moving the baseline to zero also collapsed the
        # top, so nothing reached 1. Slats survived on their minimum width;
        # hatch produced a plate with no slots at all, because every stroke came
        # out shorter than the tool could cut.
        img = plan(200, 200, 230)
        img[80:120, 80:120] = 40
        camp = ton(img, netezire=0)
        self.assertGreater(float(camp.max()), 0.95,
                           "the darkest structure must reach full ink")

    def test_o_sclipire_izolata_nu_decide_scara(self):
        # The stretch uses a high percentile, not the maximum: one specular
        # highlight in an eye should not rescale the whole face around itself.
        # The structure is a thin bar, narrower than the neighbourhood window,
        # so it genuinely has local contrast to measure.
        img = plan(200, 200, 220)
        img[:, 96:104] = 150               # the real structure
        img[100:102, 100:102] = 0          # a tiny, much darker speck
        camp = ton(img, netezire=0)
        corp = float(np.median(camp[20:60, 97:103]))
        self.assertGreater(corp, 0.3, "the real structure still reads")

    def test_netezirea_pastreaza_muchia_dar_sterge_textura(self):
        # The reason this step moved to the server: a bilateral filter flattens
        # skin without softening the jaw line beside it.
        rng = np.random.default_rng(5)
        img = plan(200, 200, 200)
        img[:, 100:] = 120                                     # a hard edge
        zgomot = rng.normal(0, 9, (200, 200, 3))
        img = np.clip(img.astype(float) + zgomot, 0, 255).astype(np.uint8)
        brut = ton(img, netezire=0)
        neted = ton(img, netezire=0.6)
        zona_plata = (slice(20, 80), slice(20, 80))
        self.assertLess(float(neted[zona_plata].mean()), float(brut[zona_plata].mean()),
                        "texture in a flat area should fade")
        self.assertGreater(float(neted[:, 96:104].max()), 0.5, "the edge survives")

    def test_o_imagine_uniforma_nu_explodeaza(self):
        camp = ton(plan(40, 40, 128), netezire=0)
        self.assertEqual(camp.shape, (40, 40))
        self.assertTrue(np.isfinite(camp).all())

    def test_o_imagine_alb_negru_e_refuzata(self):
        with self.assertRaises(ValueError):
            ton(np.zeros((10, 10), np.uint8))

    def test_portretul_pastreaza_masa_intunecata_si_detaliul(self):
        img = plan(160, 160, 220)
        img[30:130, 30:80] = 45
        img[70:75, 100:125] = 80
        camp = portret(img, netezire=0)
        self.assertGreater(float(camp[80, 55]), 0.7, "dark hair must remain a mass, not only an edge")
        self.assertGreater(float(camp[72, 110]), float(camp[20, 110]) + 0.25,
                           "a facial line must remain visible against light skin")


if __name__ == "__main__":
    unittest.main()
