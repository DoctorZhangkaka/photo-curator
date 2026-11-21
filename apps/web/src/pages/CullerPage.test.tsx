import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../lib/api";
import type {
  Album,
  CleanupExecuteResponse,
  CleanupPreflight,
  Photo,
  PhotoQuery,
  RestoreResponse,
} from "../lib/api";
import CullerPage from "./CullerPage";
import { makeTestAppValue, renderWithProviders } from "../test/render";

const apiMock = vi.hoisted(() => ({
  getAlbum: vi.fn(),
  rescanAlbum: vi.fn(),
  listPhotos: vi.fn(),
  getPhoto: vi.fn(),
  patchPhotoState: vi.fn(),
  cleanupPreflight: vi.fn(),
  cleanupExecute: vi.fn(),
  restoreOperation: vi.fn(),
  exportPreflight: vi.fn(),
  startExport: vi.fn(),
  getJob: vi.fn(),
  getOperation: vi.fn(),
  getIssues: vi.fn(),
  rescanIssues: vi.fn(),
  revealAsset: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: apiMock };
});

const NOW = "2026-11-22T02:00:00.000Z";

function makePhoto(id: string, displayName: string, overrides: Partial<Photo> = {}): Photo {
  return {
    id,
    albumId: "a1",
    albumName: "测试-京都旅行",
    displayName,
    normalizedPairKey: displayName.toLowerCase(),
    viewedStatus: "unseen",
    selectionStatus: "unmarked",
    pairingStatus: "normal",
    form: "jpg_only",
    captureTime: "2026-11-20T08:00:00",
    naturalKey: displayName,
    sortKey: `2026-11-20T08:00:00:${displayName}`,
    version: 1,
    conflictReasons: [],
    flags: { pairingConflict: false, missingFile: false, exportConflict: false, trashed: false },
    assets: [
      {
        id: `${id}-jpg`,
        kind: "jpg",
        extension: ".JPG",
        relativePath: `JPG/${displayName}.JPG`,
        originalFilename: `${displayName}.JPG`,
        sizeBytes: 120_000,
        mtimeNs: 1,
        presenceStatus: "present",
        previewStatus: "ok",
        previewError: null,
        contentSha256: null,
      },
    ],
    fileCount: 1,
    totalBytes: 120_000,
    primaryAssetId: `${id}-jpg`,
    thumbnailUrl: `/api/photos/${id}/thumbnail?v=1`,
    previewUrl: `/api/photos/${id}/preview?v=1`,
    originalPreviewUrl: `/api/photos/${id}/original-preview?v=1`,
    isViewed: false,
    isSelected: false,
    isPendingDelete: false,
    ...overrides,
  };
}

function makeAlbum(overrides: Partial<Album> = {}): Album {
  return {
    id: "a1",
    name: "测试-京都旅行",
    relativePath: "测试-京都旅行",
    coverPhotoId: "p1",
    coverThumbnailUrl: "/api/photos/p1/thumbnail?v=1",
    counts: {
      total: 3,
      viewed: 1,
      unseen: 2,
      selected: 1,
      pendingDelete: 1,
      missing: 0,
      conflicts: 0,
    },
    lastOpenedAt: NOW,
    lastScannedAt: NOW,
    scanStatus: "ready",
    scanError: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastScanReport: null,
    ...overrides,
  };
}

let photos: Photo[];
let album: Album;

function pageFor(query: PhotoQuery) {
  let items = photos;
  if (query.viewed && query.viewed !== "all") items = items.filter((photo) => photo.viewedStatus === query.viewed);
  if (query.selection && query.selection !== "all") {
    items = items.filter((photo) => photo.selectionStatus === query.selection);
  }
  if (query.form && query.form !== "all") items = items.filter((photo) => photo.form === query.form);
  return {
    items,
    nextCursor: null,
    total: items.length,
    sort: query.sort ?? "capture",
    limit: query.limit ?? 200,
  };
}

function blockedPreflight(): CleanupPreflight {
  return {
    albumId: "a1",
    token: "preflight-token",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    operationId: "op-preflight",
    summary: { photoCount: 1, fileCount: 1, totalBytes: 9_999, jpgCount: 1, rawCount: 0 },
    blocked: true,
    blockers: [
      {
        code: "ASSET_MISSING",
        message: "逻辑照片存在缺失文件，不能清理。",
        groupId: "p3",
        displayName: "DSCF0003",
        relativePath: "JPG/DSCF0003.JPG",
      },
    ],
    groups: [
      {
        groupId: "p3",
        displayName: "DSCF0003",
        selectionStatus: "pending_delete",
        pairingStatus: "missing",
        version: 1,
        blocked: true,
        assets: [
          {
            assetId: "p3-jpg",
            relativePath: "JPG/DSCF0003.JPG",
            kind: "jpg",
            extension: ".JPG",
            originalFilename: "DSCF0003.JPG",
            sizeBytes: 9_999,
            mtimeNs: 1,
          },
        ],
      },
    ],
    message: "存在阻止项，整批清理已禁止。请先处理异常后重新预检。",
  };
}

