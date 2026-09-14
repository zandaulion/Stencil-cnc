"""Subject post-processing independent of the segmentation model."""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "analiza"))

from subiect import pastreaza_persoanele  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
