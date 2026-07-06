import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// PWA 아이콘 생성 — 폰트 의존 없이 패스로 그린 "D" 로고 (Layout 로고와 동일한 인디고 그라디언트).
// 실행: npx tsx scripts/gen-icons.ts  → client/public/icon-192.png, icon-512.png, apple-touch-icon.png
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../client/public");

// rx>0: 안드로이드/매니페스트용(maskable 안전영역 고려해 D를 중앙 55%에 배치)
// rx=0: iOS apple-touch-icon(iOS가 자체 마스킹)
const svg = (rx: number) => `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#4338ca"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${rx}" fill="url(#g)"/>
  <path fill="#ffffff" fill-rule="evenodd"
    d="M182 128 H268 A128 128 0 0 1 268 384 H182 Z M254 200 H268 A56 56 0 0 1 268 312 H254 Z"/>
</svg>`;

async function main() {
  const rounded = Buffer.from(svg(115));
  const square = Buffer.from(svg(0));
  await sharp(rounded).resize(512, 512).png().toFile(path.join(OUT, "icon-512.png"));
  await sharp(rounded).resize(192, 192).png().toFile(path.join(OUT, "icon-192.png"));
  await sharp(square).resize(180, 180).png().toFile(path.join(OUT, "apple-touch-icon.png"));
  console.log("[gen-icons] done → client/public/{icon-512,icon-192,apple-touch-icon}.png");
}
main().catch((e) => { console.error(e); process.exit(1); });
