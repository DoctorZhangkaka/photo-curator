import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Photo } from "../../lib/api";
import { Filmstrip } from "./Filmstrip";

function makePhoto(index: number): Photo {
  return {
    id: `p${index}`,
    albumId: "a1",
    albumName: "测试",
    displayName: `DSCF${String(index).padStart(4, "0")}`,
    normalizedPairKey: `dscf${index}`,
    viewedStatus: "unseen",
    selectionStatus: "unmarked",
    pairingStatus: "normal",
    form: "jpg_only",
    captureTime: "2026-11-22T10:00:00",
    naturalKey: `dscf${index}`,
    sortKey: `2026-11-22T10:00:00|dscf${index}`,
    version: 1,
    conflictReasons: [],
    flags: { pairingConflict: false, missingFile: false, exportConflict: false, trashed: false },
    assets: [],
    fileCount: 1,
    totalBytes: 100,
    primaryAssetId: null,
    thumbnailUrl: `/api/photos/p${index}/thumbnail?v=1`,
    previewUrl: `/api/photos/p${index}/preview?v=1`,
    originalPreviewUrl: `/api/photos/p${index}/original-preview?v=1`,
    isViewed: false,
    isSelected: false,
    isPendingDelete: false,
  };
}

const photos = Array.from({ length: 30 }, (_, index) => makePhoto(index + 1));

beforeAll(() => {
  // jsdom 不实现平滑滚动；批次按钮只需要验证滚动调用。
  Object.defineProperty(HTMLElement.prototype, "scrollBy", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("Filmstrip 批次导航", () => {
  it("左右批次按钮存在，起始位置禁用向左、启用向右", async () => {
    render(
      <Filmstrip
        photos={photos}
        total={photos.length}
        currentIndex={0}
        onSelect={() => undefined}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={() => undefined}
      />,
    );
    const previous = screen.getByTestId("filmstrip-prev-batch");
    const next = screen.getByTestId("filmstrip-next-batch");
    expect(previous).toBeDisabled();
    expect(next).toBeInTheDocument();
    expect(next).toHaveAccessibleName("下一批缩略图");
  });

  it("点击向右按钮按视口宽度滚动，而不是只移动一张", async () => {
    const scrollBy = vi.mocked(HTMLElement.prototype.scrollBy);
    scrollBy.mockClear();
    render(
      <Filmstrip
        photos={photos}
        total={photos.length}
        currentIndex={0}
        onSelect={() => undefined}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={() => undefined}
      />,
    );
    const strip = screen.getByTestId("filmstrip");
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 720 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 3060 });
    const next = screen.getByTestId("filmstrip-next-batch");
    fireEvent.click(next);
    await waitFor(() => expect(scrollBy).toHaveBeenCalled());
    const call = scrollBy.mock.calls.at(-1)?.[0] as ScrollToOptions | undefined;
    expect(call?.left).toBeGreaterThan(102 * 2);
    expect(call?.behavior).toBe("smooth");
  });
});
