"""Experimental incremental visual odometry + stereo preview; not full SLAM."""
import argparse
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace

import cv2
import numpy as np
from coverage import CoverageMap
from reconstruct import stereo_pair


def matches(a, b):
    if a is None or b is None or len(a) < 2 or len(b) < 2:
        return []
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(a, b, k=2)
    candidates = [item[0] for item in pairs if len(item) == 2 and item[0].distance < .75*item[1].distance and item[0].distance < 65]
    used = set(); result = []
    for match in sorted(candidates, key=lambda m: m.distance):
        if match.trainIdx not in used:
            used.add(match.trainIdx); result.append(match)
    return result


def triangulate(k, r1, t1, r2, t2, a, b):
    if not len(a):
        return np.empty((0, 3)), np.zeros(0, dtype=bool)
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    homogeneous = cv2.triangulatePoints(k @ np.c_[r1, t1], k @ np.c_[r2, t2], a.T, b.T)
    with np.errstate(invalid='ignore', divide='ignore'):
        xyz = (homogeneous[:3] / homogeneous[3]).T
    ca, cb = xyz @ r1.T + t1, xyz @ r2.T + t2
    ua, ub = ca @ k.T, cb @ k.T
    with np.errstate(invalid='ignore', divide='ignore'):
        ea = np.linalg.norm(ua[:, :2]/ua[:, 2:] - a, axis=1)
        eb = np.linalg.norm(ub[:, :2]/ub[:, 2:] - b, axis=1)
        da = xyz + r1.T @ t1; db = xyz + r2.T @ t2
        cosine = np.sum(da*db, axis=1) / (np.linalg.norm(da, axis=1)*np.linalg.norm(db, axis=1))
    valid = np.isfinite(xyz).all(axis=1) & (ca[:, 2] > 0) & (cb[:, 2] > 0)
    valid &= (ea < 2.5) & (eb < 2.5) & (cosine < np.cos(np.deg2rad(1.2)))
    return xyz, valid


