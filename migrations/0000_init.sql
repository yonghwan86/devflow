-- Idempotent init: safe to re-run. Enables pgvector (used from P7; extension活성 at P0).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  username text,
  full_name text,
  password_hash text,
  avatar_url text,
  is_active boolean NOT NULL DEFAULT true,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id serial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  owner_id integer NOT NULL REFERENCES users(id),
  next_task_seq integer NOT NULL DEFAULT 1,
  github_repo text,
  auto_complete_on_pr_merge boolean NOT NULL DEFAULT false,
  require_checklist_done_before_auto_complete boolean NOT NULL DEFAULT false,
  require_guide_applied_before_done boolean NOT NULL DEFAULT false,
  start_date timestamptz,
  end_date timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  id serial PRIMARY KEY,
  email text NOT NULL,
  project_id integer REFERENCES projects(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS invites_token_hash_idx ON invites(token_hash);

CREATE TABLE IF NOT EXISTS api_tokens (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_members (
  id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS project_members_project_user_idx ON project_members(project_id, user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'todo',
  priority integer NOT NULL DEFAULT 0,
  label text,
  due_date timestamptz,
  scheduled_date timestamptz,
  parent_task_id integer,
  created_by integer NOT NULL REFERENCES users(id),
  sort_order integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_item_key_idx ON tasks(project_id, item_key);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_scheduled_idx ON tasks(scheduled_date);

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  content text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  done_by integer REFERENCES users(id),
  done_at timestamptz,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id integer NOT NULL REFERENCES users(id),
  body text NOT NULL,
  parent_id integer,
  is_guide boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guide_assignees (
  id serial PRIMARY KEY,
  comment_id integer NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending',
  note text,
  done_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS guide_assignees_comment_user_idx ON guide_assignees(comment_id, user_id);

CREATE TABLE IF NOT EXISTS attachments (
  id serial PRIMARY KEY,
  comment_id integer REFERENCES comments(id) ON DELETE CASCADE,
  task_id integer REFERENCES tasks(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  detected_type text,
  size_bytes integer NOT NULL,
  storage_key text NOT NULL,
  thumb_key text,
  uploaded_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id integer REFERENCES tasks(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id),
  action text NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value text
);

CREATE TABLE IF NOT EXISTS skills (
  id serial PRIMARY KEY,
  project_id integer REFERENCES projects(id) ON DELETE SET NULL,
  title text NOT NULL,
  category text,
  name text NOT NULL,
  description text,
  body text NOT NULL,
  antipatterns text,
  source_refs jsonb,
  tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft',
  extracted_at timestamptz,
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- connect-pg-simple session store table (idempotent)
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- 체크리스트 항목별 리뷰/피드백 (idempotent: 기존 DB에는 컬럼 추가, 재실행 무해)
ALTER TABLE comments ADD COLUMN IF NOT EXISTS checklist_item_id integer REFERENCES checklist_items(id) ON DELETE CASCADE;

-- ===== P6~P9 확장 (idempotent) =====
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS embeddings (
  id serial PRIMARY KEY,
  project_id integer REFERENCES projects(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  embedding_model text NOT NULL,
  embedding_version integer NOT NULL DEFAULT 1,
  content_hash text NOT NULL,
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS embeddings_source_idx ON embeddings(source_type, source_id);

CREATE TABLE IF NOT EXISTS embedding_jobs (
  id serial PRIMARY KEY,
  source_type text NOT NULL,
  source_id integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_source_idx ON embedding_jobs(source_type, source_id);

CREATE TABLE IF NOT EXISTS github_links (
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  external_id text NOT NULL,
  url text,
  title text,
  state text,
  ci_status text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS github_links_uniq_idx ON github_links(task_id, kind, external_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id serial PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  payload jsonb,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS snippets (
  id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
  title text NOT NULL,
  files jsonb NOT NULL,
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== 관리자 + 회의록 파이프라인 + P11 검증 갤러리 (idempotent) =====
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
-- 기존 DB 승격: 관리자가 한 명도 없으면 최초 계정을 관리자로
UPDATE users SET is_admin = true
 WHERE id = (SELECT MIN(id) FROM users)
   AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = true);

CREATE TABLE IF NOT EXISTS meeting_notes (
  id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  note_date timestamptz,
  source_text text NOT NULL,
  format text NOT NULL DEFAULT 'text',
  uploaded_by integer REFERENCES users(id),
  status text NOT NULL DEFAULT 'uploaded',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS note_extractions (
  id serial PRIMARY KEY,
  note_id integer NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  kind text NOT NULL,
  content text NOT NULL,
  speaker text,
  source_excerpt text,
  status text NOT NULL DEFAULT 'suggested',
  linked_task_id integer REFERENCES tasks(id) ON DELETE SET NULL,
  linked_comment_id integer REFERENCES comments(id) ON DELETE SET NULL,
  reviewed_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submissions (
  id serial PRIMARY KEY,
  project_id integer REFERENCES projects(id) ON DELETE SET NULL,
  title text NOT NULL,
  summary text NOT NULL,
  demo_url text,
  submitted_by integer NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'open',
  min_reviews integer NOT NULL DEFAULT 3,
  min_avg_rating integer NOT NULL DEFAULT 4,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_feedback (
  id serial PRIMARY KEY,
  submission_id integer NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  reviewer_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating integer NOT NULL,
  body text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS review_feedback_once_idx ON review_feedback(submission_id, reviewer_id);

-- ===== R1: F1 티켓 시스템 (idempotent) =====
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'task';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requested_by integer REFERENCES users(id) ON DELETE SET NULL;

-- ===== R1: F4 문서 페이지 + 태스크 파생 (idempotent) =====
CREATE TABLE IF NOT EXISTS pages (
  id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id integer REFERENCES pages(id) ON DELETE SET NULL,
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pages_project_idx ON pages(project_id);
CREATE INDEX IF NOT EXISTS pages_parent_idx ON pages(parent_id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_page_id integer REFERENCES pages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_source_page_idx ON tasks(source_page_id);

-- ===== R1: F5 일정 이벤트 (idempotent) =====
CREATE TABLE IF NOT EXISTS events (
  id serial PRIMARY KEY,
  project_id integer REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  all_day boolean NOT NULL DEFAULT false,
  created_by integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_starts_idx ON events(starts_at);
CREATE INDEX IF NOT EXISTS events_project_idx ON events(project_id);
CREATE INDEX IF NOT EXISTS events_creator_idx ON events(created_by);

CREATE TABLE IF NOT EXISTS event_attendees (
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS event_attendees_user_idx ON event_attendees(user_id);

-- ===== R2-R: 역할 계층 owner > manager > member (idempotent) =====
-- 각 프로젝트의 생성자(projects.owner_id)를 소유자(owner)로 정규화한다.
-- G1 시기에 생성자가 manager로 들어간 프로젝트도 owner_id 기준으로 소유자를 복원.
UPDATE project_members pm SET role = 'owner'
FROM projects p
WHERE pm.project_id = p.id AND pm.user_id = p.owner_id AND pm.role <> 'owner';

-- ===== R2: G5 회의록 v2 — 일정/체크리스트 반영 링크 (idempotent) =====
-- events / checklist_items 테이블이 위에서 이미 생성된 뒤라 FK 참조 안전.
ALTER TABLE note_extractions ADD COLUMN IF NOT EXISTS when_suggested text;
ALTER TABLE note_extractions ADD COLUMN IF NOT EXISTS linked_event_id integer REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE note_extractions ADD COLUMN IF NOT EXISTS linked_checklist_item_id integer REFERENCES checklist_items(id) ON DELETE SET NULL;
