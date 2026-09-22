#!/usr/bin/env python3
"""
智能去白背景 —— 从边缘 floodfill 扩散，保留角色内部白色。
用法: python3 remove-bg.py <输入目录> <输出目录>
"""
import os
import sys
from PIL import Image
import numpy as np

def remove_white_bg(input_path, output_path, threshold=240, tolerance=15):
    """
    策略：从图片四边缘向内 floodfill，标记"连通到边缘的近白区域"为透明。
    角色内部的白肚皮/白围裙/白袜因为被角色主体包围，不会被 floodfill 到。
    """
    img = Image.open(input_path).convert("RGBA")
    w, h = img.size
    arr = np.array(img)

    # 1. 找出"接近白色"的像素（R,G,B 都 >= threshold）
    rgb = arr[:, :, :3]
    is_white = np.all(rgb >= threshold, axis=2)

    # 2. BFS floodfill 从边缘开始，只扩散到 is_white 且未访问的像素
    visited = np.zeros((h, w), dtype=bool)
    queue = []

    # 从四条边采样，确认背景确实是白色
    edges = []
    for x in range(w):
        edges.append((0, x))
        edges.append((h-1, x))
    for y in range(h):
        edges.append((y, 0))
        edges.append((y, w-1))

    for y, x in edges:
        if is_white[y, x] and not visited[y, x]:
            visited[y, x] = True
            queue.append((y, x))

    # BFS 扩散
    while queue:
        new_queue = []
        for cy, cx in queue:
            for dy, dx in [(0,1),(0,-1),(1,0),(-1,0)]:
                ny, nx = cy+dy, cx+dx
                if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and is_white[ny, nx]:
                    visited[ny, nx] = True
                    new_queue.append((ny, nx))
        queue = new_queue

    # 3. visited 区域 = 背景 → 设为透明
    bg_mask = visited.copy()

    alpha = arr[:, :, 3].copy()
    alpha[bg_mask] = 0

    arr[:, :, 3] = alpha
    result = Image.fromarray(arr)
    result.save(output_path, "PNG")
    return result.size

def main():
    input_dir = sys.argv[1]
    output_dir = sys.argv[2]
    os.makedirs(output_dir, exist_ok=True)

    files = [f for f in sorted(os.listdir(input_dir))
             if f.endswith('.png') and not f.endswith('-sheet-raw.png') and f.startswith(('edit-', 'walk-', 'working-', 'action-', 'prop-', 'sleeping-', 'idle-'))]

    print(f"处理 {len(files)} 张图片...")
    for f in files:
        inp = os.path.join(input_dir, f)
        outp = os.path.join(output_dir, f)
        try:
            w, h = remove_white_bg(inp, outp)
            print(f"  ✓ {f} ({w}x{h})")
        except Exception as e:
            print(f"  ✗ {f}: {e}")

    print("done")

if __name__ == "__main__":
    main()
