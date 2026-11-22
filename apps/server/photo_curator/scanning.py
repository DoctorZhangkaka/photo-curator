"""相册发现、扫描、配对状态合并。

安全边界：
- 只扫描照片根目录的一级子目录；
- 只读取相册根目录以及其 RAW/JPG 一级子目录中的受支持图片；
- 符号链接目录/文件一律跳过并记录；
- 扫描永远只读源文件。
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .constants import (
    ISSUE_SCAN_ERROR,
    OP_STATUS_FAILED,
    OP_STATUS_SUCCESS,
    OP_TYPE_SCAN,
    PAIRING_CONFLICT,
    PAIRING_MISSING,
    PAIRING_NORMAL,
    PAIRING_TRASHED,
    PRESENCE_MISSING,
    PRESENCE_PRESENT,
    PREVIEW_PENDING,
    SCAN_EMPTY,
    SCAN_FAILED,
    SCAN_PENDING,
    SCAN_READY,
    SCAN_SCANNING,
    SELECTION_PENDING_DELETE,
    SELECTION_SELECTED,
    VIEWED_SEEN,
)
from .db import Database
from .metadata import read_jpg_metadata, read_raw_metadata_batch
from .models import Album, Asset, Operation, PhotoGroup
from .natural import utcnow_iso
from .pairing import FileRecord, PairGroup, classify_entries, supported_kind
from .paths import PathGuard

IMAGE_DIR_NAMES = {"jpg", "raw"}


@dataclass
class ScanOutcome:
    album_id: str
    album_name: str
    status: str
    counts: dict[str, int]
    report: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    duration_ms: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "albumId": self.album_id,
            "albumName": self.album_name,
            "status": self.status,
            "counts": self.counts,
            "report": self.report,
            "error": self.error,
            "durationMs": self.duration_ms,
        }


def _empty_counts() -> dict[str, int]:
    return {
        "total": 0,
        "viewed": 0,
        "unseen": 0,
        "selected": 0,
        "pendingDelete": 0,
        "missing": 0,
        "conflicts": 0,
    }


def stats_for_albums(session: Session, album_ids: list[str] | None = None) -> dict[str, dict[str, int]]:
    """按相册统计，排除已清理（trashed）的逻辑照片。"""

    from sqlalchemy import case, func

    query = (
        select(
            PhotoGroup.album_id,
            func.count(PhotoGroup.id),
            func.sum(case((PhotoGroup.viewed_status == VIEWED_SEEN, 1), else_=0)),
            func.sum(case((PhotoGroup.selection_status == SELECTION_SELECTED, 1), else_=0)),
            func.sum(case((PhotoGroup.selection_status == SELECTION_PENDING_DELETE, 1), else_=0)),
            func.sum(case((PhotoGroup.pairing_status == PAIRING_MISSING, 1), else_=0)),
            func.sum(case((PhotoGroup.pairing_status == PAIRING_CONFLICT, 1), else_=0)),
        )
        .where(
            PhotoGroup.pairing_status != PAIRING_TRASHED,
            PhotoGroup.deleted_at.is_(None),
        )
        .group_by(PhotoGroup.album_id)
    )
    if album_ids is not None:
        if not album_ids:
            return {}
        query = query.where(PhotoGroup.album_id.in_(album_ids))

    stats: dict[str, dict[str, int]] = {}
    for row in session.execute(query).all():
        album_id, total, viewed, selected, pending, missing, conflicts = row
        total = int(total or 0)
        viewed = int(viewed or 0)
        stats[album_id] = {
            "total": total,
            "viewed": viewed,
            "unseen": total - viewed,
            "selected": int(selected or 0),
            "pendingDelete": int(pending or 0),
            "missing": int(missing or 0),
            "conflicts": int(conflicts or 0),
        }
    return stats


def _record_scan_operation(
    session: Session,
    album: Album,
    *,
    trigger: str,
    status: str,
    photo_count: int,
    file_count: int,
    report: dict[str, Any],
    error: str | None,
    duration_ms: int,
) -> None:
    finished = utcnow_iso()
    operation = Operation(
        album_id=album.id,
        type=OP_TYPE_SCAN,
        status=status,
        started_at=finished,
        finished_at=finished,
        requested_photo_count=photo_count,
        requested_file_count=file_count,
        success_file_count=file_count if status == OP_STATUS_SUCCESS else 0,
        failed_file_count=0 if status == OP_STATUS_SUCCESS else 1,
        error_summary=error,
        request_snapshot_json=json.dumps(
            {"trigger": trigger, "durationMs": duration_ms, "report": report},
            ensure_ascii=False,
        ),
    )
    session.add(operation)


def _count_unincluded(directory: Path) -> tuple[int, list[str]]:
    """统计未纳入扫描的嵌套目录中的受支持图片数量。"""

    count = 0
    examples: list[str] = []
    for current, dirnames, filenames in os.walk(directory, followlinks=False):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and not os.path.islink(os.path.join(current, d))]
        for filename in filenames:
            if filename.startswith(".") or supported_kind(filename) is None:
                continue
            count += 1
            if len(examples) < 5:
                examples.append(os.path.relpath(os.path.join(current, filename), directory))
    return count, examples


def _collect_files(album_dir: Path, report: dict[str, Any]) -> list[FileRecord]:
    files: list[FileRecord] = []
    skipped_symlinks: list[str] = []
    read_errors: list[dict[str, str]] = []
    unincluded_dirs: list[dict[str, Any]] = []

    def add_file(path: Path, relative_path: str) -> None:
        if path.is_symlink():
            skipped_symlinks.append(relative_path)
            return
        try:
            stat = path.stat(follow_symlinks=False)
        except OSError as exc:
            read_errors.append({"path": relative_path, "error": str(exc)})
            return
        info = supported_kind(path.name)
        if info is None:
            return
        kind, extension = info
        files.append(
            FileRecord(
                relative_path=relative_path,
                filename=path.name,
                extension=extension,
                kind=kind,
                size_bytes=stat.st_size,
                mtime_ns=stat.st_mtime_ns,
            )
        )

    def scan_flat(directory: Path, prefix: str, *, strict: bool = False) -> None:
        try:
            entries = list(os.scandir(directory))
        except OSError as exc:
            if strict:
                raise
            read_errors.append({"path": prefix or ".", "error": str(exc)})
            return
        for entry in entries:
            if entry.name.startswith("."):
                continue
            entry_path = Path(entry.path)
            if entry.is_symlink():
                skipped_symlinks.append(f"{prefix}{entry.name}")
                continue
            if entry.is_file(follow_symlinks=False):
                add_file(entry_path, f"{prefix}{entry.name}")
            elif entry.is_dir(follow_symlinks=False):
                nested_count, examples = _count_unincluded(entry_path)
                if nested_count:
                    unincluded_dirs.append(
                        {
                            "path": f"{prefix}{entry.name}",
                            "supportedImageCount": nested_count,
                            "examples": examples,
                        }
                    )

    # 相册根目录不可读时整次扫描失败（ALB-009）；子目录读取失败记录后继续。
    scan_flat(album_dir, "", strict=True)
    try:
        root_entries = list(os.scandir(album_dir))
    except OSError as exc:
        read_errors.append({"path": ".", "error": str(exc)})
        root_entries = []
    for entry in root_entries:
        if entry.name.startswith(".") or not entry.is_dir(follow_symlinks=False):
            continue
        if entry.name.lower() not in IMAGE_DIR_NAMES:
            continue
        scan_flat(Path(entry.path), f"{entry.name}/")

    report["skippedSymlinks"] = skipped_symlinks
    report["readErrors"] = read_errors
    report["unincludedDirs"] = unincluded_dirs
    return files


def _metadata_fingerprint(files: list[FileRecord], primary: FileRecord) -> str:
    kinds = ",".join(sorted(f.kind for f in files))
    return f"{primary.relative_path}|{primary.size_bytes}|{primary.mtime_ns}|{kinds}"


def _apply_metadata(group: PhotoGroup, metadata: dict[str, Any], fingerprint: str) -> None:
    group.metadata_json = json.dumps(metadata, ensure_ascii=False) if metadata else None
    group.capture_time = metadata.get("captureTime")
    group.metadata_fingerprint = fingerprint
    prefix = group.capture_time if group.capture_time else "~"
    group.sort_key = f"{prefix}|{group.natural_key}"


def _merge_groups(
    session: Session,
    album: Album,
    guard: PathGuard,
    pairs: list[PairGroup],
    report: dict[str, Any],
    *,
    exiftool_path: str | None,
) -> tuple[list[str], dict[str, Any]]:
    existing_groups = {
        group.normalized_pair_key: group
        for group in session.scalars(
            select(PhotoGroup).where(
                PhotoGroup.album_id == album.id,
                PhotoGroup.deleted_at.is_(None),
            )
        )
    }
    existing_assets: dict[str, dict[str, Asset]] = {}
    for group in existing_groups.values():
        existing_assets[group.id] = {asset.relative_path: asset for asset in group.assets}

    metadata_jobs: list[tuple[PhotoGroup, Path, str, str]] = []
    raw_metadata_jobs: list[tuple[PhotoGroup, str, str, Path]] = []
    seen_group_ids: set[str] = set()
    new_group_count = 0
    new_asset_count = 0

    for pair in pairs:
        group = existing_groups.get(pair.pair_key)
        if group is None:
            group = PhotoGroup(
                album_id=album.id,
                normalized_pair_key=pair.pair_key,
                display_name=pair.display_name,
                natural_key=pair.natural_sort_key,
                viewed_status="unseen",
                selection_status="unmarked",
                pairing_status=PAIRING_NORMAL,
                sort_key=f"~|{pair.natural_sort_key}",
            )
            session.add(group)
            session.flush()
            existing_groups[pair.pair_key] = group
            existing_assets[group.id] = {}
            new_group_count += 1
        seen_group_ids.add(group.id)

        group.display_name = pair.display_name
        group.natural_key = pair.natural_sort_key
        if pair.is_conflict:
            group.conflict_reasons_json = json.dumps(pair.conflict_reasons, ensure_ascii=False)

        by_path = existing_assets.get(group.id, {})
        current_paths: set[str] = set()
        for file in pair.files:
            asset = by_path.get(file.relative_path)
            if asset is None:
                asset = Asset(
                    photo_group_id=group.id,
                    relative_path=file.relative_path,
                    original_filename=file.filename,
                    kind=file.kind,
                    extension=file.extension,
                    size_bytes=file.size_bytes,
                    mtime_ns=file.mtime_ns,
                    presence_status=PRESENCE_PRESENT,
                    preview_status=PREVIEW_PENDING,
                )
                session.add(asset)
                by_path[file.relative_path] = asset
                new_asset_count += 1
            else:
                changed = asset.size_bytes != file.size_bytes or asset.mtime_ns != file.mtime_ns
                asset.kind = file.kind
                asset.extension = file.extension
                asset.original_filename = file.filename
                asset.size_bytes = file.size_bytes
                asset.mtime_ns = file.mtime_ns
                if asset.presence_status == PRESENCE_MISSING:
                    asset.presence_status = PRESENCE_PRESENT
                if changed:
                    asset.content_sha256 = None
                    asset.preview_status = PREVIEW_PENDING
                    asset.preview_error = None
            current_paths.add(file.relative_path)

        for relative_path, asset in by_path.items():
            if relative_path not in current_paths:
                asset.presence_status = PRESENCE_MISSING

        present_count = len(current_paths)
        has_missing_asset = any(asset.presence_status == PRESENCE_MISSING for asset in group.assets)
        if pair.is_conflict:
            group.pairing_status = PAIRING_CONFLICT
        elif present_count == 0:
            # 应用自己清理的组保持 trashed，避免下次扫描误报成外部缺失。
            group.pairing_status = PAIRING_TRASHED if group.pairing_status == PAIRING_TRASHED else PAIRING_MISSING
        elif has_missing_asset:
            # 配对组只要缺一个文件就整体标记缺失，禁止清理/导出，等待用户恢复或重新扫描。
            group.pairing_status = PAIRING_MISSING
        else:
            # 文件重新出现在原位置（例如 Finder 从废纸篓恢复），合并原状态。
            group.pairing_status = PAIRING_NORMAL
            group.conflict_reasons_json = None

        primary = pair.primary
        primary_asset = by_path.get(primary.relative_path)
        fingerprint = _metadata_fingerprint(pair.files, primary)
        if primary_asset is not None and (group.metadata_fingerprint != fingerprint or group.metadata_json is None):
            try:
                primary_path = guard.asset_path(album.relative_path, primary.relative_path, must_exist=True)
            except Exception:  # noqa: BLE001 - 单文件异常不影响整次扫描
                primary_path = None
            if primary_path is not None:
                if primary.kind == "jpg":
                    metadata_jobs.append((group, primary_path, fingerprint, "jpg"))
                else:
                    raw_metadata_jobs.append((group, fingerprint, primary.relative_path, primary_path))

    # 数据库中存在但本次磁盘扫描未发现的逻辑照片：标记缺失，不删除状态。
    for _pair_key, group in existing_groups.items():
        if group.id in seen_group_ids:
            continue
        for asset in group.assets:
            if asset.presence_status == PRESENCE_PRESENT:
                asset.presence_status = PRESENCE_MISSING
        if group.pairing_status != PAIRING_TRASHED:
            group.pairing_status = PAIRING_MISSING

    # 元数据读取（JPG 本地解析；RAW 批量 ExifTool）
    for group, path, fingerprint, _kind in metadata_jobs:
        try:
            metadata = read_jpg_metadata(path)
        except Exception:  # noqa: BLE001
            metadata = {}
        _apply_metadata(group, metadata, fingerprint)

    if raw_metadata_jobs:
        raw_paths = [path for _group, _fp, _rel, path in raw_metadata_jobs]
        raw_results = read_raw_metadata_batch(raw_paths, exiftool_path)
        for group, fingerprint, _relative_path, raw_path in raw_metadata_jobs:
            metadata = raw_results.get(str(raw_path), {})
            _apply_metadata(group, metadata, fingerprint)

    # 对没有元数据指纹的组，保留重新读取机会（例如之后安装了 ExifTool）。
    for group, _fingerprint, _relative_path, _path in raw_metadata_jobs:
        if not group.metadata_json:
            group.metadata_fingerprint = None

    report["newGroups"] = new_group_count
    report["newAssets"] = new_asset_count

    cover = session.scalars(
        select(PhotoGroup)
        .where(
            PhotoGroup.album_id == album.id,
            PhotoGroup.pairing_status == PAIRING_NORMAL,
            PhotoGroup.deleted_at.is_(None),
            PhotoGroup.assets.any(Asset.presence_status == PRESENCE_PRESENT),
        )
        .order_by(PhotoGroup.sort_key.asc(), PhotoGroup.id.asc())
        .limit(1)
    ).first()
    album.cover_photo_id = cover.id if cover else None

    return list(seen_group_ids), report


def scan_album_with_session(
    session: Session,
    album: Album,
    *,
    settings,
    guard: PathGuard,
    trigger: str,
    record_operation: bool = True,
    exiftool_path: str | None = None,
) -> ScanOutcome:
    started = time.monotonic()
    album_id = album.id
    album.scan_status = SCAN_SCANNING
    album.updated_at = utcnow_iso()
    session.commit()

    report: dict[str, Any] = {"trigger": trigger}
    error: str | None = None
    try:
        album_dir = guard.album_dir(album.relative_path, must_exist=True)
        files = _collect_files(album_dir, report)
        if len(files) > 0:
            pairs = classify_entries(files)
            _merge_groups(session, album, guard, pairs, report, exiftool_path=exiftool_path)
        else:
            report["unincludedDirs"] = report.get("unincludedDirs", [])
            existing = session.scalars(
                select(PhotoGroup).where(PhotoGroup.album_id == album.id, PhotoGroup.deleted_at.is_(None))
            ).all()
            for group in existing:
                for asset in group.assets:
                    asset.presence_status = PRESENCE_MISSING
                if group.pairing_status != PAIRING_TRASHED:
                    group.pairing_status = PAIRING_MISSING
            album.cover_photo_id = None

        _record_scan_issues(session, album, report)
        report["fileCount"] = len(files)
        report["logicalPhotoCount"] = len(pairs) if files else 0
        album.scan_status = SCAN_EMPTY if not files else SCAN_READY
        album.scan_error = None
        album.last_scanned_at = utcnow_iso()
        album.scan_report_json = json.dumps(report, ensure_ascii=False)
        session.commit()
    except Exception as exc:  # noqa: BLE001 - 扫描失败需要落库并展示
        session.rollback()
        album = session.get(Album, album_id) or album
        error = str(exc)
        album.scan_status = SCAN_FAILED
        album.scan_error = error[:2000]
        album.last_scanned_at = utcnow_iso()
        session.commit()
        report["error"] = error

    duration_ms = int((time.monotonic() - started) * 1000)
    report["durationMs"] = duration_ms
    stats = stats_for_albums(session, [album.id]).get(album.id, _empty_counts())
    counts = dict(stats)
    if error:
        counts["total"] = stats.get("total", 0)

    if record_operation:
        _record_scan_operation(
            session,
            album,
            trigger=trigger,
            status=OP_STATUS_FAILED if error else OP_STATUS_SUCCESS,
            photo_count=report.get("logicalPhotoCount", 0),
            file_count=report.get("fileCount", 0),
            report=report,
            error=error,
            duration_ms=duration_ms,
        )
        session.commit()

    return ScanOutcome(
        album_id=album.id,
        album_name=album.name,
        status=album.scan_status,
        counts=counts,
        report=report,
        error=error,
        duration_ms=duration_ms,
    )


def discover_albums(session: Session, settings, guard: PathGuard) -> dict[str, Any]:
    """发现一级相册目录，不读取照片内容。"""

    report: dict[str, Any] = {
        "albumsFound": 0,
        "created": 0,
        "exportDirExcluded": False,
        "rootImagesIgnored": 0,
        "skippedSymlinks": [],
        "skippedHidden": 0,
        "ignoredBackups": 0,
        "errors": [],
    }
    root = settings.photo_root
    if not root.exists() or not root.is_dir():
        report["errors"].append(f"照片根目录不存在：{root}")
        return report

    existing = {
        album.relative_path: album for album in session.scalars(select(Album).where(Album.deleted_at.is_(None)))
    }
    data_dir_real = settings.data_dir.resolve()
    try:
        entries = list(os.scandir(root))
    except OSError as exc:
        report["errors"].append(f"无法读取照片根目录：{exc}")
        return report

    for entry in entries:
        name = entry.name
        if name.startswith("."):
            report["skippedHidden"] += 1
            continue
        if entry.is_symlink():
            report["skippedSymlinks"].append(name)
            continue
        if entry.is_file(follow_symlinks=False):
            if supported_kind(name):
                report["rootImagesIgnored"] += 1
            continue
        if not entry.is_dir(follow_symlinks=False):
            continue
        if name.casefold() == settings.export_dir_name.casefold():
            report["exportDirExcluded"] = True
            continue
        entry_path = Path(entry.path)
        if (entry_path / ".photo-curator-ignore").is_file():
            report["ignoredBackups"] += 1
            continue
        try:
            entry_path.resolve().relative_to(root.resolve())
        except ValueError:
            report["errors"].append(f"相册路径越界已跳过：{name}")
            continue
        if entry_path.resolve() == data_dir_real:
            continue
        album = existing.get(name)
        if album is None:
            album = Album(relative_path=name, name=name, scan_status=SCAN_PENDING)
            session.add(album)
            existing[name] = album
            report["created"] += 1
        elif album.name != name:
            album.name = name
            album.updated_at = utcnow_iso()
        report["albumsFound"] += 1

    session.commit()
    return report


def _fingerprint_path(album_id: str, kind: str, relative_path: str) -> str:
    digest = hashlib.sha1(f"{kind}:{relative_path}".encode()).hexdigest()[:16]
    return f"scan_error:{album_id}:{digest}"


def _record_scan_issues(session: Session, album: Album, report: dict[str, Any]) -> None:
    """把符号链接跳过与读取错误写入异常中心；成功扫描时清除旧记录。"""

    from .issues import record_issue, resolve_issue_prefix

    resolve_issue_prefix(session, f"scan_error:{album.id}:")
    for relative_path in report.get("skippedSymlinks", []):
        record_issue(
            session,
            album_id=album.id,
            kind=ISSUE_SCAN_ERROR,
            fingerprint=_fingerprint_path(album.id, "symlink", relative_path),
            message="检测到符号链接，出于安全原因未纳入扫描。",
            payload={"relativePath": relative_path, "reason": "symlink_skipped"},
            severity="warning",
        )
    for error in report.get("readErrors", []):
        relative_path = error.get("path", ".")
        record_issue(
            session,
            album_id=album.id,
            kind=ISSUE_SCAN_ERROR,
            fingerprint=_fingerprint_path(album.id, "read", relative_path),
            message=f"无法读取：{relative_path}。请检查文件权限。",
            payload={"relativePath": relative_path, "error": error.get("error", "")},
            severity="error",
        )


class ScanService:
    """按相册串行化扫描，避免同一相册并发写入。"""

    def __init__(self, settings, database: Database, guard: PathGuard) -> None:
        self.settings = settings
        self.database = database
        self.guard = guard
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._discovery_lock = threading.Lock()
        self._all_lock = threading.Lock()

    def album_lock(self, album_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(album_id)
            if lock is None:
                lock = threading.Lock()
                self._locks[album_id] = lock
            return lock

    def discover(self, session: Session) -> dict[str, Any]:
        with self._discovery_lock:
            return discover_albums(session, self.settings, self.guard)

    def scan_album(self, album_id: str, *, trigger: str, record_operation: bool = True) -> ScanOutcome | None:
        session = self.database.session()
        try:
            album = session.get(Album, album_id)
            if album is None or album.deleted_at is not None:
                return None
            lock = self.album_lock(album_id)
            with lock:
                return scan_album_with_session(
                    session,
                    album,
                    settings=self.settings,
                    guard=self.guard,
                    trigger=trigger,
                    record_operation=record_operation,
                    exiftool_path=self.settings.exiftool_path,
                )
        finally:
            session.close()

    def scan_all(self, *, trigger: str) -> list[ScanOutcome]:
        outcomes: list[ScanOutcome] = []
        with self._all_lock:
            session = self.database.session()
            try:
                self.discover(session)
                album_ids = list(
                    session.scalars(
                        select(Album.id).where(Album.deleted_at.is_(None)).order_by(Album.relative_path.asc())
                    )
                )
            finally:
                session.close()
            for album_id in album_ids:
                try:
                    outcome = self.scan_album(album_id, trigger=trigger)
                except Exception as exc:  # noqa: BLE001 - 单个相册失败不中断其他相册
                    session = self.database.session()
                    try:
                        album = session.get(Album, album_id)
                        name = album.name if album else album_id
                        if album is not None:
                            album.scan_status = SCAN_FAILED
                            album.scan_error = str(exc)[:2000]
                            session.commit()
                    finally:
                        session.close()
                    outcomes.append(
                        ScanOutcome(
                            album_id=album_id,
                            album_name=name,
                            status=SCAN_FAILED,
                            counts=_empty_counts(),
                            error=str(exc),
                        )
                    )
                    continue
                if outcome is not None:
                    outcomes.append(outcome)
        return outcomes
