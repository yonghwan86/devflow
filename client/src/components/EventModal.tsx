import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { get, post } from "../lib/api";
import { Modal, Button, Input, Textarea, Select, Field, Avatar, toast } from "./ui";
import { localDayKey, dayKeyToServer } from "../lib/format";
import { queryClient } from "../lib/queryClient";

// F5: 일정 생성 모달 — 프로젝트 무선택 = 개인 일정.
// 시간 규약: 종일 = `${dayKey}T00:00:00.000Z`, 시간 지정 = 로컬 시각 → ISO(timestamptz).
export function EventModal({ open, onClose, defaultProjectId, defaultDate, onCreated }: {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: number | null;
  defaultDate?: string | null;
  onCreated?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(defaultDate ?? localDayKey(new Date()));
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [projectId, setProjectId] = useState<number | "">(defaultProjectId ?? "");
  const [attendees, setAttendees] = useState<Set<number>>(new Set());

  const projectsQ = useQuery<{ projects: any[] }>({ queryKey: ["projects"], queryFn: () => get("/projects"), enabled: open });
  const membersQ = useQuery<{ members: any[] }>({
    queryKey: ["members", projectId],
    queryFn: () => get(`/projects/${projectId}/members`),
    enabled: open && projectId !== "",
  });

  const toggleAttendee = (id: number) => {
    const next = new Set(attendees);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setAttendees(next);
  };

  const create = useMutation({
    mutationFn: () => {
      const starts_at = allDay ? dayKeyToServer(date) : new Date(`${date}T${startTime}`).toISOString();
      const ends_at = !allDay && endTime ? new Date(`${date}T${endTime}`).toISOString() : null;
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
      queryClient.invalidateQueries({ queryKey: ["events"] });
      toast("일정을 만들었어요.");
      setTitle(""); setDescription(""); setAttendees(new Set());
      onCreated?.();
      onClose();
    },
    onError: (e: any) => toast(`일정 생성 실패: ${e.message}`),
  });

  return (
    <Modal open={open} onClose={onClose} title="일정 만들기">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <CalendarClock size={15} /> 프로젝트를 선택하지 않으면 개인 일정이 돼요.
        </div>
        <Field label="제목"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 스프린트 회의" autoFocus /></Field>
        <Field label="설명 (선택)"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="날짜">
            <input type="date" className="h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <label className="flex items-end gap-2 pb-2.5 text-sm text-slate-600">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="h-4 w-4 accent-emerald-500" /> 종일
          </label>
        </div>
        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="시작">
              <input type="time" className="h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </Field>
            <Field label="종료 (선택)">
              <input type="time" className="h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="프로젝트 (무선택 = 개인 일정)">
          <Select value={projectId} onChange={(e) => { setProjectId(e.target.value === "" ? "" : Number(e.target.value)); setAttendees(new Set()); }}>
            <option value="">개인 일정</option>
            {(projectsQ.data?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        {projectId !== "" && (
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
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>취소</Button>
          <Button onClick={() => title.trim() && create.mutate()} disabled={create.isPending || !title.trim()}>
            {create.isPending ? "저장 중…" : "일정 만들기"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
