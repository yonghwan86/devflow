// 활성 프로젝트(마지막으로 연 프로젝트) 기억 — 로그인 후 메인 화면으로 바로 진입하는 데 사용.
const KEY = "devflow.active_project";

export interface ActiveProject {
  id: number;
  key: string;
  name: string;
}

export function getActiveProject(): ActiveProject | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return typeof p?.id === "number" ? p : null;
  } catch {
    return null;
  }
}

export function setActiveProject(p: ActiveProject): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — 무시 */
  }
}

// id를 주면 그 프로젝트가 활성일 때만 해제 (삭제/권한상실 대응)
export function clearActiveProject(id?: number): void {
  try {
    if (id == null || getActiveProject()?.id === id) localStorage.removeItem(KEY);
  } catch {
    /* 무시 */
  }
}
