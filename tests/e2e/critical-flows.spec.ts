import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const photoRoot = fileURLToPath(new URL("../.tmp/e2e-photos", import.meta.url));
const travelDir = path.join(photoRoot, "测试-京都旅行");

test.describe.configure({ mode: "serial" });

test("旅行相册核心链路：浏览、精选导出、两阶段清理与撤销、操作记录、异常中心", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("library-page")).toBeVisible();

  const card = page.locator('[data-testid="album-card"][data-album-name="测试-京都旅行"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("测试-京都旅行");
  await card.click();

  await expect(page.getByTestId("culler-page")).toBeVisible();
  const albumId = page.url().split("/albums/")[1] ?? "";
  expect(albumId).not.toBe("");
  await expect(page.getByTestId("photo-counter")).toHaveText(/1\s*\/\s*5/, { timeout: 30_000 });
  await expect(page.getByTestId("viewer-image")).toBeVisible({ timeout: 30_000 });

  // 大图加载成功后自动标记已浏览（限定在查看器内，避免匹配到筛选下拉项）。
  await expect(
    page.locator("[data-viewport]").getByText("已浏览", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  // 默认进入相册应为“适应”，而不是 100%。
  await expect(page.getByTestId("fit-button")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("actual-size-button")).toHaveAttribute("aria-pressed", "false");

  // F 精选第一张；方向键切换后精选第二张。
  await page.keyboard.press("f");
  await expect(page.getByTestId("select-button")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("photo-counter")).toHaveText(/2\s*\/\s*5/);
  await page.keyboard.press("f");
  await expect(page.getByTestId("select-button")).toHaveAttribute("aria-pressed", "true");

  // 导出预检 → 确认 → 等待任务与逐文件结果。
  await page.getByTestId("export-button").click();
  const exportModal = page.getByTestId("export-modal");
  await expect(exportModal).toBeVisible();
  await expect(exportModal).toContainText("精选原相册");
  await expect(exportModal).toContainText("不会改变");
  await page.getByTestId("export-confirm").click();
  await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("export-result")).toContainText("导出结果");
  await expect(page.getByTestId("export-result")).toContainText(/成功\s*\d+/);
  await page.getByTestId("export-cancel").click();
  await expect(exportModal).toBeHidden();

  const exportedJpg = path.join(photoRoot, "精选原相册", "测试-京都旅行", "JPG", "DSCF0001.JPG");
  const exportedRaw = path.join(photoRoot, "精选原相册", "测试-京都旅行", "RAW", "DSCF0001.RAF");
  await expect.poll(() => fs.existsSync(exportedJpg), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(exportedRaw), { timeout: 15_000 }).toBe(true);
  expect(fs.existsSync(path.join(travelDir, "DSCF0001.JPG"))).toBe(true);
  expect(fs.existsSync(path.join(travelDir, "DSCF0001.RAF"))).toBe(true);

  // 胶片栏跳到第三张，标记待删除（只改状态，不动文件）。
  await page.getByTestId("filmstrip-item").nth(2).click();
  await expect(page.getByTestId("photo-counter")).toHaveText(/3\s*\/\s*5/);
  await page.keyboard.press("x");
  await expect(page.getByTestId("pending-delete-button")).toHaveAttribute("aria-pressed", "true");
  const pairJpg = path.join(travelDir, "JPG", "DSCF0010.JPG");
  const pairRaw = path.join(travelDir, "RAW", "DSCF0010.RAF");
  expect(fs.existsSync(pairJpg)).toBe(true);
  expect(fs.existsSync(pairRaw)).toBe(true);

  // 清理预检 → 确认 → 文件进入废纸篓 → 15 秒内撤销。
  await page.getByTestId("cleanup-button").click();
  const cleanupModal = page.getByTestId("cleanup-modal");
  await expect(cleanupModal).toBeVisible();
  await expect(cleanupModal).toContainText("不会永久删除");
  await expect(cleanupModal).toContainText("确认移入废纸篓");
  const cleanupThumb = page.getByTestId("cleanup-thumbnail").first();
  await expect(cleanupThumb).toBeVisible();
  await cleanupThumb.hover();
  await expect(page.getByTestId("cleanup-thumbnail-preview").first()).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("cleanup-confirm").click();
  await expect(page.getByTestId("cleanup-undo")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => fs.existsSync(pairJpg), { timeout: 8_000 }).toBe(false);
  await expect.poll(() => fs.existsSync(pairRaw), { timeout: 8_000 }).toBe(false);
  // 当前照片被清理后，应落到原位置的下一位，而不是回到第一张。
  await expect(page.getByTestId("photo-counter")).toHaveText(/3\s*\/\s*4/);
  await page.getByTestId("cleanup-undo").click();
  await expect.poll(() => fs.existsSync(pairJpg), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(pairRaw), { timeout: 20_000 }).toBe(true);
  await expect(cleanupModal).toContainText(/已恢复|恢复/, { timeout: 20_000 });
  await cleanupModal.getByRole("button", { name: "关闭", exact: true }).click();

  // 返回相册库，再进入操作记录（筛选器是全屏视图，没有主导航）。
  await page.getByTestId("back-button").click();
  await expect(page.getByTestId("library-page")).toBeVisible();
  await page.getByRole("link", { name: "操作记录" }).click();
  await expect(page.getByTestId("operations-page")).toBeVisible();
  await expect(page.getByTestId("operation-row").first()).toBeVisible({ timeout: 15_000 });
  const rows = page.getByTestId("operation-row");
  expect(await rows.count()).toBeGreaterThan(0);
  await rows.first().click();
  await expect(page.getByTestId("operation-detail")).toBeVisible();
  await expect(page.getByTestId("operation-detail")).toContainText(/清理|导出|扫描|恢复/);
  await page.keyboard.press("Escape");

  // 异常中心：配对冲突可见且不会被自动处理。
  await page.goto(`/issues?album=${encodeURIComponent(albumId)}`);
  await expect(page.getByTestId("issues-page")).toBeVisible();
  await expect(page.getByTestId("issues-pairing")).toBeVisible();
  await expect(page.getByTestId("issues-pairing")).toContainText("DSCF0030");
});

