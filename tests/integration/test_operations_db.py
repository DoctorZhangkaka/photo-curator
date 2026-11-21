"""数据库、迁移、操作记录、健康检查与设置测试（LOG 用例）。"""

from __future__ import annotations

import uuid

from photo_curator.db import Database
from photo_curator.operations import recover_interrupted_operations
from sqlalchemy import text

from tests.conftest import get_album, photo_by_name, rescan, set_state
from tests.fakes import install_fake_trash
from tests.fixtures.generate import create_demo_root, make_jpeg


def test_migrations_are_versioned_and_idempotent(make_settings):
    settings = make_settings()
    database = Database.create(settings.db_path)
    with database.engine.connect() as connection:
        versions = [
            row[0] for row in connection.execute(text("SELECT version FROM schema_migrations ORDER BY version"))
        ]
        assert versions == [1, 2]
        mode = connection.execute(text("PRAGMA journal_mode")).scalar()
        assert str(mode).lower() == "wal"
        fk = connection.execute(text("PRAGMA foreign_keys")).scalar()
        assert int(fk) == 1
        indexes = {row[0] for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='index'"))}
        assert "ix_operations_type_status" in indexes
        assert "ix_assets_relative_path" in indexes
    database.dispose()

    # 再次打开不会重复执行迁移，也不会丢数据
    database2 = Database.create(settings.db_path)
    with database2.engine.connect() as connection:
        count = connection.execute(text("SELECT COUNT(*) FROM schema_migrations")).scalar()
        assert count == 2
    database2.dispose()


def test_recover_interrupted_operations(make_settings):
    from photo_curator.models import Operation

    settings = make_settings()
    database = Database.create(settings.db_path)
    with database.session() as session:
        operation = Operation(type="cleanup", status="executing", requested_at="2026-11-22T00:00:00.000Z")
        session.add(operation)
        session.commit()
        operation_id = operation.id
    with database.session() as session:
        assert recover_interrupted_operations(session) == 1
    with database.session() as session:
        recovered = session.get(Operation, operation_id)
        assert recovered.status == "interrupted"
        assert "核对" in recovered.error_summary
    database.dispose()


def test_cleanup_operation_items_survive_rescan(open_client, tmp_path):
    root = tmp_path / "相册"
    create_demo_root(root)
    client, settings, app = open_client(root)
    install_fake_trash(app, tmp_path / "fake-trash")
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "测试-京都旅行")
    rescan(client, csrf, album["id"])
    photo = photo_by_name(client, album["id"], "DSCF0002")
    set_state(client, csrf, photo, selection="pending_delete")
    preflight = client.post(f"/api/albums/{album['id']}/cleanup/preflight", headers=csrf).json()
    response = client.post(
        f"/api/albums/{album['id']}/cleanup/execute",
        json={"preflightToken": preflight["token"], "idempotencyKey": str(uuid.uuid4())},
        headers=csrf,
    )
    operation_id = response.json()["operation"]["id"]
    before = client.get(f"/api/operations/{operation_id}").json()["operation"]
    assert before["items"][0]["result"] == "success"

    rescan(client, csrf, album["id"])
    after = client.get(f"/api/operations/{operation_id}").json()["operation"]
    assert [item["id"] for item in after["items"]] == [item["id"] for item in before["items"]]
    assert after["items"][0]["result"] == "success"
    assert after["successFileCount"] == 1


