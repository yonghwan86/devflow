// 참석자 픽커 칩 접기 규약 — 팀원 9명 이상이면 앞 5명만 보이고 나머지는 +N 뒤로 (8명 이하는 변화 없음).
// 선택(참석)된 사람은 숨김 순번이어도 항상 노출 — 접힌 상태에서도 "누가 참석인지"는 다 보여야 한다.
// 한도 근거: 팝업 내폭 ~311px(모바일)에 칩이 한 줄 3개 → 전원 선택+5명+(+N) = 총 7칩 ≈ 2~3줄 실측.
export const ATT_CHIP_LIMIT = 5;

export function foldMembers<T>(
  list: T[],
  idOf: (m: T) => number,
  isSelected: (id: number) => boolean,
  expanded: boolean,
): { shown: T[]; hidden: number; foldable: boolean } {
  const foldable = list.length > 8;
  if (!foldable || expanded) return { shown: list, hidden: 0, foldable };
  const shown = list.filter((m, i) => i < ATT_CHIP_LIMIT || isSelected(idOf(m)));
  return { shown, hidden: list.length - shown.length, foldable };
}
