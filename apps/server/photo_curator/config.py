"""应用配置：全部来自环境变量，不含任何密钥硬编码。

生产默认值面向用户本机（照片根目录 ~/Desktop/相册，仅监听回环地址）。
测试通过 PHOTO_CURATOR_ROOT 指向临时目录。
"""

from __future__ import annotations

import os
import secrets
import shutil
from dataclasses import dataclass, field
from pathlib import Path

APP_VERSION = "0.5.0"
DEFAULT_PHOTO_ROOT = Path.home() / "Desktop" / "相册"
DEFAULT_EXPORT_DIR_NAME = "精选原相册"
PROJECT_ROOT = Path(__file__).resolve().parents[3]

# 可选 .env（已被 gitignore）；不会覆盖已存在的环境变量。
try:
    from dotenv import load_dotenv

    _env_file = PROJECT_ROOT / ".env"
    if _env_file.is_file():
        load_dotenv(_env_file, override=False)
except ImportError:  # pragma: no cover - 依赖已声明
    pass


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return Path(raw).expanduser()


def _parse_list(raw: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in raw.split(",") if item.strip())


def _load_or_create_session_token(data_dir: Path) -> str:
    """读取或生成本地会话令牌。令牌只保存在应用数据目录（权限 0600）。"""

    env_token = os.environ.get("PHOTO_CURATOR_SESSION_TOKEN")
    if env_token:
        return env_token
    data_dir.mkdir(parents=True, exist_ok=True)
    token_file = data_dir / "session-token"
    if token_file.exists():
        token = token_file.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(32)
    token_file.write_text(token + "\n", encoding="utf-8")
    token_file.chmod(0o600)
    return token


@dataclass(frozen=True)
class Settings:
    photo_root: Path
    data_dir: Path
    export_dir_name: str = DEFAULT_EXPORT_DIR_NAME
    api_host: str = "127.0.0.1"
    api_port: int = 8765
    web_host: str = "127.0.0.1"
    web_port: int = 7100
    session_token: str = ""
    allowed_hosts: tuple[str, ...] = ("127.0.0.1", "localhost", "::1")
    allowed_origins: tuple[str, ...] = ()
    preview_concurrency: int = 2
    thumbnail_edge: int = 512
    preview_edge: int = 2560
    preflight_ttl_seconds: int = 300
    export_preflight_ttl_seconds: int = 900
    scan_debounce_ms: int = 700
    job_workers: int = 2
    exiftool_path: str | None = None
    web_dist: Path | None = None
    serve_static: bool = True
    startup_scan: bool = True
    testing: bool = False
    extra: dict = field(default_factory=dict)

    @classmethod
    def load(cls) -> Settings:
        data_dir = _env_path("PHOTO_CURATOR_DATA_DIR", PROJECT_ROOT / "data").resolve()
        photo_root = _env_path("PHOTO_CURATOR_ROOT", DEFAULT_PHOTO_ROOT).resolve()
        web_port = _env_int("PHOTO_CURATOR_WEB_PORT", 7100)
        api_port = _env_int("PHOTO_CURATOR_PORT", 8765)
        api_host = os.environ.get("PHOTO_CURATOR_HOST", "127.0.0.1")
        web_host = os.environ.get("PHOTO_CURATOR_WEB_HOST", "127.0.0.1")
        allowed_hosts = _parse_list(os.environ.get("PHOTO_CURATOR_ALLOWED_HOSTS", "127.0.0.1,localhost,::1"))
        default_origins = (
            f"http://127.0.0.1:{web_port}",
            f"http://localhost:{web_port}",
            f"http://127.0.0.1:{api_port}",
            f"http://localhost:{api_port}",
        )
        origins = default_origins + _parse_list(os.environ.get("PHOTO_CURATOR_ALLOWED_ORIGINS", ""))
        exiftool = os.environ.get("PHOTO_CURATOR_EXIFTOOL") or shutil.which("exiftool")
        web_dist = _env_path("PHOTO_CURATOR_WEB_DIST", PROJECT_ROOT / "apps/web/dist")
        return cls(
            photo_root=photo_root,
            data_dir=data_dir,
            export_dir_name=os.environ.get("PHOTO_CURATOR_EXPORT_DIR_NAME", DEFAULT_EXPORT_DIR_NAME).strip()
            or DEFAULT_EXPORT_DIR_NAME,
            api_host=api_host,
            api_port=api_port,
            web_host=web_host,
            web_port=web_port,
            session_token=_load_or_create_session_token(data_dir),
            allowed_hosts=allowed_hosts,
            allowed_origins=tuple(dict.fromkeys(origins)),
            preview_concurrency=max(1, _env_int("PHOTO_CURATOR_PREVIEW_CONCURRENCY", 2)),
            thumbnail_edge=max(128, _env_int("PHOTO_CURATOR_THUMBNAIL_EDGE", 512)),
            preview_edge=max(512, _env_int("PHOTO_CURATOR_PREVIEW_EDGE", 2560)),
            preflight_ttl_seconds=max(30, _env_int("PHOTO_CURATOR_PREFLIGHT_TTL", 300)),
            export_preflight_ttl_seconds=max(30, _env_int("PHOTO_CURATOR_EXPORT_PREFLIGHT_TTL", 900)),
            scan_debounce_ms=max(50, _env_int("PHOTO_CURATOR_SCAN_DEBOUNCE_MS", 700)),
            job_workers=max(1, _env_int("PHOTO_CURATOR_JOB_WORKERS", 2)),
            exiftool_path=exiftool,
            web_dist=web_dist,
            serve_static=_env_bool("PHOTO_CURATOR_SERVE_STATIC", True),
            startup_scan=_env_bool("PHOTO_CURATOR_STARTUP_SCAN", True),
            testing=_env_bool("PHOTO_CURATOR_TESTING", False),
        )

    @property
    def db_path(self) -> Path:
        return self.data_dir / "photo-curator.sqlite3"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def preview_cache_dir(self) -> Path:
        return self.cache_dir / "previews"

    @property
    def export_root(self) -> Path:
        # 导出目录固定在照片根目录内，绝不接受任意绝对路径。
        return self.photo_root / self.export_dir_name

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.preview_cache_dir.mkdir(parents=True, exist_ok=True)
