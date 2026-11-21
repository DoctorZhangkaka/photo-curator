"""pytest 共享夹具。

硬性约束：
- 自动化测试绝不使用真实相册目录；
- 所有根目录指向 pytest 临时目录；
- 默认导入 main 时使用的应用数据目录也放在 tests/.tmp，避免污染仓库。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
IMPORT_TMP = TESTS_DIR / ".tmp"

os.environ.setdefault("PHOTO_CURATOR_ROOT", str(IMPORT_TMP / "import-default-root"))
os.environ.setdefault("PHOTO_CURATOR_DATA_DIR", str(IMPORT_TMP / "import-default-data"))
os.environ.setdefault("PHOTO_CURATOR_STARTUP_SCAN", "0")
os.environ.setdefault("PHOTO_CURATOR_ALLOWED_HOSTS", "testserver,127.0.0.1,localhost")
os.environ.setdefault("PHOTO_CURATOR_SESSION_TOKEN", "test-session-token-for-pytest")
os.environ.setdefault("PHOTO_CURATOR_EXIFTOOL", "")

from fastapi.testclient import TestClient  # noqa: E402
from photo_curator.config import Settings  # noqa: E402
from photo_curator.main import create_app  # noqa: E402

TEST_TOKEN = "test-session-token-for-pytest"


@pytest.fixture
def make_settings(tmp_path: Path):
    def _make(photo_root: Path | None = None, **overrides) -> Settings:
        root = photo_root or (tmp_path / "相册")
        root.mkdir(parents=True, exist_ok=True)
        data_dir = tmp_path / "data"
        values = {
            "photo_root": root.resolve(),
            "data_dir": data_dir.resolve(),
            "session_token": TEST_TOKEN,
            "allowed_hosts": ("testserver", "127.0.0.1", "localhost"),
            "allowed_origins": (
                "http://testserver",
                "http://127.0.0.1:7100",
                "http://localhost:7100",
            ),
            "startup_scan": False,
            "testing": True,
            "serve_static": False,
            "scan_debounce_ms": 100,
        }
        values.update(overrides)
        return Settings(**values)

    return _make


@pytest.fixture
def settings(make_settings) -> Settings:
    return make_settings()


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
def client(app):
    with TestClient(app, base_url="http://testserver") as test_client:
        yield test_client


@pytest.fixture
def csrf() -> dict[str, str]:
    return {"X-CSRF-Token": TEST_TOKEN}


@pytest.fixture
def context(app, client):
    return app.state.context


def get_album(client: TestClient, name: str) -> dict:
    response = client.get("/api/albums")
    assert response.status_code == 200, response.text
    for album in response.json()["albums"]:
        if album["name"] == name:
            return album
    raise AssertionError(f"album not found: {name}")


def rescan(client: TestClient, csrf: dict[str, str], album_id: str) -> dict:
    response = client.post(f"/api/albums/{album_id}/rescan", headers=csrf)
    assert response.status_code == 200, response.text
    return response.json()


def fetch_photos(client: TestClient, album_id: str, **params) -> dict:
    response = client.get(f"/api/albums/{album_id}/photos", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def photo_by_name(client: TestClient, album_id: str, display_name: str) -> dict:
    payload = fetch_photos(client, album_id, limit=500)
    for item in payload["items"]:
        if item["displayName"] == display_name:
            return item
    raise AssertionError(f"photo not found: {display_name}")


def set_state(
    client: TestClient,
    csrf: dict[str, str],
    photo: dict,
    *,
    viewed: str | None = None,
    selection: str | None = None,
) -> dict:
    body: dict = {"version": photo["version"]}
    if viewed is not None:
        body["viewedStatus"] = viewed
    if selection is not None:
        body["selectionStatus"] = selection
    response = client.patch(f"/api/photos/{photo['id']}/state", json=body, headers=csrf)
    assert response.status_code == 200, response.text
    return response.json()["photo"]


def preflight_cleanup(client: TestClient, csrf: dict[str, str], album_id: str) -> dict:
    response = client.post(f"/api/albums/{album_id}/cleanup/preflight", headers=csrf)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def open_client(make_settings):
    """按自定义照片根目录创建应用与 TestClient，退出时关闭。"""
    opened: list[TestClient] = []

    def _open(photo_root: Path | None = None, **overrides):
        settings = make_settings(photo_root, **overrides)
        app = create_app(settings)
        client = TestClient(app, base_url="http://testserver")
        client.__enter__()
        opened.append(client)
        return client, settings, app

    yield _open
    for test_client in opened:
        test_client.__exit__(None, None, None)
