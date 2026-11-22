"""EXIF 文本清理与 JPG 元数据读取测试。"""

from __future__ import annotations

from photo_curator.metadata import _build_metadata, _clean_text, read_jpg_metadata

from tests.fixtures.generate import make_jpeg


def test_clean_text_strips_nul_padding_and_whitespace():
    padded = "XF56mmF1.2 R" + "\x00" * 64
    assert _clean_text(padded) == "XF56mmF1.2 R"
    assert _clean_text("  FUJIFILM  ") == "FUJIFILM"
    assert _clean_text("") == ""


def test_build_metadata_does_not_leak_nul_padding():
    metadata = _build_metadata(
        capture_time="2024-05-04T14:12:15",
        make="FUJIFILM\x00\x00",
        model="X-S20\x00",
        lens="XF56mmF1.2 R" + "\x00" * 64,
        focal=56,
        fnumber=1.2,
        exposure=1 / 4000,
        iso=160,
        width=6240,
        height=4160,
        orientation=8,
    )
    assert metadata["cameraMake"] == "FUJIFILM"
    assert metadata["cameraModel"] == "X-S20"
    assert metadata["lensModel"] == "XF56mmF1.2 R"
    assert "\x00" not in str(metadata)
    assert metadata["exposureTime"] == "1/4000"


def test_read_jpg_metadata_returns_expected_fields(tmp_path):
    path = make_jpeg(tmp_path / "meta.JPG", width=80, height=60, capture_time="2024:05:04 14:12:15")
    metadata = read_jpg_metadata(path)
    assert metadata["captureTime"] == "2024-05-04T14:12:15"
    assert metadata["cameraMake"] == "FUJIFILM"
    assert metadata["cameraModel"] == "X-T5"
    assert metadata["width"] == 80
    assert metadata["height"] == 60
    assert metadata["aperture"] == 1.4
    assert metadata["iso"] == 400
