import { useState } from "react";

// 접힘 상태를 기기(localStorage)에 기억 — 칸반 컬럼·리스트 상태 그룹 공용.
// "완료는 늘 접어둠" 같은 개인 선호가 새로고침 후에도 유지된다.
export function useCollapsedSet(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      return new Set<string>(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set<string>();
    }
  });
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* 저장 불가(프라이빗 모드 등) 시 세션 한정 */ }
      return next;
    });
  return { collapsed, toggle };
}
