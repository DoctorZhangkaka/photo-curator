"""路径安全单元测试（对应 SEC-001/002/003 与导出目标约束）。"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from photo_curator.errors import ApiError, ErrorCode
from photo_curator.paths import PathGuard


@pytest.fixture
def guard(tmp_path: Path) -> PathGuard:
    root = tmp_path / "相册"
    root.mkdir()
    (root / "旅行").mkdir()
    (root / "旅行" / "JPG").mkdir()
    (root / "旅行" / "JPG" / "A.JPG").write_bytes(b"jpg")
    (root / "精选原相册").mkdir()
    return PathGuard(root, "精选原相册")


def test_album_dir_ok(guard: PathGuard):
    assert guard.album_dir("旅行").name == "旅行"


@pytest.mark.parametrize("value", ["../escape", "旅行/../旅行", "/etc", "", ".", "a/b"])
def test_album_rejects_traversal(guard: PathGuard, value: str):
    with pytest.raises(ApiError) as excinfo:
        guard.album_dir(value)
    assert excinfo.value.code in {ErrorCode.PATH_OUTSIDE_ROOT, ErrorCode.ALBUM_NOT_FOUND}


def test_album_rejects_export_directory(guard: PathGuard):
    with pytest.raises(ApiError) as excinfo:
        guard.album_dir("精选原相册")
    assert excinfo.value.code == ErrorCode.PATH_OUTSIDE_ROOT


def test_asset_path_ok(guard: PathGuard):
    path = guard.asset_path("旅行", "JPG/A.JPG")
    assert path.read_bytes() == b"jpg"


@pytest.mark.parametrize("value", ["../../etc/passwd", "/etc/passwd", "a/b/c"])
def test_asset_rejects_traversal_and_depth(guard: PathGuard, value: str):
    with pytest.raises(ApiError) as excinfo:
        guard.asset_path("旅行", value)
    assert excinfo.value.code == ErrorCode.PATH_OUTSIDE_ROOT


def test_asset_rejects_symlink_file(guard: PathGuard, tmp_path: Path):
    outside = tmp_path / "outside.jpg"
    outside.write_bytes(b"secret")
    os.symlink(outside, guard.root / "旅行" / "LINK.JPG")
    with pytest.raises(ApiError) as excinfo:
        guard.asset_path("旅行", "LINK.JPG")
    assert excinfo.value.code == ErrorCode.PATH_OUTSIDE_ROOT


def test_asset_rejects_symlink_directory(guard: PathGuard, tmp_path: Path):
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (outside_dir / "A.JPG").write_bytes(b"secret")
    os.symlink(outside_dir, guard.root / "逃逸相册")
    with pytest.raises(ApiError) as excinfo:
        guard.album_dir("逃逸相册")
    assert excinfo.value.code == ErrorCode.PATH_OUTSIDE_ROOT


def test_export_file_path_ok(guard: PathGuard):
    path = guard.export_file_path("旅行", "JPG", "A.JPG")
    assert path == guard.root / "精选原相册" / "旅行" / "JPG" / "A.JPG"


@pytest.mark.parametrize(
    "filename",
    ["../A.JPG", "a/b.JPG", "..", ".", ""],
)
def test_export_rejects_bad_filename(guard: PathGuard, filename: str):
    with pytest.raises(ApiError):
        guard.export_file_path("旅行", "JPG", filename)


def test_export_rejects_bad_kind_dir(guard: PathGuard):
    with pytest.raises(ApiError):
        guard.export_file_path("旅行", "OTHER", "A.JPG")


def test_export_root_symlink_escape_rejected(tmp_path: Path):
    root = tmp_path / "相册"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, root / "精选原相册")
    guard = PathGuard(root, "精选原相册")
    with pytest.raises(ApiError) as excinfo:
        guard.export_file_path("旅行", "JPG", "A.JPG")
    assert excinfo.value.code == ErrorCode.PATH_OUTSIDE_ROOT


def test_export_target_symlink_rejected(guard: PathGuard, tmp_path: Path):
    target = guard.root / "精选原相册" / "旅行" / "JPG" / "A.JPG"
    target.parent.mkdir(parents=True)
    outside = tmp_path / "outside.jpg"
    outside.write_bytes(b"x")
    os.symlink(outside, target)
    with pytest.raises(ApiError) as excinfo:
        guard.export_file_path("旅行", "JPG", "A.JPG")
    assert excinfo.value.code == ErrorCode.PATH_OUTSIDE_ROOT


def test_nonexistent_asset_reports_missing(guard: PathGuard):
    with pytest.raises(ApiError) as excinfo:
        guard.asset_path("旅行", "JPG/NOPE.JPG", must_exist=True)
    assert excinfo.value.code == ErrorCode.ASSET_MISSING
