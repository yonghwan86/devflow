import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  vector,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const PROJECT_STATUS = ["active", "archived", "completed"] as const;
// G1: owner 폐지 — 프로젝트 역할은 manager/member 2단. 생성자는 manager가 된다.
// (기존 owner 행은 마이그레이션 UPDATE로 manager 전환. 사이트 축은 users.is_admin.)
export const MEMBER_ROLE = ["manager", "member"] as const;
// F1: requested(티켓 요청됨)/rejected(반려됨) 추가. 이 두 상태로의 전이는 일반 PATCH로 불가 —
// 오직 생성(member 티켓)과 승인/반려 API에서만 발생한다(TASK_PATCH_STATUS 참고).
export const TASK_STATUS = ["requested", "rejected", "todo", "in_progress", "blocked", "done"] as const;
// 일반 PATCH의 status 화이트리스트 (requested/rejected 제외 — 양방향 전이 금지)
export const TASK_PATCH_STATUS = ["todo", "in_progress", "blocked", "done"] as const;
export const TASK_KIND = ["task", "ticket"] as const;
export const GUIDE_STATE = ["pending", "applied", "skipped"] as const;
export const SKILL_STATUS = ["draft", "published"] as const;

const ts = () => ({
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  username: text("username"), // AES-256-GCM encrypted at rest
  full_name: text("full_name"),
  password_hash: text("password_hash"),
  avatar_url: text("avatar_url"),
  is_admin: boolean("is_admin").notNull().default(false), // 사이트 관리자 (최초 bootstrap 계정)
  is_active: boolean("is_active").notNull().default(true),
  failed_login_count: integer("failed_login_count").notNull().default(0),
  locked_until: timestamp("locked_until", { withTimezone: true }),
  ...ts(),
});

export const invites = pgTable(
  "invites",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    project_id: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    token_hash: text("token_hash").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    accepted_at: timestamp("accepted_at", { withTimezone: true }),
    created_by: integer("created_by").references(() => users.id),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ tokenIdx: uniqueIndex("invites_token_hash_idx").on(t.token_hash) }),
);

export const apiTokens = pgTable("api_tokens", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token_hash: text("token_hash").notNull().unique(),
  name: text("name").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  expires_at: timestamp("expires_at", { withTimezone: true }),
  last_used_at: timestamp("last_used_at", { withTimezone: true }),
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status", { enum: PROJECT_STATUS }).notNull().default("active"),
  owner_id: integer("owner_id").notNull().references(() => users.id),
  next_task_seq: integer("next_task_seq").notNull().default(1),
  github_repo: text("github_repo"),
  auto_complete_on_pr_merge: boolean("auto_complete_on_pr_merge").notNull().default(false),
  require_checklist_done_before_auto_complete: boolean("require_checklist_done_before_auto_complete").notNull().default(false),
  require_guide_applied_before_done: boolean("require_guide_applied_before_done").notNull().default(false),
  start_date: timestamp("start_date", { withTimezone: true }),
  end_date: timestamp("end_date", { withTimezone: true }),
  ...ts(),
});

export const projectMembers = pgTable(
  "project_members",
  {
    id: serial("id").primaryKey(),
    project_id: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    user_id: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: MEMBER_ROLE }).notNull().default("member"),
    joined_at: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniq: uniqueIndex("project_members_project_user_idx").on(t.project_id, t.user_id) }),
);

// F4: 프로젝트 문서 페이지(트리). tasks.source_page_id가 참조하므로 tasks보다 먼저 선언.
export const pages = pgTable(
  "pages",
  {
    id: serial("id").primaryKey(),
    project_id: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    // 중간 노드 삭제 시 하위는 루트로 승격(set null) — UI가 감안
    parent_id: integer("parent_id"),
    title: text("title").notNull(),
    content: text("content").notNull().default(""), // 마크다운 원문
    sort_order: integer("sort_order").notNull().default(0),
    created_by: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updated_by: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...ts(),
  },
  (t) => ({
    projIdx: index("pages_project_idx").on(t.project_id),
    parentIdx: index("pages_parent_idx").on(t.parent_id),
  }),
);

