"""macOS 原生废纸篓接口。

- 只使用 NSFileManager.trashItemAtURL:resultingItemURL:error:；
- 持久化 API 返回的实际废纸篓位置，绝不猜测 ~/.Trash/文件名；
- 恢复只允许使用登记过的废纸篓位置，且不覆盖原路径已有文件；
- 没有原生能力时返回不可用，绝不退化为永久删除。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class TrashResult:
    ok: bool
    trashed_path: Path | None = None
    error_code: str | None = None
    error_message: str | None = None


@dataclass
class RestoreResult:
    ok: bool
    restored_path: Path | None = None
    error_code: str | None = None
    error_message: str | None = None


class BaseTrashService:
    available: bool = False
    unavailable_reason: str = "当前平台不支持 macOS 原生废纸篓。"
    backend: str = "unavailable"

    def capabilities(self) -> dict:
        return {
            "available": self.available,
            "backend": self.backend,
            "reason": None if self.available else self.unavailable_reason,
        }

    def trash(self, path: Path) -> TrashResult:
        # 没有原生废纸篓能力时明确失败，绝不退化为永久删除。
        return TrashResult(
            False,
            error_code="DEPENDENCY_UNAVAILABLE",
            error_message=self.unavailable_reason,
        )

    def restore(self, trashed_path: Path, original_path: Path) -> RestoreResult:
        return RestoreResult(
            False,
            error_code="DEPENDENCY_UNAVAILABLE",
            error_message=self.unavailable_reason,
        )

    def is_in_trash(self, path: Path) -> bool:
        return False


class MacOSTrashService(BaseTrashService):
    backend = "NSFileManager.trashItemAtURL"

    def __init__(self, photo_root: Path | None = None) -> None:
        self.photo_root = photo_root.resolve() if photo_root is not None else None
        self._file_manager = None
        self._nsurl = None
        try:
            from AppKit import NSFileManager
            from Foundation import NSURL
        except Exception as exc:  # noqa: BLE001 - 依赖缺失时保持不可用
            self.available = False
            self.unavailable_reason = f"PyObjC 不可用：{exc}"
            return
        if sys.platform != "darwin":
            self.available = False
            self.unavailable_reason = "仅 macOS 支持原生废纸篓。"
            return
        self._file_manager = NSFileManager.defaultManager()
        self._nsurl = NSURL
        if not self._file_manager.respondsToSelector_("trashItemAtURL:resultingItemURL:error:"):
            self.available = False
            self.unavailable_reason = "当前系统缺少 trashItemAtURL 接口。"
            return
        self.available = True
        self.unavailable_reason = ""

    @property
    def trash_directory(self) -> Path:
        return Path.home() / ".Trash"

    def _inside_photo_root(self, path: Path) -> bool:
        if self.photo_root is None:
            return False
        try:
            path.resolve().relative_to(self.photo_root)
            return True
        except ValueError:
            return False

    def is_in_trash(self, path: Path) -> bool:
        """原生 API 返回的位置：用户废纸篓、外接卷 .Trashes，或根目录之外的受控位置。"""

        if path is None or path.is_symlink() or not path.exists():
            return False
        parts = {part.lower() for part in path.resolve().parts}
        if ".trash" in parts or ".trashes" in parts:
            return True
        # 外接卷等系统选择的位置：只要不由照片根目录内的文件冒充即可。
        return self.photo_root is not None and not self._inside_photo_root(path)

    def trash(self, path: Path) -> TrashResult:
        if not self.available:
            return TrashResult(False, error_code="DEPENDENCY_UNAVAILABLE", error_message=self.unavailable_reason)
        if not path.exists() or path.is_symlink() or not path.is_file():
            return TrashResult(
                False,
                error_code="ASSET_MISSING",
                error_message="文件不存在、不是普通文件或为符号链接，拒绝移入废纸篓。",
            )
        try:
            result = self._file_manager.trashItemAtURL_resultingItemURL_error_(
                self._nsurl.fileURLWithPath_(str(path)), None, None
            )
        except Exception as exc:  # noqa: BLE001 - 原生异常转为明确错误
            return TrashResult(False, error_code="TRASH_OPERATION_FAILED", error_message=str(exc)[:1000])
        ok, resulting_url, error = result
        if not ok or resulting_url is None:
            message = str(error) if error is not None else "系统未返回废纸篓位置。"
            return TrashResult(False, error_code="TRASH_OPERATION_FAILED", error_message=message[:1000])
        trashed_path = Path(resulting_url.path())
        if not trashed_path.exists() or trashed_path.is_symlink() or not trashed_path.is_file():
            return TrashResult(
                False,
                error_code="TRASH_OPERATION_FAILED",
                error_message="系统返回的废纸篓位置无效或文件不存在，已停止后续操作。",
            )
        if self._inside_photo_root(trashed_path):
            return TrashResult(
                False,
                error_code="TRASH_OPERATION_FAILED",
                error_message="系统返回的废纸篓位置仍在照片根目录内，已停止后续操作。",
            )
        return TrashResult(True, trashed_path=trashed_path)

    def restore(self, trashed_path: Path, original_path: Path) -> RestoreResult:
        if not self.available:
            return RestoreResult(False, error_code="DEPENDENCY_UNAVAILABLE", error_message=self.unavailable_reason)
        if not self.is_in_trash(trashed_path):
            return RestoreResult(
                False,
                error_code="RESTORE_FAILED",
                error_message="记录的废纸篓位置不在用户废纸篓目录内，拒绝恢复。",
            )
        if trashed_path.is_symlink() or not trashed_path.is_file():
            return RestoreResult(
                False, error_code="ASSET_MISSING", error_message="废纸篓中的文件已不存在（可能已被清空）。"
            )
        if original_path.exists() or original_path.is_symlink():
            return RestoreResult(False, error_code="DESTINATION_CONFLICT", error_message="原路径已有文件，拒绝覆盖。")
        try:
            move_result = self._file_manager.moveItemAtURL_toURL_error_(
                self._nsurl.fileURLWithPath_(str(trashed_path)),
                self._nsurl.fileURLWithPath_(str(original_path)),
                None,
            )
        except Exception as exc:  # noqa: BLE001
            return RestoreResult(False, error_code="RESTORE_FAILED", error_message=str(exc)[:1000])
        ok, error = move_result
        if not ok:
            message = str(error) if error is not None else "恢复移动失败。"
            return RestoreResult(False, error_code="RESTORE_FAILED", error_message=message[:1000])
        if not original_path.exists():
            return RestoreResult(
                False,
                error_code="RESTORE_FAILED",
                error_message="系统报告移动成功，但原路径文件不存在，请核对。",
            )
        return RestoreResult(True, restored_path=original_path)


def create_trash_service(photo_root: Path | None = None) -> BaseTrashService:
    if sys.platform == "darwin":
        return MacOSTrashService(photo_root=photo_root)
    return BaseTrashService()
