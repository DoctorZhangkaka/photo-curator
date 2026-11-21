"""自然排序与时间格式化工具。"""

from __future__ import annotations

import re
import unicodedata
from datetime import UTC, datetime

_DIGITS = re.compile(r"(\d+)")


def nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value)


def natural_key(value: str) -> str:
    """生成可做字典序比较的自然排序键。

    数字段补零到 20 位，因此 "2" < "10"；文本段使用 NFC + casefold。
    结果只用于排序，不用于展示。
    """

    normalized = nfc(value).casefold()
    parts = _DIGITS.split(normalized)
    chunks: list[str] = []
    for part in parts:
        if not part:
            continue
        if part.isdigit():
            chunks.append(f"{int(part):020d}")
        else:
            chunks.append(part)
    return "\x1f".join(chunks)


def normalize_pair_key(stem: str) -> str:
    """配对键：主文件名 NFC 规范化后不区分大小写。"""

    return nfc(stem).casefold()


def split_stem(filename: str) -> tuple[str, str]:
    """返回 (主文件名, 扩展名)；扩展名保留原始大小写，仅用于展示。"""

    dot = filename.rfind(".")
    if dot <= 0:
        return filename, ""
    return filename[:dot], filename[dot:]


def utcnow_iso() -> str:
    """UTC ISO8601（毫秒精度，Z 结尾），可直接做字符串比较和排序。"""

    now = datetime.now(UTC)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def iso_after(seconds: int) -> str:
    from datetime import timedelta

    moment = datetime.now(UTC) + timedelta(seconds=seconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def is_expired(iso_utc: str) -> bool:
    try:
        dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
    except ValueError:
        return True
    return dt <= datetime.now(UTC)


def normalize_exif_datetime(raw: object) -> str | None:
    """把 EXIF/ExifTool 时间转成可排序的本地 ISO 字符串。

    输入如 "2026:11:22 10:30:00"、"2026-11-22T10:30:00+08:00"。
    输出 "2026-11-22T10:30:00"（不带时区，仅用于拍摄时间排序与展示）。
    """

    if raw is None:
        return None
    text = str(raw).strip()
    if not text or text.startswith("0000"):
        return None
    text = text.replace("Z", "")
    if "T" in text:
        text = text.replace("T", " ")
    if "." in text:
        text = text.split(".", 1)[0]
    if "+" in text:
        text = text.split("+", 1)[0].strip()
    if text.count("-") == 2 and ":" in text[:7]:
        # 已经是 2026-11-22 形式
        normalized = text
    else:
        parts = text.split(" ")
        date_part = parts[0].replace(":", "-")
        time_part = parts[1] if len(parts) > 1 else "00:00:00"
        normalized = f"{date_part}T{time_part}"
    try:
        datetime.strptime(normalized, "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return normalized
