"""View diversity of observed surfaces. Empty space has no confidence value."""
import math
import numpy as np


class CoverageMap:
    def __init__(self, voxel_size=.4, max_cells=30000):
        self.voxel_size = voxel_size
        self.max_cells = max_cells
        self.cells = {}
        self.limited = False

    def add(self, points, colors, cameras):
        if not len(points):
            return
        points, colors = np.asarray(points), np.asarray(colors)
        valid = np.isfinite(points).all(axis=1) & np.isfinite(colors).all(axis=1)
        points, colors = points[valid], colors[valid]
        keys, inverse, counts = np.unique(np.floor(points / self.voxel_size).astype(int), axis=0,
                                           return_inverse=True, return_counts=True)
        means = np.stack([np.bincount(inverse, weights=colors[:, c])/counts for c in range(3)], axis=1)
        for key_array, color in zip(keys, means):
            key = tuple(key_array.tolist())
            if key not in self.cells:
                if len(self.cells) >= self.max_cells:
                    self.limited = True
                    continue
                self.cells[key] = {'rgb': np.zeros(3), 'samples': 0, 'views': set(), 'directions': [], 'cosine': 1.}
            cell = self.cells[key]
            # Repeated observations from the same pose/keyframe are not evidence.
            novel = [item for item in cameras if item[0] not in cell['views']]
            if not novel or len(cell['views']) >= 8:
                continue
            cell['rgb'] += color
            cell['samples'] += 1
            center = (key_array + .5) * self.voxel_size
            for frame_id, camera in novel:
                if len(cell['views']) >= 8:
                    break
                cell['views'].add(frame_id)
                direction = np.asarray(camera) - center
                length = np.linalg.norm(direction)
                if length < 1e-6:
                    continue
                direction /= length
                if cell['directions']:
                    cell['cosine'] = min(cell['cosine'], min(float(direction @ d) for d in cell['directions']))
                cell['directions'].append(direction)

    def snapshot(self):
        points, confidence = [], []
        for key, cell in self.cells.items():
            center = (np.array(key) + .5) * self.voxel_size
            rgb = np.clip(np.rint(cell['rgb'] / cell['samples']), 0, 255)
            angle = math.degrees(math.acos(np.clip(cell['cosine'], -1, 1)))
            confidence.append(round(min(1., len(cell['views']) / 3) * min(1., angle / 8), 3))
            points.extend(np.r_[center, self.voxel_size, rgb].round(5).tolist())
        return points, confidence

    def guidance(self, points, confidence, rotation, translation, calibration, scale, size):
        weak = np.asarray(points).reshape(-1, 7)[np.asarray(confidence) < 1, :3]
        if not len(weak):
            return 'Boa diversidade nas superfícies observadas. Mostre novas partes do ambiente.', None
        raw = weak / scale * np.array([1, -1, -1])
        camera = raw @ rotation.T + translation
        projected = camera @ calibration.T
        valid = camera[:, 2] > .05
        xy = projected[:, :2] / np.maximum(projected[:, 2:], .0001)
        width, height = size
        valid &= (xy[:, 0] >= 0) & (xy[:, 0] < width) & (xy[:, 1] >= 0) & (xy[:, 1] < height)
        if valid.sum() < 10:
            return 'Volte às regiões amarelas do mapa e observe por outro ângulo.', None
        bins = np.minimum((xy[valid] / [width, height] * 3).astype(int), 2)
        index = np.argmax(np.bincount(bins[:, 1]*3 + bins[:, 0], minlength=9))
        row, col = divmod(int(index), 3)
        names = [['superior esquerda', 'superior', 'superior direita'],
                 ['esquerda', 'central', 'direita'], ['inferior esquerda', 'inferior', 'inferior direita']]
        return f'Observe a região {names[row][col]} de outra posição; ela tem poucas vistas.', [col/3, row/3, 1/3, 1/3]
