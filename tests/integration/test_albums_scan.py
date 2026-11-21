"""相册发现、扫描、状态合并与元数据集成测试。"""

from __future__ import annotations

import os
from pathlib import Path

from tests.conftest import get_album, photo_by_name, rescan, set_state
from tests.fixtures.generate import build_minimal_dng, create_demo_root, make_jpeg


def test_local_albums_discovered_without_type_assumptions(open_client, tmp_path):
    root = tmp_path / "相册"
    (root / "2026-京都旅行").mkdir(parents=True)
    make_jpeg(root / "2026-京都旅行" / "A.JPG")
    (root / "2026-11-人像约拍-林小姐").mkdir()
    make_jpeg(root / "2026-11-人像约拍-林小姐" / "B.JPG")
    client, settings, _ = open_client(root)

    payload = client.get("/api/albums").json()
    names = [album["name"] for album in payload["albums"]]
    assert names == ["2026-11-人像约拍-林小姐", "2026-京都旅行"]
    assert all(album["counts"]["total"] == 0 for album in payload["albums"])

    for name in names:
        album = get_album(client, name)
        rescan(client, {"X-CSRF-Token": settings.session_token}, album["id"])
    travel = get_album(client, "2026-京都旅行")
    assert travel["counts"]["total"] == 1
    assert travel["scanStatus"] == "ready"


def test_export_directory_hidden_and_empty_album(open_client, tmp_path):
    root = tmp_path / "相册"
    create_demo_root(root)
    client, settings, _ = open_client(root)
    payload = client.get("/api/albums").json()
    names = [album["name"] for album in payload["albums"]]
    assert "精选原相册" not in names
    assert payload["discovery"]["exportDirExcluded"] is True
    assert "测试-空相册" in names
    empty = get_album(client, "测试-空相册")
    rescan(client, {"X-CSRF-Token": settings.session_token}, empty["id"])
    empty = get_album(client, "测试-空相册")
    assert empty["scanStatus"] == "empty"
    assert empty["counts"]["total"] == 0


def test_hidden_and_root_level_files_ignored(open_client, tmp_path):
    root = tmp_path / "相册"
    (root / ".cache").mkdir(parents=True)
    make_jpeg(root / ".cache" / "hidden.JPG")
    make_jpeg(root / "root-level.JPG")
    (root / "相册A").mkdir()
    make_jpeg(root / "相册A" / "A.JPG")
    client, _, _ = open_client(root)
    payload = client.get("/api/albums").json()
    names = [album["name"] for album in payload["albums"]]
    assert names == ["相册A"]
    assert payload["discovery"]["rootImagesIgnored"] == 1
    assert payload["discovery"]["skippedHidden"] >= 1


def test_raw_jpg_subdirectories_case_insensitive(open_client, tmp_path):
    root = tmp_path / "相册"
    album = root / "混合目录"
    (album / "Raw").mkdir(parents=True)
    (album / "jpG").mkdir()
    (album / "Raw" / "A.RAF").write_bytes(b"raf")
    make_jpeg(album / "jpG" / "A.JPG")
    make_jpeg(album / "B.JPG")
    client, settings, _ = open_client(root)
    album_info = get_album(client, "混合目录")
    rescan(client, {"X-CSRF-Token": settings.session_token}, album_info["id"])
    photos = client.get(f"/api/albums/{album_info['id']}/photos").json()
    assert photos["total"] == 2
    a = photo_by_name(client, album_info["id"], "A")
    assert a["form"] == "jpg_raw"
    assert {asset["relativePath"] for asset in a["assets"]} == {"Raw/A.RAF", "jpG/A.JPG"}


