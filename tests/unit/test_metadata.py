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


def test_parse_image_size_variants():
    from photo_curator.metadata import _parse_image_size

    assert _parse_image_size("6240 4160") == (6240, 4160)
    assert _parse_image_size("6240x4160") == (6240, 4160)
    assert _parse_image_size([6240, 4160]) == (6240, 4160)
    assert _parse_image_size("bad") is None
    assert _parse_image_size(None) is None


def test_raw_metadata_batch_prefers_composite_image_size(monkeypatch, tmp_path):
    import json
    import subprocess

    from photo_curator.metadata import read_raw_metadata_batch

    sample = tmp_path / "A.RAF"
    sample.write_bytes(b"fake")
    payload = [
        {
            "SourceFile": str(sample),
            "DateTimeOriginal": "2024:05:04 14:12:15",
            "Make": "FUJIFILM",
            "Model": "X-S20",
            "LensModel": "XF56mmF1.2 R\x00\x00",
            "FocalLength": 56,
            "FNumber": 1.2,
            "ExposureTime": 0.00025,
            "ISO": 160,
            "ImageWidth": 4416,
            "ImageHeight": 2944,
            "ImageSize": "6240 4160",
            "Orientation": 8,
        }
    ]
    commands = []

    class Completed:
        stdout = json.dumps(payload)
        returncode = 0

    def fake_run(command, **kwargs):
        commands.append(command)
        return Completed()

    monkeypatch.setattr(subprocess, "run", fake_run)
    result = read_raw_metadata_batch([sample], "/bin/echo")
    metadata = result[str(sample.resolve())]
    assert metadata["width"] == 6240
    assert metadata["height"] == 4160
    assert metadata["lensModel"] == "XF56mmF1.2 R"
    assert metadata["exposureTime"] == "1/4000"
    assert "-ImageSize" in commands[0]