export const tasks = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    project_id: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    item_key: text("item_key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: TASK_STATUS }).notNull().default("todo"),
    kind: text("kind", { enum: TASK_KIND }).notNull().default("task"), // F1: task | ticket
    requested_by: integer("requested_by").references(() => users.id, { onDelete: "set null" }), // F1: 티켓 요청자
    priority: integer("priority").notNull().default(0),
    label: text("label"),
    due_date: timestamp("due_date", { withTimezone: true }),
    scheduled_date: timestamp("scheduled_date", { withTimezone: true }),
    parent_task_id: integer("parent_task_id"),
    source_page_id: integer("source_page_id").references(() => pages.id, { onDelete: "set null" }), // F4: 출처 문서
    created_by: integer("created_by").notNull().references(() => users.id),
    sort_order: integer("sort_order").notNull().default(0),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    ...ts(),
  },
  (t) => ({
    keyIdx: uniqueIndex("tasks_project_item_key_idx").on(t.project_id, t.item_key),
    projIdx: index("tasks_project_idx").on(t.project_id),
    schedIdx: index("tasks_scheduled_idx").on(t.scheduled_date),
  }),
);

export const taskAssignees = pgTable(
  "task_assignees",
  {
    task_id: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    user_id: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.task_id, t.user_id] }) }),
);

export const checklistItems = pgTable("checklist_items", {
  id: serial("id").primaryKey(),
  task_id: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  done: boolean("done").notNull().default(false),
  done_by: integer("done_by").references(() => users.id),
  done_at: timestamp("done_at", { withTimezone: true }),
  sort_order: integer("sort_order").notNull().default(0),
});

export const comments = pgTable("comments", {
  id: serial("id").primaryKey(),
  task_id: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  author_id: integer("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  parent_id: integer("parent_id"),
  // 체크리스트 항목별 리뷰/피드백: 지정 시 해당 항목 스레드에 표시
  checklist_item_id: integer("checklist_item_id").references(() => checklistItems.id, { onDelete: "cascade" }),
  is_guide: boolean("is_guide").notNull().default(false),
  ...ts(),
});

export const guideAssignees = pgTable(
  "guide_assignees",
  {
    id: serial("id").primaryKey(),
    comment_id: integer("comment_id").notNull().references(() => comments.id, { onDelete: "cascade" }),
    user_id: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    state: text("state", { enum: GUIDE_STATE }).notNull().default("pending"),
    note: text("note"),
    done_at: timestamp("done_at", { withTimezone: true }),
  },
  (t) => ({ uniq: uniqueIndex("guide_assignees_comment_user_idx").on(t.comment_id, t.user_id) }),
);

export const attachments = pgTable("attachments", {
  id: serial("id").primaryKey(),
  comment_id: integer("comment_id").references(() => comments.id, { onDelete: "cascade" }),
  task_id: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  file_name: text("file_name").notNull(),
  mime_type: text("mime_type").notNull(),
  detected_type: text("detected_type"),
  size_bytes: integer("size_bytes").notNull(),
  storage_key: text("storage_key").notNull(),
  thumb_key: text("thumb_key"),
  uploaded_by: integer("uploaded_by").notNull().references(() => users.id),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const activityLog = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  task_id: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  user_id: integer("user_id").references(() => users.id),
  action: text("action").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

export const skills = pgTable("skills", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  category: text("category"),
  name: text("name").notNull(),
  description: text("description"),
  body: text("body").notNull(),
  antipatterns: text("antipatterns"),
  source_refs: jsonb("source_refs").$type<Array<Record<string, unknown>>>(),
  tags: text("tags").array().notNull().default([]),
  status: text("status", { enum: SKILL_STATUS }).notNull().default("draft"),
  extracted_at: timestamp("extracted_at", { withTimezone: true }),
  created_by: integer("created_by").references(() => users.id),
  ...ts(),
});

export const projectsRel = relations(projects, ({ many, one }) => ({
  members: many(projectMembers),
  tasks: many(tasks),
  owner: one(users, { fields: [projects.owner_id], references: [users.id] }),
}));
export const membersRel = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.project_id], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.user_id], references: [users.id] }),
}));
export const tasksRel = relations(tasks, ({ one, many }) => ({
  project: one(projects, { fields: [tasks.project_id], references: [projects.id] }),
  assignees: many(taskAssignees),
  checklist: many(checklistItems),
  comments: many(comments),
}));
export const taskAssigneesRel = relations(taskAssignees, ({ one }) => ({
  task: one(tasks, { fields: [taskAssignees.task_id], references: [tasks.id] }),
  user: one(users, { fields: [taskAssignees.user_id], references: [users.id] }),
}));
export const commentsRel = relations(comments, ({ one, many }) => ({
  task: one(tasks, { fields: [comments.task_id], references: [tasks.id] }),
  author: one(users, { fields: [comments.author_id], references: [users.id] }),
  guideAssignees: many(guideAssignees),
}));
export const guideAssigneesRel = relations(guideAssignees, ({ one }) => ({
  comment: one(comments, { fields: [guideAssignees.comment_id], references: [comments.id] }),
  user: one(users, { fields: [guideAssignees.user_id], references: [users.id] }),
}));

