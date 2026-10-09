import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cv2
import numpy as np
from coverage import CoverageMap
from guide import GuidedMapper, triangulate
from synthetic import generate


def test_triangulation_recovers_positions_and_rejects_no_baseline():
    k = np.array([[300., 0, 320], [0, 300., 240], [0, 0, 1]])
    xyz = np.array([[0., 0, 5], [1., .5, 6]])
    def project(translation):
        p = (xyz + translation) @ k.T
        return p[:, :2]/p[:, 2:]
    points, mask = triangulate(k, np.eye(3), np.zeros(3), np.eye(3), [-.5, 0, 0], project([0,0,0]), project([-.5,0,0]))
    assert mask.all(); assert np.max(np.abs(points-xyz)) < 1e-5
    _, mask = triangulate(k, np.eye(3), np.zeros(3), np.eye(3), np.zeros(3), project([0,0,0]), project([0,0,0]))
    assert not mask.any()


def test_stationary_camera_and_blank_frames_cannot_create_a_world(tmp_path):
    rng = np.random.default_rng(3)
    image = rng.integers(0, 255, (480, 640, 3), dtype=np.uint8)
    mapper = GuidedMapper(tmp_path)
    for _ in range(5):
        state = mapper.process(image)
        assert state['tracking'] == 'initializing'
        assert state['blocks'] == 0
    assert mapper.process(np.zeros_like(image))['tracking'] == 'low_texture'
    assert not (tmp_path / 'world.json').exists()


def test_incremental_scene_grows_and_recovers_without_fusing_lost_frames(tmp_path):
    generate(tmp_path / 'frames')
    mapper = GuidedMapper(tmp_path / 'scan', focal=640*.82)
    states = []
    for path in sorted((tmp_path / 'frames').glob('*.jpg')):
        states.append(mapper.process(cv2.imread(str(path))))
    assert sum(s['tracking'] == 'tracking' for s in states) >= 12
    assert mapper.revision >= 4
    assert len(mapper.coverage.cells) > 1000
    world = json.loads((tmp_path / 'scan/world.json').read_text())
    assert world['preview'] and world['metrics']['wellObservedBlocks'] > 0
    assert len(world['cameras']) >= 5
    snapshot = json.dumps(world)
    assert mapper.process(np.zeros((480, 640, 3), dtype=np.uint8))['tracking'] == 'low_texture'
    assert json.dumps(mapper.current_world) == snapshot
    rng = np.random.default_rng(5)
    assert mapper.process(rng.integers(0, 255, (480, 640, 3), dtype=np.uint8))['tracking'] == 'lost'
    assert json.dumps(mapper.current_world) == snapshot
    last = cv2.imread(str(tmp_path / 'frames/0018.jpg'))
    before = mapper.revision
    for _ in range(3):
        assert mapper.process(last)['tracking'] == 'tracking'
    assert mapper.revision == before
    assert np.isfinite(world['points']).all()
    assert max(s['milliseconds'] for s in states) < 10000


def test_pure_camera_rotation_does_not_bootstrap_geometry(tmp_path):
    generate(tmp_path / 'frames', count=2)
    image = cv2.imread(str(tmp_path / 'frames/0001.jpg'))
    mapper = GuidedMapper(tmp_path / 'scan', focal=640*.82)
    mapper.process(image)
    k = mapper.k
    for degrees in [2, 4, 6]:
        rotation = cv2.Rodrigues(np.array([0., np.deg2rad(degrees), 0.]))[0]
        rotated = cv2.warpPerspective(image, k @ rotation @ np.linalg.inv(k), (640, 480))
        assert mapper.process(rotated)['blocks'] == 0
    assert mapper.scale is None
