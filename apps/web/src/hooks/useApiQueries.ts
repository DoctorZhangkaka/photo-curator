import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, type OperationQuery, type PhotoPage } from "../lib/api";
import { queryKeys, type PhotosKeyParams } from "../lib/queryKeys";

export function useAlbums(sort: "name" | "recent") {
  return useQuery({
    queryKey: queryKeys.albums(sort),
    queryFn: () => api.listAlbums(sort),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useAlbum(albumId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.album(albumId ?? ""),
    queryFn: () => api.getAlbum(albumId as string),
    enabled: Boolean(albumId),
    staleTime: 0,
  });
}

export function usePhotos(albumId: string | undefined, params: PhotosKeyParams) {
  return useInfiniteQuery({
    queryKey: queryKeys.photos(albumId ?? "", params),
    queryFn: ({ pageParam }) => {
      if (!albumId) throw new Error("缺少相册 ID。");
      return api.listPhotos(albumId, { ...params, cursor: pageParam });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: PhotoPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(albumId),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

export function usePhotoDetail(photoId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.photo(photoId ?? ""),
    queryFn: () => api.getPhoto(photoId as string),
    enabled: Boolean(photoId),
    staleTime: 30_000,
  });
}

export function useIssues(albumId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.issues(albumId ?? ""),
    queryFn: () => api.getIssues(albumId as string),
    enabled: Boolean(albumId),
    staleTime: 10_000,
  });
}

export function useOperations(filters: OperationQuery) {
  return useQuery({
    queryKey: queryKeys.operations(filters),
    queryFn: () => api.listOperations(filters),
    staleTime: 5_000,
    placeholderData: keepPreviousData,
  });
}

export function useOperationDetail(operationId: string | null) {
  return useQuery({
    queryKey: queryKeys.operation(operationId ?? ""),
    queryFn: () => api.getOperation(operationId as string),
    enabled: Boolean(operationId),
    staleTime: 5_000,
  });
}

export function useExportJob(jobId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.job(jobId ?? ""),
    queryFn: () => api.getJob(jobId as string),
    enabled: Boolean(jobId) && enabled,
    staleTime: 0,
    refetchInterval: (query) => {
      const job = query.state.data?.job;
      if (!job) return 500;
      return job.status === "queued" || job.status === "running" ? 500 : false;
    },
    refetchOnWindowFocus: false,
  });
}
