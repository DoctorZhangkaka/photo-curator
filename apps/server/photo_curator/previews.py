"""JPG / RAW 预览生成与磁盘缓存。

缓存位置：应用数据目录（绝不写入源相册）。
缓存键包含：相册相对路径、资产相对路径、文件大小、mtime、规格，文件变化会自动失效。
RAW 解码并发受限（默认 2），同一缓存键并发请求只解码一次。
"""

from __future__ import annotations

import hashlib
import os
import threading
from pathlib import Path

from .config import Settings
from .constants import JPG_EXTENSIONS, PREVIEW_FAILED, PREVIEW_OK, RAW_EXTENSIONS
from .errors import ApiError, ErrorCode
from .models import Album, Asset
from .paths import PathGuard


class PreviewService:
    def __init__(self, settings: Settings, guard: PathGuard) -> None:
        self.settings = settings
        self.guard = guard
        self.cache_dir = settings.preview_cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._raw_semaphore = threading.BoundedSemaphore(settings.preview_concurrency)

    def _lock_for(self, key: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    def cache_path(self, album: Album, asset: Asset, spec: str) -> tuple[Path, str]:
        digest = hashlib.sha256(
            f"v1|{album.relative_path}|{asset.relative_path}|{asset.size_bytes}|{asset.mtime_ns}|{spec}".encode()
        ).hexdigest()[:40]
        return self.cache_dir / f"{spec}-{digest}.jpg", digest

    def _edge_for(self, spec: str) -> int:
        return self.settings.thumbnail_edge if spec == "thumb" else self.settings.preview_edge

    def get_or_create(self, album: Album, asset: Asset, spec: str) -> tuple[Path, str, bool]:
        """返回 (缓存文件路径, 指纹, 是否命中缓存)。"""

        if spec not in {"thumb", "preview"}:
            raise ApiError(ErrorCode.INVALID_REQUEST, "不支持的预览规格。", status_code=400)
        source = self.guard.asset_path(album.relative_path, asset.relative_path, must_exist=True)
        extension = asset.extension.lower()
        if extension not in JPG_EXTENSIONS and extension not in RAW_EXTENSIONS:
            raise ApiError(ErrorCode.UNSUPPORTED_FILE_TYPE, "不支持的文件格式。", status_code=415)

        target, digest = self.cache_path(album, asset, spec)
        if target.is_file():
            return target, digest, True
        lock = self._lock_for(digest)
        with lock:
            if target.is_file():
                return target, digest, True
            temporary = target.with_name(f"{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
            try:
                if extension in JPG_EXTENSIONS:
                    self._render_jpg(source, temporary, self._edge_for(spec))
                else:
                    with self._raw_semaphore:
                        self._render_raw(source, temporary, self._edge_for(spec))
                os.replace(temporary, target)
            except ApiError:
                temporary.unlink(missing_ok=True)
                raise
            except Exception as exc:  # noqa: BLE001 - 解码失败需要转成明确错误
                temporary.unlink(missing_ok=True)
                code = ErrorCode.RAW_PREVIEW_UNAVAILABLE if extension in RAW_EXTENSIONS else ErrorCode.PREVIEW_FAILED
                raise ApiError(
                    code,
                    "RAW 预览生成失败，请检查文件是否完整或安装 LibRaw 依赖。"
                    if extension in RAW_EXTENSIONS
                    else "预览生成失败，文件可能已损坏。",
                    status_code=422,
                    details={"reason": str(exc)[:500]},
                ) from exc
        return target, digest, False

    def mark_result(self, asset: Asset, *, ok: bool, error: str | None = None) -> None:
        asset.preview_status = PREVIEW_OK if ok else PREVIEW_FAILED
        asset.preview_error = None if ok else (error or "")[:1000]

    @staticmethod
    def _save_jpeg(image, destination: Path, edge: int) -> None:  # noqa: ANN001
        from PIL import Image, ImageOps

        image = ImageOps.exif_transpose(image)
        image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        if image.mode not in {"RGB", "L"}:
            image = image.convert("RGB")
        image.save(destination, format="JPEG", quality=84, optimize=True)

    def _render_jpg(self, source: Path, destination: Path, edge: int) -> None:
        from PIL import Image

        with Image.open(source) as image:
            image.load()
            self._save_jpeg(image, destination, edge)

    def _render_raw(self, source: Path, destination: Path, edge: int) -> None:
        import rawpy
        from PIL import Image

        with rawpy.imread(str(source)) as raw:
            rgb = raw.postprocess(
                use_camera_wb=True,
                half_size=True,
                no_auto_bright=False,
                output_bps=8,
            )
        image = Image.fromarray(rgb)
        self._save_jpeg(image, destination, edge)

    def prune(self, keep: set[str] | None = None) -> int:
        """删除不再被引用的旧缓存；仅操作应用自己的缓存目录。"""

        removed = 0
        for entry in self.cache_dir.glob("*.jpg"):
            if keep is not None and entry.name in keep:
                continue
            try:
                entry.unlink()
                removed += 1
            except OSError:
                continue
        return removed