function cleanupResult(): CleanupExecuteResponse {
  const operation = {
    id: "op-cleanup",
    type: "cleanup" as const,
    status: "partial_failure" as const,
    albumId: "a1",
    albumName: "测试-京都旅行",
    parentOperationId: null,
    requestedAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
    requestedPhotoCount: 1,
    requestedFileCount: 1,
    successFileCount: 1,
    skippedFileCount: 0,
    failedFileCount: 0,
    conflictFileCount: 0,
    errorSummary: "一张照片的文件未能完整回滚。",
    progress: null,
    restoredAt: null,
    restoreOperationId: null,
    canRestore: true,
    requestSnapshot: null,
    createdAt: NOW,
    items: [
      {
        id: "item-1",
        operationId: "op-cleanup",
        photoGroupId: "p3",
        assetId: "p3-jpg",
        displayName: "DSCF0003",
        sourceRelativePath: "JPG/DSCF0003.JPG",
        destinationPath: "/tmp/.Trash/DSCF0003.JPG",
        sourceSizeBytes: 9_999,
        sourceMtimeNs: 1,
        contentSha256: null,
        result: "success" as const,
        errorCode: null,
        errorMessage: null,
        groupIndex: 0,
      },
    ],
  };
  return {
    operation,
    undoAvailableUntil: new Date(Date.now() + 15_000).toISOString(),
    idempotentReplay: false,
    groupSummary: { requested: 1, succeeded: 1, failed: 0 },
    seriousErrors: [
      {
        photoGroupId: "p3",
        displayName: "DSCF0003",
        sourceRelativePath: "JPG/DSCF0003.JPG",
        actualLocation: "/tmp/.Trash/DSCF0003.JPG",
        message: "回滚失败，文件可能同时存在于原位置和废纸篓。",
      },
    ],
  };
}

function restoreResult(): RestoreResponse {
  const cleanup = cleanupResult().operation;
  const restoredOperation = {
    ...cleanup,
    id: "op-restore",
    type: "restore" as const,
    status: "success" as const,
    parentOperationId: cleanup.id,
    canRestore: false,
    items: cleanup.items.map((item) => ({ ...item, id: "restore-item-1", result: "restored" as const })),
  };
  return {
    operation: restoredOperation,
    originalOperation: { ...cleanup, status: "restored", canRestore: false },
    alreadyRestored: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  photos = [
    makePhoto("p1", "DSCF0001"),
    makePhoto("p2", "DSCF0002", {
      viewedStatus: "viewed",
      selectionStatus: "selected",
      isViewed: true,
      isSelected: true,
    }),
    makePhoto("p3", "DSCF0003", {
      selectionStatus: "pending_delete",
      isPendingDelete: true,
    }),
  ];
  album = makeAlbum();

  apiMock.getAlbum.mockResolvedValue({
    album,
    photoRoot: "/tmp/pc-ui",
    exportDirName: "精选原相册",
  });
  apiMock.rescanAlbum.mockResolvedValue({ album, report: null, counts: album.counts, error: null });
  apiMock.listPhotos.mockImplementation((_albumId: string, query: PhotoQuery) =>
    Promise.resolve(pageFor(query)),
  );
  apiMock.getPhoto.mockImplementation((photoId: string) =>
    Promise.resolve({ photo: photos.find((photo) => photo.id === photoId) ?? photos[0] }),
  );
  apiMock.patchPhotoState.mockImplementation(
    (photoId: string, payload: { viewedStatus?: string; selectionStatus?: string; version: number }) => {
      const index = photos.findIndex((photo) => photo.id === photoId);
      const base = photos[index] ?? photos[0];
      const next: Photo = {
        ...base,
        viewedStatus: (payload.viewedStatus as Photo["viewedStatus"]) ?? base.viewedStatus,
        selectionStatus: (payload.selectionStatus as Photo["selectionStatus"]) ?? base.selectionStatus,
        version: payload.version + 1,
      };
      next.isViewed = next.viewedStatus === "viewed";
      next.isSelected = next.selectionStatus === "selected";
      next.isPendingDelete = next.selectionStatus === "pending_delete";
      photos[index] = next;
      return Promise.resolve({ photo: next });
    },
  );
  apiMock.cleanupPreflight.mockResolvedValue({
    albumId: "a1",
    token: null,
    expiresAt: null,
    operationId: null,
    summary: { photoCount: 0, fileCount: 0, totalBytes: 0, jpgCount: 0, rawCount: 0 },
    blocked: false,
    blockers: [],
    groups: [],
    message: "当前没有标记为待删除的照片。",
  } satisfies CleanupPreflight);
  apiMock.cleanupExecute.mockResolvedValue(cleanupResult());
  apiMock.restoreOperation.mockResolvedValue(restoreResult());
  apiMock.exportPreflight.mockResolvedValue({
    albumId: "a1",
    token: "export-token",
    expiresAt: NOW,
    operationId: "op-export",
    summary: {
      photoCount: 1,
      fileCount: 1,
      jpgCount: 1,
      rawCount: 0,
      totalBytes: 120_000,
      toCopyCount: 1,
      existingCount: 0,
      conflictCount: 0,
    },
    warnings: [],
    destinationRelativePath: "精选原相册/测试-京都旅行",
    destinationAbsolutePath: "/tmp/pc-ui/精选原相册/测试-京都旅行",
    message: "将复制 1 个文件。",
  });
  apiMock.startExport.mockResolvedValue({
    operationId: "op-export",
    jobId: "job-1",
    status: "running",
    idempotentReplay: false,
  });
  apiMock.getJob.mockResolvedValue({
    job: {
      id: "job-1",
      kind: "export",
      operationId: "op-export",
      status: "success",
      progress: {
        processedFiles: 1,
        totalFiles: 1,
        successFiles: 1,
        skippedFiles: 0,
        failedFiles: 0,
        conflictFiles: 0,
      },
      error: null,
      createdAt: NOW,
      finishedAt: NOW,
    },
  });
  apiMock.getOperation.mockRejectedValue(new Error("not used"));
  apiMock.getIssues.mockRejectedValue(new Error("not used"));
  apiMock.rescanIssues.mockRejectedValue(new Error("not used"));
  apiMock.revealAsset.mockResolvedValue({ revealed: true, relativePath: "JPG/DSCF0001.JPG" });
});

