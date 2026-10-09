import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from coverage import CoverageMap


def test_coverage_requires_distinct_views_and_angles():
    grid = CoverageMap(voxel_size=1)
    xyz, rgb = np.array([[0., 0., -5.]]), np.array([[220, 60, 30]])
    grid.add(xyz, rgb, [(1, [0., 0, 0]), (2, [.02, 0, 0])])
    before = grid.snapshot()
    for _ in range(5):
        grid.add(xyz, rgb, [(1, [0., 0, 0]), (2, [.02, 0, 0])])
    assert grid.snapshot() == before
    assert before[1][0] < 1
    grid.add(xyz, rgb, [(3, [2., 0, 0])])
    assert grid.snapshot()[1] == [1.]
    assert len(grid.cells) == 1  # No cells invented in unknown space.


def test_coverage_budget_does_not_change_grid_scale():
    grid = CoverageMap(voxel_size=.4, max_cells=2)
    grid.add([[0, 0, -5], [1, 0, -5], [2, 0, -5]], [[100, 100, 100]]*3, [(1, [0, 0, 0])])
    assert len(grid.cells) == 2 and grid.limited
    assert grid.voxel_size == .4


