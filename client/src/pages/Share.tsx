import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Share2 } from "lucide-react";
import { post, upload } from "../lib/api";
import { Card, Button, Spinner, toast } from "../components/ui";
import { queryClient } from "../lib/queryClient";
import { localDayKey } from "../lib/format";

// v2: 안드로이드 공유 대상 — 다른 앱(쓰레드·브라우저 등)에서 "공유 → DevFlow"로 보낸
// 텍스트·이미지를 서비스워커(sw.js)가 Cache에 스테이징해 두면, 이 페이지가 로그인 세션으로
// 내 기록(오늘 페이지)에 저장한다. iOS는 share_target 미지원 — 시리 단축어 경로 사용.
interface StagedFile { key: string; name: string; type: string }
interface Meta { text: string; files: StagedFile[]; at: number }

const SHARE_CACHE = "devflow-share";

export default function Share() {
  const [, navigate] = useLocation();
  const [meta, setMeta] = useState<Meta | null | undefined>(undefined); // undefined=읽는 중, null=공유 없음
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const objectUrls = useRef<string[]>([]);

  useEffect(() => {
    (async () => {
      try {
        if (!("caches" in window)) { setMeta(null); return; }
        const cache = await caches.open(SHARE_CACHE);
        const res = await cache.match("/__share/meta");
        if (!res) { setMeta(null); return; }
        const m: Meta = await res.json();
        setMeta(m);
        const urls: string[] = [];
        for (const f of m.files) {
          const fr = await cache.match(f.key);
          if (fr) urls.push(URL.createObjectURL(await fr.blob()));
        }
        objectUrls.current = urls;
        setThumbs(urls);
      } catch { setMeta(null); }
    })();
    // 미리보기 blob URL은 떠날 때 해제 (메모리 누수 방지)
    return () => { objectUrls.current.forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  const clearStage = async () => { try { await caches.delete(SHARE_CACHE); } catch { /* 없어도 무방 */ } };

  const save = async () => {
    if (!meta) return;
    setSaving(true);
    try {
      const cache = await caches.open(SHARE_CACHE);
      // 텍스트를 먼저 저장하고 서버가 정한 날짜(entry_date)를 받아 이미지도 같은 날짜에 올린다 —
      // 텍스트=서버 KST, 이미지=기기 TZ로 갈라져 한 공유가 두 날짜에 나뉘던 문제 차단.
      let day = "";
      if (meta.text.trim()) {
        const res = await post<{ entry: { entry_date: string } }>("/journal/append", { text: meta.text.trim() });
        day = res.entry.entry_date;
        // 텍스트는 저장 완료 — 스테이징에서 비워, 재시도(이미지 실패 시)에 중복 append되지 않게
        meta.text = "";
        await cache.put("/__share/meta", new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
      }
      if (!day) day = localDayKey(new Date()); // 텍스트 없이 이미지만 공유된 경우 기기 오늘로
      for (const f of meta.files) {
        const res = await cache.match(f.key);
        if (!res) continue;
        const blob = await res.blob();
        const fd = new FormData();
        fd.append("file", new File([blob], f.name, { type: f.type || blob.type }));
        await upload(`/journal/${day}/attachments`, fd);
        await cache.delete(f.key); // 올린 이미지는 즉시 스테이징에서 제거 — 재시도 시 중복 업로드 방지
      }
      await clearStage();
      void queryClient.invalidateQueries({ queryKey: ["journal"] });
      toast("내 기록에 저장했어요.", "success");
      navigate("/journal", { replace: true });
    } catch (e: any) {
      toast(`저장 실패: ${e.message}. 남은 항목만 다시 시도할 수 있어요.`, "error"); // 성공분은 이미 스테이징에서 빠짐
    } finally { setSaving(false); }
  };

  const discard = async () => { await clearStage(); navigate("/journal", { replace: true }); };

  if (meta === undefined) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (meta === null) {
    return (
      <Card className="mx-auto mt-8 flex max-w-md flex-col items-center gap-3 p-6 text-center">
        <Share2 className="text-slate-300" size={28} />
        <div className="text-sm text-slate-500">공유받은 내용이 없어요.</div>
        <Button size="sm" variant="outline" onClick={() => navigate("/journal", { replace: true })}>내 기록으로</Button>
      </Card>
    );
  }
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-3">
      <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-900">
        <Share2 className="text-brand" size={20} /> 공유받은 내용
      </h1>
      <Card className="flex flex-col gap-3 p-4">
        {meta.text.trim() && (
          <div className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm leading-relaxed text-slate-700">{meta.text}</div>
        )}
        {thumbs.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {thumbs.map((u, i) => <img key={i} src={u} alt={`공유 이미지 ${i + 1}`} className="h-24 w-24 rounded-lg border border-slate-200 object-cover" />)}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void discard()} disabled={saving}>버리기</Button>
          <Button onClick={() => void save()} disabled={saving}>{saving ? "저장 중…" : "내 기록에 추가"}</Button>
        </div>
        <p className="text-xs text-slate-400">오늘 페이지에 시각 스탬프와 함께 저장돼요.</p>
      </Card>
    </div>
  );
}
