"""路径安全：所有文件访问都必须经过这里。

规则：
- 不接受绝对路径作为目标；
- 拒绝 `..` 与空组件；
- 解析后的真实路径必须位于允许的根目录内；
- 资产读取额外拒绝符号链接（相册目录、照片文件、导出目标）；
- 导出只允许写入照片根目录内固定的精选目录。
"""

from __future__ import annotations

import os
from pathlib import Path

from .errors import ApiError, ErrorCode


class PathGuard:
    def __init__(self, root: Path, export_dir_name: str) -> None:
        self.root = root.resolve()
        self.export_dir_name = export_dir_name
        self.export_root = (self.root / export_dir_name).resolve()

    # -- 基础校验 ---------------------------------------------------------
    def _validate_relative(self, relative: str) -> Path:
        if not relative or "\x00" in relative:
            raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "路径为空，拒绝访问。", status_code=400)
        candidate = Path(relative)
        if candidate.is_absolute():
            raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "不接受绝对路径。", status_code=400)
        parts = candidate.parts
        if not parts or any(part in {"..", ".", ""} for part in parts):
            raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "路径包含非法片段。", status_code=400)
        return Path(*parts)

    def _ensure_within(self, real_path: Path, base: Path) -> None:
        try:
            real_path.relative_to(base)
        except ValueError as exc:
            raise ApiError(
                ErrorCode.PATH_OUTSIDE_ROOT,
                "路径超出允许范围，已拒绝。",
                status_code=403,
                details={"reason": "outside_root"},
            ) from exc

    def _ensure_no_symlink(self, path: Path, *, allow_missing_leaf: bool = True) -> None:
        """拒绝路径中任何一级符号链接（包括最后一级）。"""

        current = path
        while True:
            if current.exists() and current.is_symlink():
                raise ApiError(
                    ErrorCode.PATH_OUTSIDE_ROOT,
                    "路径包含符号链接，出于安全原因已拒绝。",
                    status_code=403,
                    details={"reason": "symlink"},
                )
            if current == self.root or current.parent == current:
                break
            current = current.parent
        if not allow_missing_leaf and not path.exists():
            raise ApiError(ErrorCode.ASSET_MISSING, "文件不存在。", status_code=404)

    # -- 相册与资产 -------------------------------------------------------
    def album_dir(self, relative_path: str, *, must_exist: bool = True) -> Path:
        rel = self._validate_relative(relative_path)
        if len(rel.parts) != 1:
            raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "相册必须是一级目录。", status_code=400)
        candidate = self.root / rel
        self._ensure_within(candidate.resolve(strict=False), self.root)
        self._ensure_no_symlink(candidate)
        if must_exist and not candidate.is_dir():
            raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册目录已不存在。", status_code=404)
        if candidate.name == self.export_dir_name:
            raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "精选导出目录不是源相册。", status_code=403)
        return candidate

    def asset_path(self, album_relative_path: str, asset_relative_path: str, *, must_exist: bool = True) -> Path:
        album_dir = self.album_dir(album_relative_path, must_exist=must_exist)
        rel = self._validate_relative(asset_relative_path)
        if len(rel.parts) > 2:
            # 只允许相册根目录或 RAW/JPG 一级子目录
            raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "资产路径层级超出允许范围。", status_code=403)
        candidate = album_dir / rel
        self._ensure_within(candidate.resolve(strict=False), self.root)
        self._ensure_no_symlink(candidate)
        if must_exist:
            self._ensure_regular_file(candidate)
        return candidate

    def _ensure_regular_file(self, path: Path) -> None:
        if not path.exists():
            raise ApiError(ErrorCode.ASSET_MISSING, "文件已不存在。", status_code=404)
        if not path.is_file() or path.is_symlink():
            raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "目标不是普通文件。", status_code=403)

    def export_dir_for_album(self, album_relative_path: str) -> Path:
        rel = self._validate_relative(album_relative_path)
        if len(rel.parts) != 1:
            raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "相册名非法。", status_code=400)
        export_root = self.export_root
        # 导出目录可能尚未创建；校验其父目录仍在根目录内。
        self._ensure_within(export_root, self.root)
        return export_root / rel

    def export_file_path(
        self,
        album_relative_path: str,
        kind_dir: str,
        filename: str,
        *,
        must_exist: bool = False,
    ) -> Path:
        if kind_dir not in {"JPG", "RAW"}:
            raise ApiError(ErrorCode.INVALID_REQUEST, "导出子目录只能是 JPG 或 RAW。", status_code=400)
        rel_album = self._validate_relative(album_relative_path)
        if len(rel_album.parts) != 1:
            raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "相册名非法。", status_code=400)
        if not filename or "/" in filename or "\\" in filename or filename in {".", ".."}:
            raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "导出文件名非法。", status_code=400)
        # 精选目录本身必须是根目录内的真实目录（若被替换成符号链接则拒绝）。
        self._ensure_within(self.export_root, self.root)
        candidate = self.export_root / rel_album / kind_dir / filename
        self._ensure_within(candidate.parent.resolve(strict=False), self.export_root)
        self._ensure_no_symlink(candidate, allow_missing_leaf=True)
        if must_exist and not candidate.is_file():
            raise ApiError(ErrorCode.ASSET_MISSING, "导出目标不存在。", status_code=404)
        return candidate

    def ensure_still_inside(self, path: Path, *, base: Path | None = None) -> None:
        real = path.resolve(strict=False)
        self._ensure_within(real, (base or self.root).resolve())

    def is_inside_root(self, path: Path) -> bool:
        try:
            path.resolve(strict=False).relative_to(self.root)
            return True
        except ValueError:
            return False


def stat_signature(path: Path) -> tuple[int, int]:
    st = os.stat(path, follow_symlinks=False)
    return st.st_size, st.st_mtime_ns
