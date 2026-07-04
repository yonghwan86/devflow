import { marked } from "marked";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";

// §10.7: markdown is rendered then sanitized (no inline scripts/handlers/SVG-exec).
const window = new JSDOM("").window as unknown as Window & typeof globalThis;
const DOMPurify = createDOMPurify(window as any);

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(md: string): string {
  const rawHtml = marked.parse(md ?? "", { async: false }) as string;
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      "p","br","strong","em","del","code","pre","blockquote",
      "ul","ol","li","a","h1","h2","h3","h4","h5","h6","hr","table","thead","tbody","tr","th","td","img",
    ],
    ALLOWED_ATTR: ["href","title","alt","src","target","rel"],
    FORBID_TAGS: ["style","script","iframe","svg","math","form","input"],
    FORBID_ATTR: ["onerror","onload","onclick","style"],
    ALLOW_DATA_ATTR: false,
  });
}
