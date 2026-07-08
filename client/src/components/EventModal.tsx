import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { CalendarClock, Trash2 } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Modal, Button, Input, Textarea, Select, Field, Avatar, NameChip, toast, useConfirm } from "./ui";
import { localDayKey, dayKeyToServer, fmtDate } from "../lib/format";
import { queryClient } from "../lib/queryClient";
import { useAuth } from "../hooks/useAuth";

// F5: 일정 생성 + (C3) 수정·삭제 겸용 모달 — event prop이 있으면 수정 모드.
// 시간 규약: 종일 = `${dayKey}T00:00:00.000Z`, 시간 지정 = 로컬 시각 → ISO(timestamptz).
// 수정 권한(can_edit)은 GET /events/:id로 확인 — 생성자 또는 프로젝트 매니저만. 아니면 보기 전용.
const timeOf = (x: any) => {
  const d = new Date(x);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function EventModal({ open, onClose, defaultProjectId, defaultDate, defaultAttendees, onCreated, event }: {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: number | null;
  defaultDate?: string | null;
  defaultAttendees?: number[]; // 캘린더 칸 hover ➕ — 그 팀원을 참석자로 프리필 (생성 모드 전용)
  onCreated?: () => void;
  event?: any | null; // 수정 대상 일정 (GET /events 목록 행 — enrich되어 attendees/project_name 포함)
}) {
  const editing = !!event;
  const { user: me } = useAuth();
  // C9: 참석자 규약의 기준점 — 수정 모드에선 "이벤트를 만든 사람", 생성 모드에선 나
  const creatorId: number | null = editing ? (event.created_by ?? null) : (me?.id ?? null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(localDayKey(new Date()));
  const [endDate, setEndDate] = useState(""); // "" = 하루짜리. 멀티데이 일정의 종료 '날짜' 보존용(파괴 방지)
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [projectId, setProjectId] = useState<number | "">("");
  const [attendees, setAttendees] = useState<Set<number>>(new Set());
  const { confirm, dialog } = useConfirm();

  // 열릴 때마다 폼 동기화 — defaultDate/defaultProjectId가 최초 마운트에 고정되던 stale 버그 수정.
  // 수정 모드면 F5 규약 역변환으로 프리필 (종일 = starts_at 앞 10자, 시간 지정 = 로컬 변환).
  useEffect(() => {
    if (!open) return;
    if (event) {
      setTitle(event.title ?? "");
      setDescription(event.description ?? "");
      const sKey = event.all_day ? String(event.starts_at).slice(0, 10) : localDayKey(new Date(event.starts_at));
      setDate(sKey);
      // 종료 '날짜'까지 복원 — 시각만 복원하면 멀티데이 일정이 저장 시 하루짜리로 잘림
      const eKey = event.ends_at ? (event.all_day ? String(event.ends_at).slice(0, 10) : localDayKey(new Date(event.ends_at))) : "";
      setEndDate(eKey && eKey !== sKey ? eKey : "");
      setAllDay(!!event.all_day);
      setStartTime(event.all_day ? "10:00" : timeOf(event.starts_at));
      setEndTime(!event.all_day && event.ends_at ? timeOf(event.ends_at) : "");
      setProjectId(event.project_id ?? "");
      setAttendees(new Set((event.attendees ?? []).map((a: any) => a.id)));
    } else {
      setTitle("");
      setDescription("");
      setDate(defaultDate ?? localDayKey(new Date()));
      setEndDate("");
      setAllDay(false);
      setStartTime("10:00");
      setEndTime("");
      setProjectId(defaultProjectId ?? "");
      // 본인 미리 체크(해제하면 대리 등록·불참) + 칸 hover ➕로 열렸으면 그 팀원도 함께
      setAttendees(new Set([...(me?.id != null ? [me.id] : []), ...(defaultAttendees ?? [])]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, event?.id]);

  const projectsQ = useQuery<{ projects: any[] }>({ queryKey: ["projects"], queryFn: () => get("/projects"), enabled: open && !editing });
  const membersQ = useQuery<{ members: any[] }>({
    queryKey: ["members", projectId],
    queryFn: () => get(`/projects/${projectId}/members`),
    enabled: open && projectId !== "",
  });
  // 수정 모드: can_edit(생성자/매니저) 확인 — 목록 응답에는 없어 단건 조회
  const detailQ = useQuery<{ event: any; can_edit: boolean }>({
    queryKey: ["event", event?.id],
    queryFn: () => get(`/events/${event!.id}`),
    enabled: open && editing,
  });
  const canEdit = !editing || (detailQ.data?.can_edit ?? false);

  // 종료 날짜를 직접 지정하지 않았을 때만: 종료<시작이면 익일 종료로 해석 (23:00~01:00 야간 일정)
  const overnight = !allDay && !endDate && !!endTime && !!startTime && endTime < startTime;
  // 날짜 검증 — 저장 차단 사유가 있으면 메시지
  const dateError = !date ? "날짜를 입력하세요."
    : endDate && endDate < date ? "종료 날짜가 시작 날짜보다 빨라요."
    : !allDay && endDate && endDate === date && endTime && endTime < startTime ? "종료 시간이 시작보다 빨라요."
    : !allDay && endDate && !endTime ? "여러 날 일정은 종료 시간도 입력하세요."
    : null;

  const toggleAttendee = (id: number) => {
    const next = new Set(attendees);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setAttendees(next);
  };

  const save = useMutation({
    mutationFn: () => {
      // 종료일 우선순위: 명시된 종료 날짜 > 자정 넘김(익일) > 시작일 당일. DST 안전하게 날짜 문자열로 +1일.
      const nextDay = (key: string) => { const [y, m, d] = key.split("-").map(Number); return localDayKey(new Date(y, m - 1, d + 1)); };
      const effEndDate = endDate || (overnight ? nextDay(date) : date);
      const starts_at = allDay ? dayKeyToServer(date) : new Date(`${date}T${startTime}`).toISOString();
      const ends_at = allDay
        ? (endDate ? dayKeyToServer(endDate) : null)
        : endTime ? new Date(`${effEndDate}T${endTime}`).toISOString() : null;
      // C9 규약: attendee_ids = 생성자 외 참석자, include_creator = 생성자 참석 여부(체크박스 상태 그대로 — WYSIWYG)
      const attendeePayload = (pid2: number | null) =>
        pid2 == null
          ? {} // 개인 일정: 서버가 항상 [생성자]로 강제 — 필드 생략
          : {
              attendee_ids: [...attendees].filter((id) => id !== creatorId),
              include_creator: creatorId != null ? attendees.has(creatorId) : true,
            };
      if (editing) {
        // PATCH는 strict whitelist — project_id 등 여분 필드 금지
        const body: any = { title: title.trim(), description: description.trim() || null, starts_at, ends_at, all_day: allDay, ...attendeePayload(event.project_id) };
        return patch(`/events/${event.id}`, body);
      }
      const pidNum = projectId === "" ? null : Number(projectId);
      return post("/events", {
        title: title.trim(),
        description: description.trim() || null,
        starts_at,
        ends_at,
        all_day: allDay,
        project_id: pidNum,
        ...attendeePayload(pidNum),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["events"] }); // ["events", pid, ...]·["events","today",...] 모두 커버
      if (editing) queryClient.invalidateQueries({ queryKey: ["event", event.id] });
      toast(editing ? "일정을 수정했어요." : "일정을 만들었어요.");
      onCreated?.();
      onClose();
    },
    onError: (e: any) => toast(`저장 실패: ${e.message}`, "error"),
  });

  const remove = useMutation({
    mutationFn: () => del(`/events/${event!.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["events"] });
      toast("일정을 삭제했어요.");
      onClose();
    },
    onError: (e: any) => toast(`삭제 실패: ${e.message}`, "error"),
  });

  const readOnly = editing && !canEdit;

  return (
    <Modal open={open} onClose={onClose} title={editing ? (readOnly ? "일정" : "일정 수정") : "일정 만들기"}>
      {dialog}
      <div className="flex flex-col gap-3">
        {!editing && (
          <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            <CalendarClock size={15} /> 프로젝트를 선택하지 않으면 개인 일정이 돼요.
          </div>
        )}
        {readOnly && detailQ.data && (
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-500">
            보기 전용 — 일정 수정·삭제는 만든 사람 또는 프로젝트 매니저만 할 수 있어요.
          </div>
        )}
        {editing && detailQ.isError && (
          <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">
            권한 정보를 불러오지 못해 보기 전용으로 열렸어요 — 닫았다가 다시 열어주세요.
          </div>
        )}
        {/* C13: 누가 등록한 일정인지 — 대리 등록이면 참석자 목록만으론 알 수 없어 명시 */}
        {editing && (event.creator_name ?? detailQ.data?.event?.creator_name) && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
            만든 사람 <NameChip name={event.creator_name ?? detailQ.data!.event.creator_name} />
            {event.created_at && <span>· {fmtDate(event.created_at)} 등록</span>}
          </div>
        )}
        <Field label="제목"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 스프린트 회의" autoFocus disabled={readOnly} /></Field>
        <Field label="설명 (선택)"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="날짜">
            <input type="date" className="h-10 w-full rounded-lg border border-slate-200 px-2 text-sm disabled:bg-slate-50" value={date} onChange={(e) => setDate(e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="종료 날짜 (선택 — 여러 날)">
            <input type="date" min={date} className={`h-10 w-full rounded-lg border px-2 text-sm disabled:bg-slate-50 ${endDate && endDate < date ? "border-rose-300 bg-rose-50/40" : "border-slate-200"}`} value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={readOnly} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="h-4 w-4 accent-emerald-500" disabled={readOnly} /> 종일
        </label>
        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="시작">
              <input type="time" className="h-10 w-full rounded-lg border border-slate-200 px-2 text-sm disabled:bg-slate-50" value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={readOnly} />
            </Field>
            <Field label="종료 (선택)">
              <input type="time" className={`h-10 w-full rounded-lg border px-2 text-sm disabled:bg-slate-50 ${overnight ? "border-amber-300 bg-amber-50/40" : "border-slate-200"}`} value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={readOnly} />
            </Field>
          </div>
        )}
        {dateError ? <div className="text-xs text-rose-500">{dateError}</div>
          : overnight ? <div className="text-xs text-amber-600">종료가 시작보다 일러서 <b>다음 날 {endTime} 종료</b>로 저장돼요. (야간 일정)</div> : null}
        {editing ? (
          <Field label="프로젝트">
            {/* 서버 PATCH가 project_id 이동을 지원하지 않음(삭제 후 재생성) — 읽기 전용 표시 */}
            <div className="flex h-10 items-center rounded-lg border border-slate-100 bg-slate-50 px-3 text-sm text-slate-500">
              {event?.project_name ?? "개인 일정"}
            </div>
          </Field>
        ) : (
          <Field label="프로젝트 (무선택 = 개인 일정)">
            <Select value={projectId} onChange={(e) => { setProjectId(e.target.value === "" ? "" : Number(e.target.value)); setAttendees(new Set(me?.id != null ? [me.id] : [])); }}>
              <option value="">개인 일정</option>
              {(projectsQ.data?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        {projectId !== "" && !readOnly && (
          <Field label="참석자 (일정의 주인 — 전원 선택 시 공통 일정으로 표시)">
            <div className="flex flex-wrap gap-1.5">
              <button type="button"
                onClick={() => setAttendees(new Set((membersQ.data?.members ?? []).map((m: any) => m.user.id)))}
                className="inline-flex items-center rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-500 transition hover:border-emerald-300 hover:text-emerald-600">
                전원 선택
              </button>
              {(membersQ.data?.members ?? []).map((m) => {
                const name = m.user.full_name ?? m.user.email;
                const on = attendees.has(m.user.id);
                const isCreator = m.user.id === creatorId;
                return (
                  <button key={m.user.id} type="button" onClick={() => toggleAttendee(m.user.id)}
                    title={isCreator ? "만든 사람 — 체크를 해제하면 본인은 참석하지 않아요 (대리 등록)" : undefined}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${on ? "border-emerald-300 bg-emerald-50 font-semibold text-emerald-700" : "border-slate-200 bg-white text-slate-500"}`}>
                    <Avatar name={name} size={18} /> {isCreator && "★ "}{name}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        {readOnly && (event?.attendees ?? []).length > 0 && (
          <Field label="참석자">
            <div className="flex flex-wrap gap-1.5">
              {(event.attendees ?? []).map((a: any) => {
                const name = a.full_name ?? a.email;
                return <span key={a.id} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-500"><Avatar name={name} size={18} /> {name}</span>;
              })}
            </div>
          </Field>
        )}
        <div className="mt-1 flex items-center gap-2">
          {editing && canEdit && (
            <Button variant="outline" className="border-rose-200 text-rose-500 hover:bg-rose-50"
              disabled={remove.isPending}
              onClick={async () => {
                if (await confirm({ title: "일정 삭제", message: `"${event.title}" 일정을 삭제할까요?`, confirmLabel: "삭제", tone: "danger" })) remove.mutate();
              }}>
              <Trash2 size={15} /> 삭제
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>{readOnly ? "닫기" : "취소"}</Button>
            {!readOnly && (
              <Button onClick={() => title.trim() && !dateError && save.mutate()}
                disabled={save.isPending || !title.trim() || !!dateError || (editing && detailQ.isLoading)}>
                {save.isPending ? "저장 중…" : editing ? "저장" : "일정 만들기"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
