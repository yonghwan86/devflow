/** @type {import('tailwindcss').Config} */
export default {
  content: ["./client/index.html", "./client/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#4f46e5",
          fg: "#ffffff",
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
        },
        surface: {
          DEFAULT: "#ffffff",
          sunken: "#f8fafc",
          raised: "#ffffff",
        },
      },
      boxShadow: {
        card: "0 1px 2px rgba(15, 23, 42, 0.04), 0 0 0 1px rgba(15, 23, 42, 0.02)",
        "card-hover": "0 4px 12px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.05)",
        floating: "0 12px 32px rgba(15, 23, 42, 0.14), 0 2px 8px rgba(15, 23, 42, 0.08)",
        "brand-glow": "0 8px 24px rgba(79, 70, 229, 0.28)",
      },
      minHeight: { touch: "44px" },
      minWidth: { touch: "44px" },
      animation: {
        // fill은 backwards만 — both는 transform 키프레임을 항등행렬로 영구 잔존시켜
        // 내부 position:fixed의 컨테이닝 블록을 만든다 (index.css page-enter 주석 참조)
        "fade-in": "fade-in 0.25s ease-out backwards",
        "fade-in-up": "fade-in-up 0.3s cubic-bezier(0.21, 1.02, 0.73, 1) backwards",
        "scale-in": "scale-in 0.18s cubic-bezier(0.21, 1.02, 0.73, 1) backwards",
        "slide-up": "slide-up 0.28s cubic-bezier(0.21, 1.02, 0.73, 1) backwards",
        "check-pop": "check-pop 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)",
        shimmer: "shimmer 1.6s linear infinite",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "none" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "none" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(24px)" },
          to: { opacity: "1", transform: "none" },
        },
        "check-pop": {
          "0%": { transform: "scale(0.6)" },
          "60%": { transform: "scale(1.15)" },
          "100%": { transform: "scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
      },
    },
  },
  plugins: [],
};