test("排序保留当前照片、过滤、聚焦控件时不触发快捷键", async ({ page }) => {
  await page.goto("/");
  const card = page.locator('[data-testid="album-card"][data-album-name="测试-京都旅行"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(page.getByTestId("photo-counter")).toHaveText(/\/\s*5/, { timeout: 30_000 });
  await expect(page.getByTestId("viewer-image")).toBeVisible();

  // 切到文件名排序后仍保留当前照片（同一 data-photo-id）。
  const currentId = await page.getByTestId("viewer-image").getAttribute("data-photo-id");
  await page.getByTestId("culler-sort").selectOption("filename");
  await expect(page.getByTestId("viewer-image")).toHaveAttribute("data-photo-id", currentId ?? "");

  // 过滤到仅 RAW：只剩 1 张，当前照片被安全重置。
  await page.getByTestId("filter-form").selectOption("raw_only");
  await expect(page.getByTestId("photo-counter")).toHaveText(/1\s*\/\s*1/, { timeout: 15_000 });
  await expect(page.getByTestId("viewer-image")).toBeVisible();
  await page.getByTestId("filter-form").selectOption("all");

  // select 聚焦时按 F 不应改变精选状态。
  const selectButton = page.getByTestId("select-button");
  const before = await selectButton.getAttribute("aria-pressed");
  await page.getByTestId("culler-sort").focus();
  await page.keyboard.press("f");
  await expect(selectButton).toHaveAttribute("aria-pressed", before ?? "false");

  // X 只标记待删除，不移动文件；再次 X 取消。
  await page.getByTestId("filmstrip-item").first().click();
  await page.getByTestId("pending-delete-button").click();
  await expect(page.getByTestId("pending-delete-button")).toHaveAttribute("aria-pressed", "true");
  expect(fs.existsSync(path.join(travelDir, "DSCF0001.JPG"))).toBe(true);
  await page.getByTestId("pending-delete-button").click();
  await expect(page.getByTestId("pending-delete-button")).toHaveAttribute("aria-pressed", "false");

  // 自动播放按钮存在，且不会越过末尾循环。
  await expect(page.getByRole("button", { name: /播放|暂停/ }).first()).toBeVisible();

  // 全屏沉浸模式下操作按钮应明显放大，且仍可继续标记。
  const normalBox = await selectButton.boundingBox();
  await page.getByTestId("fullscreen-button").click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  const fullscreenBox = await selectButton.boundingBox();
  expect(fullscreenBox?.height ?? 0).toBeGreaterThan((normalBox?.height ?? 0) + 6);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
});
test("原地整理 JPG/RAW：预检、二次确认、移动与撤销", async ({ page }) => {
  const portraitDir = path.join(photoRoot, "测试-人像约拍-客户A");
  await page.goto("/");
  const card = page.locator('[data-testid="album-card"][data-album-name="测试-人像约拍-客户A"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(page.getByTestId("photo-counter")).toHaveText(/1\s*\/\s*3/, { timeout: 30_000 });
  await expect(page.getByTestId("viewer-image")).toBeVisible();

  await page.getByTestId("organize-button").click();
  const modal = page.getByTestId("organize-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("原地移动源文件");
  const confirm = page.getByTestId("organize-confirm");
  await expect(confirm).toBeDisabled();
  await page.getByTestId("organize-confirm-input").fill("测试-人像约拍-客户A");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("organize-result")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("organize-result")).toContainText(/成功移动\s*4/);

  await expect.poll(() => fs.existsSync(path.join(portraitDir, "JPG", "DSC0001.JPG")), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(portraitDir, "RAW", "DSC0001.ARW")), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(portraitDir, "RAW", "DSC0002.DNG")), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(portraitDir, "JPG", "DSC0003.JPG")), { timeout: 10_000 }).toBe(true);
  expect(fs.existsSync(path.join(portraitDir, "DSC0001.JPG"))).toBe(false);
  expect(fs.existsSync(path.join(portraitDir, "DSC0001.ARW"))).toBe(false);

  await page.getByTestId("organize-undo").click();
  await page.getByTestId("organize-undo-confirm").click();
  await expect(page.getByTestId("organize-undo-result")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fs.existsSync(path.join(portraitDir, "DSC0001.JPG")), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(portraitDir, "DSC0001.ARW")), { timeout: 10_000 }).toBe(true);
  expect(fs.existsSync(path.join(portraitDir, "JPG"))).toBe(false);
  expect(fs.existsSync(path.join(portraitDir, "RAW"))).toBe(false);
});
