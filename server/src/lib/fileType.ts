// §10.6: determine file type by MAGIC NUMBER (signature). Client-provided mime is NOT trusted.
export interface Detected {
  mime: string;
  category: "image" | "document" | "archive" | "video" | "text";
  ext: string;
}

const startsWith = (buf: Buffer, sig: number[], offset = 0) =>
  sig.every((b, i) => buf[offset + i] === b);

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB

// Allowlist only. SVG/HTML deliberately excluded (inline-exec risk).
export function detectFileType(buf: Buffer): Detected | null {
  if (buf.length < 4) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return { mime: "image/png", category: "image", ext: "png" };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", category: "image", ext: "jpg" };
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif", category: "image", ext: "gif" };
  // WEBP: RIFF....WEBP
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8))
    return { mime: "image/webp", category: "image", ext: "webp" };
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return { mime: "application/pdf", category: "document", ext: "pdf" };
  // ZIP / OOXML (docx,xlsx,pptx are zip): PK\x03\x04
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]))
    return { mime: "application/zip", category: "archive", ext: "zip" };
  // MP4 (ftyp at offset 4)
  if (startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) return { mime: "video/mp4", category: "video", ext: "mp4" };
  // Plain text heuristic: printable/UTF-8 sample, no NUL bytes.
  const sample = buf.subarray(0, 512);
  const isText = !sample.includes(0) && sample.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 128);
  if (isText) {
    // Reject HTML/SVG/script masquerading as text (§10.6 inline-exec risk).
    const head = buf.subarray(0, 1024).toString("utf8").toLowerCase();
    if (/<\s*(script|html|svg|!doctype|iframe|xml)/.test(head)) return null;
    return { mime: "text/plain", category: "text", ext: "txt" };
  }
  return null;
}
