"""状态维度、过滤、排序、乐观锁与持久化测试（STATE/SORT 用例）。"""

from __future__ import annotations

from tests.conftest import fetch_photos, get_album, photo_by_name, rescan, set_state
from tests.fixtures.generate import build_minimal_dng, create_demo_root, make_jpeg


def _setup(client, settings, root_name="测试-京都旅行"):
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, root_name)
    rescan(client, csrf, album["id"])
    return album, csrf


def test_two_state_dimensions_are_independent(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "状态"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    client, settings, _ = open_client(root)
    album, csrf = _setup(client, settings, "状态")

    photo = photo_by_name(client, album["id"], "A")
    assert photo["viewedStatus"] == "unseen"
    assert photo["selectionStatus"] == "unmarked"

    photo = set_state(client, csrf, photo, viewed="viewed")
    assert photo["viewedStatus"] == "viewed"
    assert photo["selectionStatus"] == "unmarked"

    photo = set_state(client, csrf, photo, selection="selected")
    assert photo["viewedStatus"] == "viewed"
    assert photo["selectionStatus"] == "selected"

    # 精选直接改为待删除；取消后回到未筛选，不自动恢复精选。
    photo = set_state(client, csrf, photo, selection="pending_delete")
    assert photo["isSelected"] is False
    assert photo["isPendingDelete"] is True
    album_after = get_album(client, "状态")
    assert album_after["counts"]["selected"] == 0
    assert album_after["counts"]["pendingDelete"] == 1

    photo = set_state(client, csrf, photo, selection="unmarked")
    assert photo["selectionStatus"] == "unmarked"

    # 手动改回未浏览不影响筛选状态。
    photo = set_state(client, csrf, photo, selection="selected")
    photo = set_state(client, csrf, photo, viewed="unseen")
    assert photo["viewedStatus"] == "unseen"
    assert photo["selectionStatus"] == "selected"


def test_pending_delete_visible_by_default(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "默认列表"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    make_jpeg(album_dir / "B.JPG")
    client, settings, _ = open_client(root)
    album, csrf = _setup(client, settings, "默认列表")
    photo = photo_by_name(client, album["id"], "A")
    set_state(client, csrf, photo, selection="pending_delete")

    payload = fetch_photos(client, album["id"])
    pending = [item for item in payload["items"] if item["displayName"] == "A"][0]
    assert pending["isPendingDelete"] is True
    assert pending["flags"]["pairingConflict"] is False


def test_filters_combinations(open_client, tmp_path):
    root = tmp_path / "相册"
    create_demo_root(root)
    client, settings, _ = open_client(root)
    album, csrf = _setup(client, settings)
    all_photos = fetch_photos(client, album["id"], limit=500)
    by_name = {item["displayName"]: item for item in all_photos["items"]}

    pair = by_name["DSCF0001"]
    jpg_only = by_name["DSCF0002"]
    raw_only = by_name["DSCF0020"]
    conflict = by_name["DSCF0030"]
    set_state(client, csrf, pair, viewed="viewed", selection="selected")
    set_state(client, csrf, jpg_only, viewed="unseen", selection="pending_delete")
    set_state(client, csrf, raw_only, selection="selected")

    forms = fetch_photos(client, album["id"], form="jpg_raw")["items"]
    assert {item["displayName"] for item in forms} == {"DSCF0001", "DSCF0010"}
    jpg_only_items = fetch_photos(client, album["id"], form="jpg_only")["items"]
    assert {item["displayName"] for item in jpg_only_items} == {"DSCF0002", "DSCF0030"}
    raw_only_items = fetch_photos(client, album["id"], form="raw_only")["items"]
    assert {item["displayName"] for item in raw_only_items} == {"DSCF0020"}

    selected = fetch_photos(client, album["id"], selection="selected")["items"]
    assert {item["displayName"] for item in selected} == {"DSCF0001", "DSCF0020"}
    pending = fetch_photos(client, album["id"], selection="pending_delete")["items"]
    assert {item["displayName"] for item in pending} == {"DSCF0002"}
    viewed = fetch_photos(client, album["id"], viewed="viewed")["items"]
    assert {item["displayName"] for item in viewed} == {"DSCF0001"}
    unseen = fetch_photos(client, album["id"], viewed="unseen")["items"]
    assert "DSCF0001" not in {item["displayName"] for item in unseen}

    combined = fetch_photos(client, album["id"], viewed="unseen", selection="selected")["items"]
    assert {item["displayName"] for item in combined} == {"DSCF0020"}

    conflicts = fetch_photos(client, album["id"], issue="pairing_conflict")["items"]
    assert {item["displayName"] for item in conflicts} == {conflict["displayName"]}

    # 文件缺失是独立异常，不是待删除。
    (root / "测试-京都旅行" / "JPG" / "DSCF0010.JPG").unlink(missing_ok=True)
    rescan(client, csrf, album["id"])
    missing = fetch_photos(client, album["id"], issue="missing")["items"]
    assert any(item["flags"]["missingFile"] for item in missing)
    pending_after = fetch_photos(client, album["id"], selection="pending_delete")["items"]
    assert all(not item["flags"]["missingFile"] for item in pending_after)


def test_stale_version_conflict(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "并发"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    client, settings, _ = open_client(root)
    album, csrf = _setup(client, settings, "并发")
    photo = photo_by_name(client, album["id"], "A")

    first = client.patch(
        f"/api/photos/{photo['id']}/state",
        json={"viewedStatus": "viewed", "version": photo["version"]},
        headers=csrf,
    )
    assert first.status_code == 200

    second = client.patch(
        f"/api/photos/{photo['id']}/state",
        json={"selectionStatus": "selected", "version": photo["version"]},
        headers=csrf,
    )
    assert second.status_code == 409
    error = second.json()["error"]
    assert error["code"] == "STALE_VERSION"
    assert error["details"]["currentVersion"] == photo["version"] + 1

    latest = client.get(f"/api/photos/{photo['id']}").json()["photo"]
    assert latest["viewedStatus"] == "viewed"
    assert latest["selectionStatus"] == "unmarked"


def test_state_persists_across_restart(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "重启"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    make_jpeg(album_dir / "B.JPG")
    client, settings, _ = open_client(root)
    album, csrf = _setup(client, settings, "重启")
    photo = photo_by_name(client, album["id"], "A")
    set_state(client, csrf, photo, viewed="viewed", selection="selected")

    # 使用同样的照片根目录与数据目录重新创建应用
    client2, settings2, _ = open_client(root)
    album2 = get_album(client2, "重启")
    persisted = photo_by_name(client2, album2["id"], "A")
    assert persisted["viewedStatus"] == "viewed"
    assert persisted["selectionStatus"] == "selected"
    assert album2["counts"]["viewed"] == 1
    assert album2["counts"]["selected"] == 1


def test_invalid_state_requests(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "校验"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    client, settings, _ = open_client(root)
    album, csrf = _setup(client, settings, "校验")
    photo = photo_by_name(client, album["id"], "A")

    no_fields = client.patch(f"/api/photos/{photo['id']}/state", json={"version": photo["version"]}, headers=csrf)
    assert no_fields.status_code == 400
    invalid = client.patch(
        f"/api/photos/{photo['id']}/state",
        json={"selectionStatus": "deleted", "version": photo["version"]},
        headers=csrf,
    )
    assert invalid.status_code == 400
    missing_version = client.patch(
        f"/api/photos/{photo['id']}/state",
        json={"selectionStatus": "selected"},
        headers=csrf,
    )
    assert missing_version.status_code == 400


def test_sort_switch_keeps_identity_data(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "排序切换"
    album_dir.mkdir(parents=True)
    for index, time in enumerate(["2026:11:20 10:00:00", "2026:11:20 09:00:00"]):
        make_jpeg(album_dir / f"IMG{index}.JPG", capture_time=time)
    client, settings, _ = open_client(root)
    album, csrf = _setup(client, settings, "排序切换")
    capture = fetch_photos(client, album["id"], sort="capture")["items"]
    filename = fetch_photos(client, album["id"], sort="filename")["items"]
    assert [item["id"] for item in capture] == [item["id"] for item in filename][::-1]
    assert {item["id"] for item in capture} == {item["id"] for item in filename}

    # 光标与排序不匹配时拒绝
    page = fetch_photos(client, album["id"], sort="capture", limit=1)
    bad = client.get(
        f"/api/albums/{album['id']}/photos",
        params={"sort": "filename", "cursor": page["nextCursor"]},
    )
    assert bad.status_code == 400


def test_media_missing_and_conflict_asset_selection(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "媒体"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    make_jpeg(album_dir / "JPG" / "A.JPG")
    build_minimal_dng(album_dir / "ONLY.DNG")
    client, settings, _ = open_client(root)
    album, csrf = _setup(client, settings, "媒体")
    conflict = photo_by_name(client, album["id"], "A")
    assert conflict["pairingStatus"] == "conflict"
    first = client.get(f"/api/photos/{conflict['id']}/thumbnail")
    assert first.status_code == 200
    second_asset = conflict["assets"][1]["id"]
    second = client.get(f"/api/photos/{conflict['id']}/thumbnail", params={"assetId": second_asset})
    assert second.status_code == 200

    dng = photo_by_name(client, album["id"], "ONLY")
    dng_path = root / "媒体" / "ONLY.DNG"
    dng_path.unlink()
    gone = client.get(f"/api/photos/{dng['id']}/thumbnail")
    assert gone.status_code == 404
    assert gone.json()["error"]["code"] == "ASSET_MISSING"
