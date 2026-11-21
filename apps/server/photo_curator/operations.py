"""操作记录（追加式）辅助函数。"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .constants import (
    OP_STATUS_FAILED,
    OP_STATUS_PARTIAL_FAILURE,
    OP_STATUS_SUCCESS,
)
from .models import Operation, OperationItem
from .natural import utcnow_iso


def create_operation(
    session: Session,
    *,
    album_id: str | None,
    type: str,
    status: str,
    idempotency_key: str | None = None,
    parent_operation_id: str | None = None,
    requested_photo_count: int = 0,
    requested_file_count: int = 0,
    request_snapshot: dict[str, Any] | None = None,
) -> Operation:
    operation = Operation(
        album_id=album_id,
        type=type,
        status=status,
        idempotency_key=idempotency_key,
        parent_operation_id=parent_operation_id,
        requested_photo_count=requested_photo_count,
        requested_file_count=requested_file_count,
        request_snapshot_json=json.dumps(request_snapshot, ensure_ascii=False) if request_snapshot else None,
        requested_at=utcnow_iso(),
    )
    session.add(operation)
    session.flush()
    return operation


def find_by_idempotency_key(session: Session, key: str) -> Operation | None:
    return session.scalars(select(Operation).where(Operation.idempotency_key == key)).first()


def operation_items(session: Session, operation_id: str) -> list[OperationItem]:
    return list(
        session.scalars(
            select(OperationItem)
            .where(OperationItem.operation_id == operation_id)
            .order_by(
                OperationItem.group_index.asc(),
                OperationItem.source_relative_path.asc(),
                OperationItem.id.asc(),
            )
        )
    )


def set_progress(
    session: Session,
    operation: Operation,
    *,
    processed_files: int,
    total_files: int,
    success: int,
    skipped: int,
    failed: int,
    conflicts: int = 0,
) -> None:
    operation.progress_json = json.dumps(
        {
            "processedFiles": processed_files,
            "totalFiles": total_files,
            "successFiles": success,
            "skippedFiles": skipped,
            "failedFiles": failed,
            "conflictFiles": conflicts,
        },
        ensure_ascii=False,
    )
    session.commit()


def finish_operation(
    session: Session,
    operation: Operation,
    *,
    status: str,
    success: int = 0,
    skipped: int = 0,
    failed: int = 0,
    conflicts: int = 0,
    error_summary: str | None = None,
) -> None:
    operation.status = status
    operation.finished_at = utcnow_iso()
    operation.success_file_count = success
    operation.skipped_file_count = skipped
    operation.failed_file_count = failed
    operation.conflict_file_count = conflicts
    operation.error_summary = error_summary
    session.commit()


def derive_status(*, total: int, success: int, failed: int, conflicts: int = 0) -> str:
    if total == 0:
        return OP_STATUS_SUCCESS
    if failed == 0 and conflicts == 0:
        return OP_STATUS_SUCCESS
    if success == 0 and failed > 0:
        return OP_STATUS_FAILED
    return OP_STATUS_PARTIAL_FAILURE


def recover_interrupted_operations(session: Session) -> int:
    """启动时把中断的执行中操作标记为“中断，需核对”，绝不当作成功。"""

    from .constants import OP_STATUS_EXECUTING, OP_STATUS_INTERRUPTED

    recovered = 0
    operations = session.scalars(select(Operation).where(Operation.status == OP_STATUS_EXECUTING)).all()
    for operation in operations:
        operation.status = OP_STATUS_INTERRUPTED
        operation.finished_at = utcnow_iso()
        operation.error_summary = "应用中断，执行结果需人工核对。"
        recovered += 1
    if recovered:
        session.commit()
    return recovered
