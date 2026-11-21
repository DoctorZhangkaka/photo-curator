/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0b0c0e",
          900: "#121316",
          850: "#17191d",
          800: "#1d2025",
          700: "#2a2e35",
          600: "#3a4049",
          500: "#5c6572",
          400: "#8b95a3",
          300: "#b7c0cc",
          200: "#d5dbe3",
        100: "#e8ebef",
        },
        accent: {
          200: "#f8e4ac",
          300: "#f4d27b",
          500: "#e3b341",
          400: "#f0c45a",
          600: "#c99a2e",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