function renderCuller() {
  return renderWithProviders(
    <Routes>
      <Route path="/albums/:albumId" element={<CullerPage />} />
      <Route path="/" element={<div>library</div>} />
      <Route path="/operations" element={<div>operations</div>} />
      <Route path="/issues" element={<div>issues</div>} />
    </Routes>,
    { route: "/albums/a1", appValue: makeTestAppValue() },
  );
}

async function waitForFirstPhoto() {
  await screen.findByAltText("大图：DSCF0001");
}

describe("CullerPage 键盘与状态操作", () => {
  it("F 只切换精选状态并调用 PATCH，不执行文件操作", async () => {
    renderCuller();
    await waitForFirstPhoto();

    fireEvent.keyDown(document.body, { key: "f" });

    await waitFor(() => {
      expect(apiMock.patchPhotoState).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ selectionStatus: "selected", version: 1 }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("select-button")).toHaveAttribute("aria-pressed", "true");
    });
    expect(apiMock.cleanupExecute).not.toHaveBeenCalled();
    expect(apiMock.startExport).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "F" });
    await waitFor(() => {
      expect(apiMock.patchPhotoState).toHaveBeenLastCalledWith(
        "p1",
        expect.objectContaining({ selectionStatus: "unmarked", version: 2 }),
      );
    });
  });

  it("X / Delete 只切换待删除，不移动文件", async () => {
    renderCuller();
    await waitForFirstPhoto();

    fireEvent.keyDown(document.body, { key: "x" });
    await waitFor(() => {
      expect(apiMock.patchPhotoState).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ selectionStatus: "pending_delete", version: 1 }),
      );
    });
    expect(apiMock.cleanupExecute).not.toHaveBeenCalled();
    expect(apiMock.restoreOperation).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByTestId("pending-delete-button")).toHaveAttribute("aria-pressed", "true");
    });
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => {
      expect(apiMock.patchPhotoState).toHaveBeenLastCalledWith(
        "p1",
        expect.objectContaining({ selectionStatus: "unmarked", version: 2 }),
      );
    });
    expect(apiMock.cleanupExecute).not.toHaveBeenCalled();
  });

  it("输入框聚焦时不触发快捷键", async () => {
    renderWithProviders(
      <>
        <Routes>
          <Route path="/albums/:albumId" element={<CullerPage />} />
        </Routes>
        <label>
          测试输入
          <input aria-label="测试输入" />
        </label>
      </>,
      { route: "/albums/a1", appValue: makeTestAppValue() },
    );
    await waitForFirstPhoto();

    const input = screen.getByLabelText("测试输入");
    input.focus();
    fireEvent.keyDown(input, { key: "f" });
    fireEvent.keyDown(input, { key: "Delete" });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(apiMock.patchPhotoState).not.toHaveBeenCalled();
    expect(apiMock.cleanupExecute).not.toHaveBeenCalled();

    const sortSelect = screen.getByTestId("culler-sort");
    sortSelect.focus();
    fireEvent.keyDown(sortSelect, { key: "f" });
    fireEvent.keyDown(sortSelect, { key: "ArrowRight" });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(apiMock.patchPhotoState).not.toHaveBeenCalled();
    expect(screen.getByAltText("大图：DSCF0001")).toBeInTheDocument();
  });

  it("标记照片时暂停自动播放", async () => {
    renderCuller();
    await waitForFirstPhoto();

    fireEvent.click(screen.getByRole("button", { name: "自动播放（空格）" }));
    await screen.findByRole("button", { name: "暂停自动播放（空格）" });

    fireEvent.keyDown(document.body, { key: "f" });
    await screen.findByRole("button", { name: "自动播放（空格）" });
    await waitFor(() => {
      expect(apiMock.patchPhotoState).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ selectionStatus: "selected" }),
      );
    });
  });
});

