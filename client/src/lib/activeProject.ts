// 활성 프로젝트(마지막으로 연 프로젝트) 기억 — 로그인 후 메인 화면으로 바로 진입하는 데 사용.
// C5: 구독 가능(useSyncExternalStore) — 프로젝트 전환 시 사이드바(미니 달력 점 등)가 즉시 따라오게.
const KEY = "devflow.active_project";

export interface ActiveProject {
  id: number;
  key: string;
  name: string;
}

// 스냅숏은 identity-stable해야 함(useSyncExternalStore 무한 루프 방지) — 캐시 후 변경 시에만 무효화
let cache: ActiveProject | null | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function readStorage(): ActiveProject | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return typeof p?.id === "number" ? p : null;
  } catch {
    return null;
  }
}

export function getActiveProject(): ActiveProject | null {
  if (cache === undefined) cache = readStorage();
  return cache;
}

// 같은 탭 = 커스텀 리스너, 다른 탭 = storage 이벤트
export function subscribeActiveProject(fn: () => void): () => void {
  const onStorage = () => { cache = undefined; fn(); };
  listeners.add(fn);
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(fn); window.removeEventListener("storage", onStorage); };
}

export function setActiveProject(p: ActiveProject): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — 무시 */
  }
  cache = p;
  emit();
}

// id를 주면 그 프로젝트가 활성일 때만 해제 (삭제/권한상실 대응)
export function clearActiveProject(id?: number): void {
  try {
    if (id == null || getActiveProject()?.id === id) {
      localStorage.removeItem(KEY);
      cache = null;
      emit();
    }
  } catch {
    /* 무시 */
  }
}
