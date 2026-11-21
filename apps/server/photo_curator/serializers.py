"""API 序列化：统一 camelCase，原始文件名与大小写保持不变。"""

from __future__ import annotations

import json
from typing import Any

from .constants import (
    PAIRING_CONFLICT,
    PAIRING_MISSING,
    PAIRING_TRASHED,
    PRESENCE_MISSING,
    SELECTION_PENDING_DELETE,
    SELECTION_SELECTED,
    VIEWED_SEEN,
)
from .models import Album, Asset, Operation, OperationItem, PhotoGroup


def _json_or_none(raw: str | None) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def asset_to_dict(asset: Asset) -> dict[str, Any]:
    return {
        "id": asset.id,
        "kind": asset.kind,
        "extension": asset.extension,
        "relativePath": asset.relative_path,
        "originalFilename": asset.original_filename,
        "sizeBytes": asset.size_bytes,
        "mtimeNs": asset.mtime_ns,
        "presenceStatus": asset.presence_status,
        "previewStatus": asset.preview_status,
        "previewError": asset.preview_error,
        "contentSha256": asset.content_sha256,
    }


def _primary_asset(group: PhotoGroup) -> Asset | None:
    present = [asset for asset in group.assets if asset.presence_status != PRESENCE_MISSING]
    if not present:
        present = list(group.assets)
    if not present:
        return None
    present.sort(key=lambda a: (0 if a.kind == "jpg" else 1, a.relative_path))
    return present[0]


def photo_to_dict(
    group: PhotoGroup,
    *,
    export_conflict_paths: set[str] | None = None,
    include_exif: bool = False,
    album_name: str | None = None,
) -> dict[str, Any]:
    assets = sorted(group.assets, key=lambda a: (0 if a.kind == "jpg" else 1, a.relative_path))
    primary = _primary_asset(group)
    conflict_paths = export_conflict_paths or set()
    flags = {
        "pairingConflict": group.pairing_status == PAIRING_CONFLICT,
        "missingFile": group.pairing_status == PAIRING_MISSING
        or any(asset.presence_status == PRESENCE_MISSING for asset in assets),
        "exportConflict": any(asset.relative_path in conflict_paths for asset in assets),
        "trashed": group.pairing_status == PAIRING_TRASHED,
    }
    version_token = f"{primary.size_bytes}-{primary.mtime_ns}" if primary else str(group.version)
    has_jpg = any(a.kind == "jpg" for a in assets)
    has_raw = any(a.kind == "raw" for a in assets)
    if has_jpg and has_raw:
        form = "jpg_raw"
    elif has_jpg:
        form = "jpg_only"
    elif has_raw:
        form = "raw_only"
    else:
        form = None
    payload: dict[str, Any] = {
        "id": group.id,
        "albumId": group.album_id,
        "albumName": album_name,
        "displayName": group.display_name,
        "normalizedPairKey": group.normalized_pair_key,
        "viewedStatus": group.viewed_status,
        "selectionStatus": group.selection_status,
        "pairingStatus": group.pairing_status,
        "form": form,
        "captureTime": group.capture_time,
        "naturalKey": group.natural_key,
        "sortKey": group.sort_key,
        "version": group.version,
        "conflictReasons": _json_or_none(group.conflict_reasons_json) or [],
        "flags": flags,
        "assets": [asset_to_dict(asset) for asset in assets],
        "fileCount": len(assets),
        "totalBytes": sum(asset.size_bytes for asset in assets),
        "primaryAssetId": primary.id if primary else None,
        "thumbnailUrl": f"/api/photos/{group.id}/thumbnail?v={version_token}",
        "previewUrl": f"/api/photos/{group.id}/preview?v={version_token}",
        "originalPreviewUrl": f"/api/photos/{group.id}/original-preview?v={version_token}",
        "isViewed": group.viewed_status == VIEWED_SEEN,
        "isSelected": group.selection_status == SELECTION_SELECTED,
        "isPendingDelete": group.selection_status == SELECTION_PENDING_DELETE,
    }
    if include_exif:
        payload["exif"] = _json_or_none(group.metadata_json) or {}
    return payload


def album_to_dict(album: Album, counts: dict[str, int], *, cover_url: str | None = None) -> dict[str, Any]:
    return {
        "id": album.id,
        "name": album.name,
        "relativePath": album.relative_path,
        "coverPhotoId": album.cover_photo_id,
        "coverThumbnailUrl": cover_url
        or (f"/api/photos/{album.cover_photo_id}/thumbnail" if album.cover_photo_id else None),
        "counts": counts,
        "lastOpenedAt": album.last_opened_at,
        "lastScannedAt": album.last_scanned_at,
        "scanStatus": album.scan_status,
        "scanError": album.scan_error,
        "createdAt": album.created_at,
        "updatedAt": album.updated_at,
        "lastScanReport": _json_or_none(album.scan_report_json),
    }


def operation_item_to_dict(item: OperationItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "operationId": item.operation_id,
        "photoGroupId": item.photo_group_id,
        "assetId": item.asset_id,
        "displayName": item.display_name,
        "sourceRelativePath": item.source_relative_path,
        "destinationPath": item.destination_path_snapshot,
        "sourceSizeBytes": item.source_size_bytes,
        "sourceMtimeNs": item.source_mtime_ns,
        "contentSha256": item.content_sha256,
        "result": item.result,
        "errorCode": item.error_code,
        "errorMessage": item.error_message,
        "groupIndex": item.group_index,
    }


def operation_to_dict(
    operation: Operation,
    *,
    album_name: str | None = None,
    items: list[OperationItem] | None = None,
    include_items: bool = True,
    can_restore: bool = False,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": operation.id,
        "type": operation.type,
        "status": operation.status,
        "albumId": operation.album_id,
        "albumName": album_name,
        "parentOperationId": operation.parent_operation_id,
        "requestedAt": operation.requested_at,
        "startedAt": operation.started_at,
        "finishedAt": operation.finished_at,
        "requestedPhotoCount": operation.requested_photo_count,
        "requestedFileCount": operation.requested_file_count,
        "successFileCount": operation.success_file_count,
        "skippedFileCount": operation.skipped_file_count,
        "failedFileCount": operation.failed_file_count,
        "conflictFileCount": operation.conflict_file_count,
        "errorSummary": operation.error_summary,
        "progress": _json_or_none(operation.progress_json),
        "restoredAt": operation.restored_at,
        "restoreOperationId": operation.restore_operation_id,
        "canRestore": can_restore,
        "requestSnapshot": _json_or_none(operation.request_snapshot_json),
        "createdAt": operation.created_at,
    }
    if include_items:
        payload["items"] = [operation_item_to_dict(item) for item in (items or [])]
    return payload
