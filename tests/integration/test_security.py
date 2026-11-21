"""安全边界测试（SEC-001 ~ SEC-010）。"""

from __future__ import annotations

import uuid

from tests.conftest import get_album, photo_by_name, rescan, set_state
from tests.fixtures.generate import create_demo_root, make_jpeg


def test_mutating_endpoint_requires_token(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "安全"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    client, settings, _ = open_client(root)
    album = get_album(client, "安全")

    response = client.post(f"/api/albums/{album['id']}/rescan")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"

    wrong = client.post(f"/api/albums/{album['id']}/rescan", headers={"X-CSRF-Token": "wrong-token"})
    assert wrong.status_code == 401


def test_cross_origin_rejected(open_client, tmp_path):
    root = tmp_path / "相册"
    root.mkdir()
    client, _, _ = open_client(root)
    response = client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN_ORIGIN"
    allowed = client.get("/api/health", headers={"Origin": "http://127.0.0.1:7100"})
    assert allowed.status_code == 200


def test_bad_host_rejected(open_client, tmp_path):
    root = tmp_path / "相册"
    root.mkdir()
    client, _, _ = open_client(root)
    response = client.get("/api/health", headers={"Host": "evil.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN_HOST"


def test_cors_headers_absent(open_client, tmp_path):
    root = tmp_path / "相册"
    root.mkdir()
    client, _, _ = open_client(root)
    response = client.get("/api/health", headers={"Origin": "http://127.0.0.1:7100"})
    assert "access-control-allow-origin" not in {key.lower() for key in response.headers}


def test_forged_cleanup_preflight_token_rejected(open_client, tmp_path):
    root = tmp_path / "相册"
    create_demo_root(root)
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "测试-京都旅行")
    rescan(client, csrf, album["id"])
    photo = photo_by_name(client, album["id"], "DSCF0002")
    set_state(client, csrf, photo, selection="pending_delete")

    response = client.post(
        f"/api/albums/{album['id']}/cleanup/execute",
        json={"preflightToken": "forged-token-value", "idempotencyKey": str(uuid.uuid4())},
        headers=csrf,
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "PREFLIGHT_INVALID"


def test_expired_cleanup_preflight_token_rejected(open_client, tmp_path):
    root = tmp_path / "相册"
    create_demo_root(root)
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "测试-京都旅行")
    rescan(client, csrf, album["id"])
    photo = photo_by_name(client, album["id"], "DSCF0002")
    set_state(client, csrf, photo, selection="pending_delete")
    preflight = client.post(f"/api/albums/{album['id']}/cleanup/preflight", headers=csrf).json()

    from photo_curator.db import Database
    from photo_curator.models import PreflightToken

    database = Database.create(settings.db_path)
    with database.session() as session:
        token = session.query(PreflightToken).filter_by(kind="cleanup").first()
        token.expires_at = "2000-01-01T00:00:00.000Z"
        session.commit()
    database.dispose()

    response = client.post(
        f"/api/albums/{album['id']}/cleanup/execute",
        json={"preflightToken": preflight["token"], "idempotencyKey": str(uuid.uuid4())},
        headers=csrf,
    )
    assert response.status_code == 410
    assert response.json()["error"]["code"] == "PREFLIGHT_EXPIRED"


def test_unsupported_extension_in_database_is_rejected(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "篡改"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    client, settings, app = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "篡改")
    rescan(client, csrf, album["id"])
    photo = photo_by_name(client, album["id"], "A")
    set_state(client, csrf, photo, selection="pending_delete")
    preflight = client.post(f"/api/albums/{album['id']}/cleanup/preflight", headers=csrf).json()
    assert preflight["blocked"] is False

    from tests.fakes import install_fake_trash

    fake = install_fake_trash(app, tmp_path / "fake-trash")
    from photo_curator.db import Database
    from photo_curator.models import Asset

    database = Database.create(settings.db_path)
    with database.session() as session:
        asset = session.query(Asset).first()
        asset.extension = ".txt"
        session.commit()
    database.dispose()

    response = client.post(
        f"/api/albums/{album['id']}/cleanup/execute",
        json={"preflightToken": preflight["token"], "idempotencyKey": str(uuid.uuid4())},
        headers=csrf,
    )
    assert response.status_code == 409
    reasons = response.json()["error"]["details"]["reasons"]
    assert any(reason["code"] == "UNSUPPORTED_FILE_TYPE" for reason in reasons)
    assert fake.trash_calls == []
    assert (album_dir / "A.JPG").exists()


def test_operation_logs_do_not_contain_session_token(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "日志"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "日志")
    rescan(client, csrf, album["id"])
    operations = client.get("/api/operations").json()
    serialized = str(operations)
    assert settings.session_token not in serialized
    assert "token" not in serialized.lower()


def test_default_bind_is_loopback(monkeypatch):
    from photo_curator.config import Settings

    monkeypatch.delenv("PHOTO_CURATOR_HOST", raising=False)
    monkeypatch.delenv("PHOTO_CURATOR_WEB_HOST", raising=False)
    settings = Settings.load()
    assert settings.api_host == "127.0.0.1"
    assert settings.web_host == "127.0.0.1"


def test_media_requires_no_token_but_rejects_missing_asset(open_client, tmp_path):
    root = tmp_path / "相册"
    album_dir = root / "媒体"
    album_dir.mkdir(parents=True)
    make_jpeg(album_dir / "A.JPG")
    client, settings, _ = open_client(root)
    csrf = {"X-CSRF-Token": settings.session_token}
    album = get_album(client, "媒体")
    rescan(client, csrf, album["id"])
    photo = photo_by_name(client, album["id"], "A")
    ok = client.get(photo["thumbnailUrl"])
    assert ok.status_code == 200
    (album_dir / "A.JPG").unlink()
    missing = client.get(photo["thumbnailUrl"])
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "ASSET_MISSING"
