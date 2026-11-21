"""外部文件变化监听测试（EXT-001/002/003）。"""

from __future__ import annotations

import time

from tests.conftest import fetch_photos, get_album
from tests.fixtures.generate import make_jpeg


def wait_for(condition, timeout: float = 8.0, interval: float = 0.1):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = condition()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"condition not met within {timeout}s; last={last!r}")


def test_watcher_detects_external_add_and_delete(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "监听"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    client, settings, _ = open_client(root, scan_debounce_ms=120)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "监听")
    client.post(f"/api/albums/{album['id']}/rescan", headers=csrf).raise_for_status()
    # 打开相册时启动监听
    client.get(f"/api/albums/{album['id']}").raise_for_status()
    time.sleep(0.4)

    make_jpeg(album_dir / "NEW.JPG", capture_time="2026:11:22 12:00:00")

    def has_new():
        payload = fetch_photos(client, album["id"])
        return len(payload["items"]) == 2 and "NEW" in {item["displayName"] for item in payload["items"]}

    wait_for(has_new)

    (album_dir / "NEW.JPG").unlink()

    def new_is_missing():
        payload = fetch_photos(client, album["id"])
        new = next(item for item in payload["items"] if item["displayName"] == "NEW")
        return new["flags"]["missingFile"] is True

    wait_for(new_is_missing)
    album_after = get_album(client, "监听")
    assert album_after["counts"]["missing"] == 1
