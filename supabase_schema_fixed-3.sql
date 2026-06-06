-- ═══════════════════════════════════════════════════════════════════
-- LMS Supabase Schema  (Fixed v3)
-- Run this in your Supabase SQL editor (Database → SQL Editor)
-- ═══════════════════════════════════════════════════════════════════

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ─── TRAINERS ───────────────────────────────────────────────────────
create table if not exists lms_trainers (
  id          text primary key,
  name        text not null,
  username    text not null unique,
  -- FIX v3: password now uses PBKDF2 (100k iterations) hashed client-side.
  -- Hash format: PBKDF2(password, salt=id, iterations=100000, hash=SHA-256)
  -- done in SubtleCrypto before insert — never plaintext.
  password    text not null,
  created_at  timestamptz default now()
);

-- ─── STUDENTS ───────────────────────────────────────────────────────
create table if not exists lms_students (
  id                   text primary key,
  name                 text not null,
  email                text not null unique,
  password_hash        text,
  trainer_id           text references lms_trainers(id) on delete cascade,
  approved             boolean default false,
  approved_at          timestamptz,
  pending_course_ids   jsonb default '[]'::jsonb,
  enrolled_course_ids  jsonb default '[]'::jsonb,
  requested_course_id  text,
  requested_course_name text,
  requested_at         timestamptz default now(),
  created_at           timestamptz default now()
);

