"""大相册性能测试：1000 张逻辑照片。

用程序生成的小尺寸 JPG（部分配对 RAW 占位），不使用任何私人照片。
"""

from __future__ import annotations

import time

import pytest

from tests.conftest import fetch_photos, get_album
from tests.fixtures.generate import make_jpeg

pytestmark = pytest.mark.performance


def test_scan_and_paginate_1000_logical_photos(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "测试-性能-1000"
    album_dir.mkdir(parents=True)
    logical = 1000
    for index in range(logical):
        make_jpeg(
            album_dir / f"IMG{index:05d}.JPG",
            width=24,
            height=16,
            capture_time=f"2026:01:{(index % 28) + 1:02d} 10:00:00",
        )
        if index % 3 == 1:
            (album_dir / f"IMG{index:05d}.RAF").write_bytes(b"perf-raw")

    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "测试-性能-1000")

    started = time.monotonic()
    response = client.post(f"/api/albums/{album['id']}/rescan", headers=csrf)
    scan_seconds = time.monotonic() - started
    assert response.status_code == 200, response.text
    assert response.json()["counts"]["total"] == logical
    assert response.json()["counts"]["conflicts"] == 0

    started = time.monotonic()
    first_page = fetch_photos(client, album["id"], limit=200)
    page_seconds = time.monotonic() - started
    assert first_page["total"] == logical
    assert len(first_page["items"]) == 200
    assert first_page["nextCursor"]

    started = time.monotonic()
    seen: set[str] = set()
    cursor = None
    pages = 0
    while True:
        params = {"limit": 200}
        if cursor:
            params["cursor"] = cursor
        page = fetch_photos(client, album["id"], **params)
        pages += 1
        seen.update(item["id"] for item in page["items"])
        cursor = page["nextCursor"]
        if not cursor:
            break
    paginate_seconds = time.monotonic() - started
    assert len(seen) == logical
    assert pages == 5

    print(
        f"\n[performance] scan={scan_seconds:.2f}s first_page={page_seconds:.3f}s "
        f"paginate_all={paginate_seconds:.2f}s pages={pages}"
    )
    # 目标：1000 张相册首次扫描应在合理时间内完成（本地 SSD），分页接近即时。
    assert scan_seconds < 30
    assert page_seconds < 3
    assert paginate_seconds < 8
