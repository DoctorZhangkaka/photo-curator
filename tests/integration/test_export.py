"""精选导出集成测试（EXP-001 ~ EXP-016）。"""

from __future__ import annotations

import errno
import hashlib
import time
import uuid

from tests.conftest import get_album, photo_by_name, rescan, set_state
from tests.fixtures.generate import create_demo_root


def wait_job(client, job_id: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/jobs/{job_id}")
        assert response.status_code == 200, response.text
        job = response.json()["job"]
        if job["status"] in {"success", "failed"}:
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish: {job}")


def select_photos(client, csrf, album_id: str, names: list[str]) -> None:
    for name in names:
        photo = photo_by_name(client, album_id, name)
        set_state(client, csrf, photo, selection="selected")


def export_preflight(client, csrf, album_id: str) -> dict:
    response = client.post(f"/api/albums/{album_id}/exports/preflight", headers=csrf)
    assert response.status_code == 200, response.text
    return response.json()


def export_execute(client, csrf, album_id: str, token: str) -> tuple[dict, dict]:
    response = client.post(
        f"/api/albums/{album_id}/exports",
        json={"preflightToken": token, "idempotencyKey": str(uuid.uuid4())},
        headers=csrf,
    )
    assert response.status_code == 202, response.text
    payload = response.json()
    job = wait_job(client, payload["jobId"])
    operation = client.get(f"/api/operations/{payload['operationId']}").json()["operation"]
    return job, operation


def setup_travel(open_client, tmp_path):
    root = tmp_path / "相册"
    create_demo_root(root)
    client, settings, app = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "测试-京都旅行")
    rescan(client, csrf, album["id"])
    return client, settings, app, root, album, csrf


def test_export_dual_and_single_formats(open_client, tmp_path):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0001", "DSCF0002", "DSCF0020"])
    preflight = export_preflight(client, csrf, album["id"])
    assert preflight["summary"]["photoCount"] == 3
    assert preflight["summary"]["fileCount"] == 4
    assert preflight["summary"]["jpgCount"] == 2
    assert preflight["summary"]["rawCount"] == 2
    assert preflight["destinationRelativePath"] == "精选原相册/测试-京都旅行"
    job, operation = export_execute(client, csrf, album["id"], preflight["token"])
    assert job["status"] == "success"
    assert operation["status"] == "success"
    assert operation["successFileCount"] == 4

    album_export = root / "精选原相册" / "测试-京都旅行"
    assert (album_export / "JPG").is_dir()
    assert (album_export / "RAW").is_dir()
    copied = sorted(path.name for path in album_export.rglob("*") if path.is_file())
    assert copied == ["DSCF0001.JPG", "DSCF0001.RAF", "DSCF0002.JPG", "DSCF0020.DNG"]
    # 源目录没有被修改
    assert (root / "测试-京都旅行" / "DSCF0001.JPG").exists()
    assert (root / "测试-京都旅行" / "DSCF0001.RAF").exists()
    # 源与目标哈希一致
    assert (
        hashlib.sha256((root / "测试-京都旅行" / "DSCF0001.JPG").read_bytes()).hexdigest()
        == hashlib.sha256((album_export / "JPG" / "DSCF0001.JPG").read_bytes()).hexdigest()
    )
    for item in operation["items"]:
        if item["result"] == "success":
            assert item["contentSha256"]


def test_export_only_jpg_and_only_raw_create_both_dirs(open_client, tmp_path):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0002"])
    preflight = export_preflight(client, csrf, album["id"])
    _, operation = export_execute(client, csrf, album["id"], preflight["token"])
    assert operation["status"] == "success"
    album_export = root / "精选原相册" / "测试-京都旅行"
    assert (album_export / "JPG" / "DSCF0002.JPG").is_file()
    assert (album_export / "RAW").is_dir()
    assert not list((album_export / "RAW").iterdir())

    # 仅 RAW（真实 DNG）：先取消 JPG 的精选，再精选 DNG
    set_state(client, csrf, photo_by_name(client, album["id"], "DSCF0002"), selection="unmarked")
    dng = photo_by_name(client, album["id"], "DSCF0020")
    set_state(client, csrf, dng, selection="selected")
    preflight = export_preflight(client, csrf, album["id"])
    assert preflight["summary"]["photoCount"] == 1
    assert preflight["summary"]["rawCount"] == 1
    _, operation = export_execute(client, csrf, album["id"], preflight["token"])
    assert operation["status"] == "success"
    assert (album_export / "RAW" / "DSCF0020.DNG").is_file()
    assert (album_export / "JPG").is_dir()


