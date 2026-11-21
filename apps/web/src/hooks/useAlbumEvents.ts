import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys";

/**
 * 在照片筛选器中订阅当前相册的 SSE 事件。
 * 任何事件只做缓存失效（不依赖事件内容做局部更新），并做 250ms 去抖。
 */
export function useAlbumEvents(albumId: string | undefined, enabled = true) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!albumId || !enabled) return;
    if (typeof EventSource === "undefined") return;

    let debounce: number | undefined;
    const source = new EventSource(`/api/albums/${encodeURIComponent(albumId)}/events`);

    const invalidate = () => {
      if (debounce !== undefined) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["photos", albumId] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.album(albumId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues(albumId) });
        void queryClient.invalidateQueries({ queryKey: ["operations"] });
        void queryClient.invalidateQueries({ queryKey: ["albums"] });
      }, 250);
    };

    source.onmessage = invalidate;
    // EventSource 会自行重连；这里不弹重复错误，避免打断浏览。
    source.onerror = () => undefined;

    return () => {
      if (debounce !== undefined) window.clearTimeout(debounce);
      source.close();
    };
  }, [albumId, enabled, queryClient]);
}
