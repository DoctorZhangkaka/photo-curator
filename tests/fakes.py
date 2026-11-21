"""测试用假废纸篓：只在临时目录内移动文件，便于故障注入。"""

from __future__ import annotations

import shutil
from pathlib import Path

from photo_curator.trash import BaseTrashService, RestoreResult, TrashResult


class FakeTrashService(BaseTrashService):
    available = True
    backend = "fake-test-trash"

    def __init__(self, trash_dir: Path) -> None:
        self.trash_dir = trash_dir
        self.trash_dir.mkdir(parents=True, exist_ok=True)
        self.fail_trash_names: set[str] = set()
        self.fail_restore_names: set[str] = set()
        self.trash_calls: list[Path] = []
        self.restore_calls: list[tuple[Path, Path]] = []

    def is_in_trash(self, path: Path) -> bool:
        try:
            Path(path).resolve().relative_to(self.trash_dir.resolve())
            return True
        except ValueError:
            return False

    def trash(self, path: Path) -> TrashResult:
        self.trash_calls.append(path)
        if path.name in self.fail_trash_names:
            return TrashResult(
                False,
                error_code="TRASH_OPERATION_FAILED",
                error_message="注入的移动失败（测试）。",
            )
        if not path.exists():
            return TrashResult(False, error_code="ASSET_MISSING", error_message="文件不存在。")
        target = self.trash_dir / path.name
        counter = 1
        while target.exists():
            target = self.trash_dir / f"{path.stem} {counter}{path.suffix}"
            counter += 1
        shutil.move(str(path), str(target))
        return TrashResult(True, trashed_path=target)

    def restore(self, trashed_path: Path, original_path: Path) -> RestoreResult:
        self.restore_calls.append((trashed_path, original_path))
        if trashed_path.name in self.fail_restore_names:
            return RestoreResult(
                False,
                error_code="ROLLBACK_FAILED",
                error_message="注入的恢复失败（测试）。",
            )
        if original_path.exists():
            return RestoreResult(False, error_code="DESTINATION_CONFLICT", error_message="原路径已有文件。")
        if not trashed_path.exists():
            return RestoreResult(False, error_code="ASSET_MISSING", error_message="废纸篓文件不存在。")
        original_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(trashed_path), str(original_path))
        return RestoreResult(True, restored_path=original_path)


def install_fake_trash(app, trash_dir: Path) -> FakeTrashService:  # noqa: ANN001
    fake = FakeTrashService(trash_dir)
    context = app.state.context
    context.trash = fake
    context.cleanup.trash = fake
    return fake
