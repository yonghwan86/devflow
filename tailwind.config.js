/** @type {import('tailwindcss').Config} */
// Tactile Soft (Vivid) 테마 — 기존 tailwind.config.js 교체본.
// 핵심 전략: 페이지 전반에서 쓰는 slate/indigo/white 팔레트를
// 웜 그레이지 · 딥 민트로 재매핑 → 페이지 코드 수정 없이 전체 톤 전환.
export default {
  content: ["./client/index.html", "./client/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 1차 강조: 딥 민트 (기존 인디고 #4f46e5 대체)
        brand: { DEFAULT: "#2E8C74", fg: "#FDFCFA" },
        // 2차 강조: 클레이 코랄
        coral: { DEFAULT: "#C05A32", soft: "#F7E4DA" },
        // 순백 → 웜 오프화이트 (카드/버튼 텍스트가 자동으로 따뜻해짐)
        white: "#FDFCFA",
        // slate → 웜 그레이지 스케일 (배경·보더·텍스트 전부 자동 전환)
        slate: {
          50: "#F4F1EB",
          100: "#EDE9E1",
          200: "#DFD9CF",
          300: "#C9C2B6",
          400: "#8A847A",
          500: "#6E685F",
          600: "#57514A",
          700: "#3A362F",
          800: "#262320",
          900: "#1B1916",
        },
        // indigo → 민트 틴트 스케일 (bg-indigo-50 활성 상태, hover:bg-indigo-700 등 자동 전환)
        indigo: {
          50: "#E9F3F0",
          100: "#D5EAE3",
          200: "#B7DACF",
          300: "#8FC4B3",
          400: "#5BA890",
          500: "#3E9C82",
          600: "#2E8C74",
          700: "#25765F",
          800: "#1D5F4D",
          900: "#174C3E",
        },
      },
      boxShadow: {
        // 다중 소프트 그림자 — 카드 부유감의 핵심
        card: "0 1px 2px rgba(38,35,32,0.05), 0 10px 28px rgba(38,35,32,0.09), 0 2px 6px rgba(38,35,32,0.05)",
        "card-hover": "0 1px 2px rgba(38,35,32,0.05), 0 18px 40px rgba(38,35,32,0.13), 0 2px 6px rgba(38,35,32,0.05)",
        cta: "0 6px 16px rgba(46,140,116,0.30)",
      },
      minHeight: { touch: "44px" },
      minWidth: { touch: "44px" },
    },
  },
  plugins: [],
};
