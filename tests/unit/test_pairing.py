"""配对算法单元测试（对应产品文档 PAIR-001 ~ PAIR-016）。"""

from __future__ import annotations

import unicodedata

from photo_curator.constants import PAIRING_CONFLICT, PAIRING_NORMAL
from photo_curator.pairing import FileRecord, classify_entries, ordered_assets


def entry(path: str, *, size: int = 10, mtime: int = 1) -> FileRecord:
    filename = path.rsplit("/", 1)[-1]
    extension = "." + filename.rsplit(".", 1)[-1]
    kind = "jpg" if extension.lower() in {".jpg", ".jpeg"} else "raw"
    return FileRecord(
        relative_path=path,
        filename=filename,
        extension=extension,
        kind=kind,
        size_bytes=size,
        mtime_ns=mtime,
    )


def one_group(*paths: str):
    groups = classify_entries([entry(path) for path in paths])
    assert len(groups) == 1
    return groups[0]


def test_pair_same_directory():
    group = one_group("A.JPG", "A.RAF")
    assert group.status == PAIRING_NORMAL
    assert group.form == "jpg_raw"
    assert {file.filename for file in group.files} == {"A.JPG", "A.RAF"}


def test_pair_across_jpg_raw_subdirs():
    group = one_group("JPG/A.JPG", "RAW/A.RAF")
    assert group.status == PAIRING_NORMAL
    assert group.primary.relative_path == "JPG/A.JPG"


def test_pair_case_insensitive():
    group = one_group("a.jpg", "RAW/A.RAF")
    assert group.status == PAIRING_NORMAL
    assert group.display_name == "a"
    assert {file.filename for file in group.files} == {"a.jpg", "A.RAF"}


def test_pair_jpeg_arw():
    group = one_group("A.JPEG", "A.ARW")
    assert group.form == "jpg_raw"


def test_pair_jpg_dng():
    group = one_group("A.JPG", "A.DNG")
    assert group.form == "jpg_raw"


def test_only_jpg():
    group = one_group("A.JPG")
    assert group.form == "jpg_only"
    assert group.status == PAIRING_NORMAL


def test_only_raw():
    group = one_group("A.RAF")
    assert group.form == "raw_only"


def test_duplicate_jpg_conflict():
    group = one_group("A.JPG", "JPG/A.JPG", "A.RAF")
    assert group.status == PAIRING_CONFLICT
    assert "duplicate_jpg" in group.conflict_reasons


def test_multiple_raw_formats_conflict():
    group = one_group("A.RAF", "A.ARW", "A.JPG")
    assert group.status == PAIRING_CONFLICT
    assert "multiple_raw_formats" in group.conflict_reasons
    assert "duplicate_raw" in group.conflict_reasons


def test_two_raw_conflict():
    group = one_group("A.RAF", "A.DNG")
    assert group.status == PAIRING_CONFLICT
    assert "duplicate_raw" in group.conflict_reasons


def test_different_albums_are_independent():
    album_one = classify_entries([entry("A.JPG")])
    album_two = classify_entries([entry("A.JPG")])
    assert len(album_one) == 1 and len(album_two) == 1
    assert album_one[0].pair_key == album_two[0].pair_key


def test_single_formats_do_not_merge():
    groups = classify_entries([entry("A.JPG"), entry("B.RAF")])
    assert len(groups) == 2
    assert {group.display_name for group in groups} == {"A", "B"}


def test_unicode_nfc_pairing_preserves_display():
    nfc_stem = unicodedata.normalize("NFC", "Café")
    nfd_stem = unicodedata.normalize("NFD", "Café")
    groups = classify_entries([entry(f"{nfc_stem}.JPG"), entry(f"{nfd_stem}.RAF")])
    assert len(groups) == 1
    assert groups[0].status == PAIRING_NORMAL
    assert groups[0].display_name == nfc_stem


def test_case_only_filenames_conflict():
    group = one_group("A.JPG", "a.JPG")
    assert group.status == PAIRING_CONFLICT
    assert "case_unicode_collision" in group.conflict_reasons
    assert "duplicate_jpg" in group.conflict_reasons
    filenames = {file.filename for file in group.files}
    assert filenames == {"A.JPG", "a.JPG"}


def test_extension_case_insensitive():
    group = one_group("A.JpG", "A.rAf")
    assert group.status == PAIRING_NORMAL
    assert {file.extension for file in group.files} == {".JpG", ".rAf"}


def test_metadata_time_does_not_split_pair():
    # 配对纯函数不读取 EXIF；同主文件名即配对，时间差异不影响。
    group = one_group("A.JPG", "A.RAF")
    assert group.status == PAIRING_NORMAL


def test_rename_creates_new_pair_key():
    before = classify_entries([entry("A.JPG"), entry("A.RAF")])[0]
    after = classify_entries([entry("B.JPG"), entry("B.RAF")])[0]
    assert before.pair_key != after.pair_key


def test_ordered_assets_jpg_first():
    files = [entry("RAW/A.RAF"), entry("A.JPG")]
    ordered = ordered_assets(files)
    assert [file.filename for file in ordered] == ["A.JPG", "A.RAF"]
