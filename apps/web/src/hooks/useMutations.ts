import { useMutation, useQueryClient, type InfiniteData, type QueryKey } from "@tanstack/react-query";
import {
  api,
  isApiError,
  type AlbumResponse,
  type CleanupExecuteResponse,
  type IssuesResponse,
  type OperationDetailResponse,
  type Photo,
  type PhotoDetailResponse,
  type PhotoPage,
  type PhotoStatePatch,
  type RescanAlbumResponse,
  type RescanAllResponse,
  type RestoreResponse,
  type RevealResponse,
  type SelectionStatus,
  type ViewedStatus,
} from "../lib/api";
import { queryKeys } from "../lib/queryKeys";

interface PhotoStateVars {
  photoId: string;
  version: number;
  viewedStatus?: ViewedStatus;
  selectionStatus?: SelectionStatus;
}

function applyState(photo: Photo, vars: PhotoStateVars): Photo {
  const viewedStatus = vars.viewedStatus ?? photo.viewedStatus;
  const selectionStatus = vars.selectionStatus ?? photo.selectionStatus;
  return {
    ...photo,
    viewedStatus,
    selectionStatus,
    version: photo.version + 1,
    isViewed: viewedStatus === "viewed",
    isSelected: selectionStatus === "selected",
    isPendingDelete: selectionStatus === "pending_delete",
  };
}

function findCachedPhoto(
  queryClient: ReturnType<typeof useQueryClient>,
  albumId: string,
  photoId: string,
): Photo | undefined {
  const cachedLists = queryClient.getQueriesData<InfiniteData<PhotoPage>>({
    queryKey: ["photos", albumId],
  });
  for (const [, data] of cachedLists) {
    const photo = data?.pages.flatMap((page) => page.items).find((item) => item.id === photoId);
    if (photo) return photo;
  }
  return queryClient.getQueryData<PhotoDetailResponse>(queryKeys.photo(photoId))?.photo;
}

function updatePhotoInCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  albumId: string,
  photo: Photo,
): void {
  queryClient.setQueriesData<InfiniteData<PhotoPage>>({ queryKey: ["photos", albumId] }, (data) => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map((page) => {
      let pageChanged = false;
      const items = page.items.map((item) => {
        if (item.id !== photo.id) return item;
        // 迟到的响应不得覆盖更新的本地版本。
        if (item.version > photo.version) return item;
        changed = true;
        pageChanged = true;
        return photo;
      });
      return pageChanged ? { ...page, items } : page;
    });
    return changed ? { ...data, pages } : data;
  });
  const existingDetail = queryClient.getQueryData<PhotoDetailResponse>(queryKeys.photo(photo.id));
  if (!existingDetail || existingDetail.photo.version <= photo.version) {
    queryClient.setQueryData<PhotoDetailResponse>(queryKeys.photo(photo.id), { photo });
  }
}

/**
 * 照片状态更新（乐观锁）。
 *
 * - 使用当前照片的 version；
 * - 先做本地乐观更新，版本 +1 与服务端一致；
 * - 失败时回滚；409 STALE_VERSION 额外刷新缓存，绝不静默覆盖。
 */
export function usePhotoStateMutation(albumId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: PhotoStateVars) => {
      const payload: PhotoStatePatch = { version: vars.version };
      if (vars.viewedStatus) payload.viewedStatus = vars.viewedStatus;
      if (vars.selectionStatus) payload.selectionStatus = vars.selectionStatus;
      return api.patchPhotoState(vars.photoId, payload);
    },
    onMutate: async (vars) => {
      if (!albumId) return { snapshots: [] as Array<[QueryKey, unknown]> };
      await queryClient.cancelQueries({ queryKey: ["photos", albumId] });
      const snapshots: Array<[QueryKey, unknown]> = [
        ...queryClient.getQueriesData({ queryKey: ["photos", albumId] }),
      ];
      const detail = queryClient.getQueryData<PhotoDetailResponse>(queryKeys.photo(vars.photoId));
      if (detail) snapshots.push([queryKeys.photo(vars.photoId), detail]);

      const current = findCachedPhoto(queryClient, albumId, vars.photoId);
      if (current) updatePhotoInCaches(queryClient, albumId, applyState(current, vars));
      if (detail) {
        // 保留详情中的 EXIF，只合并两个状态维度。
        queryClient.setQueryData<PhotoDetailResponse>(queryKeys.photo(vars.photoId), {
          photo: applyState(detail.photo, vars),
        });
      }
      return { snapshots };
    },
    onError: (error, vars, context) => {
      if (context?.snapshots) {
        for (const [key, data] of context.snapshots) queryClient.setQueryData(key, data);
      }
      if (isApiError(error) && error.code === "STALE_VERSION" && albumId) {
        void queryClient.invalidateQueries({ queryKey: ["photos", albumId] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.photo(vars.photoId) });
      }
    },
    onSuccess: (response, vars) => {
      const albumKey = albumId ? queryKeys.album(albumId) : null;
      if (albumId) updatePhotoInCaches(queryClient, albumId, response.photo);
      else queryClient.setQueryData<PhotoDetailResponse>(queryKeys.photo(vars.photoId), response);
      if (albumKey) void queryClient.invalidateQueries({ queryKey: albumKey });
      void queryClient.invalidateQueries({ queryKey: ["albums"] });
    },
  });
}

