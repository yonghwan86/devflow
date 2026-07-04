import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { and, eq, or, inArray } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { attachments, comments, tasks } from "../../../shared/schema.ts";
import { ah } from "../lib/http.ts";
import { requireAuth } from "../middleware/auth.ts";
import { loadTaskForUser } from "../lib/taskService.ts";
import { detectFileType, MAX_UPLOAD_BYTES } from "../lib/fileType.ts";
import { getStorage } from "../lib/storage.ts";
import { logActivity } from "../lib/activity.ts";
import { randomToken } from "../lib/crypto.ts";
import { err } from "../lib/errors.ts";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// Resolve the task an attachment target belongs to (task_id or comment_id) + verify membership.
async function resolveTarget(body: { task_id?: number; comment_id?: number }, userId: number) {
  let taskId = body.task_id;
  if (!taskId && body.comment_id) {
    const [c] = await db.select().from(comments).where(eq(comments.id, body.comment_id)).limit(1);
    if (!c) return null;
    taskId = c.task_id;
  }
  if (!taskId) return null;
  const acc = await loadTaskForUser(taskId, userId);
  if (!acc) return null;
  return { taskId, projectId: acc.task.project_id };
}

export function attachmentsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  // Upload (mobile camera/gallery). Type verified by magic number, NOT client mime.
  r.post(
    "/",
    upload.single("file"),
    ah(async (req, res) => {
      if (!req.file) throw err.badRequest("파일이 없습니다.");
      const task_id = req.body.task_id ? Number(req.body.task_id) : undefined;
      const comment_id = req.body.comment_id ? Number(req.body.comment_id) : undefined;
      const target = await resolveTarget({ task_id, comment_id }, req.userId!);
      if (!target) throw err.forbidden("업로드 권한이 없습니다.");

      const detected = detectFileType(req.file.buffer);
      if (!detected) throw err.badRequest("허용되지 않는 파일 형식입니다.");

      const storage = getStorage();
      const base = `p${target.projectId}/${randomToken(16)}`;
      const storageKey = `${base}.${detected.ext}`;
      await storage.put(storageKey, req.file.buffer, detected.mime);

      // Thumbnail for images.
      let thumbKey: string | null = null;
      if (detected.category === "image") {
        try {
          const thumb = await sharp(req.file.buffer).resize(320, 320, { fit: "inside" }).jpeg({ quality: 72 }).toBuffer();
          thumbKey = `${base}.thumb.jpg`;
          await storage.put(thumbKey, thumb, "image/jpeg");
        } catch { /* non-fatal */ }
      }

      const [a] = await db
        .insert(attachments)
        .values({
          task_id: comment_id ? null : target.taskId,
          comment_id: comment_id ?? null,
          file_name: req.file.originalname,
          mime_type: req.file.mimetype, // stored but untrusted
          detected_type: detected.mime, // authoritative
          size_bytes: req.file.size,
          storage_key: storageKey,
          thumb_key: thumbKey,
          uploaded_by: req.userId!,
        })
        .returning();
      await logActivity({ project_id: target.projectId, task_id: target.taskId, user_id: req.userId, action: "attachment.uploaded", meta: { attachment_id: a.id, detected: detected.mime } });
      res.status(201).json({ attachment: { ...a, download_url: `/api/attachments/${a.id}`, thumb_url: thumbKey ? `/api/attachments/${a.id}?thumb=1` : null } });
    }),
  );

  // List for a task.
  r.get(
    "/",
    ah(async (req, res) => {
      const taskId = Number(req.query.task_id);
      const acc = await loadTaskForUser(taskId, req.userId!);
      if (!acc) throw err.notFound();
      // task-scoped OR belonging to a comment on this task
      const commentIds = (await db.select({ id: comments.id }).from(comments).where(eq(comments.task_id, taskId))).map((c) => c.id);
      const rows = await db
        .select()
        .from(attachments)
        .where(commentIds.length ? or(eq(attachments.task_id, taskId), inArray(attachments.comment_id, commentIds)) : eq(attachments.task_id, taskId));
      res.json({ attachments: rows.map((a) => ({ ...a, download_url: `/api/attachments/${a.id}`, thumb_url: a.thumb_key ? `/api/attachments/${a.id}?thumb=1` : null })) });
    }),
  );

  // Authorized download: presigned URL if driver supports it, else stream (§10.6).
  r.get(
    "/:id",
    ah(async (req, res) => {
      const [a] = await db.select().from(attachments).where(eq(attachments.id, Number(req.params.id))).limit(1);
      if (!a) throw err.notFound();
      // resolve task for membership check
      const taskId = a.task_id ?? (a.comment_id
        ? (await db.select().from(comments).where(eq(comments.id, a.comment_id)).limit(1))[0]?.task_id
        : undefined);
      if (!taskId) throw err.notFound();
      const acc = await loadTaskForUser(taskId, req.userId!);
      if (!acc) throw err.forbidden();

      const wantThumb = req.query.thumb === "1" && a.thumb_key;
      const key = wantThumb ? a.thumb_key! : a.storage_key;
      const storage = getStorage();
      const url = await storage.presignGet(key, a.file_name);
      if (url) return res.redirect(url);
      // stream through app with forced attachment disposition
      const buf = await storage.get(key);
      res.setHeader("Content-Type", wantThumb ? "image/jpeg" : a.detected_type ?? "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(a.file_name)}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(buf);
    }),
  );

  r.delete(
    "/:id",
    ah(async (req, res) => {
      const [a] = await db.select().from(attachments).where(eq(attachments.id, Number(req.params.id))).limit(1);
      if (!a) throw err.notFound();
      const taskId = a.task_id ?? (a.comment_id
        ? (await db.select().from(comments).where(eq(comments.id, a.comment_id)).limit(1))[0]?.task_id
        : undefined);
      if (!taskId) throw err.notFound();
      const acc = await loadTaskForUser(taskId, req.userId!);
      if (!acc) throw err.forbidden();
      if (a.uploaded_by !== req.userId! && acc.role === "member") throw err.forbidden();
      const storage = getStorage();
      await storage.delete(a.storage_key).catch(() => {});
      if (a.thumb_key) await storage.delete(a.thumb_key).catch(() => {});
      await db.delete(attachments).where(eq(attachments.id, a.id));
      res.json({ ok: true });
    }),
  );

  return r;
}