-- ─── COURSES ───────────────────────────────────────────────────────
create table if not exists lms_courses (
  id          text primary key,
  name        text not null,
  trainer_id  text references lms_trainers(id) on delete cascade,
  plan_text   text default '',
  plan_days   jsonb default '[]'::jsonb,
  start_date  text default '',
  monfri      boolean default true,
  day_status  jsonb default '{}'::jsonb,
  -- day_data stores only lightweight per-day fields (notes, codeEdits).
  -- Heavy AI content goes into lms_day_content rows (one row per type per day).
  day_data    jsonb default '{}'::jsonb,
  -- day_map is deprecated — always derived client-side from plan_days + start_date + monfri.
  -- Kept for schema compat only; app no longer writes it.
  day_map     jsonb default '{}'::jsonb,
  cal_year    int default extract(year from now())::int,
  cal_month   int default extract(month from now())::int - 1,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ─── DAY CONTENT TABLE — one row per (course, day, content_type) ───
-- Replaces cramming everything into day_data JSONB.
-- content_type: 'notebook' | 'examples' | 'resources' | 'assignment' | 'quiz' | 'teachingGuide'
create table if not exists lms_day_content (
  id           text primary key,
  course_id    text not null references lms_courses(id) on delete cascade,
  day_key      text not null,          -- e.g. "2025-06-15"
  content_type text not null,
  content      text,                   -- markdown / JSON string
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (course_id, day_key, content_type)
);

-- ─── CURRENT COURSE SELECTION (per trainer) ─────────────────────────
create table if not exists lms_current_course (
  trainer_id  text primary key references lms_trainers(id) on delete cascade,
  course_id   text,
  updated_at  timestamptz default now()
);

-- ─── DAY FILES (metadata only — actual content in Supabase Storage) ─
-- FIX v3: storage_path is the preferred field. data_url kept for legacy rows only.
--         New uploads go to Supabase Storage bucket 'lms-files'.
create table if not exists lms_day_files (
  id           text primary key,
  course_id    text references lms_courses(id) on delete cascade,
  day_key      text not null,
  name         text,
  type         text,
  size         int,
  storage_path text,   -- path in 'lms-files' storage bucket (preferred)
  data_url     text,   -- legacy base64 fallback; prefer storage_path for new uploads
  created_at   timestamptz default now()
);

-- ─── PERFORMANCE INDEXES ──────────────────────────────────────────
-- FIX v3: Added indexes that were missing — prevents full table scans
-- on common query patterns.
create index if not exists idx_lms_courses_trainer_id    on lms_courses(trainer_id);
create index if not exists idx_lms_students_email        on lms_students(email);
create index if not exists idx_lms_students_trainer_id   on lms_students(trainer_id);
create index if not exists idx_lms_students_req_course   on lms_students(requested_course_id);
create index if not exists idx_lms_day_content_course    on lms_day_content(course_id);
create index if not exists idx_lms_day_content_course_day on lms_day_content(course_id, day_key);
create index if not exists idx_lms_day_files_course_day  on lms_day_files(course_id, day_key);

-- ─── ROW LEVEL SECURITY ─────────────────────────────────────────────
-- FIX v3: RLS enabled. Policies are currently open (allow anon read/write)
-- because the app handles auth in the React layer with hashed passwords.
--
-- ⚠️  PRODUCTION TODO: migrate to Supabase Auth (email/password) and replace
-- these "allow_all" policies with JWT-scoped policies like:
--   using (auth.uid()::text = trainer_id)   -- trainer rows
--   using (auth.uid()::text = id)           -- student rows
-- This gives true row-level isolation without any client-side trust.

alter table lms_trainers        enable row level security;
alter table lms_students        enable row level security;
alter table lms_courses         enable row level security;
alter table lms_current_course  enable row level security;
alter table lms_day_files       enable row level security;
alter table lms_day_content     enable row level security;

-- Drop old policies if they exist (safe to re-run)
drop policy if exists "allow_all_trainers"       on lms_trainers;
drop policy if exists "allow_all_students"       on lms_students;
drop policy if exists "allow_all_courses"        on lms_courses;
drop policy if exists "allow_all_current_course" on lms_current_course;
drop policy if exists "allow_all_day_files"      on lms_day_files;
drop policy if exists "allow_all_day_content"    on lms_day_content;

-- ─── PHASE 1 POLICIES (current: open anon access for React-layer auth) ──────
-- These allow the app to work while you use React-layer hashed-password auth.
-- They are intentionally open — the React layer handles authorization.
-- See Phase 2 below for production-grade JWT-scoped policies.

create policy "allow_all_trainers"        on lms_trainers        for all using (true) with check (true);
create policy "allow_all_students"        on lms_students        for all using (true) with check (true);
create policy "allow_all_courses"         on lms_courses         for all using (true) with check (true);
create policy "allow_all_current_course"  on lms_current_course  for all using (true) with check (true);
create policy "allow_all_day_files"       on lms_day_files       for all using (true) with check (true);
create policy "allow_all_day_content"     on lms_day_content     for all using (true) with check (true);

-- ─── PHASE 2: PRODUCTION-GRADE RLS (migrate to Supabase Auth first) ─────────
-- ⚠️  DO NOT run Phase 2 until you have migrated authentication to Supabase Auth.
--    When ready:
--    1. Migrate trainers/students to Supabase Auth (auth.users table)
--    2. Comment out ALL Phase 1 policies above
--    3. Uncomment ALL Phase 2 policies below
--    4. Update React login to use supabase.auth.signInWithPassword()
--    5. The app will then have true row-level isolation — no cross-trainer data leakage.
--
-- -- Trainers can only read/write their own row
-- create policy "trainers_own_row" on lms_trainers
--   for all using (auth.uid()::text = id) with check (auth.uid()::text = id);
--
-- -- Courses: trainer can only see/modify their own courses
-- create policy "courses_own_trainer" on lms_courses
--   for all using (auth.uid()::text = trainer_id) with check (auth.uid()::text = trainer_id);
--
-- -- Students: student can read their own row; trainer can read rows where trainer_id matches
-- create policy "students_self_read" on lms_students
--   for select using (auth.uid()::text = id OR auth.uid()::text = trainer_id);
-- create policy "students_self_write" on lms_students
--   for all using (auth.uid()::text = trainer_id) with check (auth.uid()::text = trainer_id);
--
-- -- Day content: readable by enrolled student; writable only by course trainer
-- create policy "day_content_trainer_write" on lms_day_content
--   for all using (
--     exists (select 1 from lms_courses where id = course_id and trainer_id = auth.uid()::text)
--   );
-- create policy "day_content_student_read" on lms_day_content
--   for select using (
--     exists (
--       select 1 from lms_students
--       where id = auth.uid()::text
--         and enrolled_course_ids::text ilike '%' || course_id || '%'
--     )
--   );
--
-- -- Day files: same scoping as day_content
-- create policy "day_files_trainer_write" on lms_day_files
--   for all using (
--     exists (select 1 from lms_courses where id = course_id and trainer_id = auth.uid()::text)
--   );
-- create policy "day_files_student_read" on lms_day_files
--   for select using (
--     exists (
--       select 1 from lms_students
--       where id = auth.uid()::text
--         and enrolled_course_ids::text ilike '%' || course_id || '%'
--     )
--   );
--
-- -- Current course: trainer owns their row
-- create policy "current_course_own" on lms_current_course
--   for all using (auth.uid()::text = trainer_id) with check (auth.uid()::text = trainer_id);

-- ─── STORAGE BUCKET for file uploads ──────────────────────────────
-- FIX v3: The app now uploads files to Supabase Storage instead of
-- storing base64 blobs in lms_day_files.data_url.
--
-- One-time setup (do this in Supabase Dashboard, not SQL editor):
--   1. Go to Storage → New Bucket
--   2. Name: lms-files
--   3. Public: OFF (files served via signed URLs)
--   4. Add storage policy: allow anon read + write
--      (or: authenticated only if you've migrated to Supabase Auth)
--
-- If you skip this step, the app automatically falls back to storing
-- base64 in data_url — files still work but the DB will grow large.
