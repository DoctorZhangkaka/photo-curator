import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom 没有 matchMedia / ResizeObserver / EventSource；测试中提供轻量实现。
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}

class EventSourceMock {
  url: string;
  readyState = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static instances: EventSourceMock[] = [];

  constructor(url: string) {
    this.url = url;
    EventSourceMock.instances.push(this);
  }

  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = 2;
  }
}

if (typeof globalThis.EventSource === "undefined") {
  globalThis.EventSource = EventSourceMock as unknown as typeof EventSource;
}

if (typeof HTMLElement !== "undefined") {
  // jsdom 的 clientWidth/clientHeight 始终为 0，导致虚拟列表无法计算可视范围。
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 1200;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 800;
    },
  });
}

if (typeof Element !== "undefined") {
  const originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const rect = originalRect.call(this);
    if (rect.width > 0 || rect.height > 0) return rect;
    // 虚拟列表和弹窗需要非零尺寸；jsdom 默认所有元素都是 0×0。
    return {
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function scrollTo() {};
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function setPointerCapture() {};
    Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  }
}
