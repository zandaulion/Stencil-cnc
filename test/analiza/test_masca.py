"""The wire format is the one integration that cannot be repaired later.

Everything else between Python and the browser can be renegotiated; if a mask
arrives mis-shaped, the geometry is silently wrong and the first sign of it is a
sheet of metal. So the round trip is tested on its own, including the shapes
that usually break run-length coders: a single cell, a mask that is entirely on,
and one entirely off.
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "analiza"))

from masca import codifica, decodifica  # noqa: E402


class TestCodificare(unittest.TestCase):
    def test_dus_intors_pastreaza_forma_si_continutul(self):
        rng = np.random.default_rng(11)
        for forma in [(1, 1), (1, 7), (7, 1), (3, 5), (17, 23), (64, 40)]:
            with self.subTest(forma=forma):
                original = rng.random(forma) > 0.55
                refacut = decodifica(codifica(original))
                self.assertEqual(refacut.shape, original.shape)
                self.assertTrue((refacut == original).all())

    def test_latimea_si_inaltimea_nu_se_inverseaza(self):
        # NumPy indexes (rows, columns); the browser reads width then height.
        # Swapping them produces a mask that decodes without complaint and is
        # rotated, which is the worst kind of wrong.
        masca = np.zeros((3, 5), bool)
        codificat = codifica(masca)
        self.assertEqual(codificat["width"], 5)
        self.assertEqual(codificat["height"], 3)

    def test_masca_uniforma_da_o_singura_secventa(self):
        for valoare in (False, True):
            with self.subTest(valoare=valoare):
                codificat = codifica(np.full((9, 9), valoare))
                self.assertEqual(codificat["runs"], [81])
                self.assertEqual(codificat["startsWith"], int(valoare))

    def test_secventele_acopera_exact_suprafata(self):
        rng = np.random.default_rng(3)
        codificat = codifica(rng.random((13, 29)) > 0.5)
        self.assertEqual(sum(codificat["runs"]), 13 * 29)

    def test_o_masca_goala_e_refuzata(self):
        with self.assertRaises(ValueError):
            codifica(np.zeros((0, 4), bool))

    def test_codificarea_necunoscuta_e_refuzata(self):
        with self.assertRaises(ValueError):
            decodifica({"encoding": "altceva", "width": 1, "height": 1,
                        "startsWith": 0, "runs": [1]})


if __name__ == "__main__":
    unittest.main()
