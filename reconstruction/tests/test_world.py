import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import pytest
from world import fuse


def test_fusion_keeps_geometry_and_averages_color():
    voxels, size = fuse([[.1, .1, .1], [.2, .2, .2], [2., 0., 0.]], [[255, 0, 0], [0, 0, 255], [0, 255, 0]], 1)
    assert len(voxels) == 2
    assert voxels[0].tolist() == [.5, .5, .5, 1., 128., 0., 128.]
    assert size == 1


def test_budget_increases_spacing_without_truncation():
    rng = np.random.default_rng(1)
    xyz = rng.uniform(-10, 10, (1000, 3))
    voxels, size = fuse(xyz, np.full((1000, 3), 100), .01, 100)
    assert len(voxels) <= 100
    assert size > .01


def test_nonfinite_and_invalid_input():
    with pytest.raises(ValueError):
        fuse([[np.nan, 0, 0]], [[0, 0, 0]], 1)
    with pytest.raises(ValueError):
        fuse([[0, 0, 0]], [[0, 0, 0]], 0)