def test_operations_filters_and_validation(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "记录"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "记录")
    rescan(client, csrf, album["id"])

    operations = client.get("/api/operations", params={"type": "scan"}).json()
    assert operations["total"] >= 1
    assert all(item["type"] == "scan" for item in operations["items"])
    assert operations["items"][0]["albumName"] == "记录"
    assert operations["items"][0]["status"] == "success"

    by_album = client.get("/api/operations", params={"albumId": album["id"]}).json()
    assert by_album["total"] >= 1
    no_match = client.get("/api/operations", params={"albumId": str(uuid.uuid4())}).json()
    assert no_match["total"] == 0

    assert client.get("/api/operations", params={"type": "bogus"}).status_code == 400
    assert client.get("/api/operations", params={"status": "bogus"}).status_code == 400
    assert client.get("/api/operations", params={"from": "not-a-time"}).status_code == 400
    assert client.get("/api/operations", params={"from": "2999-01-01T00:00:00Z"}).json()["total"] == 0

    assert client.get("/api/operations/does-not-exist").status_code == 404


def test_scan_operation_records_report(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "扫描记录"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "扫描记录")
    rescan(client, csrf, album["id"])
    operations = client.get("/api/operations", params={"type": "scan"}).json()["items"]
    assert operations
    detail = client.get(f"/api/operations/{operations[0]['id']}").json()["operation"]
    assert detail["requestSnapshot"]["report"]["fileCount"] == 1
    assert detail["requestSnapshot"]["trigger"] == "manual"


def test_settings_roundtrip(open_client, tmp_path):
    root = tmp_path / "相册"
    root.mkdir()
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    initial = client.get("/api/settings").json()["settings"]
    assert initial == {"defaultSort": "capture", "autoplayInterval": 3, "cleanupNoticeSeen": False}

    updated = client.patch(
        "/api/settings",
        json={"defaultSort": "filename", "autoplayInterval": 5, "cleanupNoticeSeen": True},
        headers=csrf,
    )
    assert updated.status_code == 200
    assert updated.json()["settings"] == {
        "defaultSort": "filename",
        "autoplayInterval": 5,
        "cleanupNoticeSeen": True,
    }
    config = client.get("/api/config").json()
    assert config["defaults"]["sort"] == "filename"
    assert config["defaults"]["autoplayInterval"] == 5

    invalid = client.patch("/api/settings", json={"autoplayInterval": 7}, headers=csrf)
    assert invalid.status_code == 400
    unknown = client.patch("/api/settings", json={"photoRoot": "/etc"}, headers=csrf)
    assert unknown.status_code == 400


def test_health_reports_dependencies(open_client, tmp_path):
    root = tmp_path / "相册"
    root.mkdir()
    client, _, _ = open_client(root)
    health = client.get("/api/health").json()
    assert health["database"]["ok"] is True
    assert health["photoRoot"]["exists"] is True
    assert health["photoRoot"]["readable"] is True
    assert health["exportDirectory"]["creatable"] is True
    assert health["dependencies"]["rawpy"]["available"] is True
    assert "exiftool" in health["dependencies"]
    assert "trash" in health["dependencies"]
    assert health["version"] == "0.1.0"
    assert client.get("/api/config").json()["exportDirName"] == "精选原相册"
    assert client.get("/api/session").json()["token"] == health_session_token(client)


def health_session_token(client) -> str:
    return client.app.state.context.settings.session_token


def test_production_static_serving_and_spa_fallback(open_client, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><body><div id="root"></div>'
        '<script type="module" src="/assets/app.js"></script></body></html>',
        encoding="utf-8",
    )
    (dist / "assets" / "app.js").write_text("console.log('photo-curator');\n", encoding="utf-8")

    client, _, _ = open_client(tmp_path / "相册", web_dist=dist, serve_static=True)
    index = client.get("/")
    assert index.status_code == 200
    assert "root" in index.text
    assert "Content-Security-Policy" in index.headers
    assert index.headers["Cache-Control"] == "no-store"

    deep_link = client.get("/albums/not-a-real-id")
    assert deep_link.status_code == 200
    assert "root" in deep_link.text

    asset = client.get("/assets/app.js")
    assert asset.status_code == 200
    assert "photo-curator" in asset.text

    unknown_api = client.get("/api/does-not-exist")
    assert unknown_api.status_code == 404
    assert unknown_api.json()["error"]["code"] == "NOT_FOUND"
