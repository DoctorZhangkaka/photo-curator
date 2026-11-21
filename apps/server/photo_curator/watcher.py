"""外部文件变化监听。

- 只监听当前打开的相册（递归监听，但只接受相册根目录与 RAW/JPG 一级子目录的事件）；
- 事件去抖后触发完整校对扫描，事件本身不直接修改状态；
- 扫描在后台线程执行，不阻塞 HTTP；
- 监听只是提示，最终以完整扫描为准。
"""

from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from .config import Settings
from .constants import SUPPORTED_EXTENSIONS
from .scanning import ScanService


class _AlbumEventHandler(FileSystemEventHandler):
    def __init__(self, service: WatcherService, album_id: str, album_dir: Path) -> None:
        self.service = service
        self.album_id = album_id
        self.album_dir = album_dir
        self._timer: threading.Timer | None = None
        self._timer_lock = threading.Lock()
        self._stopped = False

    def _relevant(self, raw_path: str) -> bool:
        try:
            relative = Path(os.path.relpath(raw_path, self.album_dir))
        except ValueError:
            return False
        parts = relative.parts
        if not parts or any(part.startswith(".") for part in parts):
            return False
        if len(parts) > 2:
            return False
        if len(parts) == 2 and parts[0].lower() not in {"raw", "jpg"}:
            return False
        if len(parts) == 1:
            return True
        return Path(parts[-1]).suffix.lower() in SUPPORTED_EXTENSIONS

    def _schedule(self, raw_path: str) -> None:
        if self._stopped or not self._relevant(raw_path):
            return
        with self._timer_lock:
            if self._timer is not None:
                self._timer.cancel()
            delay = self.service.settings.scan_debounce_ms / 1000.0
            self._timer = threading.Timer(delay, self._fire)
            self._timer.daemon = True
            self._timer.start()

    def _fire(self) -> None:
        if self._stopped:
            return
        self.service._request_scan(self.album_id)

    def stop(self) -> None:
        self._stopped = True
        with self._timer_lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.event_type in {"opened", "closed_no_write"}:
            return
        self._schedule(event.src_path)
        destination = getattr(event, "dest_path", "")
        if destination:
            self._schedule(destination)


class WatcherService:
    def __init__(
        self,
        settings: Settings,
        scan_service: ScanService,
        events=None,  # noqa: ANN001
    ) -> None:
        self.settings = settings
        self.scan_service = scan_service
        self.events = events
        self._observer: Observer | None = None
        self._lock = threading.Lock()
        self._current_album_id: str | None = None
        self._current_watch = None
        self._handler: _AlbumEventHandler | None = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="photo-curator-watch")
        self._pending = False

    def _ensure_observer(self) -> Observer:
        if self._observer is None:
            self._observer = Observer()
            self._observer.daemon = True
            self._observer.start()
        return self._observer

    def watch_album(self, album_id: str, album_dir: Path) -> None:
        if not album_dir.is_dir():
            return
        with self._lock:
            if self._current_album_id == album_id:
                return
            self._stop_current()
            handler = _AlbumEventHandler(self, album_id, album_dir)
            try:
                watch = self._ensure_observer().schedule(handler, str(album_dir), recursive=True)
            except OSError:
                return
            self._current_album_id = album_id
            self._current_watch = watch
            self._handler = handler

    def _stop_current(self) -> None:
        if self._handler is not None:
            self._handler.stop()
        if self._observer is not None and self._current_watch is not None:
            try:
                self._observer.unschedule(self._current_watch)
            except Exception:  # noqa: BLE001 - 已移除或 observer 已停止
                pass
        self._current_album_id = None
        self._current_watch = None
        self._handler = None

    def _request_scan(self, album_id: str) -> None:
        with self._lock:
            if self._current_album_id != album_id:
                return
            if self._pending:
                return
            self._pending = True

        def run() -> None:
            try:
                outcome = self.scan_service.scan_album(album_id, trigger="watcher")
                if outcome is not None and self.events is not None:
                    self.events.publish(
                        album_id,
                        "album_changed",
                        {
                            "status": outcome.status,
                            "counts": outcome.counts,
                            "durationMs": outcome.duration_ms,
                        },
                    )
            finally:
                with self._lock:
                    self._pending = False

        self._executor.submit(run)

    def stop(self) -> None:
        with self._lock:
            self._stop_current()
            if self._observer is not None:
                self._observer.stop()
                self._observer.join(timeout=3)
                self._observer = None
        self._executor.shutdown(wait=False, cancel_futures=True)
