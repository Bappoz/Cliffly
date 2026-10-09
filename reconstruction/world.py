"""Fusion into a bounded, uniformly spaced grid; geometry never comes from RGB."""
import numpy as np

MAX_VOXELS = 120_000


def fuse(points, colors, voxel_size, max_voxels=MAX_VOXELS):
    points, colors = np.asarray(points), np.asarray(colors)
    if voxel_size <= 0 or not np.isfinite(voxel_size):
        raise ValueError('Invalid voxel size')
    valid = np.isfinite(points).all(axis=1) & np.isfinite(colors).all(axis=1)
    points, colors = points[valid], colors[valid]
    if not len(points):
        raise ValueError('Nenhum ponto 3D válido foi reconstruído.')
    # Increase grid spacing when necessary, rather than truncate parts of the room.
    for _ in range(64):
        cells, inverse, counts = np.unique(np.floor(points / voxel_size).astype(np.int64), axis=0,
                                          return_inverse=True, return_counts=True)
        if len(cells) <= max_voxels:
            break
        voxel_size *= 1.25
    else:
        raise ValueError('Não foi possível limitar o tamanho do mundo.')
    rgb = np.stack([np.bincount(inverse, weights=colors[:, c]) / counts for c in range(3)], axis=1)
    centers = (cells + .5) * voxel_size
    return np.column_stack((centers, np.full(len(cells), voxel_size), np.clip(np.rint(rgb), 0, 255))).round(5), voxel_size
