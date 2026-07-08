import { useState } from "react";

// .txt/.md 파일을 브라우저에서 직접 읽어 기존 입력칸에 채우는 공용 헬퍼 — 서버 업로드 없음.
// 회의록(새 회의록 모달)·문서(PageEditor, 파일로 새 문서)가 같은 경로를 쓴다.

const TEXT_EXT = /\.(txt|md|markdown)$/i;
export const TEXT_FILE_ACCEPT = ".txt,.md,.markdown,text/plain,text/markdown";

export function isTextFile(f: File) {
  return TEXT_EXT.test(f.name) || f.type === "text/plain" || f.type === "text/markdown";
}

export async function readTextFile(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let text: string;
  // 메모장 "유니코드"(UTF-16) 저장 파일 — BOM으로 식별. 안 하면 EUC-KR 폴백이 무경고 모지바케를 만든다
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder("utf-16le").decode(buf);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder("utf-16be").decode(buf);
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      // 한국어 레거시 메모장(.txt, CP949) — UTF-8 해석 실패 시에만 폴백
      text = new TextDecoder("euc-kr").decode(buf);
    }
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM 제거
}

export function titleFromFilename(name: string) {
  return name.replace(/\.[^.]+$/, "").trim();
}

/** 파일 선택 버튼 + 드롭존 공용 훅. 검증(확장자·크기) 후 onText(내용, 파일)를 부른다. */
export function useTextFileIntake(opts: {
  maxBytes: number;
  onText: (text: string, file: File) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!isTextFile(file)) { opts.onError("텍스트 파일(.txt, .md)만 불러올 수 있어요."); return; }
    // 1차: 파일 자체 크기로 빠른 거절 (UTF-16은 UTF-8보다 크므로 2배 여유)
    if (file.size > opts.maxBytes * 2) {
      opts.onError(`파일이 너무 커요 — ${Math.round(opts.maxBytes / 1024)}KB까지 불러올 수 있어요.`);
      return;
    }
    try {
      const text = await readTextFile(file);
      // 2차: 서버 검증과 같은 UTF-8 바이트 기준 — CP949 파일은 UTF-8로 ~1.5배 팽창하므로
      // 원본 크기만 보면 통과했다가 등록 시점에 400을 맞는다
      if (new TextEncoder().encode(text).length > opts.maxBytes) {
        opts.onError(`파일이 너무 커요 — ${Math.round(opts.maxBytes / 1024)}KB까지 불러올 수 있어요.`);
        return;
      }
      await opts.onText(text, file);
    } catch {
      opts.onError("파일을 읽지 못했어요. 텍스트 파일인지 확인해 주세요.");
    }
  };

  return {
    dragging,
    /** 숨은 input 없이 파일 선택창 열기 (버튼 onClick에서 호출) */
    openPicker: () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = TEXT_FILE_ACCEPT;
      input.onchange = () => handleFile(input.files?.[0]);
      input.click();
    },
    /** 파일 드롭만 반응 — 텍스트 선택 드래그·태스크 카드 드래그에는 간섭하지 않음 */
    dropProps: {
      onDragOver: (e: React.DragEvent) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setDragging(true); }
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragging(false);
      },
      onDrop: (e: React.DragEvent) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        void handleFile(e.dataTransfer.files?.[0]);
      },
    },
  };
}
