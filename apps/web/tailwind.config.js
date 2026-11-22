/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 光学中性炭灰阶（消除偏蓝色温，避免影响照片白平衡与肤色判断）
        ink: {
          950: "#09090a",
          900: "#111113",
          850: "#17171a",
          800: "#1e1e22",
          700: "#2b2b30",
          600: "#3f3f46",
          500: "#63636c",
          400: "#8e8e98",
          300: "#b8b8c2",
          200: "#d8d8df",
          100: "#efeff2",
        },
        // 暗房安全灯 / 徕卡黄铜琥珀金强调色
        accent: {
          200: "#f7e3b0",
          300: "#f1cd78",
          400: "#e8b64d",
          500: "#d9a133",
          600: "#ba8520",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Inter",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "sans-serif",
        ],
        mono: [
          "SF Mono",
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        "darkroom-panel":
          "inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 12px 32px rgba(0, 0, 0, 0.45)",
        "darkroom-card":
          "inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 6px 20px rgba(0, 0, 0, 0.35)",
        "darkroom-control": "inset 0 1px 0 rgba(255, 255, 255, 0.06)",
        "darkroom-glow": "0 0 0 1px rgba(232, 182, 77, 0.45), 0 0 18px rgba(217, 161, 51, 0.16)",
      },
    },
  },
  plugins: [],
};