class GuidedMapper:
    def __init__(self, output, focal=None):
        self.output = Path(output); self.output.mkdir(parents=True, exist_ok=True)
        self.focal = focal
        self.orb = cv2.ORB_create(nfeatures=2500, edgeThreshold=19, fastThreshold=12)
        self.k = None; self.reference = None; self.scale = None
        self.map_points = []; self.map_descriptors = []; self.cameras = []
        self.coverage = CoverageMap()
        self.revision = 0; self.frames = 0; self.rotation = np.eye(3); self.translation = np.zeros(3)
        self.current_world = None; self.last_dense = 0
        cv2.setNumThreads(2)
        cv2.setRNGSeed(42)

    def normalized(self, xyz):
        return np.asarray(xyz) * np.array([1, -1, -1]) * self.scale

    def frame(self, image, number):
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        keypoints, descriptors = self.orb.detectAndCompute(gray, None)
        return {'image': image, 'xy': np.array([p.pt for p in keypoints]), 'descriptors': descriptors,
                'ids': {}, 'r': None, 't': None, 'id': number,
                'sharpness': float(cv2.Laplacian(gray, cv2.CV_64F).var())}

    def initialize(self, current):
        previous = self.reference
        links = matches(previous['descriptors'], current['descriptors'])
        if len(links) < 70:
            return False
        a = np.array([previous['xy'][m.queryIdx] for m in links])
        b = np.array([current['xy'][m.trainIdx] for m in links])
        if np.median(np.linalg.norm(b-a, axis=1)) < 6:
            return False
        essential, mask = cv2.findEssentialMat(a, b, self.k, method=cv2.RANSAC, prob=.999, threshold=1.2)
        if essential is None:
            return False
        _, rotation, translation, mask = cv2.recoverPose(essential[:3], a, b, self.k, mask=mask)
        xyz, valid = triangulate(self.k, np.eye(3), np.zeros(3), rotation, translation.ravel(), a, b)
        valid &= mask.ravel() > 0
        if valid.sum() < 60:
            return False
        # A useful baseline must produce finite geometry in front of both views.
        depth = np.median(xyz[valid, 2])
        if depth < 1 or depth > 100:
            return False
        previous['r'], previous['t'] = np.eye(3), np.zeros(3)
        current['r'], current['t'] = rotation, translation.ravel()
        self.scale = 20 / depth
        for point, link, accepted in zip(xyz, links, valid):
            if not accepted:
                continue
            index = len(self.map_points); self.map_points.append(point)
            self.map_descriptors.append(current['descriptors'][link.trainIdx])
            previous['ids'][link.queryIdx] = index; current['ids'][link.trainIdx] = index
        self.add_camera(previous)
        self.fuse_pair(previous, current)
        self.reference = current
        self.rotation, self.translation = rotation, translation.ravel()
        return True

    def estimate_pose(self, current):
        previous = self.reference
        links = matches(previous['descriptors'], current['descriptors'])
        known = [(previous['ids'][m.queryIdx], m.trainIdx) for m in links if m.queryIdx in previous['ids']]
        if len(known) < 35:
            links_to_map = matches(np.array(self.map_descriptors, dtype=np.uint8), current['descriptors'])
            known = [(m.queryIdx, m.trainIdx) for m in links_to_map]
        if len(known) < 25:
            return None, links
        xyz = np.array([self.map_points[i] for i, _ in known], dtype=np.float64)
        xy = np.array([current['xy'][j] for _, j in known], dtype=np.float64)
        ok, rotation, translation, inliers = cv2.solvePnPRansac(xyz, xy, self.k, None,
            iterationsCount=150, reprojectionError=3., confidence=.999, flags=cv2.SOLVEPNP_EPNP)
        if not ok or inliers is None or len(inliers) < 25 or len(inliers) < len(known)*.4:
            return None, links
        selected = inliers.ravel()
        rotation, translation = cv2.solvePnPRefineLM(xyz[selected], xy[selected], self.k, None, rotation, translation)
        r = cv2.Rodrigues(rotation)[0]; t = translation.ravel()
        center = -r.T @ t
        prior = -self.rotation.T @ self.translation
        scene_depth = 20 / self.scale
        if not np.isfinite(center).all() or np.linalg.norm(center-prior) > scene_depth*.5:
            return None, links
        for index in selected:
            map_id, key_id = known[index]
            current['ids'][key_id] = map_id
            self.map_descriptors[map_id] = current['descriptors'][key_id]
        return (r, t), links

    def add_camera(self, frame):
        center = -frame['r'].T @ frame['t']
        forward = frame['r'].T @ np.array([0., 0, 5/self.scale])
        self.cameras.append({'frame': str(frame['id']), 'position': self.normalized(center).round(5).tolist(),
                             'target': self.normalized(center+forward).round(5).tolist()})

    def fuse_pair(self, previous, current):
        # Reuse the tested rectification/left-right consistency implementation.
        image_path = self.output / 'keyframes'; image_path.mkdir(exist_ok=True)
        for frame in [previous, current]:
            cv2.imwrite(str(image_path / f"{frame['id']}.jpg"), frame['image'])
        camera = SimpleNamespace(model_name='PINHOLE', calibration_matrix=lambda: self.k)
        def wrapped(frame):
            return SimpleNamespace(camera_id=1, name=f"{frame['id']}.jpg",
                cam_from_world=lambda: SimpleNamespace(matrix=lambda: np.c_[frame['r'], frame['t']]))
        a, b = previous, current
        relative = b['t'] - b['r'] @ a['r'].T @ a['t']
        if relative[0] > 0:
            a, b = b, a
        sparse = np.array(self.map_points)
        centers = np.array([-f['r'].T @ f['t'] for f in [previous, current]])
        low, high = np.percentile(sparse, [1, 99], axis=0)
        margin = np.maximum((high-low)*.3, .1)
        bounds = (np.minimum(low, centers.min(axis=0))-margin, np.maximum(high, centers.max(axis=0))+margin)
        dense, rgb = stereo_pair(wrapped(a), wrapped(b), SimpleNamespace(cameras={1: camera}), image_path, bounds)
        if not len(dense):
            # Sparse points are still triangulated from multiple views.
            ids = list(current['ids'].items())
            dense = np.array([self.map_points[i] for _, i in ids])
            uv = np.rint([current['xy'][j] for j, _ in ids]).astype(int)
            uv[:, 0] = np.clip(uv[:, 0], 0, current['image'].shape[1]-1)
            uv[:, 1] = np.clip(uv[:, 1], 0, current['image'].shape[0]-1)
            rgb = current['image'][uv[:, 1], uv[:, 0], ::-1]
        cameras = [(f['id'], self.normalized(-f['r'].T @ f['t'])) for f in [previous, current]]
        self.coverage.add(self.normalized(dense), rgb, cameras)
        self.add_camera(current)
        self.last_dense = len(dense)
        self.revision += 1
        self.write_world()

    def write_world(self):
        points, confidence = self.coverage.snapshot()
        if not points:
            return
        xyz = np.array(points).reshape(-1, 7)[:, :3]
        self.current_world = {'version': 2, 'kind': 'voxel-world', 'preview': True, 'scale': 'relative',
            'voxelSize': self.coverage.voxel_size, 'points': points, 'confidence': confidence,
            'cameras': self.cameras, 'bounds': {'min': xyz.min(axis=0).tolist(), 'max': xyz.max(axis=0).tolist()},
            'metrics': {'registeredFrames': len(self.cameras), 'blocks': len(confidence),
                        'wellObservedBlocks': sum(v >= 1 for v in confidence)},
            'warnings': ['Prévia experimental com intrínsecos aproximados; refine após a gravação.',
                         'Cobertura descreve apenas superfícies observadas. Espaços vazios são desconhecidos.']}
        if self.coverage.limited:
            self.current_world['warnings'].append('Limite de 30 mil blocos da prévia atingido.')
        path = self.output / 'world.tmp'
        path.write_text(json.dumps(self.current_world, separators=(',', ':'), ensure_ascii=False, allow_nan=False))
        path.replace(self.output / 'world.json')

    def process(self, image):
        started = time.monotonic()
        self.frames += 1
        if self.frames > 180:
            raise ValueError('Limite de frames da prévia atingido.')
        image = cv2.resize(image, (640, round(image.shape[0]*640/image.shape[1])))
        width, height = image.shape[1], image.shape[0]
        if self.k is None:
            focal = self.focal or .9*width
            self.k = np.array([[focal, 0, width/2], [0, focal, height/2], [0, 0, 1.]])
            self.size = (width, height)
        elif self.size != (width, height):
            raise ValueError('A resolução da câmera mudou. Reinicie a prévia.')
        current = self.frame(image, self.frames)
        tracking, message, target = 'initializing', 'Mova a câmera lentamente para os lados, mantendo detalhes em comum.', None
        if len(current['xy']) < 80:
            tracking, message = 'low_texture', 'Poucos detalhes visíveis. Aproxime uma região com textura e boa luz.'
        elif current['sharpness'] < 25:
            tracking, message = 'blur', 'Imagem desfocada. Diminua o movimento e aguarde a câmera estabilizar.'
        elif self.reference is None:
            self.reference = current
        elif self.scale is None:
            if self.initialize(current):
                tracking, message = 'tracking', 'Primeiras superfícies reconstruídas. Observe as áreas amarelas por outro ângulo.'
        else:
            estimated, links = self.estimate_pose(current)
            if estimated is None:
                tracking, message = 'lost', 'Rastreamento perdido. Volte devagar para uma região já observada.'
            else:
                r, t = estimated; current['r'], current['t'] = r, t
                self.rotation, self.translation = r, t
                reference = self.reference
                center, prior = -r.T @ t, -reference['r'].T @ reference['t']
                distance = np.linalg.norm(center-prior) * self.scale
                angle = np.degrees(np.arccos(np.clip((np.trace(r @ reference['r'].T)-1)/2, -1, 1)))
                if distance > .65 and len(self.cameras) < 80:
                    unmapped = [m for m in links if m.queryIdx not in reference['ids'] and m.trainIdx not in current['ids']]
                    a = np.array([reference['xy'][m.queryIdx] for m in unmapped])
                    b = np.array([current['xy'][m.trainIdx] for m in unmapped])
                    xyz, valid = triangulate(self.k, reference['r'], reference['t'], r, t, a, b)
                    for point, match, accepted in zip(xyz, unmapped, valid):
                        if accepted and len(self.map_points) < 10000:
                            index = len(self.map_points); self.map_points.append(point)
                            self.map_descriptors.append(current['descriptors'][match.trainIdx]); current['ids'][match.trainIdx] = index
                    self.fuse_pair(reference, current)
                    self.reference = current
                tracking = 'tracking'
                if self.current_world:
                    message, target = self.coverage.guidance(self.current_world['points'], self.current_world['confidence'],
                        r, t, self.k, self.scale, self.size)
                if distance < .1 and angle < .5:
                    message = 'A câmera está quase parada. Desloque-a para obter novas perspectivas.'
        pose = None
        if self.scale is not None:
            center = -self.rotation.T @ self.translation
            pose = {'position': self.normalized(center).round(5).tolist(),
                    'target': self.normalized(center+self.rotation.T @ np.array([0., 0, 5/self.scale])).round(5).tolist()}
        state = {'tracking': tracking, 'message': message, 'targetRegion': target,
                 'revision': self.revision, 'frames': self.frames, 'keyframes': len(self.cameras),
                 'blocks': len(self.coverage.cells), 'camera': pose, 'milliseconds': round((time.monotonic()-started)*1000),
                 'approximateIntrinsics': True}
        temporary = self.output / 'state.tmp'; temporary.write_text(json.dumps(state, ensure_ascii=False))
        temporary.replace(self.output / 'state.json')
        return state


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(); mapper = GuidedMapper(args.output)
    for line in sys.stdin:
        try:
            value = json.loads(line); image = cv2.imread(value['frame'])
            if image is None:
                raise ValueError('Frame JPEG ilegível.')
            print(json.dumps(mapper.process(image), ensure_ascii=False, allow_nan=False), flush=True)
        except Exception as exc:
            print(json.dumps({'error': str(exc)}, ensure_ascii=False), flush=True)
