"""Deterministic ray-cast room with known translating cameras; no personal footage."""
from pathlib import Path
import argparse
import cv2
import numpy as np


def generate(directory: Path, count=18, width=640, height=480):
    directory.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(42)
    textures = []
    for _ in range(12):
        small = rng.integers(30, 240, (160, 160, 3), dtype=np.uint8)
        textures.append(cv2.resize(small, (1280, 1280), interpolation=cv2.INTER_NEAREST))
    # axis, coordinate, horizontal axis/range, vertical axis/range, texture
    faces = [(2, 6., 0, (-3., 3.), 1, (-1.8, 1.8), 0),
             (1, 1.8, 0, (-3., 3.), 2, (0., 6.), 1),
             (0, -3., 2, (0., 6.), 1, (-1.8, 1.8), 2),
             (0, 3., 2, (0., 6.), 1, (-1.8, 1.8), 3)]
    # Three solid objects in front of the walls, with visible face boundaries.
    for index, (lo, hi) in enumerate([((-1.9, .5, 3.), (-.8, 1.8, 4.)),
                                    ((.4, -.3, 4.), (1.6, 1.8, 5.)),
                                    ((-.4, 1., 2.), (.3, 1.8, 2.8))]):
        for axis in range(3):
            u, v = [a for a in range(3) if a != axis]
            for side in [lo[axis], hi[axis]]:
                faces.append((axis, side, u, (lo[u], hi[u]), v, (lo[v], hi[v]), 4 + index))
    yy, xx = np.mgrid[:height, :width]
    rays = np.stack(((xx - width / 2) / (width * .82),
                     (yy - height / 2) / (width * .82), np.ones_like(xx)), -1)
    for i in range(count):
        origin = np.array([-1.15 + 2.3 * i / (count - 1), -.2 + .12 * np.sin(i / 4), 0.])
        angle = -.06 * origin[0]
        rotation = np.array([[np.cos(angle), 0, np.sin(angle)], [0, 1, 0],
                             [-np.sin(angle), 0, np.cos(angle)]])
        directions = rays @ rotation.T
        depth = np.full((height, width), np.inf)
        image = np.full((height, width, 3), 20, dtype=np.uint8)
        for axis, coord, u, urange, v, vrange, texture_id in faces:
            with np.errstate(divide='ignore', invalid='ignore'):
                t = (coord - origin[axis]) / directions[:, :, axis]
                hit = origin + directions * t[:, :, None]
            valid = (t > 0) & (t < depth) & (hit[:, :, u] >= urange[0]) & (hit[:, :, u] <= urange[1])
            valid &= (hit[:, :, v] >= vrange[0]) & (hit[:, :, v] <= vrange[1])
            tu = np.clip(((hit[:, :, u][valid] - urange[0]) / (urange[1] - urange[0]) * 1279).astype(int), 0, 1279)
            tv = np.clip(((hit[:, :, v][valid] - vrange[0]) / (vrange[1] - vrange[0]) * 1279).astype(int), 0, 1279)
            image[valid] = textures[texture_id][tv, tu]
            depth[valid] = t[valid]
        cv2.imwrite(str(directory / f'{i+1:04d}.jpg'), image, [cv2.IMWRITE_JPEG_QUALITY, 95])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--count', type=int, default=18)
    args = parser.parse_args()
    generate(args.directory, args.count)
