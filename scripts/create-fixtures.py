#!/usr/bin/env python3
"""构造演示/测试相册（不含任何私人照片）。

用法：
    .venv/bin/python scripts/create-fixtures.py --root /tmp/photo-curator-demo
    .venv/bin/python scripts/create-fixtures.py --root /tmp/pc-perf --count 1000

注意：只写入指定目录，绝不允许指向真实相册目录。默认拒绝 /Users/eason/Desktop/相册。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from tests.fixtures.generate import create_demo_root, make_jpeg  # noqa: E402

DEFAULT_ROOT = Path("/tmp/photo-curator-demo")
REAL_ROOT = Path("/Users/eason/Desktop/相册").resolve()


def guard_root(root: Path) -> Path:
    resolved = root.expanduser().resolve()
    if resolved == REAL_ROOT or REAL_ROOT in resolved.parents:
        raise SystemExit("拒绝在真实相册目录内生成测试数据。请使用 /tmp 下的目录。")
    if resolved == Path("/"):
        raise SystemExit("拒绝使用根目录。")
    return resolved


def create_performance_album(root: Path, count: int) -> Path:
    album = root / f"测试-性能-{count}张"
    if album.exists():
        shutil.rmtree(album)
    album.mkdir(parents=True)
    for index in range(count):
        pair = index % 3 != 0
        make_jpeg(
            album / f"IMG{index:05d}.JPG",
            width=32,
            height=24,
            capture_time=f"2026:01:{(index % 28) + 1:02d} 10:00:00",
        )
        if pair:
            (album / f"IMG{index:05d}.RAF").write_bytes(b"perf-fixture-raw")
    return album


def main() -> None:
    parser = argparse.ArgumentParser(description="构造相册精选助手测试夹具")
    parser.add_argument("--root", default=str(DEFAULT_ROOT), help="测试照片根目录（必须在 /tmp 下）")
    parser.add_argument("--count", type=int, default=0, help="额外生成一个 N 张逻辑照片的性能相册")
    parser.add_argument("--clean", action="store_true", help="生成前清空目标目录")
    args = parser.parse_args()

    root = guard_root(Path(args.root))
    if args.clean and root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    paths = create_demo_root(root)
    result = {key: str(value) for key, value in paths.items()}
    if args.count:
        album = create_performance_album(root, args.count)
        result["performance"] = str(album)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
