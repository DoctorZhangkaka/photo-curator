"""补充边界测试：RAW 预览失败、导出冲突恢复、全量重扫、临时文件清理等。"""

from __future__ import annotations

import time
import uuid
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient
from photo_curator.config import Settings
from photo_curator.exporting import cleanup_stale_temp_files
from photo_curator.main import create_app
from photo_curator.paths import PathGuard
from photo_curator.trash import BaseTrashService

from tests.conftest import fetch_photos, get_album, photo_by_name, rescan, set_state
from tests.fixtures.generate import create_demo_root, make_jpeg


def test_raw_preview_failure_creates_issue(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "坏RAW"
    album_dir.mkdir(parents=True)
    (album_dir / "BROKEN.RAF").write_bytes(b"this is not a real raw file")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "坏RAW")
    rescan(client, csrf, album["id"])
    photo = photo_by_name(client, album["id"], "BROKEN")
    assert photo["form"] == "raw_only"
    response = client.get(f"/api/photos/{photo['id']}/thumbnail")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "RAW_PREVIEW_UNAVAILABLE"
    issues = client.get(f"/api/albums/{album['id']}/issues").json()
    assert issues["counts"]["previewFailures"] == 1
    assert issues["previewFailures"][0]["payload"]["assetId"] == photo["assets"][0]["id"]
    assert photo_by_name(client, album["id"], "BROKEN")["flags"]["missingFile"] is False


def test_export_conflict_clears_after_content_resolution(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "冲突恢复"
    album_dir.mkdir(parents=True)
    source = make_jpeg(album_dir / "A.JPG")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "冲突恢复")
    rescan(client, csrf, album["id"])
    photo = photo_by_name(client, album["id"], "A")
    set_state(client, csrf, photo, selection="selected")
    preflight = client.post(f"/api/albums/{album['id']}/exports/preflight", headers=csrf).json()
    response = client.post(
        f"/api/albums/{album['id']}/exports",
        json={"preflightToken": preflight["token"], "idempotencyKey": str(uuid.uuid4())},
        headers=csrf,
    )
    assert response.status_code == 202
    # 等待导出完成
    for _ in range(200):
        job = client.get(f"/api/jobs/{response.json()['jobId']}").json()["job"]
        if job["status"] in {"success", "failed"}:
            break
        time.sleep(0.02)
    target = root / "精选原相册" / "冲突恢复" / "JPG" / "A.JPG"
    assert target.exists()

    original = target.read_bytes()
    target.write_bytes(bytes([(byte + 1) % 256 for byte in original]))
    preflight = client.post(f"/api/albums/{album['id']}/exports/preflight", headers=csrf).json()
    response = client.post(
        f"/api/albums/{album['id']}/exports",
        json={"preflightToken": preflight["token"], "idempotencyKey": str(uuid.uuid4())},
        headers=csrf,
    )
    for _ in range(200):
        job = client.get(f"/api/jobs/{response.json()['jobId']}").json()["job"]
        if job["status"] in {"success", "failed"}:
            break
        time.sleep(0.02)
    conflict_items = fetch_photos(client, album["id"], issue="export_conflict")["items"]
    assert len(conflict_items) == 1
    assert client.get(f"/api/albums/{album['id']}/issues").json()["counts"]["exportConflicts"] == 1

    target.write_bytes(source.read_bytes())
    preflight = client.post(f"/api/albums/{album['id']}/exports/preflight", headers=csrf).json()
    response = client.post(
        f"/api/albums/{album['id']}/exports",
        json={"preflightToken": preflight["token"], "idempotencyKey": str(uuid.uuid4())},
        headers=csrf,
    )
    for _ in range(200):
        job = client.get(f"/api/jobs/{response.json()['jobId']}").json()["job"]
        if job["status"] in {"success", "failed"}:
            break
        time.sleep(0.02)
    assert client.get(f"/api/albums/{album['id']}/issues").json()["counts"]["exportConflicts"] == 0
    assert fetch_photos(client, album["id"], issue="export_conflict")["items"] == []


def test_rescan_all_and_library_sort(open_client, tmp_path):
    root = tmp_path / "相册"
    create_demo_root(root)
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    response = client.post("/api/albums/rescan", headers=csrf)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["failed"] == 0
    assert len(payload["outcomes"]) == 3
    assert {album["name"] for album in payload["albums"]} == {
        "测试-京都旅行",
        "测试-人像约拍-客户A",
        "测试-空相册",
    }

    travel = get_album(client, "测试-京都旅行")
    client.get(f"/api/albums/{travel['id']}")
    recent = client.get("/api/albums", params={"sort": "recent"}).json()["albums"]
    assert recent[0]["id"] == travel["id"]
    by_name = client.get("/api/albums", params={"sort": "name"}).json()["albums"]
    assert [album["name"] for album in by_name] == sorted(album["name"] for album in by_name)


def test_startup_cleans_only_own_export_temp_files(make_settings, tmp_path):
    settings = make_settings()
    guard = PathGuard(settings.photo_root, settings.export_dir_name)
    export_dir = guard.root / settings.export_dir_name / "某相册" / "JPG"
    export_dir.mkdir(parents=True)
    temp_file = export_dir / ".pc-tmp-deadbeef"
    temp_file.write_bytes(b"partial")
    user_file = export_dir / "A.JPG"
    user_file.write_bytes(b"real")
    removed = cleanup_stale_temp_files(settings, guard)
    assert removed == 1
    assert not temp_file.exists()
    assert user_file.exists()


def test_health_degraded_when_root_missing(make_settings, tmp_path):
    base = make_settings()
    missing_root = tmp_path / "不存在的相册根目录"
    settings: Settings = replace(base, photo_root=missing_root)
    app = create_app(settings)
    with TestClient(app, base_url="http://testserver") as client:
        health = client.get("/api/health").json()
        assert health["status"] == "degraded"
        assert health["photoRoot"]["exists"] is False
        assert health["photoRoot"]["readable"] is False
        albums = client.get("/api/albums").json()
        assert albums["albums"] == []
        assert albums["discovery"]["errors"]


def test_unavailable_trash_does_not_delete():
    service = BaseTrashService()
    capabilities = service.capabilities()
    assert capabilities["available"] is False
    assert capabilities["reason"]
    result = service.trash(Path("/tmp/whatever"))
    assert result.ok is False
    assert result.error_code == "DEPENDENCY_UNAVAILABLE"