describe("CullerPage 导航与筛选", () => {
  it("上一张/下一张边界正确，胶片栏可以跳转", async () => {
    renderCuller();
    await waitForFirstPhoto();

    const previous = screen.getByRole("button", { name: "上一张" });
    const next = screen.getByRole("button", { name: "下一张" });
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();

    fireEvent.click(next);
    await screen.findByAltText("大图：DSCF0002");
    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    await screen.findByAltText("大图：DSCF0003");
    expect(screen.getByRole("button", { name: "下一张" })).toBeDisabled();

    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(screen.getByAltText("大图：DSCF0003")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    await screen.findByAltText("大图：DSCF0002");

    fireEvent.click(screen.getByRole("option", { name: /第 1 张/ }));
    await screen.findByAltText("大图：DSCF0001");
  });

  it("切换排序保留当前照片；筛选后照片消失则回到第一张", async () => {
    renderCuller();
    await waitForFirstPhoto();
    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    await screen.findByAltText("大图：DSCF0002");

    fireEvent.change(screen.getByTestId("culler-sort"), { target: { value: "filename" } });
    await waitFor(() => {
      expect(apiMock.listPhotos).toHaveBeenLastCalledWith(
        "a1",
        expect.objectContaining({ sort: "filename" }),
      );
    });
    expect(screen.getByAltText("大图：DSCF0002")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("filter-selection"), { target: { value: "selected" } });
    await waitFor(() => {
      expect(apiMock.listPhotos).toHaveBeenLastCalledWith(
        "a1",
        expect.objectContaining({ selection: "selected" }),
      );
    });
    await waitFor(() => expect(screen.getByAltText("大图：DSCF0002")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("filter-selection"), { target: { value: "pending_delete" } });
    await waitFor(() => {
      expect(apiMock.listPhotos).toHaveBeenLastCalledWith(
        "a1",
        expect.objectContaining({ selection: "pending_delete" }),
      );
    });
    await screen.findByAltText("大图：DSCF0003");
  });

  it("大图成功加载后才标记已浏览，胶片栏缩略图加载不算", async () => {
    renderCuller();
    await waitForFirstPhoto();

    fireEvent.load(screen.getByAltText("DSCF0001"));
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(apiMock.patchPhotoState).not.toHaveBeenCalled();

    fireEvent.load(screen.getByAltText("大图：DSCF0001"));
    await waitFor(() => {
      expect(apiMock.patchPhotoState).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ viewedStatus: "viewed", version: 1 }),
      );
    });
  });

  it("自动标记已浏览遇到 409 时刷新版本并重试一次", async () => {
    const fresh: Photo = { ...photos[0], version: 2, viewedStatus: "unseen", isViewed: false };
    apiMock.getPhoto.mockResolvedValue({ photo: fresh });
    let attempts = 0;
    apiMock.patchPhotoState.mockImplementation(
      (photoId: string, payload: { viewedStatus?: string; selectionStatus?: string; version: number }) => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(
            new ApiRequestError("STALE_VERSION", "照片状态已在其他窗口更新，请刷新后重试。", 409, {
              currentVersion: 2,
            }),
          );
        }
        const base = photos.find((photo) => photo.id === photoId) ?? photos[0];
        return Promise.resolve({
          photo: {
            ...base,
            version: payload.version + 1,
            viewedStatus: "viewed",
            isViewed: true,
          },
        });
      },
    );

    renderCuller();
    await waitForFirstPhoto();
    fireEvent.load(screen.getByAltText("大图：DSCF0001"));

    await waitFor(() => expect(apiMock.patchPhotoState).toHaveBeenCalledTimes(2));
    expect(apiMock.getPhoto).toHaveBeenCalledWith("p1");
    expect(apiMock.patchPhotoState).toHaveBeenNthCalledWith(
      1,
      "p1",
      expect.objectContaining({ viewedStatus: "viewed", version: 1 }),
    );
    expect(apiMock.patchPhotoState).toHaveBeenNthCalledWith(
      2,
      "p1",
      expect.objectContaining({ viewedStatus: "viewed", version: 2 }),
    );
  });

  it("大相册的胶片栏只挂载可视区域附近的节点", async () => {
    photos = Array.from({ length: 60 }, (_, index) =>
      makePhoto(`bulk-${index}`, `BULK${String(index).padStart(4, "0")}`),
    );
    album = makeAlbum({
      counts: {
        total: 60,
        viewed: 0,
        unseen: 60,
        selected: 0,
        pendingDelete: 0,
        missing: 0,
        conflicts: 0,
      },
      coverPhotoId: photos[0].id,
    });
    apiMock.getAlbum.mockResolvedValue({ album, photoRoot: "/tmp/pc-ui", exportDirName: "精选原相册" });
    apiMock.rescanAlbum.mockResolvedValue({ album, report: null, counts: album.counts, error: null });

    renderCuller();
    await screen.findByAltText("大图：BULK0000");

    const items = screen.getAllByTestId("filmstrip-item");
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(60);
    expect(screen.getByTestId("filmstrip")).toBeInTheDocument();
  });
});

