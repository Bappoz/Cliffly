import os
import sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cv2
import numpy as np
import pytest
from reconstruct import reconstruct, stereo_pair
from synthetic import generate


def test_stereo_recovers_known_depth_and_color(tmp_path):
    rng = np.random.default_rng(3)
    left = rng.integers(20, 240, (320, 640, 3), dtype=np.uint8)
    left = cv2.GaussianBlur(left, (3, 3), 0)
    right = np.zeros_like(left)
    right[:, :-32] = left[:, 32:]
    cv2.imwrite(str(tmp_path / 'left.jpg'), left)
    cv2.imwrite(str(tmp_path / 'right.jpg'), right)
    camera = SimpleNamespace(model_name='PINHOLE', calibration_matrix=lambda: np.array([[300., 0, 320], [0, 300., 160], [0, 0, 1.]]))
    def image(name, translation):
        transform = SimpleNamespace(matrix=lambda: np.column_stack((np.eye(3), translation)))
        return SimpleNamespace(camera_id=1, name=name, cam_from_world=lambda: transform)
    xyz, rgb = stereo_pair(image('left.jpg', [0., 0, 0]), image('right.jpg', [-.5, 0, 0]),
                           SimpleNamespace(cameras={1: camera}), tmp_path,
                           (np.array([-10., -10, 1]), np.array([10., 10, 10])))
    assert len(xyz) > 5000
    assert abs(np.median(xyz[:, 2]) - 300 * .5 / 32) < .05
    assert (rgb >= 0).all() and (rgb <= 255).all()


def test_too_few_frames_fail_without_inventing_world(tmp_path):
    frames = tmp_path / 'frames'; frames.mkdir()
    with pytest.raises(ValueError, match='3 segundos'):
        reconstruct(frames, tmp_path / 'output')
    assert not (tmp_path / 'output/world.json').exists()


@pytest.mark.skipif(os.getenv('CLIFFLY_SFM_TEST') != '1', reason='Explicit CPU SfM integration run')
def test_real_multiview_reconstructs_a_room(tmp_path):
    generate(tmp_path / 'frames')
    world = reconstruct(tmp_path / 'frames', tmp_path / 'output')
    assert world['metrics']['registeredFrames'] >= 15
    assert world['metrics']['densePoints'] > 50000
    assert world['metrics']['blocks'] > 1000
    assert world['kind'] == 'voxel-world'
    points = np.array(world['points']).reshape(-1, 7)
    assert np.isfinite(points).all()
    assert np.ptp(points[:, 2]) > 5
    assert len(world['cameras']) >= 15
    assert (tmp_path / 'output/world.json').is_file()
