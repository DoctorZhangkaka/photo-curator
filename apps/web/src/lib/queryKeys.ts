import type { FormFilter, IssueFilter, SelectionFilter, SortMode, ViewFilter } from "./api";

export interface PhotoFilters {
  viewed: ViewFilter;
  selection: SelectionFilter;
  form: FormFilter;
  issue: IssueFilter;
}

export const DEFAULT_FILTERS: PhotoFilters = {
  viewed: "all",
  selection: "all",
  form: "all",
  issue: "all",
};

export interface PhotosKeyParams extends PhotoFilters {
  sort: SortMode;
}

export const queryKeys = {
  session: ["session"] as const,
  config: ["config"] as const,
  settings: ["settings"] as const,
  albums: (sort: "name" | "recent") => ["albums", sort] as const,
  album: (albumId: string) => ["album", albumId] as const,
  photos: (albumId: string, params: PhotosKeyParams) => ["photos", albumId, params] as const,
  photo: (photoId: string) => ["photo", photoId] as const,
  issues: (albumId: string) => ["issues", albumId] as const,
  operations: <T extends object>(params: T) => ["operations", params] as const,
  operation: (operationId: string) => ["operation", operationId] as const,
  job: (jobId: string) => ["job", jobId] as const,
};
