import { useEffect, useRef } from "react";

export interface ShortcutHandlers {
  previous: () => void;
  next: () => void;
  toggleSelected: () => void;
  togglePendingDelete: () => void;
  togglePlayback: () => void;
  toggleInfo: () => void;
  toggleViewed: () => void;
  escape: () => void;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

/**
 * 全局照片快捷键。
 *
 * - 输入框 / 文本域 / select / contenteditable 聚焦时完全不触发；
 * - 有修饰键（⌘/Ctrl/Alt）时不拦截，保留浏览器与系统快捷方式；
 * - Esc 交给页面处理（关闭弹窗或退出全屏）。
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const key = event.key;
      const lower = key.toLowerCase();
      const repeatable = key === "ArrowLeft" || key === "ArrowRight";
      if (event.repeat && !repeatable) return;

      switch (key) {
        case "ArrowLeft":
          event.preventDefault();
          handlersRef.current.previous();
          return;
        case "ArrowRight":
          event.preventDefault();
          handlersRef.current.next();
          return;
        case " ":
        case "Spacebar": {
          // 焦点在按钮/链接上时，保留空格激活控件的行为。
          const target = event.target;
          if (target instanceof HTMLElement && target.closest("button, a[href]")) return;
          event.preventDefault();
          handlersRef.current.togglePlayback();
          return;
        }
        case "Escape":
          handlersRef.current.escape();
          return;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          handlersRef.current.togglePendingDelete();
          return;
        default:
          break;
      }

      if (lower === "f") {
        event.preventDefault();
        handlersRef.current.toggleSelected();
      } else if (lower === "x") {
        event.preventDefault();
        handlersRef.current.togglePendingDelete();
      } else if (lower === "i") {
        event.preventDefault();
        handlersRef.current.toggleInfo();
      } else if (lower === "u") {
        event.preventDefault();
        handlersRef.current.toggleViewed();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
