"""异常中心：配对冲突、文件缺失、导出冲突、RAW 预览失败、扫描错误。"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .constants import (
    ISSUE_CLEANUP_INCOMPLETE,
    ISSUE_EXPORT_CONFLICT,
    ISSUE_PREVIEW_FAILURE,
    ISSUE_SCAN_ERROR,
    PAIRING_CONFLICT,
    PAIRING_MISSING,
    PAIRING_TRASHED,
    PRESENCE_MISSING,
    SCAN_FAILED,
)
from .models import Album, Asset, ExportConflict, Issue, PhotoGroup
from .natural import utcnow_iso


def record_issue(
    session: Session,
    *,
    album_id: str | None,
    kind: str,
    fingerprint: str,
    message: str,
    payload: dict[str, Any] | None = None,
    severity: str = "warning",
    operation_id: str | None = None,
) -> Issue:
    issue = session.scalars(select(Issue).where(Issue.fingerprint == fingerprint)).first()
    now = utcnow_iso()
    if issue is None:
        issue = Issue(
            album_id=album_id,
            kind=kind,
            severity=severity,
            fingerprint=fingerprint,
            message=message,
            payload_json=json.dumps(payload, ensure_ascii=False) if payload else None,
            operation_id=operation_id,
        )
        session.add(issue)
    else:
        issue.album_id = album_id
        issue.kind = kind
        issue.severity = severity
        issue.message = message
        issue.payload_json = json.dumps(payload, ensure_ascii=False) if payload else None
        issue.operation_id = operation_id
        issue.last_seen_at = now
        issue.resolved_at = None
    session.flush()
    return issue


def resolve_issue(session: Session, fingerprint: str) -> None:
    issue = session.scalars(select(Issue).where(Issue.fingerprint == fingerprint)).first()
    if issue is not None and issue.resolved_at is None:
        issue.resolved_at = utcnow_iso()
        session.flush()


def resolve_issue_prefix(session: Session, prefix: str) -> None:
    issues = session.scalars(
        select(Issue).where(Issue.fingerprint.like(f"{prefix}%"), Issue.resolved_at.is_(None))
    ).all()
    now = utcnow_iso()
    for issue in issues:
        issue.resolved_at = now
    if issues:
        session.flush()


def _asset_ref(asset: Asset) -> dict[str, Any]:
    return {
        "assetId": asset.id,
        "relativePath": asset.relative_path,
        "originalFilename": asset.original_filename,
        "kind": asset.kind,
        "sizeBytes": asset.size_bytes,
        "presenceStatus": asset.presence_status,
    }


def list_issues(session: Session, album: Album) -> dict[str, Any]:
    groups = list(
        session.scalars(
            select(PhotoGroup).where(
                PhotoGroup.album_id == album.id,
                PhotoGroup.deleted_at.is_(None),
                PhotoGroup.pairing_status != PAIRING_TRASHED,
            )
        )
    )
    pairing_conflicts: list[dict[str, Any]] = []
    missing_files: list[dict[str, Any]] = []

    for group in groups:
        if group.pairing_status == PAIRING_CONFLICT:
            pairing_conflicts.append(
                {
                    "groupId": group.id,
                    "displayName": group.display_name,
                    "pairingStatus": group.pairing_status,
                    "conflictReasons": json.loads(group.conflict_reasons_json or "[]"),
                    "files": [_asset_ref(asset) for asset in group.assets],
                }
            )
        missing_assets = [asset for asset in group.assets if asset.presence_status == PRESENCE_MISSING]
        if group.pairing_status == PAIRING_MISSING or missing_assets:
            missing_files.append(
                {
                    "groupId": group.id,
                    "displayName": group.display_name,
                    "pairingStatus": group.pairing_status,
                    "selectionStatus": group.selection_status,
                    "missingPaths": [asset.relative_path for asset in missing_assets]
                    or [asset.relative_path for asset in group.assets],
                    "files": [_asset_ref(asset) for asset in group.assets],
                }
            )

    conflict_rows = list(session.scalars(select(ExportConflict).where(ExportConflict.album_id == album.id)))
    export_conflicts: list[dict[str, Any]] = []
    for conflict in conflict_rows:
        source_assets = list(
            session.scalars(
                select(Asset)
                .join(PhotoGroup)
                .where(
                    PhotoGroup.album_id == album.id,
                    Asset.relative_path == conflict.source_relative_path,
                )
            )
        )
        export_conflicts.append(
            {
                "id": conflict.id,
                "operationId": conflict.operation_id,
                "sourceRelativePath": conflict.source_relative_path,
                "destinationRelativePath": conflict.destination_relative_path,
                "conflictType": conflict.conflict_type,
                "sourceSizeBytes": conflict.source_size_bytes,
                "destinationSizeBytes": conflict.destination_size_bytes,
                "lastSeenAt": conflict.last_seen_at,
                "sourceAssets": [_asset_ref(asset) for asset in source_assets],
            }
        )

    app_issues = list(
        session.scalars(
            select(Issue).where(
                Issue.album_id == album.id,
                Issue.resolved_at.is_(None),
                Issue.kind.in_(
                    [
                        ISSUE_PREVIEW_FAILURE,
                        ISSUE_SCAN_ERROR,
                        ISSUE_CLEANUP_INCOMPLETE,
                        ISSUE_EXPORT_CONFLICT,
                    ]
                ),
            )
        )
    )
    preview_failures = []
    scan_errors = []
    cleanup_incomplete = []
    for issue in app_issues:
        payload = json.loads(issue.payload_json) if issue.payload_json else {}
        entry = {
            "id": issue.id,
            "kind": issue.kind,
            "severity": issue.severity,
            "message": issue.message,
            "operationId": issue.operation_id,
            "lastSeenAt": issue.last_seen_at,
            "payload": payload,
        }
        if issue.kind == ISSUE_PREVIEW_FAILURE:
            preview_failures.append(entry)
        elif issue.kind == ISSUE_SCAN_ERROR:
            scan_errors.append(entry)
        elif issue.kind == ISSUE_CLEANUP_INCOMPLETE:
            cleanup_incomplete.append(entry)
        elif issue.kind == ISSUE_EXPORT_CONFLICT:
            # 导出冲突以 export_conflicts 表为主，避免重复展示。
            continue
    if album.scan_status == SCAN_FAILED and album.scan_error:
        scan_errors.append(
            {
                "id": f"scan-{album.id}",
                "kind": ISSUE_SCAN_ERROR,
                "severity": "error",
                "message": album.scan_error,
                "operationId": None,
                "lastSeenAt": album.last_scanned_at,
                "payload": {},
            }
        )

    counts = {
        "pairingConflicts": len(pairing_conflicts),
        "missingFiles": len(missing_files),
        "exportConflicts": len(export_conflicts),
        "previewFailures": len(preview_failures),
        "scanErrors": len(scan_errors),
        "cleanupIncomplete": len(cleanup_incomplete),
    }
    return {
        "albumId": album.id,
        "albumName": album.name,
        "counts": counts,
        "total": sum(counts.values()),
        "pairingConflicts": pairing_conflicts,
        "missingFiles": missing_files,
        "exportConflicts": export_conflicts,
        "previewFailures": preview_failures,
        "scanErrors": scan_errors,
        "cleanupIncomplete": cleanup_incomplete,
    }


def upsert_export_conflict(
    session: Session,
    *,
    album_id: str,
    source_relative_path: str,
    destination_relative_path: str,
    operation_id: str,
    source_size: int | None,
    destination_size: int | None,
) -> ExportConflict:
    conflict = session.scalars(
        select(ExportConflict).where(
            ExportConflict.album_id == album_id,
            ExportConflict.source_relative_path == source_relative_path,
            ExportConflict.destination_relative_path == destination_relative_path,
        )
    ).first()
    if conflict is None:
        conflict = ExportConflict(
            album_id=album_id,
            source_relative_path=source_relative_path,
            destination_relative_path=destination_relative_path,
            operation_id=operation_id,
            conflict_type="same_name_different_content",
            source_size_bytes=source_size,
            destination_size_bytes=destination_size,
        )
        session.add(conflict)
    else:
        conflict.operation_id = operation_id
        conflict.source_size_bytes = source_size
        conflict.destination_size_bytes = destination_size
        conflict.last_seen_at = utcnow_iso()
    session.flush()
    return conflict


def clear_export_conflict(
    session: Session, *, album_id: str, source_relative_path: str, destination_relative_path: str
) -> None:
    conflict = session.scalars(
        select(ExportConflict).where(
            ExportConflict.album_id == album_id,
            ExportConflict.source_relative_path == source_relative_path,
            ExportConflict.destination_relative_path == destination_relative_path,
        )
    ).first()
    if conflict is not None:
        session.delete(conflict)
        session.flush()