export function useRescanAllAlbums() {
  const queryClient = useQueryClient();
  return useMutation<RescanAllResponse, unknown, void>({
    mutationFn: () => api.rescanAllAlbums(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["albums"] });
      void queryClient.invalidateQueries({ queryKey: ["photos"] });
      void queryClient.invalidateQueries({ queryKey: ["album"] });
      void queryClient.invalidateQueries({ queryKey: ["issues"] });
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });
}

export function useRescanAlbum(albumId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<RescanAlbumResponse, unknown, void>({
    mutationFn: () => {
      if (!albumId) throw new Error("缺少相册 ID。");
      return api.rescanAlbum(albumId);
    },
    onSuccess: (response) => {
      if (!albumId) return;
      queryClient.setQueryData<AlbumResponse>(queryKeys.album(albumId), (current) =>
        current ? { ...current, album: response.album } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["albums"] });
      void queryClient.invalidateQueries({ queryKey: ["photos", albumId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues(albumId) });
    },
  });
}

export function useRevealAsset() {
  return useMutation<RevealResponse, unknown, string>({
    mutationFn: (assetId) => api.revealAsset(assetId),
  });
}

export function useRescanIssues(albumId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<IssuesResponse, unknown, void>({
    mutationFn: () => {
      if (!albumId) throw new Error("缺少相册 ID。");
      return api.rescanIssues(albumId);
    },
    onSuccess: (response) => {
      if (!albumId) return;
      queryClient.setQueryData<IssuesResponse>(queryKeys.issues(albumId), response);
      void queryClient.invalidateQueries({ queryKey: ["albums"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.album(albumId) });
      void queryClient.invalidateQueries({ queryKey: ["photos", albumId] });
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });
}

export function useRestoreOperation() {
  const queryClient = useQueryClient();
  return useMutation<RestoreResponse, unknown, string>({
    mutationFn: (operationId) => api.restoreOperation(operationId),
    onSuccess: (response) => {
      if (response.operation) {
        queryClient.setQueryData<OperationDetailResponse>(queryKeys.operation(response.operation.id), {
          operation: response.operation,
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.operation(response.operation.id) });
      }
      queryClient.setQueryData<OperationDetailResponse>(
        queryKeys.operation(response.originalOperation.id),
        { operation: response.originalOperation },
      );
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
      void queryClient.invalidateQueries({ queryKey: ["albums"] });
      void queryClient.invalidateQueries({ queryKey: ["photos"] });
      void queryClient.invalidateQueries({ queryKey: ["album"] });
      void queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
  });
}

export type CleanupExecuteMutation = ReturnType<typeof useCleanupExecute>;
export function useCleanupExecute(albumId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<
    CleanupExecuteResponse,
    unknown,
    { token: string; idempotencyKey: string }
  >({
    mutationFn: ({ token, idempotencyKey }) => {
      if (!albumId) throw new Error("缺少相册 ID。");
      return api.cleanupExecute(albumId, { preflightToken: token, idempotencyKey });
    },
    onSuccess: () => {
      if (albumId) {
        void queryClient.invalidateQueries({ queryKey: ["photos", albumId] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.album(albumId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues(albumId) });
      }
      void queryClient.invalidateQueries({ queryKey: ["albums"] });
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });
}

export type ExportStartMutation = ReturnType<typeof useExportStart>;
export function useExportStart(albumId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<
    Awaited<ReturnType<typeof api.startExport>>,
    unknown,
    { token: string; idempotencyKey: string }
  >({
    mutationFn: ({ token, idempotencyKey }) => {
      if (!albumId) throw new Error("缺少相册 ID。");
      return api.startExport(albumId, { preflightToken: token, idempotencyKey });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
      if (albumId) void queryClient.invalidateQueries({ queryKey: queryKeys.issues(albumId) });
    },
  });
}
