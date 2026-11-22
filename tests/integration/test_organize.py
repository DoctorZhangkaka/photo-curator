"""原地整理 JPG/RAW 的预检、执行、回滚与安全测试。"""

from __future__ import annotations

import uuid

from tests.conftest import get_album, photo_by_name, rescan
from tests.fixtures.generate import make_jpeg


def make_album(root):
    album = root / "整理测试"
    album.mkdir(parents=True)
    make_jpeg(album / "A.JPG")
    (album / "A.RAF").write_bytes(b"raw-a")
    make_jpeg(album / "B.JPG")
    make_jpeg(album / "JPG" / "C.JPG") if (album / "JPG").mkdir(exist_ok=True) is None else None
    return album


def setup(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = make_album(root)
    client, settings, app = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "整理测试")
    rescan(client, csrf, album["id"])
    return client, settings, app, root, album_dir, album, csrf


def preflight(client, csrf, album_id):
    response = client.post(f"/api/albums/{album_id}/organize/preflight", headers=csrf)
    assert response.status_code == 200, response.text
    return response.json()


def execute(client, csrf, album_id, token):
    return client.post(
        f"/api/albums/{album_id}/organize/execute",
        json={"preflightToken": token, "idempotencyKey": str(uuid.uuid4())},
        headers=csrf,
    )


def test_organize_moves_flat_files_and_rolls_back(open_client, tmp_path):
    client, _, _, root, album_dir, album, csrf = setup(open_client, tmp_path)

    plan = preflight(client, csrf, album["id"])
    assert plan["blocked"] is False
    assert plan["summary"]["moveCount"] == 3
    assert plan["summary"]["skipCount"] == 1
    assert plan["summary"]["jpgCount"] == 2
    assert plan["summary"]["rawCount"] == 1
    assert plan["token"]
    # 预检不移动文件
    assert (album_dir / "A.JPG").is_file()
    assert (album_dir / "A.RAF").is_file()
    assert not (album_dir / "JPG" / "A.JPG").exists()

    result = execute(client, csrf, album["id"], plan["token"])
    assert result.status_code == 200, result.text
    operation = result.json()["operation"]
    assert operation["type"] == "organize"
    assert operation["status"] == "success"
    assert operation["successFileCount"] == 3
    assert operation["canRestore"] is True
    assert (album_dir / "JPG" / "A.JPG").is_file()
    assert (album_dir / "JPG" / "B.JPG").is_file()
    assert (album_dir / "RAW" / "A.RAF").is_file()
    assert not (album_dir / "A.JPG").exists()
    assert not (album_dir / "A.RAF").exists()

    # 数据库中的路径已经更新，重新扫描不会把文件当缺失。
    photo = photo_by_name(client, album["id"], "A")
    paths = {asset["relativePath"] for asset in photo["assets"]}
    assert paths == {"JPG/A.JPG", "RAW/A.RAF"}
    rescan(client, csrf, album["id"])
    after_scan = photo_by_name(client, album["id"], "A")
    assert {asset["presenceStatus"] for asset in after_scan["assets"]} == {"present"}

    restore = client.post(f"/api/operations/{operation['id']}/restore", headers=csrf)
    assert restore.status_code == 200, restore.text
    restored = restore.json()
    assert restored["operation"]["type"] == "organize_undo"
    assert restored["operation"]["status"] == "success"
    assert restored["originalOperation"]["canRestore"] is False
    assert (album_dir / "A.JPG").is_file()
    assert (album_dir / "A.RAF").is_file()
    assert not (album_dir / "JPG" / "A.JPG").exists()
    assert (album_dir / "JPG" / "C.JPG").is_file()
    assert not (album_dir / "RAW").exists()


def test_organize_blocks_existing_destination(open_client, tmp_path):
    client, _, _, _, album_dir, album, csrf = setup(open_client, tmp_path)
    (album_dir / "JPG" / "A.JPG").write_bytes(b"already-here")
    plan = preflight(client, csrf, album["id"])
    assert plan["blocked"] is True
    assert plan["token"] is None
    # 扫描先把同名 JPG 识别为配对冲突；无论哪一类阻止项，都不能执行。
    assert plan["blockers"]
    assert (album_dir / "A.JPG").is_file()
    assert (album_dir / "JPG" / "A.JPG").read_bytes() == b"already-here"


def test_organize_aborts_if_file_changed_after_preflight(open_client, tmp_path):
    client, _, _, _, album_dir, album, csrf = setup(open_client, tmp_path)
    plan = preflight(client, csrf, album["id"])
    source = album_dir / "A.JPG"
    source.write_bytes(source.read_bytes() + b"changed")
    result = execute(client, csrf, album["id"], plan["token"])
    assert result.status_code == 409, result.text
    assert result.json()["error"]["code"] == "SOURCE_CHANGED"
    assert source.is_file()
    assert not (album_dir / "JPG" / "A.JPG").exists()
    operation_id = result.json()["error"]["details"]["operationId"]
    operation = client.get(f"/api/operations/{operation_id}").json()["operation"]
    assert operation["status"] == "failed"
    assert operation["canRestore"] is False


def test_organized_album_needs_no_changes(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "已整理"
    album_dir.mkdir(parents=True)
    (album_dir / "JPG").mkdir()
    (album_dir / "RAW").mkdir()
    make_jpeg(album_dir / "JPG" / "A.JPG")
    (album_dir / "RAW" / "A.RAF").write_bytes(b"raw")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "已整理")
    rescan(client, csrf, album["id"])
    plan = preflight(client, csrf, album["id"])
    assert plan["blocked"] is False
    assert plan["summary"]["moveCount"] == 0
    assert plan["summary"]["skipCount"] == 2
    assert plan["token"] is None
    assert (album_dir / "JPG" / "A.JPG").is_file()


def test_rollback_refuses_to_overwrite_new_source_file(open_client, tmp_path):
    client, _, _, _, album_dir, album, csrf = setup(open_client, tmp_path)
    plan = preflight(client, csrf, album["id"])
    operation = execute(client, csrf, album["id"], plan["token"]).json()["operation"]
    # 模拟整理后用户又在原位置放了同名文件。
    (album_dir / "A.JPG").write_bytes(b"new-file-after-organize")

    rollback = client.post(f"/api/operations/{operation['id']}/restore", headers=csrf)
    assert rollback.status_code == 200, rollback.text
    body = rollback.json()
    assert body["operation"]["status"] in {"failed", "partial_failure"}
    assert body["operation"]["conflictFileCount"] >= 1
    assert body["originalOperation"]["canRestore"] is True
    assert (album_dir / "A.JPG").read_bytes() == b"new-file-after-organize"
    assert (album_dir / "JPG" / "A.JPG").is_file()


def test_symlink_target_blocks_organize(open_client, tmp_path):
    client, _, _, root, album_dir, album, csrf = setup(open_client, tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    raw_dir = album_dir / "RAW"
    raw_dir.rmdir() if raw_dir.exists() and not any(raw_dir.iterdir()) else None
    try:
        raw_dir.symlink_to(outside, target_is_directory=True)
    except OSError:
        return
    plan = preflight(client, csrf, album["id"])
    assert plan["blocked"] is True
    assert plan["token"] is None
    assert (album_dir / "A.JPG").is_file()
    assert not (outside / "A.RAF").exists()
