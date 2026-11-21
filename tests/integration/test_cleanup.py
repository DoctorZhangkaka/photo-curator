"""清理、回滚、撤销与清扫后状态测试（DEL-001 ~ DEL-016）。"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from tests.conftest import fetch_photos, get_album, photo_by_name, preflight_cleanup, rescan, set_state
from tests.fakes import install_fake_trash
from tests.fixtures.generate import create_demo_root


def setup_cleanup(open_client, tmp_path):
    root = tmp_path / "相册"
    create_demo_root(root)
    client, settings, app = open_client(root)
    fake = install_fake_trash(app, tmp_path / "fake-trash")
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "测试-京都旅行")
    rescan(client, csrf, album["id"])
    return client, settings, app, root, album, csrf, fake


def mark_pending(client, csrf, album_id: str, names: list[str]) -> None:
    for name in names:
        photo = photo_by_name(client, album_id, name)
        set_state(client, csrf, photo, selection="pending_delete")


def execute_cleanup(client, csrf, album_id: str, token: str, key: str | None = None) -> dict:
    response = client.post(
        f"/api/albums/{album_id}/cleanup/execute",
        json={"preflightToken": token, "idempotencyKey": key or str(uuid.uuid4())},
        headers=csrf,
    )
    return {"status": response.status_code, "body": response.json()}


def test_marking_pending_never_moves_files(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0002"])
    assert (root / "测试-京都旅行" / "DSCF0002.JPG").exists()
    assert fake.trash_calls == []
    assert not list((tmp_path / "fake-trash").iterdir())


def test_preflight_dual_format_lists_both_files(open_client, tmp_path):
    client, _, _, root, album, csrf, _ = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0001"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    assert preflight["blocked"] is False
    assert preflight["summary"]["photoCount"] == 1
    assert preflight["summary"]["fileCount"] == 2
    group = preflight["groups"][0]
    assert {asset["relativePath"] for asset in group["assets"]} == {"DSCF0001.JPG", "DSCF0001.RAF"}
    assert "废纸篓" in preflight["message"]
    assert "永久删除" in preflight["message"]


def test_cleanup_only_jpg(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0002"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    assert result["status"] == 200
    operation = result["body"]["operation"]
    assert operation["status"] == "success"
    assert operation["successFileCount"] == 1
    assert len(operation["items"]) == 1
    assert operation["items"][0]["result"] == "success"
    assert not (root / "测试-京都旅行" / "DSCF0002.JPG").exists()
    assert operation["items"][0]["destinationPath"].startswith(str(tmp_path / "fake-trash"))
    assert operation["canRestore"] is True


def test_cleanup_only_raw_dng(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0020"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    assert preflight["summary"]["rawCount"] == 1
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    operation = result["body"]["operation"]
    assert operation["status"] == "success"
    assert not (root / "测试-京都旅行" / "JPG" / "DSCF0020.DNG").exists()
    assert (fake.trash_dir / "DSCF0020.DNG").exists()


def test_cleanup_dual_format_group(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0001"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    operation = result["body"]["operation"]
    assert operation["status"] == "success"
    assert operation["successFileCount"] == 2
    assert len([item for item in operation["items"] if item["result"] == "success"]) == 2
    assert not (root / "测试-京都旅行" / "DSCF0001.JPG").exists()
    assert not (root / "测试-京都旅行" / "DSCF0001.RAF").exists()
    assert len([path for path in fake.trash_dir.iterdir() if path.is_file()]) == 2


def test_pairing_conflict_blocks_entire_batch(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0002", "DSCF0030"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    assert preflight["blocked"] is True
    codes = {blocker["code"] for blocker in preflight["blockers"]}
    assert "PAIRING_CONFLICT" in codes
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    assert result["status"] == 409
    assert result["body"]["error"]["code"] == "PREFLIGHT_BLOCKED"
    assert (root / "测试-京都旅行" / "DSCF0002.JPG").exists()
    assert fake.trash_calls == []


def test_missing_file_blocks_entire_batch(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    (root / "测试-京都旅行" / "DSCF0001.RAF").unlink()
    rescan(client, csrf, album["id"])
    mark_pending(client, csrf, album["id"], ["DSCF0001"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    assert preflight["blocked"] is True
    codes = {blocker["code"] for blocker in preflight["blockers"]}
    assert "ASSET_MISSING" in codes
    assert fake.trash_calls == []


def test_source_change_after_preflight_aborts_batch(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0002"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    source = root / "测试-京都旅行" / "DSCF0002.JPG"
    source.write_bytes(source.read_bytes() + b"changed")
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    assert result["status"] == 409
    assert result["body"]["error"]["code"] == "SOURCE_CHANGED"
    assert fake.trash_calls == []
    assert source.exists()
    operation_id = result["body"]["error"]["details"]["operationId"]
    operation = client.get(f"/api/operations/{operation_id}").json()["operation"]
    assert operation["status"] == "failed"
    assert all(item["result"] == "failed" for item in operation["items"])


def test_second_file_failure_rolls_back_group(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    fake.fail_trash_names.add("DSCF0001.RAF")
    mark_pending(client, csrf, album["id"], ["DSCF0001"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    operation = result["body"]["operation"]
    assert operation["status"] == "failed"
    assert operation["successFileCount"] == 0
    assert operation["failedFileCount"] == 2
    assert (root / "测试-京都旅行" / "DSCF0001.JPG").exists()
    assert (root / "测试-京都旅行" / "DSCF0001.RAF").exists()
    assert not list(fake.trash_dir.iterdir())
    jpg_item = next(item for item in operation["items"] if item["sourceRelativePath"].endswith(".JPG"))
    raf_item = next(item for item in operation["items"] if item["sourceRelativePath"].endswith(".RAF"))
    assert jpg_item["result"] == "restored"
    assert raf_item["result"] == "failed"
    # 组状态恢复为正常，仍保留待删除标记，用户可重试。
    photo = photo_by_name(client, album["id"], "DSCF0001")
    assert photo["pairingStatus"] == "normal"
    assert photo["selectionStatus"] == "pending_delete"


def test_rollback_failure_is_critical_not_success(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    fake.fail_trash_names.add("DSCF0001.RAF")
    fake.fail_restore_names.add("DSCF0001.JPG")
    mark_pending(client, csrf, album["id"], ["DSCF0001"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    operation = result["body"]["operation"]
    assert operation["status"] == "failed"
    jpg_item = next(item for item in operation["items"] if item["sourceRelativePath"].endswith(".JPG"))
    assert jpg_item["errorCode"] == "ROLLBACK_FAILED"
    assert "实际位置" in jpg_item["errorMessage"]
    jpg_path = root / "测试-京都旅行" / "DSCF0001.JPG"
    assert not jpg_path.exists()
    assert (fake.trash_dir / "DSCF0001.JPG").exists()
    photo = photo_by_name(client, album["id"], "DSCF0001")
    assert photo["pairingStatus"] == "conflict"
    issues = client.get(f"/api/albums/{album['id']}/issues").json()
    assert issues["counts"]["cleanupIncomplete"] == 1
    # 清理测试夹具，避免残留
    shutil.move(str(fake.trash_dir / "DSCF0001.JPG"), str(jpg_path))


def test_duplicate_execute_is_idempotent(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0002"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    key = str(uuid.uuid4())
    first = execute_cleanup(client, csrf, album["id"], preflight["token"], key)
    assert first["status"] == 200
    second = execute_cleanup(client, csrf, album["id"], preflight["token"], key)
    assert second["status"] == 200
    assert second["body"]["idempotentReplay"] is True
    assert second["body"]["operation"]["id"] == first["body"]["operation"]["id"]
    assert len(fake.trash_calls) == 1

    # 已消费的预检换一个幂等键不能再次执行
    third = execute_cleanup(client, csrf, album["id"], preflight["token"], str(uuid.uuid4()))
    assert third["status"] == 409
    assert third["body"]["error"]["code"] == "PREFLIGHT_CONSUMED"


def test_undo_restores_files_and_state(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0001", "DSCF0002"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    operation = result["body"]["operation"]
    assert operation["status"] == "success"
    assert not (root / "测试-京都旅行" / "DSCF0001.JPG").exists()

    restored = client.post(f"/api/operations/{operation['id']}/restore", headers=csrf)
    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert body["alreadyRestored"] is False
    assert body["operation"]["status"] == "success"
    assert body["originalOperation"]["status"] == "restored"
    assert (root / "测试-京都旅行" / "DSCF0001.JPG").exists()
    assert (root / "测试-京都旅行" / "DSCF0001.RAF").exists()
    assert (root / "测试-京都旅行" / "DSCF0002.JPG").exists()
    photo = photo_by_name(client, album["id"], "DSCF0001")
    assert photo["pairingStatus"] == "normal"
    assert photo["selectionStatus"] == "pending_delete"

    again = client.post(f"/api/operations/{operation['id']}/restore", headers=csrf)
    assert again.status_code == 200
    assert again.json()["alreadyRestored"] is True


def test_undo_conflict_does_not_overwrite(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0002"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    operation = result["body"]["operation"]
    original = root / "测试-京都旅行" / "DSCF0002.JPG"
    original.write_bytes(b"new file after cleanup")

    restored = client.post(f"/api/operations/{operation['id']}/restore", headers=csrf)
    assert restored.status_code == 200
    body = restored.json()
    assert body["operation"]["status"] == "partial_failure"
    assert body["operation"]["conflictFileCount"] == 1
    assert body["operation"]["items"][0]["result"] == "conflict"
    assert original.read_bytes() == b"new file after cleanup"
    assert (fake.trash_dir / "DSCF0002.JPG").exists()
    assert body["originalOperation"]["canRestore"] is True


def test_cleanup_rescan_not_reported_as_external_missing(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0002"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    execute_cleanup(client, csrf, album["id"], preflight["token"])
    rescan(client, csrf, album["id"])
    issues = client.get(f"/api/albums/{album['id']}/issues").json()
    assert issues["counts"]["missingFiles"] == 0
    photos = fetch_photos(client, album["id"])
    assert "DSCF0002" not in {item["displayName"] for item in photos["items"]}
    assert photos["total"] == 4


def test_finder_recovery_merges_state(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0002"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    operation = result["body"]["operation"]
    trash_path = Path(operation["items"][0]["destinationPath"])
    original = root / "测试-京都旅行" / "DSCF0002.JPG"
    shutil.move(str(trash_path), str(original))

    rescan(client, csrf, album["id"])
    photo = photo_by_name(client, album["id"], "DSCF0002")
    assert photo["pairingStatus"] == "normal"
    assert photo["selectionStatus"] == "pending_delete"
    assert photo["flags"]["missingFile"] is False


def test_no_permanent_delete_entrypoint(open_client, tmp_path):
    client, _, _, root, album, csrf, fake = setup_cleanup(open_client, tmp_path)
    mark_pending(client, csrf, album["id"], ["DSCF0002"])
    preflight = preflight_cleanup(client, csrf, album["id"])
    assert "永久删除" in preflight["message"]
    # 所有执行后的文件必须存在于（测试）废纸篓，而不是被 unlink 消失
    result = execute_cleanup(client, csrf, album["id"], preflight["token"])
    trash_path = Path(result["body"]["operation"]["items"][0]["destinationPath"])
    assert trash_path.exists()
    assert fake.is_in_trash(trash_path)