def test_export_only_selected_excludes_pending_and_conflict(open_client, tmp_path):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0001"])
    pending = photo_by_name(client, album["id"], "DSCF0002")
    set_state(client, csrf, pending, selection="pending_delete")
    conflict = photo_by_name(client, album["id"], "DSCF0030")
    set_state(client, csrf, conflict, selection="selected")
    missing = photo_by_name(client, album["id"], "DSCF0010")
    set_state(client, csrf, missing, selection="selected")
    (root / "测试-京都旅行" / "JPG" / "DSCF0010.JPG").unlink()
    rescan(client, csrf, album["id"])

    preflight = export_preflight(client, csrf, album["id"])
    assert preflight["summary"]["photoCount"] == 1
    assert preflight["summary"]["fileCount"] == 2
    warning_codes = {warning["code"] for warning in preflight["warnings"]}
    assert "PAIRING_CONFLICT" in warning_codes
    assert "ASSET_MISSING" in warning_codes
    _, operation = export_execute(client, csrf, album["id"], preflight["token"])
    assert operation["status"] == "success"
    assert operation["successFileCount"] == 2
    exported = {path.name for path in (root / "精选原相册" / "测试-京都旅行").rglob("*") if path.is_file()}
    assert exported == {"DSCF0001.JPG", "DSCF0001.RAF"}


def test_incremental_export_and_skip(open_client, tmp_path):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0002"])
    preflight = export_preflight(client, csrf, album["id"])
    _, first = export_execute(client, csrf, album["id"], preflight["token"])
    assert first["successFileCount"] == 1

    second_preflight = export_preflight(client, csrf, album["id"])
    assert second_preflight["summary"]["existingCount"] == 1
    assert second_preflight["summary"]["toCopyCount"] == 0
    _, second = export_execute(client, csrf, album["id"], second_preflight["token"])
    assert second["status"] == "success"
    assert second["successFileCount"] == 0
    assert second["skippedFileCount"] == 1
    assert second["items"][0]["result"] == "skipped"

    # 新增精选后只补新文件
    dng = photo_by_name(client, album["id"], "DSCF0020")
    set_state(client, csrf, dng, selection="selected")
    third_preflight = export_preflight(client, csrf, album["id"])
    assert third_preflight["summary"]["toCopyCount"] == 1
    assert third_preflight["summary"]["existingCount"] == 1
    _, third = export_execute(client, csrf, album["id"], third_preflight["token"])
    assert third["successFileCount"] == 1
    assert third["skippedFileCount"] == 1
    files = sorted(path.name for path in (root / "精选原相册" / "测试-京都旅行").rglob("*") if path.is_file())
    assert files == ["DSCF0002.JPG", "DSCF0020.DNG"]


def test_same_name_different_content_conflict_not_overwritten(open_client, tmp_path):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0002"])
    preflight = export_preflight(client, csrf, album["id"])
    _, first = export_execute(client, csrf, album["id"], preflight["token"])
    assert first["successFileCount"] == 1
    target = root / "精选原相册" / "测试-京都旅行" / "JPG" / "DSCF0002.JPG"
    original_target = target.read_bytes()
    # 同样大小、不同内容，验证哈希比较而不是只看大小。
    target.write_bytes(bytes([(byte + 1) % 256 for byte in original_target]))
    tampered = target.read_bytes()

    preflight = export_preflight(client, csrf, album["id"])
    _, operation = export_execute(client, csrf, album["id"], preflight["token"])
    assert operation["status"] == "partial_failure"
    assert operation["conflictFileCount"] == 1
    assert operation["items"][0]["result"] == "conflict"
    assert target.read_bytes() == tampered
    issues = client.get(f"/api/albums/{album['id']}/issues").json()
    assert issues["counts"]["exportConflicts"] == 1
    assert issues["exportConflicts"][0]["sourceRelativePath"] == "DSCF0002.JPG"


def test_unselect_does_not_delete_exported_file(open_client, tmp_path):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0002"])
    preflight = export_preflight(client, csrf, album["id"])
    export_execute(client, csrf, album["id"], preflight["token"])
    target = root / "精选原相册" / "测试-京都旅行" / "JPG" / "DSCF0002.JPG"
    assert target.exists()

    photo = photo_by_name(client, album["id"], "DSCF0002")
    set_state(client, csrf, photo, selection="unmarked")
    empty = export_preflight(client, csrf, album["id"])
    assert empty["token"] is None
    assert empty["summary"]["photoCount"] == 0
    assert target.exists()


