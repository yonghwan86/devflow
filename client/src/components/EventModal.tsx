import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { CalendarClock, Trash2 } from "lucide-react";
import { get, post, patch, del } from "../lib/api";
import { Modal, Button, Input, Textarea, Select, Field, Avatar, toast, useConfirm } from "./ui";
import { localDayKey, dayKeyToServer } from "../lib/format";
import { queryClient } from "../lib/queryClient";

// F5: 일정 생성 + (C3) 수정·삭제 겸용 모달 — event prop이 있으면 수정 모드.
// 시간 규약: 종일 = `${dayKey}T00:00:00.000Z`, 시간 지정 = 로컬 시각 → ISO(timestamptz).
// 수정 권한(can_edit)은 GET /events/:id로 확인 — 생성자 또는 프로젝트 매니저만. 아니면 보기 전용.
const timeOf = (x: any) => {
  const d = new Date(x);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function EventModal({ open, onClose, defaultProjectId, defaultDate, onCreated, event }: {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: number | null;
  defaultDate?: string | null;
  onCreated?: () => void;
  event?: any | null; // 수정 대상 일정 (GET /events 목록 행 — enrich되어 attendees/project_name 포함)
}) {
  const editing = !!event;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(localDayKey(new Date()));
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
      setDate(event.all_day ? String(event.starts_at).slice(0, 10) : localDayKey(new Date(event.starts_at)));
      setAllDay(!!event.all_day);
      setStartTime(event.all_day ? "10:00" : timeOf(event.starts_at));
      setEndTime(!event.all_day && event.ends_at ? timeOf(event.ends_at) : "");
      setProjectId(event.project_id ?? "");
      setAttendees(new Set((event.attendees ?? []).map((a: any) => a.id)));
    } else {
      setTitle("");
      setDescription("");
      setDate(defaultDate ?? localDayKey(new Date()));
      setAllDay(false);
      setStartTime("10:00");
      setEndTime("");
      setProjectId(defaultProjectId ?? "");
      setAttendees(new Set());
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

  // 종료<시작 인라인 검증 (서버와 동일하게 end==start는 허용, 자정 넘김은 미지원)
  const timeError = !allDay && endTime && startTime && endTime < startTime ? "종료가 시작보다 빨라요. 자정을 넘기는 일정은 두 개로 나눠주세요." : null;

  const toggleAttendee = (id: number) => {
    const next = new Set(attendees);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setAttendees(next);
  };

  const save = useMutation({
    mutationFn: () => {
      const starts_at = allDay ? dayKeyToServer(date) : new Date(`${date}T${startTime}`).toISOString();
      const ends_at = !allDay && endTime ? new Date(`${date}T${endTime}`).toISOString() : null;
      if (editing) {
        // PATCH는 strict whitelist — project_id 등 여분 필드 금지. 개인 일정은 attendee_ids 자체를 생략.
        const body: any = { title: title.trim(), description: description.trim() || null, starts_at, ends_at, all_day: allDay };
        if (event.project_id != null) body.attendee_ids = [...attendees];
        return patch(`/events/${event.id}`, body);
      }
      return post("/events", {
        title: title.trim(),
        description: description.trim() || null,
        starts_at,
        ends_at,
        all_day: allDay,
        project_id: projectId === "" ? null : Number(projectId),
        attendee_ids: projectId === "" ? [] : [...attendees],
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
        <Field label="제목"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 스프린트 회의" autoFocus disabled={readOnly} /></Field>
        <Field label="설명 (선택)"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="날짜">
            <input type="date" className="h-10 w-full rounded-lg border border-slate-200 px-2 text-sm disabled:bg-slate-50" value={date} onChange={(e) => setDate(e.target.value)} disabled={readOnly} />
          </Field>
          <label className="flex items-end gap-2 pb-2.5 text-sm text-slate-600">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="h-4 w-4 accent-emerald-500" disabled={readOnly} /> 종일
          </label>
        </div>
        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="시작">
              <input type="time" className="h-10 w-full rounded-lg border border-slate-200 px-2 text-sm disabled:bg-slate-50" value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={readOnly} />
            </Field>
            <Field label="종료 (선택)">
              <input type="time" className={`h-10 w-full rounded-lg border px-2 text-sm disabled:bg-slate-50 ${timeError ? "border-rose-300 bg-rose-50/40" : "border-slate-200"}`} value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={readOnly} />
            </Field>
          </div>
        )}
        {timeError && <div className="text-xs text-rose-500">{timeError}</div>}
        {editing ? (
          <Field label="프로젝트">
            {/* 서버 PATCH가 project_id 이동을 지원하지 않음(삭제 후 재생성) — 읽기 전용 표시 */}
            <div className="flex h-10 items-center rounded-lg border border-slate-100 bg-slate-50 px-3 text-sm text-slate-500">
              {event?.project_name ?? "개인 일정"}
            </div>
          </Field>
        ) : (
          <Field label="프로젝트 (무선택 = 개인 일정)">
            <Select value={projectId} onChange={(e) => { setProjectId(e.target.value === "" ? "" : Number(e.target.value)); setAttendees(new Set()); }}>
              <option value="">개인 일정</option>
              {(projectsQ.data?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        {projectId !== "" && !readOnly && (
          <Field label="참석자">
            <div className="flex flex-wrap gap-1.5">
              {(membersQ.data?.members ?? []).map((m) => {
                const name = m.user.full_name ?? m.user.email;
                const on = attendees.has(m.user.id);
                return (
                  <button key={m.user.id} type="button" onClick={() => toggleAttendee(m.user.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${on ? "border-emerald-300 bg-emerald-50 font-semibold text-emerald-700" : "border-slate-200 bg-white text-slate-500"}`}>
                    <Avatar name={name} size={18} /> {name}
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
              <Button onClick={() => title.trim() && !timeError && save.mutate()}
                disabled={save.isPending || !title.trim() || !!timeError || (editing && detailQ.isLoading)}>
                {save.isPending ? "저장 중…" : editing ? "저장" : "일정 만들기"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
