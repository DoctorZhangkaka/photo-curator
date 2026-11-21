"""RAW/JPG 配对算法（纯函数，无数据库依赖）。

配对范围：同一相册内，按 NFC + casefold 的规范化主文件名分组。
正常组只能是：一张 JPG、一个 RAW、或一张 JPG + 一个 RAW。
其余情况一律标记冲突，绝不静默合并。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .constants import PAIRING_CONFLICT, PAIRING_NORMAL, SUPPORTED_EXTENSIONS
from .natural import natural_key, nfc, normalize_pair_key, split_stem


@dataclass(frozen=True)
class FileRecord:
    relative_path: str
    filename: str
    extension: str  # 保留原始大小写，例如 ".JPG"
    kind: str  # jpg / raw
    size_bytes: int
    mtime_ns: int


@dataclass
class PairGroup:
    pair_key: str
    display_name: str
    natural_sort_key: str
    files: list[FileRecord]
    status: str
    conflict_reasons: list[str] = field(default_factory=list)

    @property
    def jpgs(self) -> list[FileRecord]:
        return [f for f in self.files if f.kind == "jpg"]

    @property
    def raws(self) -> list[FileRecord]:
        return [f for f in self.files if f.kind == "raw"]

    @property
    def is_conflict(self) -> bool:
        return self.status == PAIRING_CONFLICT

    @property
    def primary(self) -> FileRecord:
        return self.jpgs[0] if self.jpgs else self.files[0]

    @property
    def form(self) -> str | None:
        if self.is_conflict:
            return None
        has_jpg = bool(self.jpgs)
        has_raw = bool(self.raws)
        if has_jpg and has_raw:
            return "jpg_raw"
        if has_jpg:
            return "jpg_only"
        if has_raw:
            return "raw_only"
        return None


def supported_kind(filename: str) -> tuple[str, str] | None:
    """返回 (kind, 原始扩展名)；不支持返回 None。"""

    stem, extension = split_stem(filename)
    if not stem or not extension:
        return None
    kind = SUPPORTED_EXTENSIONS.get(extension.lower())
    if kind is None:
        return None
    return kind, extension


def classify_entries(entries: list[FileRecord]) -> list[PairGroup]:
    buckets: dict[str, list[FileRecord]] = {}
    for entry in entries:
        stem, _ = split_stem(entry.filename)
        key = normalize_pair_key(stem)
        buckets.setdefault(key, []).append(entry)

    groups: list[PairGroup] = []
    for pair_key, files in buckets.items():
        files = sorted(files, key=lambda item: item.relative_path)
        jpgs = [f for f in files if f.kind == "jpg"]
        raws = [f for f in files if f.kind == "raw"]
        reasons: list[str] = []
        if len(jpgs) > 1:
            reasons.append("duplicate_jpg")
        if len(raws) > 1:
            reasons.append("duplicate_raw")
        if len({f.extension.lower() for f in raws}) > 1:
            reasons.append("multiple_raw_formats")
        distinct_stems = {nfc(split_stem(f.filename)[0]) for f in files}
        # 跨格式的纯大小写差异是正常配对（如 a.jpg + RAW/A.RAF）；
        # 只有当大小写/Unicode 归一化造成同格式歧义时才是冲突。
        if len(distinct_stems) > 1 and (len(jpgs) > 1 or len(raws) > 1 or len(files) > 2):
            reasons.append("case_unicode_collision")

        primary = jpgs[0] if jpgs else raws[0]
        display_stem = nfc(split_stem(primary.filename)[0])
        status = PAIRING_CONFLICT if reasons else PAIRING_NORMAL
        groups.append(
            PairGroup(
                pair_key=pair_key,
                display_name=display_stem,
                natural_sort_key=natural_key(display_stem),
                files=files,
                status=status,
                conflict_reasons=reasons,
            )
        )

    groups.sort(key=lambda group: (group.natural_sort_key, group.pair_key))
    return groups


def ordered_assets(files: list[FileRecord]) -> list[FileRecord]:
    """展示/预览顺序：JPG 优先，然后按相对路径。"""

    return sorted(files, key=lambda f: (0 if f.kind == "jpg" else 1, f.relative_path))
