"""Subject post-processing independent of the segmentation model."""

import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "analiza"))

from subiect import pastreaza_persoanele, rafineaza_subiect_icoana  # noqa: E402


class TestPersoaneMultiple(unittest.TestCase):
    def test_un_cuplu_e_pastrat_dar_zgomotul_dispare(self):
        mask = np.zeros((100, 160), np.uint8)
        mask[15:85, 15:65] = 1
        mask[25:90, 90:140] = 1
        mask[2:4, 2:4] = 1
        result = pastreaza_persoanele(mask)
        self.assertTrue(result[40, 40])
        self.assertTrue(result[50, 110])
        self.assertFalse(result[2, 2])


class TestRafinareIcoana(unittest.TestCase):
    def test_fundalul_pal_etichetat_ca_haina_nu_devine_cap(self):
        h, w = 180, 140
        imagine = np.full((h, w, 3), (190, 220, 235), np.uint8)
        categorii = np.zeros((h, w), np.uint8)

        imagine[70:175, 30:110] = (30, 40, 170)
        categorii[70:175, 30:110] = 4  # clothing
        cv2.circle(imagine, (70, 58), 22, (150, 190, 220), -1)
        cv2.circle(categorii, (70, 58), 22, 3, -1)  # face skin: certain foreground

        # A background-coloured semantic mistake connected to the head would
        # survive ordinary connected-component filtering and become the cap
        # seen above the generated halo.
        categorii[5:30, 45:95] = 4
        categorii[30:55, 69:72] = 4

        rafinata = rafineaza_subiect_icoana(imagine, categorii, cu_haine=True)
        self.assertFalse(rafinata[15, 70])
        self.assertTrue(rafinata[58, 70])
        self.assertTrue(rafinata[120, 70])


if __name__ == "__main__":
    unittest.main()
