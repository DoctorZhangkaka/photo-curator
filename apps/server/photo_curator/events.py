"""进程内事件总线，用于 SSE 通知相册变化与任务进度。"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

from .natural import utcnow_iso


class EventBus:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: dict[str, set[asyncio.Queue[str]]] = {}
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, album_id: str) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=64)
        with self._lock:
            self._subscribers.setdefault(album_id, set()).add(queue)
        return queue

    def unsubscribe(self, album_id: str, queue: asyncio.Queue[str]) -> None:
        with self._lock:
            subscribers = self._subscribers.get(album_id)
            if subscribers is not None:
                subscribers.discard(queue)
                if not subscribers:
                    self._subscribers.pop(album_id, None)

    def publish(self, album_id: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
        message = json.dumps(
            {"type": event_type, "albumId": album_id, "at": utcnow_iso(), **(payload or {})},
            ensure_ascii=False,
        )
        with self._lock:
            queues = list(self._subscribers.get(album_id, ()))
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        for queue in queues:
            try:
                loop.call_soon_threadsafe(self._offer, queue, message)
            except RuntimeError:
                continue

    @staticmethod
    def _offer(queue: asyncio.Queue[str], message: str) -> None:
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            # 慢消费者：丢弃最旧的事件，保证服务端永不阻塞。
            try:
                queue.get_nowait()
                queue.put_nowait(message)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass
