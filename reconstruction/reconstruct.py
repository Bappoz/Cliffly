"""Video frames -> CPU SfM -> rectified stereo -> colored persistent voxel world."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import time

import cv2
import numpy as np
import pycolmap
from world import fuse


def progress(output, stage, percent, message):
    value = {'stage': stage, 'percent': percent, 'message': message}
    temporary = output / 'progress.tmp'
    temporary.write_text(json.dumps(value, ensure_ascii=False))
    temporary.replace(output / 'progress.json')
    print(json.dumps(value, ensure_ascii=False), flush=True)


def pose(image):
    matrix = image.cam_from_world().matrix()
    return matrix[:, :3], matrix[:, 3]


def calibration(camera):
    k = camera.calibration_matrix()
    distortion = np.zeros(5)
    if camera.model_name == 'SIMPLE_RADIAL':
        distortion[0] = camera.params[3]
    elif camera.model_name != 'PINHOLE' and camera.model_name != 'SIMPLE_PINHOLE':
        raise ValueError('Modelo de câmera não suportado no estéreo.')
    return k, distortion


def stereo_pair(left, right, model, images_path, bounds):
    camera1, camera2 = model.cameras[left.camera_id], model.cameras[right.camera_id]
    k1, d1 = calibration(camera1)
    k2, d2 = calibration(camera2)
    r1, t1 = pose(left)
    r2, t2 = pose(right)
    rotation, translation = r2 @ r1.T, t2 - r2 @ r1.T @ t1
    if np.linalg.norm(translation) < 1e-6:
        return np.empty((0, 3)), np.empty((0, 3))
    a = cv2.imread(str(images_path / left.name))
    b = cv2.imread(str(images_path / right.name))
    size = (a.shape[1], a.shape[0])
    rr1, rr2, p1, p2, q, roi1, roi2 = cv2.stereoRectify(k1, d1, k2, d2, size, rotation, translation.reshape(3, 1), alpha=0)
    # SGBM performs horizontal matching. Reject vertically rectified pairs.
    if abs(p2[1, 3]) > abs(p2[0, 3]) or p2[0, 3] >= 0:
        return np.empty((0, 3)), np.empty((0, 3))
    map1 = cv2.initUndistortRectifyMap(k1, d1, rr1, p1, size, cv2.CV_32FC1)
    map2 = cv2.initUndistortRectifyMap(k2, d2, rr2, p2, size, cv2.CV_32FC1)
    a, b = cv2.remap(a, *map1, cv2.INTER_LINEAR), cv2.remap(b, *map2, cv2.INTER_LINEAR)
    gray1, gray2 = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    disparities = min(192, (size[0] // 3 // 16) * 16)
    options = dict(numDisparities=disparities, blockSize=5, P1=8*25, P2=32*25,
                   uniquenessRatio=12, speckleWindowSize=100, speckleRange=2,
                   disp12MaxDiff=1, mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY)
    dl = cv2.StereoSGBM_create(minDisparity=0, **options).compute(gray1, gray2).astype(np.float32) / 16
    dr = cv2.StereoSGBM_create(minDisparity=-disparities, **options).compute(gray2, gray1).astype(np.float32) / 16
    yy, xx = np.mgrid[:size[1], :size[0]]
    xr = np.rint(xx - dl).astype(int)
    in_image = (xr >= 0) & (xr < size[0])
    consistency = np.abs(dl + dr[yy, np.clip(xr, 0, size[0] - 1)]) < 1.25
    valid = (dl > 1) & (dl < disparities - 1) & in_image & consistency
    for x, y, w, h in [roi1, roi2]:
        valid &= (xx >= x) & (xx < x+w) & (yy >= y) & (yy < y+h)
    valid &= (xx % 3 == 0) & (yy % 3 == 0)
    rectified = cv2.reprojectImageTo3D(dl, q)
    # Row-vector inverse of rectified-camera -> camera -> world.
    with np.errstate(invalid='ignore'):
        world = (rectified @ rr1 - t1) @ r1
    valid &= np.isfinite(world).all(axis=2) & (rectified[:, :, 2] > 0)
    valid &= (world >= bounds[0]).all(axis=2) & (world <= bounds[1]).all(axis=2)
    return world[valid], cv2.cvtColor(a, cv2.COLOR_BGR2RGB)[valid]


def reconstruct(frames, output, max_frames=60):
    started = time.monotonic()
    output.mkdir(parents=True, exist_ok=True)
    source = sorted(frames.glob('*.jpg'))
    if len(source) < 3:
        raise ValueError('Grave pelo menos 3 segundos com deslocamento lateral e boa sobreposição.')
    selected = [source[i] for i in np.unique(np.linspace(0, len(source)-1, min(max_frames, len(source))).astype(int))]
    images_path = output / 'images'
    if images_path.exists():
        shutil.rmtree(images_path)
    images_path.mkdir()
    for path in selected:
        image = cv2.imread(str(path))
        if image is None:
            raise ValueError('Frame ilegível.')
        scale = min(1., 800 / max(image.shape[:2]))
        cv2.imwrite(str(images_path / path.name), cv2.resize(image, None, fx=scale, fy=scale))
    database = output / 'features.db'
    for suffix in ['', '-shm', '-wal']:
        (Path(str(database) + suffix)).unlink(missing_ok=True)
    progress(output, 'features', 12, 'Encontrando detalhes correspondentes nos frames…')
    threads = min(4, os.cpu_count() or 1)
    cv2.setNumThreads(threads)
    pycolmap.extract_features(database, images_path, camera_mode=pycolmap.CameraMode.SINGLE,
        reader_options={'camera_model': 'SIMPLE_RADIAL'},
        extraction_options={'num_threads': threads, 'use_gpu': False, 'sift': {'max_num_features': 4096}},
        device=pycolmap.Device.cpu)
    progress(output, 'matching', 28, 'Comparando vistas e verificando correspondências…')
    pycolmap.match_sequential(database, matching_options={'num_threads': threads, 'use_gpu': False},
        pairing_options={'overlap': 8, 'loop_detection': False}, device=pycolmap.Device.cpu)
    progress(output, 'poses', 42, 'Estimando câmeras e triangulando pontos 3D…')
    models_path = output / 'sfm'
    if models_path.exists():
        shutil.rmtree(models_path)
    models_path.mkdir()
    models = pycolmap.incremental_mapping(database, images_path, models_path,
        options={'num_threads': threads, 'min_model_size': 3, 'max_num_models': 3,
                 'random_seed': 42, 'max_runtime_seconds': 600,
                 'mapper': {'init_min_tri_angle': 8., 'init_min_num_inliers': 60}})
    if not models:
        raise ValueError('Não foi possível estimar as câmeras. Mova a câmera lateralmente; evite paredes lisas, reflexos e desfoque.')
    model = max(models.values(), key=lambda m: m.num_reg_images())
    images = sorted(model.images.values(), key=lambda i: i.name)
    points = [p for p in model.points3D.values() if p.track.length() >= 3 and p.error <= 2.5]
    if len(images) < 3 or len(points) < 80:
        raise ValueError('Geometria insuficiente. Grave mais vistas sobrepostas de um ambiente parado e texturizado.')
    xyz = np.array([p.xyz for p in points])
    rgb = np.array([p.color for p in points])
    low, high = np.percentile(xyz, [2, 98], axis=0)
    margin = np.maximum((high - low) * .15, .05)
    bounds = (low - margin, high + margin)
    sparse_valid = (xyz >= bounds[0]).all(axis=1) & (xyz <= bounds[1]).all(axis=1)
    xyz, rgb = xyz[sparse_valid], rgb[sparse_valid]
    point_sets, color_sets = [xyz], [rgb]
    centers = [i.projection_center() for i in images]
    ids = [{p.point3D_id for p in i.points2D if p.has_point3D()} for i in images]
    pairs = []
    depth = np.median(np.linalg.norm(xyz - centers[0], axis=1))
    for a in range(len(images)):
        candidates = []
        for b in range(a+1, min(len(images), a+9)):
            baseline = np.linalg.norm(centers[a] - centers[b]) / depth
            overlap = len(ids[a] & ids[b])
            if .015 < baseline < .4 and overlap >= 40:
                candidates.append((overlap, b))
        pairs.extend((a, b) for _, b in sorted(candidates, reverse=True)[:2])
    pairs = pairs[:40]
    dense_count = 0
    for n, (a, b) in enumerate(pairs):
        progress(output, 'stereo', 55 + int(30*n/max(1, len(pairs))), f'Reconstruindo superfícies: par {n+1}/{len(pairs)}…')
        # Order stereo left/right using relative camera translation.
        r1, t1 = pose(images[a]); r2, t2 = pose(images[b])
        if (t2 - r2 @ r1.T @ t1)[0] > 0:
            a, b = b, a
        dense, colors = stereo_pair(images[a], images[b], model, images_path, bounds)
        point_sets.append(dense); color_sets.append(colors); dense_count += len(dense)
    progress(output, 'fusion', 90, 'Fusionando pontos e cores em blocos persistentes…')
    r0, t0 = pose(images[0])
    signs = np.array([1, -1, -1])
    scale = 20 / depth
    def normalized(p):
        return ((np.asarray(p) @ r0.T + t0) * signs) * scale
    merged = normalized(np.concatenate(point_sets))
    voxel_size = np.linalg.norm((high-low) * scale) / 150
    voxels, voxel_size = fuse(merged, np.concatenate(color_sets), voxel_size)
    cameras = []
    for image in images:
        r, t = pose(image)
        center = image.projection_center()
        forward = r.T @ np.array([0., 0., 1.])
        cameras.append({'frame': image.name, 'position': normalized(center).round(5).tolist(),
                        'target': normalized(center + forward * depth * .25).round(5).tolist()})
    world = {'version': 2, 'kind': 'voxel-world', 'scale': 'relative', 'voxelSize': round(voxel_size, 5),
             'points': voxels.flatten().tolist(), 'cameras': cameras,
             'bounds': {'min': voxels[:, :3].min(axis=0).tolist(), 'max': voxels[:, :3].max(axis=0).tolist()},
             'metrics': {'inputFrames': len(source), 'selectedFrames': len(selected), 'registeredFrames': len(images),
                         'sparsePoints': len(xyz), 'densePoints': dense_count, 'stereoPairs': len(pairs),
                         'blocks': len(voxels), 'seconds': round(time.monotonic() - started, 1)},
             'warnings': ['Escala relativa; regiões não observadas ficam vazias.']}
    if len(images) < len(selected) * .7:
        world['warnings'].append('Parte dos frames não pôde ser registrada: cobertura incompleta.')
    if dense_count < 1000:
        world['warnings'].append('Poucas superfícies densas: o resultado contém principalmente pontos esparsos.')
    temporary = output / 'world.tmp'
    temporary.write_text(json.dumps(world, ensure_ascii=False, separators=(',', ':'), allow_nan=False))
    temporary.replace(output / 'world.json')
    progress(output, 'complete', 100, 'Mundo 3D salvo. Pronto para explorar.')
    return world


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--frames', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        reconstruct(args.frames, args.output)
    except Exception as exc:
        args.output.mkdir(parents=True, exist_ok=True)
        progress(args.output, 'failed', 0, str(exc))
        print(str(exc), file=sys.stderr)
        sys.exit(1)
