"""后台任务（导出等）管理器。任务状态在内存中，操作结果持久化在数据库。"""

from __future__ import annotations

import threading
import traceback
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from .natural import utcnow_iso


@dataclass
class JobRecord:
    id: str
    kind: str
    operation_id: str | None
    status: str = "queued"  # queued / running / success / failed
    progress: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    created_at: str = field(default_factory=utcnow_iso)
    finished_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "operationId": self.operation_id,
            "status": self.status,
            "progress": self.progress,
            "error": self.error,
            "createdAt": self.created_at,
            "finishedAt": self.finished_at,
        }


class JobManager:
    def __init__(self, workers: int = 2) -> None:
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="photo-curator-job")
        self._jobs: dict[str, JobRecord] = {}
        self._by_operation: dict[str, str] = {}
        self._lock = threading.Lock()

    def submit(self, *, kind: str, operation_id: str | None, run: Callable[[JobRecord], None]) -> str:
        import uuid

        job_id = str(uuid.uuid4())
        record = JobRecord(id=job_id, kind=kind, operation_id=operation_id)
        with self._lock:
            self._jobs[job_id] = record
            if operation_id:
                self._by_operation[operation_id] = job_id

        def wrapper() -> None:
            with self._lock:
                record.status = "running"
            try:
                run(record)
            except Exception as exc:  # noqa: BLE001 - 任务异常必须记录并暴露
                record.status = "failed"
                record.error = f"{exc}\n{traceback.format_exc(limit=3)}"[:2000]
            else:
                if record.status == "running":
                    record.status = "success"
            finally:
                record.finished_at = utcnow_iso()
                with self._lock:
                    if record.status == "running":
                        record.status = "success"

        self._executor.submit(wrapper)
        return job_id

    def update_progress(self, job_id: str, progress: dict[str, Any]) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if record is not None:
                record.progress = progress

    def get(self, job_id: str) -> JobRecord | None:
        with self._lock:
            return self._jobs.get(job_id)

    def for_operation(self, operation_id: str) -> JobRecord | None:
        with self._lock:
            job_id = self._by_operation.get(operation_id)
            return self._jobs.get(job_id) if job_id else None

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
