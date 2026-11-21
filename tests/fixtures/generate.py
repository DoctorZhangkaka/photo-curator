"""测试夹具生成：全部为程序生成的图片，不包含任何私人照片。

JPG 用 Pillow 生成；DNG 用手写的最小合法 TIFF/DNG 结构生成（LibRaw 可解码）。
"""

from __future__ import annotations

import struct
from fractions import Fraction
from pathlib import Path

BYTE, ASCII, SHORT, LONG, RATIONAL = 1, 2, 3, 4, 5


def make_jpeg(
    path: Path,
    *,
    width: int = 64,
    height: int = 48,
    color: tuple[int, int, int] = (120, 90, 60),
    capture_time: str | None = "2026:11:22 10:30:00",
    make: str = "FUJIFILM",
    model: str = "X-T5",
    lens: str = "XF23mmF1.4 R LM WR",
    focal_length: float = 23.0,
    aperture: float = 1.4,
    exposure: float = 1 / 250,
    iso: int = 400,
) -> Path:
    from PIL import Image, TiffImagePlugin

    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (width, height), color)
    # 简单渐变，避免所有测试图片完全相同
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            pixels[x, y] = (
                (color[0] + x * 2) % 256,
                (color[1] + y * 3) % 256,
                (color[2] + (x + y)) % 256,
            )
    exif = Image.Exif()
    exif[271] = make
    exif[272] = model
    exif[274] = 1
    if capture_time:
        exif[36867] = capture_time
        exif[36868] = capture_time
    exif[42036] = lens
    exif[37386] = TiffImagePlugin.IFDRational(Fraction(focal_length).numerator, Fraction(focal_length).denominator)
    exif[33437] = TiffImagePlugin.IFDRational(
        Fraction(aperture).limit_denominator(100).numerator,
        Fraction(aperture).limit_denominator(100).denominator,
    )
    exposure_fraction = Fraction(exposure).limit_denominator(100000)
    exif[33434] = TiffImagePlugin.IFDRational(exposure_fraction.numerator, exposure_fraction.denominator)
    exif[34855] = iso
    image.save(path, format="JPEG", quality=90, exif=exif)
    return path


def build_minimal_dng(path: Path, *, width: int = 64, height: int = 40, seed: int = 1) -> Path:
    """生成一个 LibRaw 可解码的最小 DNG。

    仅用于测试预览/元数据路径；不是相机原始文件，也不包含任何个人数据。
    """

    import math

    path.parent.mkdir(parents=True, exist_ok=True)
    pixel_rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            value = int(1000 + 800 * math.sin((x + seed) / 7.0) + 500 * math.cos((y + seed) / 5.0)) % 4096
            row += struct.pack("<H", value)
        pixel_rows.append(bytes(row))
    pixel_bytes = b"".join(pixel_rows)
    entries: list[tuple[int, int, int, bytes]] = []

    def add_inline(tag: int, typ: int, count: int, payload: bytes) -> None:
        entries.append((tag, typ, count, payload))

    def add_ascii(tag: int, text: str) -> None:
        payload = text.encode("ascii") + b"\x00"
        entries.append((tag, ASCII, len(payload), payload))

    def add_rational(tag: int, values: tuple[float, ...]) -> None:
        payload = b"".join(struct.pack("<II", int(round(value * 10000)), 10000) for value in values)
        entries.append((tag, RATIONAL, len(values), payload))

    add_inline(254, LONG, 1, struct.pack("<I", 0))
    add_inline(256, LONG, 1, struct.pack("<I", width))
    add_inline(257, LONG, 1, struct.pack("<I", height))
    add_inline(258, SHORT, 1, struct.pack("<H", 16))
    add_inline(259, SHORT, 1, struct.pack("<H", 1))
    add_inline(262, SHORT, 1, struct.pack("<H", 32803))  # CFA
    add_ascii(271, "Synthetic")
    add_ascii(272, "Synthetic DNG")
    add_inline(273, LONG, 1, struct.pack("<I", 0))  # StripOffsets 稍后回填
    add_inline(277, SHORT, 1, struct.pack("<H", 1))
    add_inline(278, LONG, 1, struct.pack("<I", height))
    add_inline(279, LONG, 1, struct.pack("<I", len(pixel_bytes)))
    add_inline(284, SHORT, 1, struct.pack("<H", 1))
    add_inline(33421, SHORT, 2, struct.pack("<HH", 2, 2))
    add_inline(33422, BYTE, 4, bytes([0, 1, 1, 2]))
    add_inline(50706, BYTE, 4, bytes([1, 4, 0, 0]))  # DNGVersion
    add_inline(50707, BYTE, 4, bytes([1, 1, 0, 0]))
    add_ascii(50708, "Synthetic Camera")
    add_inline(50714, SHORT, 1, struct.pack("<H", 256))
    add_inline(50717, LONG, 1, struct.pack("<I", 4095))
    add_rational(50721, (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0))
    add_rational(50728, (1.0, 1.0, 1.0))
    add_inline(50778, SHORT, 1, struct.pack("<H", 21))

    entries.sort(key=lambda item: item[0])
    ifd_offset = 8
    ifd_size = 2 + len(entries) * 12 + 4
    cursor = ifd_offset + ifd_size
    ifd = bytearray(struct.pack("<H", len(entries)))
    out_of_line: list[bytes] = []
    for tag, typ, count, payload in entries:
        if len(payload) <= 4:
            value = payload.ljust(4, b"\x00")
        else:
            value = struct.pack("<I", cursor)
            out_of_line.append(payload)
            cursor += len(payload)
        ifd += struct.pack("<HHI", tag, typ, count) + value
    ifd += struct.pack("<I", 0)
    pixels_offset = cursor
    patched = bytearray()
    index = 2
    for tag, typ, count, _payload in entries:
        if tag == 273:
            patched += struct.pack("<HHI", tag, typ, count) + struct.pack("<I", pixels_offset)
        else:
            patched += ifd[index : index + 12]
        index += 12
    ifd = ifd[:2] + patched + ifd[-4:]
    path.write_bytes(b"II*\x00" + struct.pack("<I", ifd_offset) + bytes(ifd) + b"".join(out_of_line) + pixel_bytes)
    return path