def test_nested_directories_not_included_and_reported(open_client, tmp_path):
    root = tmp_path / "相册"
    album = root / "嵌套"
    (album / "其他" / "深层").mkdir(parents=True)
    make_jpeg(album / "A.JPG")
    make_jpeg(album / "其他" / "深层" / "B.JPG")
    client, settings, _ = open_client(root)
    album_info = get_album(client, "嵌套")
    report = rescan(client, {"X-CSRF-Token": settings.session_token}, album_info["id"])["report"]
    photos = client.get(f"/api/albums/{album_info['id']}/photos").json()
    assert photos["total"] == 1
    assert report["unincludedDirs"][0]["path"] == "其他"
    assert report["unincludedDirs"][0]["supportedImageCount"] == 1


def test_symlink_escape_rejected_and_reported(open_client, tmp_path):
    root = tmp_path / "相册"
    album = root / "链接"
    album.mkdir(parents=True)
    outside = tmp_path / "secret.JPG"
    make_jpeg(outside)
    os.symlink(outside, album / "LINK.JPG")
    outside_dir = tmp_path / "outside_dir"
    outside_dir.mkdir()
    make_jpeg(outside_dir / "NESTED.JPG")
    os.symlink(outside_dir, album / "LINK_DIR")
    client, settings, _ = open_client(root)
    album_info = get_album(client, "链接")
    report = rescan(client, {"X-CSRF-Token": settings.session_token}, album_info["id"])["report"]
    photos = client.get(f"/api/albums/{album_info['id']}/photos").json()
    assert photos["total"] == 0
    assert "LINK.JPG" in report["skippedSymlinks"]
    assert "LINK_DIR" in report["skippedSymlinks"]
    issues = client.get(f"/api/albums/{album_info['id']}/issues").json()
    assert issues["counts"]["scanErrors"] >= 2


def test_scan_failure_isolated_per_album(open_client, tmp_path, monkeypatch):
    root = tmp_path / "相册"
    good = root / "正常"
    bad = root / "不可读"
    good.mkdir(parents=True)
    bad.mkdir()
    make_jpeg(good / "A.JPG")
    make_jpeg(bad / "B.JPG")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    good_album = get_album(client, "正常")
    bad_album = get_album(client, "不可读")

    import photo_curator.scanning as scanning

    original = scanning.os.scandir

    def failing_scandir(path):
        if Path(path).resolve() == bad.resolve():
            raise PermissionError("permission denied by test")
        return original(path)

    monkeypatch.setattr(scanning.os, "scandir", failing_scandir)
    response = client.post(f"/api/albums/{bad_album['id']}/rescan", headers=csrf)
    assert response.status_code == 200
    assert response.json()["error"]
    bad_after = get_album(client, "不可读")
    assert bad_after["scanStatus"] == "failed"
    assert bad_after["scanError"]

    monkeypatch.setattr(scanning.os, "scandir", original)
    ok = client.post(f"/api/albums/{good_album['id']}/rescan", headers=csrf)
    assert ok.status_code == 200
    good_after = get_album(client, "正常")
    assert good_after["scanStatus"] == "ready"
    assert good_after["counts"]["total"] == 1


def test_conflict_group_and_counts(open_client, tmp_path):
    root = tmp_path / "相册"
    create_demo_root(root)
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "测试-京都旅行")
    rescan(client, csrf, album["id"])
    album = get_album(client, "测试-京都旅行")
    assert album["counts"]["total"] == 5
    assert album["counts"]["conflicts"] == 1
    conflict = photo_by_name(client, album["id"], "DSCF0030")
    assert conflict["pairingStatus"] == "conflict"
    assert "duplicate_jpg" in conflict["conflictReasons"]
    assert conflict["form"] == "jpg_only"
    # DNG only 真实 RAW 资产
    dng = photo_by_name(client, album["id"], "DSCF0020")
    assert dng["form"] == "raw_only"
    assert dng["assets"][0]["extension"] == ".DNG"


