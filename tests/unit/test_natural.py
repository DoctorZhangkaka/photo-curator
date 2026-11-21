"""自然排序、配对键、EXIF 时间规范化测试。"""

from __future__ import annotations

import unicodedata

from photo_curator.natural import (
    is_expired,
    iso_after,
    natural_key,
    nfc,
    normalize_exif_datetime,
    normalize_pair_key,
    split_stem,
    utcnow_iso,
)


def test_natural_sort_numbers():
    names = ["IMG10.JPG", "IMG2.JPG", "IMG1.JPG"]
    ordered = sorted(names, key=natural_key)
    assert ordered == ["IMG1.JPG", "IMG2.JPG", "IMG10.JPG"]


def test_natural_sort_is_case_insensitive():
    assert natural_key("DSCF0002") == natural_key("dscf0002")


def test_natural_sort_text_and_numbers():
    assert natural_key("a2") < natural_key("a10")
    assert natural_key("a2") < natural_key("ab")


def test_pair_key_unicode_nfc_casefold():
    nfd = unicodedata.normalize("NFD", "Café")
    assert normalize_pair_key(nfd) == normalize_pair_key("CAFÉ")
    assert nfc("Café") == unicodedata.normalize("NFC", "Café")


def test_split_stem_keeps_extension_case():
    assert split_stem("DSCF0001.JPG") == ("DSCF0001", ".JPG")
    assert split_stem("noext") == ("noext", "")


def test_normalize_exif_datetime_variants():
    assert normalize_exif_datetime("2026:11:22 10:30:00") == "2026-11-22T10:30:00"
    assert normalize_exif_datetime("2026-11-22T10:30:00+08:00") == "2026-11-22T10:30:00"
    assert normalize_exif_datetime("2026-11-22T10:30:00.123Z") == "2026-11-22T10:30:00"
    assert normalize_exif_datetime("0000:00:00 00:00:00") is None
    assert normalize_exif_datetime("garbage") is None
    assert normalize_exif_datetime(None) is None


def test_time_helpers_are_sortable_and_expire():
    now = utcnow_iso()
    future = iso_after(60)
    assert future > now
    assert not is_expired(future)
    assert is_expired("2000-01-01T00:00:00.000Z")
    assert is_expired("not-a-time")