export const insertProjectSchema = createInsertSchema(projects);
export const insertTaskSchema = createInsertSchema(tasks);
export const insertCommentSchema = createInsertSchema(comments);
export const insertChecklistSchema = createInsertSchema(checklistItems);
export const insertSkillSchema = createInsertSchema(skills);
export const selectUserSchema = createSelectSchema(users);

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type GuideAssignee = typeof guideAssignees.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type MemberRole = (typeof MEMBER_ROLE)[number];
export type TaskStatus = (typeof TASK_STATUS)[number];
export type TaskKind = (typeof TASK_KIND)[number]; // F1
export type Page = typeof pages.$inferSelect; // F4

/* ---------------- P6~P9 확장 테이블 ---------------- */

// P6: 태스크 의존성 (선행 태스크 — Redmine의 precedes/follows 패턴)
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    task_id: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    depends_on_task_id: integer("depends_on_task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.task_id, t.depends_on_task_id] }) }),
);

// P7: RAG 임베딩 + 재색인 잡 큐
export const EMBED_SOURCE = ["task", "comment", "skill"] as const;
export const JOB_STATUS = ["pending", "done", "failed"] as const;
export const EMBEDDING_DIM = 1536;

export const embeddings = pgTable(
  "embeddings",
  {
    id: serial("id").primaryKey(),
    project_id: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
    source_type: text("source_type", { enum: EMBED_SOURCE }).notNull(),
    source_id: integer("source_id").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    embedding_model: text("embedding_model").notNull(),
    embedding_version: integer("embedding_version").notNull().default(1),
    content_hash: text("content_hash").notNull(),
    source_updated_at: timestamp("source_updated_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniq: uniqueIndex("embeddings_source_idx").on(t.source_type, t.source_id) }),
);

export const embeddingJobs = pgTable(
  "embedding_jobs",
  {
    id: serial("id").primaryKey(),
    source_type: text("source_type", { enum: EMBED_SOURCE }).notNull(),
    source_id: integer("source_id").notNull(),
    status: text("status", { enum: JOB_STATUS }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    ...ts(),
  },
  (t) => ({ uniq: uniqueIndex("embedding_jobs_source_idx").on(t.source_type, t.source_id) }),
);

// P8: GitHub 연동 (커밋/PR/브랜치 링크 + 웹훅 멱등)
export const GITHUB_KIND = ["commit", "pr", "branch", "issue"] as const;

export const githubLinks = pgTable(
  "github_links",
  {
    id: serial("id").primaryKey(),
    task_id: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: GITHUB_KIND }).notNull(),
    external_id: text("external_id").notNull(),
    url: text("url"),
    title: text("title"),
    state: text("state"),
    ci_status: text("ci_status"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniq: uniqueIndex("github_links_uniq_idx").on(t.task_id, t.kind, t.external_id) }),
);

export const webhookEvents = pgTable("webhook_events", {
  id: serial("id").primaryKey(),
  delivery_id: text("delivery_id").notNull().unique(),
  event_type: text("event_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  processed_at: timestamp("processed_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// P9: 라이브 프리뷰 스니펫 (멀티파일)
export interface SnippetFile {
  name: string;
  content: string;
}
export const snippets = pgTable("snippets", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  task_id: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  files: jsonb("files").$type<SnippetFile[]>().notNull(),
  created_by: integer("created_by").references(() => users.id),
  ...ts(),
});

/* ---------------- 회의록 파이프라인 + P11 검증 갤러리 ---------------- */

// 회의록 → AI 구조화 (자동등록 금지: suggested → 사람 검토 후 accepted)
export const NOTE_STATUS = ["uploaded", "processed", "reviewed"] as const;
// G5-4: event 추가 — 회의록에서 일정 추출
export const EXTRACT_KIND = ["decision", "action", "guide", "blocker", "question", "event"] as const;
export const EXTRACT_STATUS = ["suggested", "accepted", "rejected", "edited"] as const;

export const meetingNotes = pgTable("meeting_notes", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  note_date: timestamp("note_date", { withTimezone: true }),
  source_text: text("source_text").notNull(),
  format: text("format").notNull().default("text"),
  uploaded_by: integer("uploaded_by").references(() => users.id),
  status: text("status", { enum: NOTE_STATUS }).notNull().default("uploaded"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const noteExtractions = pgTable("note_extractions", {
  id: serial("id").primaryKey(),
  note_id: integer("note_id").notNull().references(() => meetingNotes.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: EXTRACT_KIND }).notNull(),
  content: text("content").notNull(),
  speaker: text("speaker"),
  source_excerpt: text("source_excerpt"),
  status: text("status", { enum: EXTRACT_STATUS }).notNull().default("suggested"),
  linked_task_id: integer("linked_task_id").references(() => tasks.id, { onDelete: "set null" }),
  linked_comment_id: integer("linked_comment_id").references(() => comments.id, { onDelete: "set null" }),
  // G5-4: 일정/체크리스트 반영 대상 링크 (FK는 0000_init.sql에서 — events가 뒤에 선언되므로 여기선 plain)
  when_suggested: text("when_suggested"),
  linked_event_id: integer("linked_event_id"),
  linked_checklist_item_id: integer("linked_checklist_item_id"),
  reviewed_by: integer("reviewed_by").references(() => users.id),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// P11: 검증 갤러리 (링크/설명형 1차) — 게이트 조건은 submissions 컬럼으로 단순화
export const SUBMISSION_STATUS = ["open", "validated", "rejected"] as const;
export const FEEDBACK_CATEGORY = ["ux", "perf", "bug", "market", "other"] as const;

export const submissions = pgTable("submissions", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  demo_url: text("demo_url"),
  submitted_by: integer("submitted_by").notNull().references(() => users.id),
  status: text("status", { enum: SUBMISSION_STATUS }).notNull().default("open"),
  min_reviews: integer("min_reviews").notNull().default(3),
  min_avg_rating: integer("min_avg_rating").notNull().default(4), // 1~5
  ...ts(),
});

export const reviewFeedback = pgTable(
  "review_feedback",
  {
    id: serial("id").primaryKey(),
    submission_id: integer("submission_id").notNull().references(() => submissions.id, { onDelete: "cascade" }),
    reviewer_id: integer("reviewer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(), // 1~5
    body: text("body").notNull(),
    category: text("category", { enum: FEEDBACK_CATEGORY }).notNull().default("other"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniq: uniqueIndex("review_feedback_once_idx").on(t.submission_id, t.reviewer_id) }),
);

export type MeetingNote = typeof meetingNotes.$inferSelect;
export type NoteExtraction = typeof noteExtractions.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type ReviewFeedback = typeof reviewFeedback.$inferSelect;

export type TaskDependency = typeof taskDependencies.$inferSelect;
export type Embedding = typeof embeddings.$inferSelect;
export type EmbeddingJob = typeof embeddingJobs.$inferSelect;
export type GithubLink = typeof githubLinks.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type Snippet = typeof snippets.$inferSelect;

/* ---------------- F5: 일정 이벤트 ---------------- */
// project_id null = 개인 일정(생성자+참석자만), not null = 프로젝트 일정(멤버 전체 열람).
// 시간 규약: 시간 지정 이벤트는 실제 timestamptz(캘린더 배치는 로컬 날),
//            all_day 이벤트는 F3 규약대로 `${dayKey}T00:00:00.000Z` 저장(배치는 slice(0,10)).
export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    project_id: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    starts_at: timestamp("starts_at", { withTimezone: true }).notNull(),
    ends_at: timestamp("ends_at", { withTimezone: true }),
    all_day: boolean("all_day").notNull().default(false),
    created_by: integer("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
    ...ts(),
  },
  (t) => ({
    startsIdx: index("events_starts_idx").on(t.starts_at),
    projIdx: index("events_project_idx").on(t.project_id),
    creatorIdx: index("events_creator_idx").on(t.created_by),
  }),
);

export const eventAttendees = pgTable(
  "event_attendees",
  {
    event_id: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    user_id: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.event_id, t.user_id] }),
    userIdx: index("event_attendees_user_idx").on(t.user_id),
  }),
);

export type EventRow = typeof events.$inferSelect;