def test_export_conflict_within_album_does_not_appear_in_source_library(open_client, tmp_path):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0002"])
    preflight = export_preflight(client, csrf, album["id"])
    export_execute(client, csrf, album["id"], preflight["token"])
    rescan(client, csrf, album["id"])
    album_after = get_album(client, "测试-京都旅行")
    assert album_after["counts"]["total"] == 5
    names = [item["name"] for item in client.get("/api/albums").json()["albums"]]
    assert "精选原相册" not in names


def test_export_idempotency(open_client, tmp_path):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0002"])
    preflight = export_preflight(client, csrf, album["id"])
    key = str(uuid.uuid4())
    first = client.post(
        f"/api/albums/{album['id']}/exports",
        json={"preflightToken": preflight["token"], "idempotencyKey": key},
        headers=csrf,
    )
    assert first.status_code == 202
    wait_job(client, first.json()["jobId"])
    second = client.post(
        f"/api/albums/{album['id']}/exports",
        json={"preflightToken": preflight["token"], "idempotencyKey": key},
        headers=csrf,
    )
    assert second.status_code == 202
    assert second.json()["idempotentReplay"] is True
    assert second.json()["operationId"] == first.json()["operationId"]
    files = list((root / "精选原相册" / "测试-京都旅行").rglob("*.JPG"))
    assert len(files) == 1


def test_export_source_change_marks_item_failed(open_client, tmp_path, monkeypatch):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0002"])

    import photo_curator.exporting as exporting

    original_export_one = exporting.export_one

    def changing_copy(source, destination):
        source_hash, written = exporting._copy_and_hash(source, destination)
        # 模拟复制期间源文件被外部修改
        import os

        os.utime(source, ns=(time.time_ns(), time.time_ns() + 10_000_000))
        return source_hash, written

    def wrapper(source, target, **kwargs):
        return original_export_one(source, target, copy_and_hash=changing_copy, **kwargs)

    monkeypatch.setattr(exporting, "export_one", wrapper)
    preflight = export_preflight(client, csrf, album["id"])
    _, operation = export_execute(client, csrf, album["id"], preflight["token"])
    assert operation["status"] == "failed"
    assert operation["failedFileCount"] == 1
    assert operation["items"][0]["errorCode"] == "SOURCE_CHANGED"
    assert not (root / "精选原相册" / "测试-京都旅行" / "JPG" / "DSCF0002.JPG").exists()


def test_export_disk_full_leaves_no_final_file(open_client, tmp_path, monkeypatch):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0002"])

    import photo_curator.exporting as exporting

    original_export_one = exporting.export_one

    def failing_copy(source, destination):
        raise OSError(errno.ENOSPC, "No space left on device (injected)")

    def wrapper(source, target, **kwargs):
        return original_export_one(source, target, copy_and_hash=failing_copy, **kwargs)

    monkeypatch.setattr(exporting, "export_one", wrapper)
    preflight = export_preflight(client, csrf, album["id"])
    _, operation = export_execute(client, csrf, album["id"], preflight["token"])
    assert operation["status"] == "failed"
    assert operation["items"][0]["result"] == "failed"
    assert "No space left" in operation["items"][0]["errorMessage"]
    album_export = root / "精选原相册" / "测试-京都旅行"
    assert not list(album_export.rglob("DSCF0002.JPG"))
    # 临时文件被清理
    assert not list(album_export.rglob(".pc-tmp-*"))


def test_preflight_expired_cannot_export(open_client, tmp_path):
    client, settings, _, root, album, csrf = setup_travel(open_client, tmp_path)
    select_photos(client, csrf, album["id"], ["DSCF0002"])
    preflight = export_preflight(client, csrf, album["id"])
    from photo_curator.db import Database
    from photo_curator.models import PreflightToken

    database = Database.create(settings.db_path)
    with database.session() as session:
        token = session.query(PreflightToken).filter_by(kind="export").first()
        token.expires_at = "2000-01-01T00:00:00.000Z"
        session.commit()
    database.dispose()
    response = client.post(
        f"/api/albums/{album['id']}/exports",
        json={"preflightToken": preflight["token"], "idempotencyKey": str(uuid.uuid4())},
        headers=csrf,
    )
    assert response.status_code == 410
    assert response.json()["error"]["code"] == "PREFLIGHT_EXPIRED"
