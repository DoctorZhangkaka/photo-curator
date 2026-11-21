"""受控的 macOS 原生废纸篓集成测试。

只操作本测试创建的临时夹具，绝不触碰真实相册或废纸篓中的其他内容。
没有 macOS/PyObjC 时明确跳过并报告，不伪造通过。
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
from photo_curator.trash import MacOSTrashService

pytestmark = pytest.mark.macos_trash

requires_macos = pytest.mark.skipif(sys.platform != "darwin", reason="仅 macOS 原生废纸篓环境")


@requires_macos
def test_native_trash_and_restore(tmp_path: Path):
    service = MacOSTrashService()
    if not service.available:
        pytest.skip(f"原生废纸篓不可用：{service.unavailable_reason}")

    name = f"pc-trash-integration-{uuid.uuid4().hex}.jpg"
    source = tmp_path / name
    source.write_bytes(b"photo-curator-trash-test")
    result = service.trash(source)
    assert result.ok, result
    assert result.trashed_path is not None
    assert result.trashed_path.exists()
    assert service.is_in_trash(result.trashed_path)
    assert not source.exists()

    restored = service.restore(result.trashed_path, source)
    assert restored.ok, restored
    assert source.read_bytes() == b"photo-curator-trash-test"

    # 恢复冲突：原路径已有新文件时绝不覆盖。
    second = service.trash(source)
    assert second.ok
    source.write_bytes(b"new-content-must-survive")
    conflict = service.restore(second.trashed_path, source)
    assert conflict.ok is False
    assert conflict.error_code == "DESTINATION_CONFLICT"
    assert source.read_bytes() == b"new-content-must-survive"

    # 只清理本测试生成的废纸篓夹具。
    trash_path: Path = second.trashed_path
    assert trash_path.name.startswith("pc-trash-integration-")
    assert service.is_in_trash(trash_path)
    trash_path.unlink()
    assert not trash_path.exists()


@requires_macos
def test_trash_service_refuses_missing_file(tmp_path: Path):
    service = MacOSTrashService()
    if not service.available:
        pytest.skip("原生废纸篓不可用")
    result = service.trash(tmp_path / "does-not-exist.jpg")
    assert result.ok is False
    assert result.error_code in {"ASSET_MISSING", "TRASH_OPERATION_FAILED"}
