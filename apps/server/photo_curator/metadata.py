"""EXIF / 元数据读取。

- JPG 用 Pillow 本地解析（不依赖外部工具）；
- RAW 用 ExifTool（首选，支持 RAF/ARW/DNG）；ExifTool 缺失时返回空元数据，
  不阻塞浏览，健康检查会提示依赖缺失；
- 元数据只用于展示和排序，绝不会反向改变配对关系。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .natural import normalize_exif_datetime

EXIFTOOL_TAGS = (
    "DateTimeOriginal",
    "CreateDate",
    "Make",
    "Model",
    "LensModel",
    "FocalLength",
    "FNumber",
    "ExposureTime",
    "ISO",
    "ImageWidth",
    "ImageHeight",
    "ImageSize",
    "Orientation",
)

_EMPTY: dict[str, Any] = {}


def _format_exposure(value: Any) -> str | None:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    if seconds >= 1:
        if abs(seconds - round(seconds)) < 0.01:
            return f"{int(round(seconds))}s"
        return f"{seconds:.1f}s"
    denominator = round(1 / seconds)
    if denominator <= 1:
        return f"{seconds:.2f}s"
    return f"1/{denominator}"


def _clean_text(value: Any) -> str:
    """清理 EXIF ASCII 标签的 NUL 填充与首尾空白。"""

    return str(value).replace("\x00", "").strip()


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_image_size(value: Any) -> tuple[int, int] | None:
    """解析 ExifTool 的 ImageSize（如 "6240 4160" 或 "6240x4160"）。

    RAF 的 ImageWidth/ImageHeight 可能是内嵌预览尺寸，Composite ImageSize 才是
    相机输出的完整图像尺寸，因此 RAW 元数据优先使用它。
    """

    if value is None:
        return None
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        width, height = _to_int(value[0]), _to_int(value[1])
    else:
        text = str(value).replace("x", " ").replace("X", " ").replace(",", " ")
        parts = text.split()
        if len(parts) < 2:
            return None
        width, height = _to_int(parts[0]), _to_int(parts[1])
    if not width or not height:
        return None
    return width, height


def _to_int(value: Any) -> int | None:
    try:
        if isinstance(value, (list, tuple)):
            value = value[0]
        return int(value)
    except (TypeError, ValueError):
        return None


def _build_metadata(
    *,
    capture_time: str | None,
    make: Any,
    model: Any,
    lens: Any,
    focal: Any,
    fnumber: Any,
    exposure: Any,
    iso: Any,
    width: Any,
    height: Any,
    orientation: Any,
) -> dict[str, Any]:
    data: dict[str, Any] = {}
    if capture_time:
        data["captureTime"] = capture_time
    make_text = _clean_text(make) if make else ""
    model_text = _clean_text(model) if model else ""
    lens_text = _clean_text(lens) if lens else ""
    if make_text:
        data["cameraMake"] = make_text
    if model_text:
        data["cameraModel"] = model_text
    if lens_text:
        data["lensModel"] = lens_text
    focal_value = _to_float(focal)
    if focal_value:
        data["focalLength"] = round(focal_value, 2)
    aperture_value = _to_float(fnumber)
    if aperture_value:
        data["aperture"] = round(aperture_value, 2)
    exposure_text = _format_exposure(exposure)
    if exposure_text:
        data["exposureTime"] = exposure_text
    iso_value = _to_int(iso)
    if iso_value:
        data["iso"] = iso_value
    width_value = _to_int(width)
    height_value = _to_int(height)
    if width_value and height_value:
        data["width"] = width_value
        data["height"] = height_value
    orientation_value = _to_int(orientation)
    if orientation_value:
        data["orientation"] = orientation_value
    return data


def read_jpg_metadata(path: Path) -> dict[str, Any]:
    """读取 JPG 元数据；任何失败都返回空字典，不抛出。"""

    try:
        from PIL import Image
    except ImportError:  # pragma: no cover - 依赖已声明
        return dict(_EMPTY)
    try:
        with Image.open(path) as image:
            width, height = image.size
            exif = image.getexif()
            try:
                exif_ifd = exif.get_ifd(0x8769)
            except Exception:  # noqa: BLE001 - 损坏 EXIF 不应影响浏览
                exif_ifd = {}

            def get(tag: int) -> Any:
                value = exif.get(tag)
                if value is None:
                    value = exif_ifd.get(tag)
                return value

            capture = normalize_exif_datetime(get(36867) or get(36868) or get(306))
            return _build_metadata(
                capture_time=capture,
                make=get(271),
                model=get(272),
                lens=get(42036),
                focal=get(37386),
                fnumber=get(33437),
                exposure=get(33434),
                iso=get(34855),
                width=width,
                height=height,
                orientation=get(274),
            )
    except Exception:  # noqa: BLE001 - 元数据失败不影响浏览
        return {}


def exiftool_available(exiftool_path: str | None) -> bool:
    if not exiftool_path:
        return False
    return Path(exiftool_path).exists() or shutil.which(exiftool_path) is not None


def read_raw_metadata_batch(paths: list[Path], exiftool_path: str | None) -> dict[str, dict[str, Any]]:
    """批量读取 RAW 元数据，避免每张照片启动一个进程。"""

    if not paths or not exiftool_available(exiftool_path):
        return {}
    result: dict[str, dict[str, Any]] = {}
    chunk_size = 100
    for start in range(0, len(paths), chunk_size):
        chunk = paths[start : start + chunk_size]
        command = [exiftool_path or "exiftool", "-j", "-n", "-m", "-q"]
        command += [f"-{tag}" for tag in EXIFTOOL_TAGS]
        command += [str(path) for path in chunk]
        try:
            completed = subprocess.run(  # noqa: S603 - 参数数组，无 shell
                command,
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if not completed.stdout.strip():
            continue
        try:
            records = json.loads(completed.stdout)
        except json.JSONDecodeError:
            continue
        for record in records:
            source = record.get("SourceFile")
            if not source:
                continue
            full_size = _parse_image_size(record.get("ImageSize"))
            metadata = _build_metadata(
                capture_time=normalize_exif_datetime(record.get("DateTimeOriginal") or record.get("CreateDate")),
                make=record.get("Make"),
                model=record.get("Model"),
                lens=record.get("LensModel"),
                focal=record.get("FocalLength"),
                fnumber=record.get("FNumber"),
                exposure=record.get("ExposureTime"),
                iso=record.get("ISO"),
                width=full_size[0] if full_size else record.get("ImageWidth"),
                height=full_size[1] if full_size else record.get("ImageHeight"),
                orientation=record.get("Orientation"),
            )
            result[str(Path(source).resolve())] = metadata
    return result


def exiftool_version(exiftool_path: str | None) -> str | None:
    if not exiftool_available(exiftool_path):
        return None
    try:
        completed = subprocess.run(  # noqa: S603
            [exiftool_path or "exiftool", "-ver"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return completed.stdout.strip() or None
