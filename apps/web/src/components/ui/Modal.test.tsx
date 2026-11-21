import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

function renderModal(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <Modal
        open
        onClose={onClose}
        title="测试弹窗"
        description="这是一个用于验证焦点约束的弹窗"
        footer={<button type="button">底部操作</button>}
      >
        <button type="button">第一个</button>
        <button type="button">第二个</button>
        <button type="button">第三个</button>
      </Modal>,
    ),
  };
}

describe("Modal", () => {
  it("打开后聚焦第一个可聚焦元素，Tab 在弹窗内循环", async () => {
    renderModal();
    const dialog = screen.getByRole("dialog", { name: "测试弹窗" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const closeButton = screen.getByRole("button", { name: "关闭窗口" });
    await waitFor(() => expect(closeButton).toHaveFocus());

    const lastButton = screen.getByRole("button", { name: "底部操作" });
    lastButton.focus();
    fireEvent.keyDown(lastButton, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(lastButton).toHaveFocus();
  });

  it("Esc 关闭弹窗，并阻止快捷键冒泡", async () => {
    const { onClose } = renderModal();
    const second = screen.getByRole("button", { name: "第二个" });
    second.focus();

    fireEvent.keyDown(second, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击遮罩关闭弹窗，点击弹窗内部不关闭", () => {
    const { onClose } = renderModal();
    const dialog = screen.getByRole("dialog", { name: "测试弹窗" });
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    const overlay = dialog.parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
