"""应用运行上下文：一次性构造服务对象，供路由与后台任务复用。"""

from __future__ import annotations

import threading
from dataclasses import dataclass

from .cleanup import CleanupService
from .config import Settings
from .db import Database
from .events import EventBus
from .exporting import ExportService, cleanup_stale_temp_files
from .jobs import JobManager
from .paths import PathGuard
from .previews import PreviewService
from .scanning import ScanService
from .trash import BaseTrashService, create_trash_service
from .watcher import WatcherService

DEFAULT_SETTINGS = {
    "default_sort": "capture",
    "autoplay_interval": "3",
    "cleanup_notice_seen": "0",
}


@dataclass
class AppContext:
    settings: Settings
    database: Database
    guard: PathGuard
    scan: ScanService
    previews: PreviewService
    trash: BaseTrashService
    events: EventBus
    jobs: JobManager
    cleanup: CleanupService
    exports: ExportService
    watcher: WatcherService
    startup_scan_thread: threading.Thread | None = None

    def shutdown(self) -> None:
        self.watcher.stop()
        self.jobs.shutdown()
        self.database.dispose()


def seed_settings(settings: Settings, database: Database) -> None:
    from .models import Setting
    from .natural import utcnow_iso

    with database.session() as session:
        existing = {row.key for row in session.query(Setting).all()}
        desired = {
            "photo_root": str(settings.photo_root),
            "export_dir_name": settings.export_dir_name,
            **DEFAULT_SETTINGS,
        }
        for key, value in desired.items():
            if key not in existing:
                session.add(Setting(key=key, value=value, updated_at=utcnow_iso()))
        session.commit()


def build_context(settings: Settings) -> AppContext:
    settings.ensure_directories()
    database = Database.create(settings.db_path)
    guard = PathGuard(settings.photo_root, settings.export_dir_name)
    seed_settings(settings, database)

    events = EventBus()
    jobs = JobManager(workers=settings.job_workers)
    scan = ScanService(settings, database, guard)
    previews = PreviewService(settings, guard)
    trash = create_trash_service(settings.photo_root)
    cleanup = CleanupService(settings, database, guard, scan, trash, events)
    exports = ExportService(settings, database, guard, scan, jobs, events)
    watcher = WatcherService(settings, scan, events)
    context = AppContext(
        settings=settings,
        database=database,
        guard=guard,
        scan=scan,
        previews=previews,
        trash=trash,
        events=events,
        jobs=jobs,
        cleanup=cleanup,
        exports=exports,
        watcher=watcher,
    )
    from .operations import recover_interrupted_operations

    with database.session() as session:
        recover_interrupted_operations(session)
    cleanup_stale_temp_files(settings, guard)
    return context


def bootstrap(context: AppContext, *, background_scan: bool = True) -> None:
    """启动时同步发现相册目录，再按需在后台扫描内容，避免阻塞应用启动。"""

    session = context.database.session()
    try:
        context.scan.discover(session)
    finally:
        session.close()

    if not background_scan:
        return

    def run() -> None:
        try:
            context.scan.scan_all(trigger="startup")
        except Exception:  # noqa: BLE001 - 启动扫描失败不应阻止应用运行
            pass

    thread = threading.Thread(target=run, name="photo-curator-startup-scan", daemon=True)
    thread.start()
    context.startup_scan_thread = thread