describe("清理流程", () => {
  it("有阻止项时显示警告、禁用确认并说明原因", async () => {
    apiMock.cleanupPreflight.mockResolvedValue(blockedPreflight());
    const { appValue } = renderCuller();
    await waitForFirstPhoto();

    fireEvent.click(screen.getByTestId("cleanup-button"));

    expect(await screen.findByTestId("cleanup-modal")).toBeInTheDocument();
    expect(await screen.findByText("文件将移入 macOS 废纸篓，不会永久删除。")).toBeInTheDocument();
    expect(screen.getByTestId("cleanup-blockers")).toHaveTextContent("逻辑照片存在缺失文件，不能清理。");
    expect(screen.getByTestId("cleanup-confirm")).toBeDisabled();
    expect(appValue.updateSettings).toHaveBeenCalledWith({ cleanupNoticeSeen: true });
    expect(apiMock.cleanupExecute).not.toHaveBeenCalled();
  });

  it("清理成功后展示组级统计、严重错误与 15 秒撤销入口", async () => {
    apiMock.cleanupPreflight.mockResolvedValue({
      ...blockedPreflight(),
      blocked: false,
      blockers: [],
      groups: [
        {
          groupId: "p3",
          displayName: "DSCF0003",
          selectionStatus: "pending_delete",
          pairingStatus: "normal",
          version: 1,
          blocked: false,
          assets: [
            {
              assetId: "p3-jpg",
              relativePath: "JPG/DSCF0003.JPG",
              kind: "jpg",
              extension: ".JPG",
              originalFilename: "DSCF0003.JPG",
              sizeBytes: 9_999,
              mtimeNs: 1,
            },
          ],
        },
      ],
      message: "将把 1 张逻辑照片的 1 个文件移入 macOS 废纸篓，不会永久删除。",
    });
    renderCuller();
    await waitForFirstPhoto();
    fireEvent.click(screen.getByTestId("cleanup-button"));
    await screen.findByTestId("cleanup-modal");

    fireEvent.click(screen.getByTestId("cleanup-confirm"));

    await waitFor(() => {
      expect(apiMock.cleanupExecute).toHaveBeenCalledWith("a1", {
        preflightToken: "preflight-token",
        idempotencyKey: expect.any(String),
      });
    });
    const executeCall = apiMock.cleanupExecute.mock.calls[0];
    expect(executeCall[1].idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(await screen.findByText(/严重错误：1 组文件回滚失败/)).toBeInTheDocument();
    expect(screen.getByText("成功组数")).toBeInTheDocument();
    const undo = await screen.findByTestId("cleanup-undo");
    expect(undo).toBeInTheDocument();

    fireEvent.click(undo);
    await waitFor(() => expect(apiMock.restoreOperation).toHaveBeenCalledWith("op-cleanup"));
  });
});