def create_demo_root(root: Path) -> dict[str, Path]:
    """创建一套演示/验收用相册（不含私人照片）。"""

    root.mkdir(parents=True, exist_ok=True)
    travel = root / "测试-京都旅行"
    travel.mkdir(parents=True, exist_ok=True)
    portrait = root / "测试-人像约拍-客户A"
    portrait.mkdir(parents=True, exist_ok=True)

    # 旅行：混放配对 + 仅 JPG
    make_jpeg(travel / "DSCF0001.JPG", capture_time="2026:11:20 08:00:00")
    (travel / "DSCF0001.RAF").write_bytes(b"FAKE-RAF-FOR-PAIRING-ONLY")
    make_jpeg(travel / "DSCF0002.JPG", capture_time="2026:11:20 08:05:00")

    # 旅行：RAW/JPG 分目录配对 + 真实可解码的 DNG
    (travel / "JPG").mkdir(exist_ok=True)
    (travel / "RAW").mkdir(exist_ok=True)
    make_jpeg(travel / "JPG" / "DSCF0010.JPG", capture_time="2026:11:20 09:00:00")
    (travel / "RAW" / "DSCF0010.RAF").write_bytes(b"FAKE-RAF-10")
    build_minimal_dng(travel / "JPG" / "DSCF0020.DNG", seed=2)

    # 配对冲突：两个同名 JPG
    make_jpeg(travel / "DSCF0030.JPG")
    make_jpeg(travel / "JPG" / "DSCF0030.JPG")

    # 空相册与导出目录（导出目录必须被排除）
    (root / "测试-空相册").mkdir(exist_ok=True)
    make_jpeg(root / "精选原相册" / "旧导出.JPG")

    # 人像：混放配对 + 真实 DNG + 仅 JPG
    make_jpeg(portrait / "DSC0001.JPG", capture_time="2026:11:01 14:00:00", model="ILCE-7RM5")
    (portrait / "DSC0001.ARW").write_bytes(b"FAKE-ARW-1")
    build_minimal_dng(portrait / "DSC0002.DNG", seed=5)
    make_jpeg(portrait / "DSC0003.JPG", capture_time="2026:11:01 14:10:00", model="ILCE-7RM5")

    return {"root": root, "travel": travel, "portrait": portrait}