def test_scan_metadata_and_sorting(open_client, tmp_path):
    root = tmp_path / "相册"
    album = root / "排序"
    album.mkdir(parents=True)
    make_jpeg(album / "IMG2.JPG", capture_time="2026:11:20 10:00:00")
    make_jpeg(album / "IMG10.JPG", capture_time="2026:11:20 09:00:00")
    make_jpeg(album / "IMG1.JPG", capture_time=None)
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album_info = get_album(client, "排序")
    rescan(client, csrf, album_info["id"])

    capture = client.get(f"/api/albums/{album_info['id']}/photos", params={"sort": "capture"}).json()
    assert [item["displayName"] for item in capture["items"]] == ["IMG10", "IMG2", "IMG1"]
    assert capture["items"][0]["captureTime"] == "2026-11-20T09:00:00"
    assert capture["items"][0]["exif"] if "exif" in capture["items"][0] else True

    filename = client.get(f"/api/albums/{album_info['id']}/photos", params={"sort": "filename"}).json()
    assert [item["displayName"] for item in filename["items"]] == ["IMG1", "IMG2", "IMG10"]

    detail = client.get(f"/api/photos/{capture['items'][0]['id']}").json()["photo"]
    assert detail["exif"]["cameraMake"] == "FUJIFILM"
    assert detail["exif"]["cameraModel"] == "X-T5"
    assert detail["exif"]["width"] == 64
    assert detail["exif"]["height"] == 48


def test_missing_file_keeps_state_and_recovers(open_client, tmp_path):
    root = tmp_path / "相册"
    album = root / "缺失"
    album.mkdir(parents=True)
    source = make_jpeg(album / "A.JPG", capture_time="2026:11:20 08:00:00")
    make_jpeg(album / "B.JPG", capture_time="2026:11:20 09:00:00")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album_info = get_album(client, "缺失")
    rescan(client, csrf, album_info["id"])
    photo = photo_by_name(client, album_info["id"], "A")
    photo = set_state(client, csrf, photo, selection="selected", viewed="viewed")

    source.unlink()
    rescan(client, csrf, album_info["id"])
    missing = photo_by_name(client, album_info["id"], "A")
    assert missing["flags"]["missingFile"] is True
    assert missing["selectionStatus"] == "selected"
    assert missing["viewedStatus"] == "viewed"
    assert client.get(f"/api/albums/{album_info['id']}/issues").json()["counts"]["missingFiles"] == 1

    make_jpeg(source)
    rescan(client, csrf, album_info["id"])
    recovered = photo_by_name(client, album_info["id"], "A")
    assert recovered["pairingStatus"] == "normal"
    assert recovered["flags"]["missingFile"] is False
    assert recovered["selectionStatus"] == "selected"
    assert recovered["viewedStatus"] == "viewed"


def test_raw_only_dng_preview_and_dimensions(open_client, tmp_path):
    root = tmp_path / "相册"
    album = root / "RAW"
    album.mkdir(parents=True)
    build_minimal_dng(album / "ONLY.DNG")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album_info = get_album(client, "RAW")
    rescan(client, csrf, album_info["id"])
    photo = photo_by_name(client, album_info["id"], "ONLY")
    response = client.get(f"/api/photos/{photo['id']}/thumbnail")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/jpeg"
    assert len(response.content) > 100
    preview = client.get(f"/api/photos/{photo['id']}/original-preview")
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/jpeg"


def test_cursor_pagination_is_stable(open_client, tmp_path):
    root = tmp_path / "相册"
    album = root / "分页"
    album.mkdir(parents=True)
    for index in range(7):
        make_jpeg(album / f"P{index:02d}.JPG", capture_time=f"2026:11:20 0{index}:00:00")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album_info = get_album(client, "分页")
    rescan(client, csrf, album_info["id"])

    seen: list[str] = []
    cursor = None
    for _ in range(10):
        params = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = client.get(f"/api/albums/{album_info['id']}/photos", params=params).json()
        seen.extend(item["id"] for item in page["items"])
        cursor = page["nextCursor"]
        if not cursor:
            break
    assert len(seen) == 7
    assert len(set(seen)) == 7
