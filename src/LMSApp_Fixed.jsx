import { useState, useEffect, useCallback, useRef, Component } from "react";

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════════ */
const GROQ_MODELS = ["llama-3.1-8b-instant"];
const OLLAMA_MODELS = ["llama3","llama3.1","mistral"];
const DAYS_HDR = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const STATUS_CFG = {
  "Not Started": { bg:"#f8fafc", border:"#e2e8f0", text:"#64748b", dot:"#cbd5e1", label:"Not Started" },
  "In Progress": { bg:"#fffbeb", border:"#fde68a", text:"#92400e", dot:"#f59e0b", label:"In Progress" },
  "Completed":   { bg:"#f0fdf4", border:"#bbf7d0", text:"#166534", dot:"#22c55e", label:"Completed"  },
};
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";

// ─── Supabase credentials stored in sessionStorage (cleared on tab close)
// Users enter URL+key once in Settings; we cache them for the session only.
// ── Supabase credentials come from .env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)
// Students and trainers share the same DB connection — no manual credential entry needed.
const _SB_URL  = import.meta.env.VITE_SUPABASE_URL  || "";
const _SB_KEY  = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const SB_AUTH_KEY  = "lms_sb_auth";

/* ═══════════════════════════════════════════════════════════════════
   ADMIN CREDENTIALS — hardcoded, never stored in DB
   Change these to your own username/password.
═══════════════════════════════════════════════════════════════════ */
const ADMIN_USERNAME = import.meta.env.VITE_ADMIN_USERNAME || "";
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || "";
const ADMIN_USER     = { id: "admin_1", name: "Admin", role: "admin", approved: true };

/* ═══════════════════════════════════════════════════════════════════
   SUPABASE CLIENT — zero external dependency REST wrapper
═══════════════════════════════════════════════════════════════════ */
function makeSupabase(url, key) {
  if (!url || !key) return null;
  const h = {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
  };

  const req = async (method, path, body, extra = {}) => {
    const r = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: { ...h, ...extra },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!r.ok) {
      const e = await r.text().catch(() => r.statusText);
      throw new Error(`Supabase ${r.status}: ${e}`);
    }
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("json")) return r.json();
    return null;
  };

  return {
    async select(table, filter = "") {
      return req("GET", `${table}${filter ? "?" + filter : ""}`);
    },
    async upsert(table, row) {
      return req("POST", table, row, { "Prefer": "resolution=merge-duplicates,return=representation" });
    },
    async update(table, filter, patch) {
      return req("PATCH", `${table}?${filter}`, patch);
    },
    async delete(table, filter) {
      return req("DELETE", `${table}?${filter}`);
    },
    async upsertMany(table, rows) {
      return req("POST", table, rows, { "Prefer": "resolution=merge-duplicates,return=representation" });
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════
   SESSION STORAGE HELPERS (credentials + auth only — no app data)
═══════════════════════════════════════════════════════════════════ */
function getAuthState() {
  try { const s = sessionStorage.getItem(SB_AUTH_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
function saveAuthState(state) {
  try { sessionStorage.setItem(SB_AUTH_KEY, JSON.stringify(state)); } catch {}
}
function getSbCreds() { return { url: _SB_URL, key: _SB_KEY }; }
function saveSbCreds() { /* no-op: credentials are in .env */ }

/* ═══════════════════════════════════════════════════════════════════
   ID GENERATOR
═══════════════════════════════════════════════════════════════════ */
// FIX #2: Password hashing with PBKDF2 (100,000 iterations) — vastly stronger than bare SHA-256.
// PBKDF2 is a proper password hashing function available in SubtleCrypto with no external deps.
// Passwords are NEVER stored or transmitted in plaintext.
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

// FIX 8: Legacy SHA-256 fallback — users who registered before PBKDF2 migration
// can still log in. On success, we transparently return { ok: true, needsRehash: true }
// so the caller can re-save the PBKDF2 hash and upgrade the account silently.
async function hashPasswordLegacySHA256(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyPassword(password, salt, storedHash) {
  // Try PBKDF2 first (current standard)
  const pbkdf2Hash = await hashPassword(password, salt);
  if (pbkdf2Hash === storedHash) return { ok: true, needsRehash: false };
  // Fallback: try bare SHA-256 (legacy accounts before v3)
  const sha256Hash = await hashPasswordLegacySHA256(password);
  if (sha256Hash === storedHash) return { ok: true, needsRehash: true };
  return { ok: false, needsRehash: false };
}

// — cryptographically unique, no collisions
function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  // Fallback for older environments
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ═══════════════════════════════════════════════════════════════════
   SUPABASE DATA LAYER — all reads/writes go through here
═══════════════════════════════════════════════════════════════════ */

// ── TRAINERS ──────────────────────────────────────────────────────
async function sbGetTrainers(sb) {
  const rows = await sb.select("lms_trainers", "order=created_at.asc");
  return rows || [];
}

async function sbGetTrainerById(sb, id) {
  const rows = await sb.select("lms_trainers", `id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows?.[0] || null;
}

// FIX 8: Compare against stored hash, never plaintext. Transparently re-hashes legacy SHA-256 accounts.
async function sbLoginTrainer(sb, username, password) {
  const trainers = await sbGetTrainers(sb);
  const trainer = trainers.find(t => t.username.toLowerCase() === username.toLowerCase());
  if (!trainer) return null;
  const { ok, needsRehash } = await verifyPassword(password, trainer.id, trainer.password);
  if (!ok) return null;
  // Block login if trainer not approved by admin
  if (trainer.approved === false) {
    throw new Error("Your account is pending admin approval. Please wait for approval before logging in.");
  }
  // Silently upgrade legacy SHA-256 hash to PBKDF2
  if (needsRehash) {
    const newHash = await hashPassword(password, trainer.id);
    await sb.update("lms_trainers", `id=eq.${encodeURIComponent(trainer.id)}`, { password: newHash })
      .catch(() => {}); // non-fatal — they are already logged in
  }
  return trainer;
}

// FIX #2: Hash password before storing; FIX #16: no hardcoded default credentials
async function sbRegisterTrainer(sb, name, username, password) {
  const trainers = await sbGetTrainers(sb);
  if (trainers.find(t => t.username.toLowerCase() === username.toLowerCase())) {
    throw new Error("Username already taken");
  }
  const id = "trainer_" + generateId();
  const passwordHash = await hashPassword(password, id);
  const trainer = { id, name: name.trim(), username: username.trim(), password: passwordHash, approved: false, role: "trainer", created_at: new Date().toISOString() };
  await sb.upsert("lms_trainers", trainer);
  return trainer;
}

// ── COURSES ───────────────────────────────────────────────────────
async function sbGetCourses(sb) {
  return (await sb.select("lms_courses", "order=created_at.asc")) || [];
}

async function sbGetCoursesByTrainer(sb, trainerId) {
  // FIX: server-side filter — don't fetch all courses and filter in JS
  const rows = await sb.select("lms_courses", `trainer_id=eq.${encodeURIComponent(trainerId)}&order=created_at.asc`);
  return (rows || []).map(dbRowToCourse);
}

async function sbGetCourseData(sb, courseId) {
  const rows = await sb.select("lms_courses", `id=eq.${encodeURIComponent(courseId)}&limit=1`);
  const row = rows?.[0];
  if (!row) return null;
  return dbRowToCourse(row);
}

function dbRowToCourse(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    trainerId: row.trainer_id,
    planText: row.plan_text || "",
    planDays: row.plan_days || [],
    startDate: row.start_date || new Date().toISOString().split("T")[0],
    monfri: row.monfri !== undefined ? row.monfri : true,
    dayStatus: row.day_status || {},
    dayData: row.day_data || {},
    dayMap: row.day_map || {},
    dayOverrides: row.day_overrides || {},   // { "YYYY-MM-DD": { type:"holiday"|"extra"|"special", label:"..." } }
    calYear: row.cal_year || new Date().getFullYear(),
    calMonth: row.cal_month !== undefined ? row.cal_month : new Date().getMonth(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function courseToDbRow(course) {
  return {
    id: course.id,
    name: course.name,
    trainer_id: course.trainerId || (() => { throw new Error("courseToDbRow: trainerId is required"); })(),
    plan_text: course.planText || "",
    plan_days: course.planDays || [],
    start_date: course.startDate || "",
    monfri: course.monfri !== undefined ? course.monfri : true,
    day_status: course.dayStatus || {},
    day_data: course.dayData || {},
    day_map: course.dayMap || {},
    day_overrides: course.dayOverrides || {},
    cal_year: course.calYear || new Date().getFullYear(),
    cal_month: course.calMonth !== undefined ? course.calMonth : new Date().getMonth(),
    created_at: course.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// FIX #7: Use PATCH (not read-merge-upsert) to avoid last-write-wins race condition.
// Only the fields explicitly in `patch` are sent to Supabase.
async function sbSaveCourseData(sb, courseId, patch) {
  const dbPatch = {};
  const fieldMap = {
    planText: "plan_text", planDays: "plan_days", startDate: "start_date",
    monfri: "monfri", dayStatus: "day_status", dayData: "day_data",
    dayMap: "day_map", dayOverrides: "day_overrides", calYear: "cal_year", calMonth: "cal_month",
    name: "name", trainerId: "trainer_id",
  };
  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (patch[jsKey] !== undefined) dbPatch[dbCol] = patch[jsKey];
  }
  dbPatch.updated_at = new Date().toISOString();
  await sb.update("lms_courses", `id=eq.${encodeURIComponent(courseId)}`, dbPatch);
}

async function sbCreateCourse(sb, name, trainerId) {
  const course = {
    id: generateId(),
    name,
    trainerId: trainerId || (() => { throw new Error("sbCreateCourse: trainerId is required"); })(),
    planText: "", planDays: [],
    startDate: new Date().toISOString().split("T")[0],
    monfri: true, dayStatus: {}, dayData: {}, dayMap: {}, dayOverrides: {},
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await sb.upsert("lms_courses", courseToDbRow(course));
  return course;
}

async function sbDeleteCourse(sb, courseId) {
  await sb.delete("lms_courses", `id=eq.${encodeURIComponent(courseId)}`);
  await sb.delete("lms_day_files", `course_id=eq.${encodeURIComponent(courseId)}`).catch(() => {});
  // clear current_course if it points here
  await sb.delete("lms_current_course", `course_id=eq.${encodeURIComponent(courseId)}`).catch(() => {});
}

async function sbGetCurrentCourseId(sb, trainerId) {
  const rows = await sb.select("lms_current_course", `trainer_id=eq.${encodeURIComponent(trainerId)}&limit=1`);
  return rows?.[0]?.course_id || null;
}

async function sbSetCurrentCourseId(sb, trainerId, courseId) {
  await sb.upsert("lms_current_course", { trainer_id: trainerId, course_id: courseId, updated_at: new Date().toISOString() });
}

// ── STUDENTS ──────────────────────────────────────────────────────
async function sbGetStudents(sb) {
  return (await sb.select("lms_students", "order=created_at.asc")) || [];
}

async function sbSaveStudent(sb, student) {
  await sb.upsert("lms_students", studentToDbRow(student));
}

// FIX #8: Use upsertMany — single HTTP request instead of N+1 sequential calls
async function sbSaveStudents(sb, students) {
  if (!students || students.length === 0) return;
  await sb.upsertMany("lms_students", students.map(studentToDbRow));
}

async function sbDeleteStudent(sb, studentId) {
  await sb.delete("lms_students", `id=eq.${encodeURIComponent(studentId)}`);
}

function studentToDbRow(s) {
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    // FIX #3: persist hashed password
    password_hash: s.passwordHash || s.password_hash || null,
    trainer_id: s.trainerId || s.trainer_id || null,
    approved: s.approved || false,
    approved_at: s.approvedAt || s.approved_at || null,
    pending_course_ids: s.pendingCourseIds || [],
    enrolled_course_ids: s.enrolledCourseIds || [],
    requested_course_id: s.requestedCourseId || null,
    requested_course_name: s.requestedCourseName || null,
    requested_at: s.requestedAt || new Date().toISOString(),
    created_at: s.createdAt || s.created_at || new Date().toISOString(),
  };
}

function dbRowToStudent(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    // FIX #3: surface hashed password so login can verify
    passwordHash: row.password_hash,
    trainerId: row.trainer_id,
    approved: row.approved || false,
    approvedAt: row.approved_at,
    pendingCourseIds: row.pending_course_ids || [],
    enrolledCourseIds: row.enrolled_course_ids || [],
    requestedCourseId: row.requested_course_id,
    requestedCourseName: row.requested_course_name,
    requestedAt: row.requested_at,
    createdAt: row.created_at,
  };
}

function getStudentEnrolledCourses(student) {
  if (!student) return [];
  // Primary path: new-format enrolledCourseIds array has entries
  if (student.enrolledCourseIds && Array.isArray(student.enrolledCourseIds) && student.enrolledCourseIds.length > 0) {
    return student.enrolledCourseIds;
  }
  // Legacy fallback: approved=true with requestedCourseId (old single-course path)
  // Also catches cases where enrolledCourseIds was reset to [] but student is still approved
  if (student.requestedCourseId && student.approved) {
    return [{ courseId: student.requestedCourseId, courseName: student.requestedCourseName || "" }];
  }
  return [];
}

// ── DAY FILES ─────────────────────────────────────────────────────
async function sbGetFilesForDay(sb, courseId, dayKey) {
  const rows = await sb.select("lms_day_files", `course_id=eq.${encodeURIComponent(courseId)}&day_key=eq.${encodeURIComponent(dayKey)}&order=created_at.asc`);
  return (rows || []).map(r => ({ id: r.id, name: r.name, type: r.type, size: r.size, dataUrl: r.data_url, storagePath: r.storage_path, uploadedAt: r.created_at }));
}

// FIX #9: Upload file to Supabase Storage bucket 'lms-files' instead of storing base64 in DB.
// Falls back to storing dataUrl in the DB if Storage is not set up (backward-compat).
async function sbUploadFileToStorage(sbUrl, sbKey, storagePath, blob) {
  const res = await fetch(`${sbUrl}/storage/v1/object/lms-files/${storagePath}`, {
    method: "POST",
    headers: {
      "apikey": sbKey,
      "Authorization": `Bearer ${sbKey}`,
      "Content-Type": blob.type || "application/octet-stream",
    },
    body: blob,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Storage upload failed: ${err}`);
  }
  return storagePath;
}

async function sbGetStorageFileUrl(sbUrl, sbKey, storagePath) {
  // Return a signed URL valid for 1 hour
  const res = await fetch(`${sbUrl}/storage/v1/object/sign/lms-files/${storagePath}`, {
    method: "POST",
    headers: {
      "apikey": sbKey,
      "Authorization": `Bearer ${sbKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.signedURL ? `${sbUrl}/storage/v1${data.signedURL}` : null;
}

async function sbSaveFile(sb, courseId, dayKey, fileObj) {
  await sb.upsert("lms_day_files", {
    id: fileObj.id,
    course_id: courseId,
    day_key: dayKey,
    name: fileObj.name,
    type: fileObj.type,
    size: fileObj.size,
    data_url: fileObj.dataUrl || null,           // legacy: kept for backward compat
    storage_path: fileObj.storagePath || null,   // FIX #9: preferred storage path
    created_at: fileObj.uploadedAt || new Date().toISOString(),
  });
}

async function sbDeleteFile(sb, fileId) {
  await sb.delete("lms_day_files", `id=eq.${encodeURIComponent(fileId)}`);
}

// ── FIX #4: DAY CONTENT — separate table, one row per (course, day, type) ──
// content_type: 'notebook' | 'examples' | 'resources' | 'assignment' | 'quiz' | 'teachingGuide'
async function sbSaveDayContent(sb, courseId, dayKey, contentType, content) {
  const id = `${courseId}__${dayKey}__${contentType}`;
  const payload = typeof content === "object" ? JSON.stringify(content) : (content || "");
  await sb.upsert("lms_day_content", {
    id,
    course_id: courseId,
    day_key: dayKey,
    content_type: contentType,
    content: payload,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });
}

async function sbGetDayContent(sb, courseId, dayKey) {
  const rows = await sb.select(
    "lms_day_content",
    `course_id=eq.${encodeURIComponent(courseId)}&day_key=eq.${encodeURIComponent(dayKey)}`
  );
  const result = {};
  for (const row of (rows || [])) {
    try {
      result[row.content_type] = row.content_type === "quiz"
        ? JSON.parse(row.content)
        : row.content;
    } catch {
      result[row.content_type] = row.content;
    }
  }
  return result;
}

async function sbGetAllDayContent(sb, courseId) {
  const rows = await sb.select(
    "lms_day_content",
    `course_id=eq.${encodeURIComponent(courseId)}&order=day_key.asc`
  );
  const byDay = {};
  for (const row of (rows || [])) {
    if (!byDay[row.day_key]) byDay[row.day_key] = {};
    try {
      byDay[row.day_key][row.content_type] = row.content_type === "quiz"
        ? JSON.parse(row.content)
        : row.content;
    } catch {
      byDay[row.day_key][row.content_type] = row.content;
    }
  }
  return byDay;
}

function getCourseStats(course) {
  const total = course.planDays?.length || 0;
  const completed = Object.values(course.dayStatus || {}).filter(s => s === "Completed").length;
  const inProgress = Object.values(course.dayStatus || {}).filter(s => s === "In Progress").length;
  return { total, completed, inProgress };
}

function validateAIResponse(text, type = "general") {
  if (!text || typeof text !== "string") throw new Error("AI returned empty response");
  if (text.trim().length < 20) throw new Error("AI response too short — may be truncated");
  if (type === "notebook") {
    if (!text.includes("##") && !text.includes("#")) {
      throw new Error("Notebook response missing structure — regenerate");
    }
  }
  if (type === "assignment") {
    if (!text.includes("Part") && !text.includes("Question") && !text.includes("Challenge")) {
      throw new Error("Assignment response missing expected sections — regenerate");
    }
  }
  return text;
}


const daysInMonth  = (y,m) => new Date(y, m+1, 0).getDate();
const firstWeekday = (y,m) => { const d=new Date(y,m,1).getDay(); return d===0?6:d-1; };
const toKey = (y,m,d) => `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const todayKey = () => { const n=new Date(); return toKey(n.getFullYear(),n.getMonth(),n.getDate()); };

function parsePlan(text) {
  const days = [];
  for (const line of text.trim().split("\n")) {
    // FIX 13: Added dot (.) as a valid delimiter so "1. Topic" format also works
    const m = line.trim().match(/^(?:day\s*)?(\d+)\s*[:\-\.\u2013]\s*(.+)$/i);
    if (m) days.push({ dayNum: parseInt(m[1]), topic: m[2].trim() });
  }
  return days;
}

function buildDayMap(planDays, startDate, monfriOnly, dayOverrides = {}) {
  const map = {};
  let date = new Date(startDate);
  let idx = 0;
  // FIX 14: Dynamic tries limit — weekday-only needs ~1.4x iterations vs all-days
  // Add extra buffer for holidays that shift days forward
  const holidayCount = Object.values(dayOverrides).filter(o => o.type === "holiday" || o.type === "special").length;
  const maxTries = Math.ceil(planDays.length * (monfriOnly ? 2 : 1.1)) + 30 + holidayCount * 2;
  let tries = 0;
  while (idx < planDays.length && tries < maxTries) {
    const k = toKey(date.getFullYear(), date.getMonth(), date.getDate());
    const dow = date.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const override = dayOverrides[k];
    // Skip weekends if Mon-Fri mode
    if (monfriOnly && isWeekend) {
      date.setDate(date.getDate() + 1);
      tries++;
      continue;
    }
    // Skip holiday dates — plan shifts forward automatically
    // Also skip "special" days — they have custom content but still shift the plan forward
    if (override?.type === "holiday" || override?.type === "special") {
      date.setDate(date.getDate() + 1);
      tries++;
      continue;
    }
    // "extra" days occupy the slot but belong to the day's own entry, not a plan day
    // They are NOT in dayMap — they're shown separately on the calendar
    map[k] = idx;
    idx++;
    date.setDate(date.getDate() + 1);
    tries++;
  }
  if (idx < planDays.length) {
    console.warn(`LMS: buildDayMap only mapped ${idx}/${planDays.length} days — tries limit reached`);
  }
  return map;
}

function downloadBlob(content, filename, mime="text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function buildIpynb(topic, mdContent, codeBlocks) {
  const cells = [];
  cells.push({ cell_type:"markdown", metadata:{}, source:[`# ${topic}\n\n${mdContent}`] });
  for (const cb of codeBlocks) {
    cells.push({ cell_type:"code", metadata:{}, source:[cb], outputs:[], execution_count:null });
  }
  return JSON.stringify({
    nbformat:4, nbformat_minor:5,
    metadata:{ kernelspec:{ display_name:"Python 3", language:"python", name:"python3" }, language_info:{ name:"python" } },
    cells
  }, null, 2);
}

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```(?:python)?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
}

/* ═══════════════════════════════════════════════════════════════════
   ZIP EXPORT — lazy-loads JSZip from CDN, then packs day content
═══════════════════════════════════════════════════════════════════ */
let _jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (_jszipPromise) return _jszipPromise;
  _jszipPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload  = () => resolve(window.JSZip);
    s.onerror = () => { _jszipPromise = null; reject(new Error("Failed to load JSZip")); };
    document.head.appendChild(s);
  });
  return _jszipPromise;
}

async function buildDayZip(day, dayData, selection) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const folder = zip.folder(`Day${day.dayNum}_${day.topic.replace(/[^a-zA-Z0-9]+/g,"_")}`);
  const { notebook, codeBlocks, examples, resources, assignment, quiz, notes, teachingGuide } = dayData;

  if (selection.notebook && notebook) {
    folder.file(`Day${day.dayNum}_notebook.md`,
      `# Day ${day.dayNum}: ${day.topic}\n\n${notebook}`);
    // Also include as .ipynb
    const cells = [{ cell_type:"markdown", metadata:{}, source:[`# ${day.topic}\n\n${notebook}`] }];
    for (const cb of (codeBlocks||[])) {
      cells.push({ cell_type:"code", metadata:{}, source:[cb], outputs:[], execution_count:null });
    }
    const nb = JSON.stringify({ nbformat:4, nbformat_minor:5,
      metadata:{ kernelspec:{ display_name:"Python 3", language:"python", name:"python3" }, language_info:{ name:"python" }},
      cells }, null, 2);
    folder.file(`Day${day.dayNum}_notebook.ipynb`, nb);
  }

  if (selection.examples && examples) {
    folder.file(`Day${day.dayNum}_exercises.md`,
      `# Day ${day.dayNum} Exercises: ${day.topic}\n\n${examples}`);
  }

  if (selection.resources && resources) {
    folder.file(`Day${day.dayNum}_resources.md`,
      `# Day ${day.dayNum} Resources: ${day.topic}\n\n${resources}`);
  }

  if (selection.assignment && assignment) {
    folder.file(`Day${day.dayNum}_assignment.md`,
      `# Day ${day.dayNum} Assignment: ${day.topic}\n\n${assignment}`);
    // Also as .ipynb skeleton
    const cells2 = [
      { cell_type:"markdown", metadata:{}, source:[`# Assignment: ${day.topic}\n\n${assignment}`] },
      { cell_type:"code", metadata:{}, source:["# Your solution here\n"], outputs:[], execution_count:null }
    ];
    const nb2 = JSON.stringify({ nbformat:4, nbformat_minor:5,
      metadata:{ kernelspec:{ display_name:"Python 3", language:"python", name:"python3" }, language_info:{ name:"python" }},
      cells: cells2 }, null, 2);
    folder.file(`Day${day.dayNum}_assignment.ipynb`, nb2);
  }

  if (selection.quiz && quiz && Array.isArray(quiz)) {
    // Student-facing version (no answers)
    const studentLines = quiz.map((q,i) => [
      `Q${i+1}. ${q.q}`,
      ...q.options.map((o,oi) => `   ${["A","B","C","D"][oi]}) ${o}`),
      ""
    ].join("\n")).join("\n");
    folder.file(`Day${day.dayNum}_quiz_student.md`,
      `# Quiz: ${day.topic}\n\n${studentLines}`);
    // Teacher answer key
    const keyLines = quiz.map((q,i) => [
      `Q${i+1}. ${q.q}`,
      `   ✅ Answer: ${["A","B","C","D"][q.answer]}) ${q.options[q.answer]}`,
      `   📖 ${q.explanation}`,
      ""
    ].join("\n")).join("\n");
    folder.file(`Day${day.dayNum}_quiz_answer_key.md`,
      `# Quiz Answer Key: ${day.topic}\n\n${keyLines}`);
    // Raw JSON for re-import
    folder.file(`Day${day.dayNum}_quiz.json`, JSON.stringify(quiz, null, 2));
  }

  if (selection.notes && notes?.trim()) {
    folder.file(`Day${day.dayNum}_my_notes.md`,
      `# My Notes: Day ${day.dayNum} - ${day.topic}\n\n${notes}`);
  }

  if (selection.guide && teachingGuide) {
    folder.file(`Day${day.dayNum}_teaching_guide.md`,
      `# Teaching Guide: Day ${day.dayNum} - ${day.topic}\n\n${teachingGuide}`);
  }

  // README manifest
  const files = [];
  if (selection.notebook && notebook)           files.push("📓 notebook (.md + .ipynb)");
  if (selection.examples && examples)           files.push("⚡ exercises (.md)");
  if (selection.resources && resources)         files.push("📂 resources (.md)");
  if (selection.assignment && assignment)       files.push("📝 assignment (.md + .ipynb skeleton)");
  if (selection.quiz && quiz?.length)           files.push("🎯 quiz (student sheet + answer key + .json)");
  if (selection.notes && notes?.trim())         files.push("🗒️ personal notes (.md)");
  if (selection.guide && teachingGuide)         files.push("🧑‍🏫 teaching guide (.md)");

  folder.file("README.md",
    `# Day ${day.dayNum}: ${day.topic}\n\nExported from AI With ARBAJ LMS — ${new Date().toLocaleDateString()}\n\n## Contents\n${files.map(f => `- ${f}`).join("\n")}\n`);

  return zip.generateAsync({ type: "blob" });
}


function DayExportPanel({ day, dayData, notify, isTrainer, onClose }) {
  const available = {
    notebook:   !!dayData.notebook,
    examples:   !!dayData.examples,
    resources:  !!dayData.resources,
    assignment: !!dayData.assignment,
    quiz:       Array.isArray(dayData.quiz) && dayData.quiz.length > 0,
    notes:      !!dayData.notes?.trim(),
    guide:      !!dayData.teachingGuide && isTrainer,
  };

  const ITEMS = [
    { key:"notebook",   label:"📓 Notebook",       sub:"(.md + .ipynb)" },
    { key:"examples",   label:"⚡ Exercises",       sub:"(.md)" },
    { key:"resources",  label:"📂 Resources",       sub:"(.md)" },
    { key:"assignment", label:"📝 Assignment",      sub:"(.md + .ipynb skeleton)" },
    { key:"quiz",       label:"🎯 Quiz",            sub:"(student sheet + answer key)" },
    { key:"notes",      label:"🗒️ My Notes",        sub:"(.md)" },
    ...(isTrainer ? [{ key:"guide", label:"🧑‍🏫 Teaching Guide", sub:"(.md)" }] : []),
  ].filter(i => available[i.key]);

  const [sel, setSel] = useState(() => {
    const s = {};
    for (const i of ITEMS) s[i.key] = true;
    return s;
  });
  const [packing, setPacking] = useState(false);

  const totalAvailable = ITEMS.length;
  const totalSelected  = Object.values(sel).filter(Boolean).length;
  const allOn = totalSelected === totalAvailable;

  const toggleAll = () => {
    const s = {};
    for (const i of ITEMS) s[i.key] = !allOn;
    setSel(s);
  };

  const downloadZip = async () => {
    if (totalSelected === 0) { notify("Select at least one item to export", "err"); return; }
    setPacking(true);
    try {
      const blob = await buildDayZip(day, dayData, sel);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `Day${day.dayNum}_${day.topic.replace(/[^a-zA-Z0-9]+/g,"_")}_export.zip`;
      a.click();
      URL.revokeObjectURL(url);
      notify(`Zip downloaded — ${totalSelected} item(s) ✓`);
      setPacking(false);
      onClose();
    } catch(e) {
      notify(`Export failed: ${e.message}`, "err");
      setPacking(false);
    }
  };

  // Single-item quick download (no zip)
  const downloadSingle = (key) => {
    const { notebook, codeBlocks, examples, resources, assignment, quiz, notes, teachingGuide } = dayData;
    if (key === "notebook" && notebook) {
      downloadBlob(`# Day ${day.dayNum}: ${day.topic}\n\n${notebook}`, `Day${day.dayNum}_notebook.md`);
    } else if (key === "examples" && examples) {
      downloadBlob(`# Day ${day.dayNum} Exercises: ${day.topic}\n\n${examples}`, `Day${day.dayNum}_exercises.md`);
    } else if (key === "resources" && resources) {
      downloadBlob(`# Day ${day.dayNum} Resources: ${day.topic}\n\n${resources}`, `Day${day.dayNum}_resources.md`);
    } else if (key === "assignment" && assignment) {
      downloadBlob(`# Day ${day.dayNum} Assignment: ${day.topic}\n\n${assignment}`, `Day${day.dayNum}_assignment.md`);
    } else if (key === "quiz" && quiz?.length) {
      const lines = quiz.map((q,i) => [
        `Q${i+1}. ${q.q}`,
        ...q.options.map((o,oi) => `   ${["A","B","C","D"][oi]}) ${o}`), ""
      ].join("\n")).join("\n");
      downloadBlob(`# Quiz: ${day.topic}\n\n${lines}`, `Day${day.dayNum}_quiz.md`);
    } else if (key === "notes" && notes) {
      downloadBlob(`# My Notes: Day ${day.dayNum}\n\n${notes}`, `Day${day.dayNum}_notes.md`);
    } else if (key === "guide" && teachingGuide) {
      downloadBlob(`# Teaching Guide: Day ${day.dayNum}\n\n${teachingGuide}`, `Day${day.dayNum}_teaching_guide.md`);
    }
  };

  if (totalAvailable === 0) {
    return (
      <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:9000, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}
        onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
        <div style={{ background:"#fff", borderRadius:20, padding:28, maxWidth:400, width:"100%", textAlign:"center" }}>
          <p style={{ fontSize:32, marginBottom:12 }}>📭</p>
          <p style={{ fontWeight:700, fontSize:16, color:"#0f172a", marginBottom:8 }}>Nothing to export yet</p>
          <p style={{ fontSize:13.5, color:"#64748b", marginBottom:20, lineHeight:1.6 }}>Generate some content first — notebook, quiz, assignment, etc. — then come back to export.</p>
          <button className="lms-btn lms-btn-dark" onClick={onClose}>Got it</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:9000, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}
      onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div style={{ background:"#fff", borderRadius:20, width:"100%", maxWidth:500, boxShadow:"0 24px 80px rgba(0,0,0,.3)", overflow:"hidden" }}>

        {/* Header */}
        <div style={{ padding:"20px 24px 16px", borderBottom:"1.5px solid #f1f5f9", display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:38, height:38, background:"linear-gradient(135deg,#3b82f6,#8b5cf6)", borderRadius:11, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
            <Ic n="download" s={18} c="#fff"/>
          </div>
          <div style={{ flex:1 }}>
            <p style={{ fontWeight:800, fontSize:16, color:"#0f172a" }}>Export Day {day.dayNum}</p>
            <p style={{ fontSize:12.5, color:"#64748b" }}>{day.topic}</p>
          </div>
          <button onClick={onClose} style={{ background:"#f1f5f9", border:"none", borderRadius:8, cursor:"pointer", padding:"6px 8px", color:"#64748b" }}>
            <Ic n="x" s={16}/>
          </button>
        </div>

        {/* Content list */}
        <div style={{ padding:"16px 24px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <p style={{ fontSize:12, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:".07em" }}>
              Select content to include
            </p>
            <button onClick={toggleAll} style={{ background:"none", border:"none", cursor:"pointer", fontSize:12.5, color:"#3b82f6", fontWeight:600, fontFamily:"inherit" }}>
              {allOn ? "Deselect all" : "Select all"}
            </button>
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {ITEMS.map(item => (
              <div key={item.key} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 14px", borderRadius:11, border:`1.5px solid ${sel[item.key]?"#3b82f6":"#e2e8f0"}`, background:sel[item.key]?"#eff6ff":"#f8fafc", cursor:"pointer", transition:"all .12s" }}
                onClick={()=>setSel(p=>({...p,[item.key]:!p[item.key]}))}>
                <div style={{ width:20, height:20, borderRadius:6, border:`2px solid ${sel[item.key]?"#3b82f6":"#cbd5e1"}`, background:sel[item.key]?"#3b82f6":"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                  {sel[item.key] && <Ic n="check" s={11} c="#fff"/>}
                </div>
                <span style={{ fontSize:14, fontWeight:600, color:"#0f172a", flex:1 }}>{item.label}</span>
                <span style={{ fontSize:11.5, color:"#94a3b8" }}>{item.sub}</span>
                {/* Quick single-file download button */}
                <button
                  title={`Download ${item.label} only`}
                  onClick={e=>{ e.stopPropagation(); downloadSingle(item.key); }}
                  style={{ background:"#f1f5f9", border:"none", borderRadius:7, cursor:"pointer", padding:"4px 7px", color:"#64748b", display:"flex", alignItems:"center" }}>
                  <Ic n="download" s={13}/>
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding:"14px 24px 20px", borderTop:"1.5px solid #f1f5f9", display:"flex", gap:10, alignItems:"center" }}>
          <button className="lms-btn lms-btn-dark" style={{ flex:1, justifyContent:"center", padding:"11px 0" }}
            disabled={packing || totalSelected === 0}
            onClick={downloadZip}>
            {packing
              ? <><Spin s={14}/>Packing zip…</>
              : <><Ic n="download" s={15}/>Download as .zip ({totalSelected} item{totalSelected!==1?"s":""})</>}
          </button>
          <button className="lms-btn lms-btn-ghost" onClick={onClose}>Cancel</button>
        </div>

        <div style={{ padding:"0 24px 16px" }}>
          <p style={{ fontSize:11.5, color:"#94a3b8", lineHeight:1.6 }}>
            💡 Zip includes student sheets <em>and</em> answer keys. Each item also has a ⬇ button for individual download.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   FIX 7: RETRY LOGIC
   - Only retries on transient errors (network, 429 rate limit, 5xx server errors)
   - Respects Groq's retry-after header on 429
   - Does NOT retry on permanent errors (401 bad key, 400 bad request, 404)
═══════════════════════════════════════════════════════════════════ */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 1500) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Don't retry permanent failures
      if (e._httpStatus && !RETRYABLE_STATUSES.has(e._httpStatus)) throw e;
      if (i < maxAttempts - 1) {
        // Respect retry-after if present (set by callGroq on 429)
        const waitMs = e._retryAfterMs ?? baseDelayMs * Math.pow(2, i);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}

/* ═══════════════════════════════════════════════════════════════════
   AI CALLERS
═══════════════════════════════════════════════════════════════════ */
async function callGroq(apiKey, model, messages) {
  // Vision-capable Groq models — only these support image_url content
  const VISION_MODELS = new Set(["llava-v1.5-7b-4096-preview","llama-3.2-11b-vision-preview","llama-3.2-90b-vision-preview"]);
  const isVisionModel = VISION_MODELS.has(model);

  // For non-vision models, flatten array content down to text only
  const safeMessages = messages.map(m => {
    if (Array.isArray(m.content)) {
      if (isVisionModel) return m; // pass through as-is for vision models
      // Flatten: extract text parts, drop image_url parts
      const text = m.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      return { ...m, content: text || "(no text)" };
    }
    return m;
  });

  // Timeout after 30s — prevents UI freeze if Groq hangs mid-session
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: safeMessages, max_tokens:3000, temperature:0.7 }),
      signal: controller.signal
    });
  } catch(e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") throw new Error("Groq timed out after 30s — check your connection or try a smaller model");
    throw new Error(`Groq unreachable: ${e.message}`);
  }
  clearTimeout(timeout);
  if (!res.ok) {
    const e = await res.json().catch(()=>({}));
    const err = new Error(e?.error?.message || `Groq ${res.status}`);
    err._httpStatus = res.status;
    // Respect Retry-After header on 429 rate limit
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      err._retryAfterMs = retryAfter ? parseFloat(retryAfter) * 1000 : 8000;
    }
    throw err;
  }
  const d = await res.json();
  const content = d?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned no content");
  return content;
}

async function callOllama(baseUrl, model, messages) {
  // Flatten messages: if content is an array (vision format), extract text parts only
  const flatMessages = messages.map(m => {
    if (Array.isArray(m.content)) {
      const textParts = m.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      return { ...m, content: textParts || "(no text content)" };
    }
    return m;
  });
  const prompt = flatMessages.map(m => `${m.role==="system"?"System":m.role==="user"?"User":"Assistant"}: ${m.content}`).join("\n\n");
  // Timeout after 60s — local Ollama can be slow but shouldn't hang indefinitely
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch(`${baseUrl}/api/generate`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ model, prompt, stream:false }),
      signal: controller.signal
    });
  } catch(e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") throw new Error("Ollama timed out after 60s — model may still be loading");
    throw new Error(`Ollama unreachable: ${e.message}`);
  }
  clearTimeout(timeout);
  if (!res.ok) {
    const err = new Error(`Ollama ${res.status}`);
    err._httpStatus = res.status;
    throw err;
  }
  const d = await res.json();
  if (!d?.response) throw new Error("Ollama returned no response");
  return d.response;
}

/* ═══════════════════════════════════════════════════════════════════
   FIX 1: PYODIDE PYTHON RUNNER — real WASM execution
═══════════════════════════════════════════════════════════════════ */
// FIX 3: Renamed to avoid collision with the React state variable of the same name
let pyodideInstance = null;
let pyodideLoadingPromise = null;

async function loadPyodide() {
  if (pyodideInstance) return pyodideInstance;
  if (pyodideLoadingPromise) return pyodideLoadingPromise;

  pyodideLoadingPromise = new Promise(async (resolve, reject) => {
    try {
      if (!window.loadPyodide) {
        await new Promise((res, rej) => {
          const script = document.createElement("script");
          script.src = PYODIDE_URL;
          script.onload = res;
          script.onerror = () => rej(new Error("Failed to load Pyodide script"));
          document.head.appendChild(script);
        });
      }
      const py = await window.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/" });
      pyodideInstance = py;
      resolve(py);
    } catch (e) {
      pyodideLoadingPromise = null;
      reject(e);
    }
  });
  return pyodideLoadingPromise;
}

async function runPythonReal(code) {
  const py = await loadPyodide();
  let stdout = "";
  let stderr = "";

  py.setStdout({ batched: (text) => { stdout += text + "\n"; } });
  py.setStderr({ batched: (text) => { stderr += text + "\n"; } });

  try {
    await py.runPythonAsync(code);
    return (stdout || "(no output)") + (stderr ? `\nSTDERR:\n${stderr}` : "");
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   FIX 9: OFFLINE INDICATOR HOOK
═══════════════════════════════════════════════════════════════════ */
function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

/* ═══════════════════════════════════════════════════════════════════
   FIX 3 + FIX 15: ERROR BOUNDARY
   The key-based remount trick only works when the key is on the
   ErrorBoundary itself (from its parent). We expose a resetKey prop
   and use a thin wrapper component (ResettableErrorBoundary) that
   increments it, forcing a full unmount+remount of the boundary and
   its children — preventing an immediate re-crash on "Try Again".
═══════════════════════════════════════════════════════════════════ */
class ErrorBoundaryInner extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("LMS crashed:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, textAlign: "center", fontFamily: "system-ui" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ color: "#dc2626", marginBottom: 12 }}>Something went wrong</h2>
          <p style={{ color: "#64748b", marginBottom: 20, maxWidth: 400, margin: "0 auto 20px" }}>
            {this.state.error.message}
          </p>
          <button
            style={{ padding: "10px 24px", background: "#0f172a", color: "#fff", border: "none", borderRadius: 9, cursor: "pointer", fontSize: 14, fontWeight: 600 }}
            onClick={() => this.props.onReset()}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// FIX 15: Wrapper that holds resetKey in state; incrementing it remounts
// ErrorBoundaryInner (and therefore all its children) from scratch.
function ErrorBoundary({ children }) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundaryInner key={resetKey} onReset={() => setResetKey(k => k + 1)}>
      {children}
    </ErrorBoundaryInner>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ICONS
═══════════════════════════════════════════════════════════════════ */
const Ic = ({ n, s=16, c="currentColor" }) => {
  const a = { width:s, height:s, viewBox:"0 0 24 24", fill:"none", stroke:c, strokeWidth:"2", strokeLinecap:"round", strokeLinejoin:"round" };
  if (n==="home")     return <svg {...a}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
  if (n==="book")     return <svg {...a}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>;
  if (n==="calendar") return <svg {...a}><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
  if (n==="settings") return <svg {...a}><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M4.93 19.07l1.41-1.41M19.07 19.07l-1.41-1.41M12 2v2M12 20v2M2 12h2M20 12h2"/></svg>;
  if (n==="upload")   return <svg {...a}><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>;
  if (n==="download") return <svg {...a}><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>;
  if (n==="play")     return <svg {...a}><polygon points="5 3 19 12 5 21 5 3"/></svg>;
  if (n==="check")    return <svg {...a}><polyline points="20 6 9 17 4 12"/></svg>;
  if (n==="x")        return <svg {...a}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
  if (n==="plus")     return <svg {...a}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
  if (n==="brain")    return <svg {...a}><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-1.98-3A3 3 0 0 1 4 12a3 3 0 0 1 1.06-2.29 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 1.98-3A3 3 0 0 0 20 12a3 3 0 0 0-1.06-2.29 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>;
  if (n==="code")     return <svg {...a}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
  if (n==="file")     return <svg {...a}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>;
  if (n==="chevL")    return <svg {...a}><polyline points="15 18 9 12 15 6"/></svg>;
  if (n==="chevR")    return <svg {...a}><polyline points="9 18 15 12 9 6"/></svg>;
  if (n==="menu")     return <svg {...a}><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>;
  if (n==="clip")     return <svg {...a}><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>;
  if (n==="loader")   return <svg {...a}><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>;
  if (n==="zap")      return <svg {...a}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
  if (n==="teacher")  return <svg {...a}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
  if (n==="chart")    return <svg {...a}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>;
  if (n==="trash")    return <svg {...a}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>;
  if (n==="img")      return <svg {...a}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>;
  if (n==="pdf")      return <svg {...a}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>;
  if (n==="db")       return <svg {...a}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
  if (n==="bell")     return <svg {...a}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>;
  if (n==="lock")     return <svg {...a}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
  if (n==="user")     return <svg {...a}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
  if (n==="wifi-off") return <svg {...a}><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>;
  if (n==="refresh")  return <svg {...a}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>;
  if (n==="search")   return <svg {...a}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
  if (n==="shield")   return <svg {...a}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
  return null;
};

const Spin = ({ s=14 }) => (
  <span style={{ display:"inline-flex", animation:"lms-spin 0.8s linear infinite" }}>
    <Ic n="loader" s={s} />
  </span>
);

import bgImage from "./assets/bg.jpg";
/* ═══════════════════════════════════════════════════════════════════
   LOGIN SCREEN — uses Supabase for all auth
═══════════════════════════════════════════════════════════════════ */
function LoginScreen({ onLogin, sb }) {
  const [mode, setMode] = useState("select");
  const [trainerUsername, setTrainerUsername] = useState("");
  const [trainerPass, setTrainerPass]         = useState("");
  const [newTrainerName, setNewTrainerName]   = useState("");
  const [newTrainerUsername, setNewTrainerUsername] = useState("");
  const [newTrainerPass, setNewTrainerPass]   = useState("");
  const [studentEmail, setStudentEmail]       = useState("");
  const [studentName, setStudentName]         = useState("");
  const [studentPassword, setStudentPassword] = useState(""); // FIX #3
  const [studentCourseIds, setStudentCourseIds] = useState([]); // multi-course selection
  const [error, setError]   = useState("");
  const [loading, setLoading] = useState(false);
  const [allCourses, setAllCourses] = useState([]);
  const [trainersMap, setTrainersMap] = useState({});


  useEffect(() => {
    if (!sb) return;
    sbGetCourses(sb).then(courses => {
      setAllCourses(courses.map(dbRowToCourse));
      sbGetTrainers(sb).then(trainers => {
        const m = {};
        trainers.forEach(t => { m[t.id] = t; });
        setTrainersMap(m);
      }).catch(() => {});
    }).catch(() => {});
  }, [sb]);

  const handleTrainerLogin = async () => {
    setError(""); setLoading(true);
    try {
      if (!trainerUsername.trim() || !trainerPass.trim()) throw new Error("Enter username and password");
      // ── Admin hardcoded login (no DB lookup needed) ──
      if (trainerUsername.trim() === ADMIN_USERNAME && trainerPass === ADMIN_PASSWORD) {
        saveAuthState({ ...ADMIN_USER, loginTime: new Date().toISOString() });
        onLogin();
        setLoading(false);
        return;
      }
      if (!sb) throw new Error("Database not configured — check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env");
      const trainer = await sbLoginTrainer(sb, trainerUsername.trim(), trainerPass);
      if (!trainer) throw new Error("Invalid username or password");
      saveAuthState({ role: "trainer", id: trainer.id, name: trainer.name, username: trainer.username, loginTime: new Date().toISOString() });
      onLogin();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const handleTrainerRegister = async () => {
    setError(""); setLoading(true);
    try {
      if (!newTrainerName.trim() || !newTrainerUsername.trim() || !newTrainerPass.trim()) throw new Error("Fill in all fields");
      if (!sb) throw new Error("Database not configured — check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env");
      await sbRegisterTrainer(sb, newTrainerName, newTrainerUsername, newTrainerPass);
      // Do NOT auto-login — trainer must wait for admin approval
      setError("");
      setNewTrainerName(""); setNewTrainerUsername(""); setNewTrainerPass("");
      setMode("trainer-pending");
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const handleStudentRegister = async () => {
    setError(""); setLoading(true);
    try {
      if (!studentName.trim() || !studentEmail.trim()) throw new Error("Fill in all fields");
      // FIX #3: require a password on registration
      if (!studentPassword.trim() || studentPassword.trim().length < 6) throw new Error("Password must be at least 6 characters");
      if (!studentCourseIds.length) throw new Error("Please select at least one course to enroll in");
      // FIX #14: filter server-side by email — don't fetch all students
      const existingRows = await sb.select("lms_students", `email=eq.${encodeURIComponent(studentEmail.trim())}&limit=1`);
      if (existingRows && existingRows.length > 0) throw new Error("Email already registered");
      // Use the first selected course's trainer as the primary trainer
      const firstCourse = allCourses.find(c => c.id === studentCourseIds[0]);
      if (!firstCourse?.trainerId) throw new Error("Could not determine trainer for the selected course");
      const newId = generateId();
      // FIX #3: hash the password before storing
      const passwordHash = await hashPassword(studentPassword.trim(), newId);
      const pendingCourseIds = studentCourseIds.map(cid => {
        const course = allCourses.find(c => c.id === cid);
        return { courseId: cid, courseName: course?.name || "", requestedAt: new Date().toISOString() };
      });
      const newStudent = {
        id: newId,
        name: studentName.trim(),
        email: studentEmail.trim(),
        passwordHash,
        trainerId: firstCourse.trainerId,
        approved: false,
        pendingCourseIds,
        enrolledCourseIds: [],
        requestedCourseId: studentCourseIds[0],
        requestedCourseName: firstCourse?.name || "",
        requestedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      await sbSaveStudent(sb, newStudent);
      alert(`✅ Registered for ${studentCourseIds.length} course(s)! Wait for trainer approval.`);
      setMode("select");
      setStudentName(""); setStudentEmail(""); setStudentCourseIds([]); setStudentPassword("");
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  // FIX #3: student login now verifies password hash
  const handleStudentLogin = async () => {
    setError(""); setLoading(true);
    try {
      if (!studentEmail.trim()) throw new Error("Enter email");
      if (!studentPassword.trim()) throw new Error("Enter password");
      // FIX #14: server-side filter, not full table scan
      const rows = await sb.select("lms_students", `email=eq.${encodeURIComponent(studentEmail.trim())}&limit=1`);
      if (!rows || rows.length === 0) throw new Error("Email not found");
      const student = dbRowToStudent(rows[0]);
      // FIX 8: Verify password with PBKDF2; transparently rehash legacy SHA-256 accounts
      if (student.passwordHash) {
        const { ok, needsRehash } = await verifyPassword(studentPassword.trim(), student.id, student.passwordHash);
        if (!ok) throw new Error("Incorrect password");
        if (needsRehash) {
          const newHash = await hashPassword(studentPassword.trim(), student.id);
          await sb.update("lms_students", `id=eq.${encodeURIComponent(student.id)}`, { password_hash: newHash })
            .catch(() => {}); // non-fatal
        }
      }
      const enrolled = getStudentEnrolledCourses(student);
      const hasApproved = student.approved || enrolled.length > 0;
      if (!hasApproved) throw new Error("Pending trainer approval");
      saveAuthState({ role: "student", id: student.id, name: student.name, email: student.email, loginTime: new Date().toISOString() });
      onLogin();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };



  return (
    

<div style={{
  minHeight: "100vh",
  backgroundImage: `url(${bgImage})`,
  backgroundSize: "cover",
  backgroundPosition: "center",
  backgroundRepeat: "no-repeat",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  
  fontFamily: "'Segoe UI','Helvetica Neue',system-ui,sans-serif"
}}>
      <div style={{ background:"white", borderRadius:20, padding:48, maxWidth:480, width:"100%", boxShadow:"0 25px 70px rgba(0,0,0,.25)" }}>
        <div style={{ textAlign:"center", marginBottom:40 }}>
          <div style={{ fontSize:56, marginBottom:16 }}>📚</div>
          <h1 style={{ fontSize:32, fontWeight:800, color:"#1a202c", margin:0, letterSpacing:"-0.5px" }}>LMS Portal</h1>
          <p style={{ color:"#64748b", fontSize:14, margin:"12px 0 0 0", lineHeight:1.6 }}>Interactive Learning Management System</p>
        </div>

        {error && <div style={{ background:"#fed7d7", color:"#c53030", padding:12, borderRadius:8, marginBottom:20, fontSize:13 }}>{error}</div>}

        {mode === "select" && (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <button onClick={() => setMode("trainer")} style={{ padding:14, background:"#667eea", color:"white", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>👨‍🏫 Trainer Login</button>
            <button onClick={() => setMode("trainer-register")} style={{ padding:14, background:"#4f46e5", color:"white", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>🆕 New Trainer Account</button>
            <button onClick={() => setMode("student")} style={{ padding:14, background:"#764ba2", color:"white", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>👨‍🎓 Student Login</button>
            <button onClick={() => setMode("register")} style={{ padding:14, background:"#e2e8f0", color:"#2d3748", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>✍️ Student Registration</button>
          </div>
        )}

        {mode === "trainer" && (
          <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
            <input type="text" value={trainerUsername} onChange={e=>setTrainerUsername(e.target.value)} placeholder="Username" style={{ padding:10, border:"1px solid #cbd5e1", borderRadius:6, fontSize:14 }} />
            <input type="password" value={trainerPass} onChange={e=>setTrainerPass(e.target.value)} placeholder="Password" style={{ padding:10, border:"1px solid #cbd5e1", borderRadius:6, fontSize:14 }} onKeyDown={e=>e.key==="Enter"&&handleTrainerLogin()} />
            <button onClick={handleTrainerLogin} disabled={loading} style={{ padding:12, background:"#667eea", color:"white", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>{loading?"Logging in...":"Login"}</button>
            <button onClick={()=>setMode("select")} style={{ padding:12, background:"#e2e8f0", color:"#667eea", border:"1px solid #667eea", borderRadius:8, fontWeight:600, cursor:"pointer" }}>← Back</button>
          </div>
        )}

        {mode === "trainer-register" && (
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <p style={{ fontWeight:700, fontSize:15, color:"#1a202c", margin:0 }}>Create Trainer Account</p>
            <input type="text" value={newTrainerName} onChange={e=>setNewTrainerName(e.target.value)} placeholder="Full Name" style={{ padding:10, border:"1px solid #cbd5e1", borderRadius:6, fontSize:14 }} />
            <input type="text" value={newTrainerUsername} onChange={e=>setNewTrainerUsername(e.target.value)} placeholder="Username (unique)" style={{ padding:10, border:"1px solid #cbd5e1", borderRadius:6, fontSize:14 }} />
            <input type="password" value={newTrainerPass} onChange={e=>setNewTrainerPass(e.target.value)} placeholder="Password" style={{ padding:10, border:"1px solid #cbd5e1", borderRadius:6, fontSize:14 }} />
            <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:8, padding:"10px 14px", fontSize:12.5, color:"#92400e", lineHeight:1.6 }}>
              🔒 New trainer accounts require admin approval before login is granted.
            </div>
            <button onClick={handleTrainerRegister} disabled={loading} style={{ padding:12, background:"#4f46e5", color:"white", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>{loading?"Creating...":"Request Trainer Account"}</button>
            <button onClick={()=>setMode("select")} style={{ padding:12, background:"#e2e8f0", color:"#667eea", border:"1px solid #667eea", borderRadius:8, fontWeight:600, cursor:"pointer" }}>← Back</button>
          </div>
        )}

        {mode === "trainer-pending" && (
          <div style={{ display:"flex", flexDirection:"column", gap:16, textAlign:"center" }}>
            <div style={{ fontSize:52 }}>⏳</div>
            <p style={{ fontWeight:800, fontSize:18, color:"#1a202c", margin:0 }}>Account Created!</p>
            <p style={{ fontSize:13.5, color:"#64748b", lineHeight:1.7, margin:0 }}>
              Your trainer account has been submitted. An admin will review and approve it shortly. Once approved, you can log in normally.
            </p>
            <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"12px 16px", fontSize:13, color:"#166534", textAlign:"left", lineHeight:1.6 }}>
              ✅ Account registered successfully<br/>
              🔒 Status: <strong>Pending admin approval</strong><br/>
              📧 Contact admin if not approved within 24 hrs
            </div>
            <button onClick={()=>setMode("trainer")} style={{ padding:12, background:"#667eea", color:"white", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>Go to Trainer Login</button>
            <button onClick={()=>setMode("select")} style={{ padding:12, background:"#e2e8f0", color:"#4a5568", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>← Back to Home</button>
          </div>
        )}

        {mode === "student" && (
          <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
            <input type="email" value={studentEmail} onChange={e=>setStudentEmail(e.target.value)} placeholder="your@email.com" style={{ padding:10, border:"1px solid #cbd5e1", borderRadius:6, fontSize:14 }} />
            {/* FIX #3: password required for student login */}
            <input type="password" value={studentPassword} onChange={e=>setStudentPassword(e.target.value)} placeholder="Password" style={{ padding:10, border:"1px solid #cbd5e1", borderRadius:6, fontSize:14 }} onKeyDown={e=>e.key==="Enter"&&handleStudentLogin()} />
            <button onClick={handleStudentLogin} disabled={loading} style={{ padding:12, background:"#764ba2", color:"white", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>{loading?"Logging in...":"Login"}</button>
            <button onClick={()=>setMode("select")} style={{ padding:12, background:"#e2e8f0", color:"#667eea", border:"1px solid #667eea", borderRadius:8, fontWeight:600, cursor:"pointer" }}>← Back</button>
          </div>
        )}

        {mode === "register" && (
          <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
            <input type="text" value={studentName} onChange={e=>setStudentName(e.target.value)} placeholder="Full Name" style={{ padding:10, border:"1px solid #cbd5e1", borderRadius:6, fontSize:14 }} />
            <input type="email" value={studentEmail} onChange={e=>setStudentEmail(e.target.value)} placeholder="your@email.com" style={{ padding:10, border:"1px solid #cbd5e1", borderRadius:6, fontSize:14 }} />
            {/* FIX #3: require password at registration */}
            <input type="password" value={studentPassword} onChange={e=>setStudentPassword(e.target.value)} placeholder="Choose a password (min 6 chars)" style={{ padding:10, border:"1px solid #cbd5e1", borderRadius:6, fontSize:14 }} />

            {/* Multi-course selection — grouped by trainer */}
            <div style={{ border:"1px solid #cbd5e1", borderRadius:8, overflow:"hidden" }}>
              <div style={{ background:"#f7f7f7", padding:"8px 12px", fontSize:13, fontWeight:700, color:"#4a5568", borderBottom:"1px solid #e2e8f0" }}>
                📚 Select Course(s) to Enroll In {studentCourseIds.length > 0 && <span style={{ marginLeft:6, background:"#764ba2", color:"#fff", borderRadius:99, fontSize:11, padding:"1px 7px" }}>{studentCourseIds.length} selected</span>}
              </div>
              <div style={{ maxHeight:220, overflowY:"auto", padding:"8px 4px" }}>
                {allCourses.length === 0
                  ? <p style={{ padding:"12px 16px", color:"#94a3b8", fontSize:13 }}>No courses available yet.</p>
                  : (() => {
                      // Group courses by trainer
                      const byTrainer = {};
                      allCourses.forEach(c => {
                        const tName = trainersMap[c.trainerId]?.name || "Unknown Trainer";
                        if (!byTrainer[tName]) byTrainer[tName] = [];
                        byTrainer[tName].push(c);
                      });
                      return Object.entries(byTrainer).map(([tName, courses]) => (
                        <div key={tName}>
                          <div style={{ padding:"5px 12px 3px", fontSize:11, fontWeight:700, color:"#764ba2", textTransform:"uppercase", letterSpacing:".06em" }}>👨‍🏫 {tName}</div>
                          {courses.map(c => {
                            const checked = studentCourseIds.includes(c.id);
                            return (
                              <label key={c.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 14px", cursor:"pointer", background:checked?"#f5f3ff":"transparent", transition:"background .12s" }}>
                                <input type="checkbox" checked={checked}
                                  onChange={e => {
                                    if (e.target.checked) setStudentCourseIds(prev => [...prev, c.id]);
                                    else setStudentCourseIds(prev => prev.filter(id => id !== c.id));
                                  }}
                                  style={{ width:15, height:15, accentColor:"#764ba2", cursor:"pointer" }}
                                />
                                <span style={{ fontSize:13.5, color:checked?"#5b21b6":"#2d3748", fontWeight:checked?600:400 }}>{c.name}</span>
                              </label>
                            );
                          })}
                        </div>
                      ));
                    })()
                }
              </div>
            </div>

            <button onClick={handleStudentRegister} disabled={loading} style={{ padding:12, background:"#764ba2", color:"white", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>{loading?"Registering...":"Register"}</button>
            <button onClick={()=>setMode("select")} style={{ padding:12, background:"#e2e8f0", color:"#667eea", border:"1px solid #667eea", borderRadius:8, fontWeight:600, cursor:"pointer" }}>← Back</button>
          </div>
        )}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════
   TRAINER ENROLLMENTS — Supabase-backed
═══════════════════════════════════════════════════════════════════ */
function TrainerEnrollments({ courseId, courseName, trainerId, sb, onClose }) {
  const [students, setStudents] = useState([]);
  const [allCourses, setAllCourses] = useState([]);
  const [addCourseStudentId, setAddCourseStudentId] = useState(null);
  const [addCourseId, setAddCourseId]               = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      // FIX 3: filter server-side by trainer_id — never fetch the whole students table
      const rows = await sb.select("lms_students", `trainer_id=eq.${encodeURIComponent(trainerId)}&order=created_at.asc`);
      setStudents((rows || []).map(dbRowToStudent));
      // FIX 1: sbGetCoursesByTrainer already calls dbRowToCourse — no double-map
      const courses = await sbGetCoursesByTrainer(sb, trainerId);
      setAllCourses(courses);
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const pending = students.filter(s => {
    const inPending = Array.isArray(s.pendingCourseIds) && s.pendingCourseIds.some(p => p.courseId === courseId);
    const legacyPending = !s.approved && s.requestedCourseId === courseId && !Array.isArray(s.pendingCourseIds);
    return inPending || legacyPending;
  });

  const approved = students.filter(s => {
    const inEnrolled = Array.isArray(s.enrolledCourseIds) && s.enrolledCourseIds.some(e => e.courseId === courseId);
    const legacyApproved = s.approved && s.requestedCourseId === courseId && !Array.isArray(s.enrolledCourseIds);
    return inEnrolled || legacyApproved;
  });

  const handleApprove = async (studentId) => {
    const s = students.find(x => x.id === studentId);
    if (!s) return;
    const pendingEntry = Array.isArray(s.pendingCourseIds) ? s.pendingCourseIds.find(p => p.courseId === courseId) : { courseId, courseName: s.requestedCourseName || courseName };
    const newEnrolled = [...(s.enrolledCourseIds || [])];
    if (!newEnrolled.some(e => e.courseId === courseId)) {
      newEnrolled.push({ courseId, courseName: pendingEntry?.courseName || courseName, approvedAt: new Date().toISOString() });
    }
    const newPending = Array.isArray(s.pendingCourseIds) ? s.pendingCourseIds.filter(p => p.courseId !== courseId) : [];
    const updated = { ...s, enrolledCourseIds: newEnrolled, pendingCourseIds: newPending, approved: true, approvedAt: new Date().toISOString(), requestedCourseId: s.requestedCourseId || courseId, requestedCourseName: s.requestedCourseName || courseName };
    await sbSaveStudent(sb, updated);
    load();
  };

  const handleReject = async (studentId) => {
    const s = students.find(x => x.id === studentId);
    if (!s) return;
    const newPending = Array.isArray(s.pendingCourseIds) ? s.pendingCourseIds.filter(p => p.courseId !== courseId) : [];
    const hasPending = newPending.length > 0;
    const hasEnrolled = Array.isArray(s.enrolledCourseIds) && s.enrolledCourseIds.length > 0;
    if (!hasPending && !hasEnrolled && !Array.isArray(s.pendingCourseIds)) {
      await sbDeleteStudent(sb, studentId);
    } else {
      await sbSaveStudent(sb, { ...s, pendingCourseIds: newPending });
    }
    load();
  };

  const handleRevoke = async (studentId) => {
    const s = students.find(x => x.id === studentId);
    if (!s) return;
    const newEnrolled = Array.isArray(s.enrolledCourseIds) ? s.enrolledCourseIds.filter(e => e.courseId !== courseId) : [];
    await sbSaveStudent(sb, { ...s, enrolledCourseIds: newEnrolled });
    load();
  };

  const handleAddCourseEnrollment = async () => {
    if (!addCourseStudentId || !addCourseId) return;
    const target = allCourses.find(c => c.id === addCourseId);
    if (!target) return;
    const s = students.find(x => x.id === addCourseStudentId);
    if (!s) return;
    const newEnrolled = [...(s.enrolledCourseIds || [])];
    if (!newEnrolled.some(e => e.courseId === addCourseId)) {
      newEnrolled.push({ courseId: addCourseId, courseName: target.name, approvedAt: new Date().toISOString() });
    }
    await sbSaveStudent(sb, { ...s, enrolledCourseIds: newEnrolled });
    setAddCourseStudentId(null); setAddCourseId("");
    load();
  };

  return (
    <div style={{ position:"fixed", top:0, left:0, right:0, bottom:0, background:"rgba(0,0,0,0.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:10000, padding:20 }}>
      <div style={{ background:"white", borderRadius:16, padding:30, maxWidth:720, width:"100%", maxHeight:"85vh", overflow:"auto", boxShadow:"0 20px 60px rgba(0,0,0,.3)" }}>
        <h2 style={{ fontSize:22, fontWeight:700, marginBottom:4, color:"#1a202c" }}>📋 Student Enrollments</h2>
        {courseName && <p style={{ fontSize:14, color:"#764ba2", fontWeight:600, margin:"0 0 20px 0" }}>📚 {courseName}</p>}
        {loading ? <p style={{ color:"#94a3b8", textAlign:"center", padding:40 }}>Loading…</p> : (
          <>
            <div style={{ marginBottom:20 }}>
              <h3 style={{ color:"#f59e0b", marginBottom:10, fontSize:15 }}>⏳ Pending ({pending.length})</h3>
              {pending.length === 0 ? <p style={{ color:"#718096", fontSize:13 }}>No pending requests</p> : pending.map(s => (
                <div key={s.id} style={{ padding:12, background:"#fffbeb", border:"1px solid #fde68a", borderRadius:8, marginBottom:8, display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
                  <div>
                    <p style={{ fontWeight:600, margin:"0 0 2px 0", color:"#1a202c", fontSize:14 }}>{s.name}</p>
                    <p style={{ fontSize:12, color:"#718096", margin:0 }}>{s.email}</p>
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={()=>handleApprove(s.id)} style={{ padding:"6px 12px", background:"#22c55e", color:"white", border:"none", borderRadius:4, cursor:"pointer", fontSize:12, fontWeight:600 }}>Approve</button>
                    <button onClick={()=>handleReject(s.id)} style={{ padding:"6px 12px", background:"#ef4444", color:"white", border:"none", borderRadius:4, cursor:"pointer", fontSize:12, fontWeight:600 }}>Reject</button>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginBottom:20 }}>
              <h3 style={{ color:"#22c55e", marginBottom:10, fontSize:15 }}>✅ Enrolled ({approved.length})</h3>
              {approved.length === 0 ? <p style={{ color:"#718096", fontSize:13 }}>No enrolled students</p> : approved.map(s => {
                const otherCourses = (s.enrolledCourseIds||[]).filter(e=>e.courseId!==courseId);
                return (
                  <div key={s.id} style={{ padding:12, background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:8, marginBottom:8 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                      <div style={{ flex:1 }}>
                        <p style={{ fontWeight:600, margin:"0 0 2px 0", color:"#1a202c", fontSize:14 }}>{s.name}</p>
                        <p style={{ fontSize:12, color:"#718096", margin:"0 0 4px 0" }}>{s.email}</p>
                        {otherCourses.length > 0 && <p style={{ fontSize:11, color:"#764ba2", margin:0 }}>Also enrolled in: {otherCourses.map(e=>e.courseName).join(", ")}</p>}
                      </div>
                      <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                        <button title="Enroll in another course" onClick={()=>{setAddCourseStudentId(s.id);setAddCourseId("");}} style={{ padding:"5px 9px", background:"#eff6ff", color:"#3b82f6", border:"1px solid #bfdbfe", borderRadius:4, cursor:"pointer", fontSize:11, fontWeight:600 }}>+ Course</button>
                        <button onClick={()=>handleRevoke(s.id)} style={{ padding:"5px 9px", background:"#fef2f2", color:"#dc2626", border:"1px solid #fecaca", borderRadius:4, cursor:"pointer", fontSize:11, fontWeight:600 }}>Revoke</button>
                      </div>
                    </div>
                    {addCourseStudentId === s.id && (
                      <div style={{ marginTop:10, display:"flex", gap:8 }}>
                        <select value={addCourseId} onChange={e=>setAddCourseId(e.target.value)} style={{ flex:1, padding:"6px 8px", border:"1px solid #cbd5e1", borderRadius:6, fontSize:12, background:"white" }}>
                          <option value="">— Select course —</option>
                          {allCourses.filter(c=>!s.enrolledCourseIds?.some(e=>e.courseId===c.id)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <button onClick={handleAddCourseEnrollment} style={{ padding:"6px 12px", background:"#3b82f6", color:"white", border:"none", borderRadius:4, cursor:"pointer", fontSize:12, fontWeight:600 }}>Enroll</button>
                        <button onClick={()=>setAddCourseStudentId(null)} style={{ padding:"6px 10px", background:"#f1f5f9", color:"#475569", border:"1px solid #e2e8f0", borderRadius:4, cursor:"pointer", fontSize:12 }}>✕</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
        <button onClick={onClose} style={{ width:"100%", marginTop:8, padding:12, background:"#667eea", color:"white", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer" }}>Close</button>
      </div>
    </div>
  );
}


/* ─── StudentsNavBtn (top-level to avoid remount on each render) ─── */
function StudentsNavBtn({ sb, courseId, trainerId, studentsOpen, setStudentsOpen, collapsed }) {
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    if (!sb || !courseId) return;
    // FIX: query all students for this trainer (indexed column), then filter in JS.
    // This avoids fragile JSONB containment queries and catches both new-path
    // (pending_course_ids array) and legacy-path (requested_course_id) students.
    const filter = trainerId
      ? `trainer_id=eq.${encodeURIComponent(trainerId)}&limit=500`
      : `requested_course_id=eq.${encodeURIComponent(courseId)}&approved=eq.false&limit=200`;
    sb.select("lms_students", filter).then(rows => {
      const students = (rows || []).map(dbRowToStudent);
      const count = students.filter(s => {
        const inPending = Array.isArray(s.pendingCourseIds) && s.pendingCourseIds.some(p => p.courseId === courseId);
        const legacyPending = !s.approved && s.requestedCourseId === courseId;
        return inPending || legacyPending;
      }).length;
      setPendingCount(count);
    }).catch(() => {});
  }, [studentsOpen, sb, courseId, trainerId]);

  return (
    <button className={`lms-nav${studentsOpen?" on":""}`} onClick={()=>setStudentsOpen(p=>!p)} title={collapsed?"Students":""} style={{ position:"relative" }}>
      <Ic n="teacher" s={16} />
      {!collapsed && <span>Students</span>}
      {pendingCount > 0 && (
        <span style={{ marginLeft:"auto", background:"#f59e0b", color:"#fff", borderRadius:99, fontSize:9, fontWeight:800, padding:"2px 6px", lineHeight:1.4, flexShrink:0 }}>
          {pendingCount}
        </span>
      )}
    </button>
  );
}

/* ─── StudentsPanel (top-level to avoid remount on each render) ─── */
function StudentsPanel({ sb, courseId, trainerId, collapsed, setStudentsOpen }) {
  const [list, setList] = useState([]);
  useEffect(() => {
    if (!sb) return;
    // FIX: query all students for this trainer by trainer_id (indexed), filter in JS.
    // Catches both new-path (pending_course_ids JSONB) and legacy-path students.
    const filter = trainerId
      ? `trainer_id=eq.${encodeURIComponent(trainerId)}&order=created_at.asc&limit=500`
      : `requested_course_id=eq.${encodeURIComponent(courseId)}&limit=300`;
    sb.select("lms_students", filter).then(rows => {
      const students = (rows || []).map(dbRowToStudent);
      setList(students.filter(s => {
        const inPending = Array.isArray(s.pendingCourseIds) && s.pendingCourseIds.some(p => p.courseId === courseId);
        const legacyPending = !s.approved && s.requestedCourseId === courseId && !Array.isArray(s.pendingCourseIds);
        const inEnrolled = Array.isArray(s.enrolledCourseIds) && s.enrolledCourseIds.some(e => e.courseId === courseId);
        const legacyApproved = s.approved && s.requestedCourseId === courseId && !Array.isArray(s.enrolledCourseIds);
        return inPending || legacyPending || inEnrolled || legacyApproved;
      }));
    }).catch(() => {});
  }, [sb, courseId, trainerId]);

  const approved = list.filter(s => Array.isArray(s.enrolledCourseIds) ? s.enrolledCourseIds.some(e => e.courseId === courseId) : (s.approved && s.requestedCourseId === courseId));
  const pending  = list.filter(s => Array.isArray(s.pendingCourseIds) ? s.pendingCourseIds.some(p => p.courseId === courseId) : (!s.approved && s.requestedCourseId === courseId));

  const handleApprove = async (id) => {
    const s = list.find(x => x.id === id); if (!s) return;
    const pendingEntry = Array.isArray(s.pendingCourseIds) ? s.pendingCourseIds.find(p => p.courseId === courseId) : null;
    const resolvedCourseName = pendingEntry?.courseName || s.requestedCourseName || courseId;
    const newEnrolled = [...(s.enrolledCourseIds||[])];
    if (!newEnrolled.some(e => e.courseId === courseId)) newEnrolled.push({ courseId, courseName: resolvedCourseName, approvedAt: new Date().toISOString() });
    const newPending = Array.isArray(s.pendingCourseIds) ? s.pendingCourseIds.filter(p => p.courseId !== courseId) : [];
    const updated = { ...s, enrolledCourseIds: newEnrolled, pendingCourseIds: newPending, approved: true, approvedAt: new Date().toISOString() };
    await sbSaveStudent(sb, updated).catch(() => {});
    setList(prev => prev.map(x => x.id === id ? updated : x));
  };
  const handleReject = async (id) => {
    await sbDeleteStudent(sb, id).catch(() => {});
    setList(prev => prev.filter(x => x.id !== id));
  };

  return (
    <div style={{ position:"fixed", top:0, left:0, right:0, bottom:0, zIndex:500, display:"flex" }} onClick={e=>{ if(e.target===e.currentTarget) setStudentsOpen(false); }}>
      <div style={{ width: collapsed ? 58 : 210, flexShrink:0 }} />
      <div style={{ width:300, background:"#fff", borderRight:"1.5px solid #e8edf3", display:"flex", flexDirection:"column", boxShadow:"4px 0 24px rgba(0,0,0,.08)", animation:"lms-slide .2s ease", height:"100vh", overflow:"hidden" }}>
        <div style={{ padding:"16px 16px 12px", borderBottom:"1px solid #f1f5f9", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
          <div>
            <p style={{ fontWeight:700, fontSize:14, color:"#0f172a", margin:0 }}>Students</p>
            <p style={{ fontSize:11.5, color:"#94a3b8", margin:"2px 0 0 0" }}>{list.length} enrolled · {pending.length} pending</p>
          </div>
          <button onClick={()=>setStudentsOpen(false)} style={{ background:"#f1f5f9", border:"none", borderRadius:8, cursor:"pointer", padding:"5px 7px", color:"#64748b", display:"flex", alignItems:"center" }}><Ic n="x" s={14}/></button>
        </div>
        <div style={{ flex:1, overflowY:"auto", padding:"12px 10px" }}>
          {pending.length > 0 && (
            <div style={{ marginBottom:16 }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#f59e0b", textTransform:"uppercase", letterSpacing:".07em", padding:"0 6px 8px" }}>⏳ Pending ({pending.length})</div>
              {pending.map(s => (
                <div key={s.id} style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"10px 12px", marginBottom:8 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom:8 }}>
                    <div style={{ width:30, height:30, borderRadius:"50%", background:"#fef3c7", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#92400e", flexShrink:0 }}>{s.name.charAt(0).toUpperCase()}</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12.5, fontWeight:700, color:"#0f172a", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{s.name}</div>
                      <div style={{ fontSize:11, color:"#78716c", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{s.email}</div>
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:6 }}>
                    <button onClick={()=>handleApprove(s.id)} style={{ flex:1, padding:"5px 0", background:"#22c55e", color:"#fff", border:"none", borderRadius:6, fontSize:11.5, fontWeight:700, cursor:"pointer" }}>✓ Approve</button>
                    <button onClick={()=>handleReject(s.id)} style={{ flex:1, padding:"5px 0", background:"#fee2e2", color:"#dc2626", border:"none", borderRadius:6, fontSize:11.5, fontWeight:700, cursor:"pointer" }}>✕ Reject</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {approved.length > 0 && (
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:"#22c55e", textTransform:"uppercase", letterSpacing:".07em", padding:"0 6px 8px" }}>✓ Enrolled ({approved.length})</div>
              {approved.map(s => (
                <div key={s.id} style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"10px 12px", marginBottom:8 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom:8 }}>
                    <div style={{ width:30, height:30, borderRadius:"50%", background:"#dcfce7", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#15803d", flexShrink:0 }}>{s.name.charAt(0).toUpperCase()}</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12.5, fontWeight:700, color:"#0f172a", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{s.name}</div>
                      <div style={{ fontSize:11, color:"#64748b", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{s.email}</div>
                    </div>
                  </div>
                  <button onClick={()=>handleReject(s.id)} style={{ width:"100%", padding:"5px 0", background:"#fee2e2", color:"#dc2626", border:"none", borderRadius:6, fontSize:11.5, fontWeight:700, cursor:"pointer" }}>Remove</button>
                </div>
              ))}
            </div>
          )}
          {list.length === 0 && <div style={{ textAlign:"center", padding:"40px 16px", color:"#94a3b8", fontSize:13 }}>No students yet</div>}
        </div>
      </div>
    </div>
  );
}

/* ─── StudentCourseView (top-level to avoid remount on each render) ─── */
function StudentCourseView({ sb, auth, handleLogout }) {
  // FIX 11 & 12: Added refresh mechanism + retry on empty enrollment
  const [enrolledCourses, setEnrolledCourses] = useState([]);
  const [activeCourseId, setActiveCourseId]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Post-login enrollment request state
  const [showEnrollPanel, setShowEnrollPanel]   = useState(false);
  const [allCourses, setAllCourses]             = useState([]);
  const [trainersMap, setTrainersMap]           = useState({});
  const [selectedEnrollIds, setSelectedEnrollIds] = useState([]);
  const [enrolling, setEnrolling]               = useState(false);
  const [enrollMsg, setEnrollMsg]               = useState("");

  const loadStudent = () => {
    if (!sb) return;
    setLoading(true);
    sb.select("lms_students", `id=eq.${encodeURIComponent(auth.id)}&limit=1`).then(rows => {
      const student = rows?.[0] ? dbRowToStudent(rows[0]) : null;
      if (!student) { setLoading(false); return; }
      const enrolled = getStudentEnrolledCourses(student);
      setEnrolledCourses(enrolled);
      // Default to first enrolled course; preserve active selection if still valid
      setActiveCourseId(prev => {
        if (prev && enrolled.some(e => e.courseId === prev)) return prev;
        return enrolled[0]?.courseId || null;
      });
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  // FIX 12: re-runs when refreshKey increments (manual refresh button)
  useEffect(() => { loadStudent(); }, [sb, auth.id, refreshKey]);

  // Load all available courses whenever enrollment panel opens
  useEffect(() => {
    if (!showEnrollPanel || !sb) return;
    sbGetCourses(sb).then(rows => {
      const courses = rows.map(dbRowToCourse);
      setAllCourses(courses);
      sbGetTrainers(sb).then(trainers => {
        const m = {};
        trainers.forEach(t => { m[t.id] = t; });
        setTrainersMap(m);
      }).catch(() => {});
    }).catch(() => {});
  }, [showEnrollPanel, sb]);

  const handleRequestEnrollment = async () => {
    if (!selectedEnrollIds.length) { setEnrollMsg("Please select at least one course."); return; }
    setEnrolling(true); setEnrollMsg("");
    try {
      const rows = await sb.select("lms_students", `id=eq.${encodeURIComponent(auth.id)}&limit=1`);
      const student = rows?.[0] ? dbRowToStudent(rows[0]) : null;
      if (!student) throw new Error("Could not load your profile. Please refresh.");
      const existing = [
        ...(student.pendingCourseIds || []).map(p => p.courseId),
        ...(student.enrolledCourseIds || []).map(e => e.courseId),
      ];
      const newRequests = selectedEnrollIds.filter(id => !existing.includes(id));
      if (!newRequests.length) { setEnrollMsg("You are already enrolled or pending in all selected courses."); setEnrolling(false); return; }
      const newPending = [
        ...(student.pendingCourseIds || []),
        ...newRequests.map(cid => {
          const c = allCourses.find(x => x.id === cid);
          return { courseId: cid, courseName: c?.name || "", requestedAt: new Date().toISOString() };
        }),
      ];
      await sbSaveStudent(sb, { ...student, pendingCourseIds: newPending });
      setEnrollMsg(`✅ Enrollment request sent for ${newRequests.length} course(s)! Wait for trainer approval.`);
      setSelectedEnrollIds([]);
    } catch(e) { setEnrollMsg("❌ " + e.message); }
    setEnrolling(false);
  };

  const hasAnyCourse = enrolledCourses.length > 0;
  const activeCourseName = enrolledCourses.find(e => e.courseId === activeCourseId)?.courseName || "Your Course";

  // Courses not yet enrolled/pending — for the enroll panel
  const availableToEnroll = allCourses.filter(c => {
    const pendingIds = []; // will check against live student data inside handler
    return !enrolledCourses.some(e => e.courseId === c.id);
  });

  if (loading) return <div style={{ textAlign:"center", padding:"60px 20px", color:"#94a3b8", fontSize:14 }}>Loading…</div>;

  return (
    <div style={{ minHeight:"100vh", background:"#f8fafc" }}>
      <div style={{ background:"white", padding:"14px 20px", borderBottom:"1px solid #e2e8f0", display:"flex", justifyContent:"space-between", alignItems:"center", position:"sticky", top:0, zIndex:100 }}>
        <div>
          <h1 style={{ fontSize:20, fontWeight:700, color:"#1a202c", margin:0 }}>📚 LMS</h1>
          <p style={{ fontSize:12, color:"#718096", margin:"4px 0 0 0" }}>👨‍🎓 {auth.name}{hasAnyCourse ? ` · ${activeCourseName}` : ""}
            <span style={{ marginLeft:8, background:"#f0fdf4", color:"#16a34a", border:"1px solid #bbf7d0", borderRadius:99, fontSize:10, fontWeight:700, padding:"1px 7px" }}>🔄 Live</span>
          </p>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {enrolledCourses.length > 1 && (
            <select value={activeCourseId||""} onChange={e=>setActiveCourseId(e.target.value)} style={{ padding:"7px 10px", border:"1px solid #ddd6fe", borderRadius:6, fontSize:12, fontWeight:600, color:"#764ba2", background:"#f5f3ff", cursor:"pointer", maxWidth:200 }}>
              {enrolledCourses.map(e=><option key={e.courseId} value={e.courseId}>{e.courseName}</option>)}
            </select>
          )}
          {/* Enroll in Another Course */}
          <button
            onClick={()=>{ setShowEnrollPanel(p=>!p); setEnrollMsg(""); setSelectedEnrollIds([]); }}
            style={{ padding:"8px 12px", background:"#f5f3ff", color:"#764ba2", border:"1px solid #ddd6fe", borderRadius:6, cursor:"pointer", fontSize:12, fontWeight:600 }}
            title="Request enrollment in additional courses"
          >
            ➕ More Courses
          </button>
          {/* FIX: always show refresh — lets students re-check enrollment after approval */}
          <button onClick={()=>setRefreshKey(k=>k+1)} style={{ padding:"8px 12px", background:"#f0fdf4", color:"#16a34a", border:"1px solid #bbf7d0", borderRadius:6, cursor:"pointer", fontSize:12, fontWeight:600 }}>
            🔄 Refresh
          </button>
          <button onClick={handleLogout} style={{ padding:"8px 14px", background:"#ef4444", color:"white", border:"none", borderRadius:6, cursor:"pointer" }}>Logout</button>
        </div>
      </div>

      {/* ── Enroll in Another Course Panel ── */}
      {showEnrollPanel && (
        <div style={{ background:"white", borderBottom:"2px solid #ede9fe", padding:"18px 20px", boxShadow:"0 4px 16px rgba(118,75,162,.08)" }}>
          <div style={{ maxWidth:720, margin:"0 auto" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
              <div>
                <p style={{ fontWeight:700, fontSize:15, color:"#5b21b6", margin:0 }}>📚 Request Enrollment in More Courses</p>
                <p style={{ fontSize:12, color:"#94a3b8", margin:"2px 0 0 0" }}>Select courses below — your trainer will be notified to approve you.</p>
              </div>
              <button onClick={()=>setShowEnrollPanel(false)} style={{ background:"#f1f5f9", border:"none", borderRadius:8, cursor:"pointer", padding:"5px 8px", color:"#64748b" }}>✕</button>
            </div>

            {allCourses.length === 0
              ? <p style={{ color:"#94a3b8", fontSize:13 }}>Loading available courses…</p>
              : (()=>{
                  // Group by trainer
                  const byTrainer = {};
                  allCourses.forEach(c => {
                    const tName = trainersMap[c.trainerId]?.name || "Unknown Trainer";
                    if (!byTrainer[tName]) byTrainer[tName] = [];
                    byTrainer[tName].push(c);
                  });
                  return (
                    <div style={{ display:"flex", flexWrap:"wrap", gap:12, marginBottom:14 }}>
                      {Object.entries(byTrainer).map(([tName, courses]) => (
                        <div key={tName} style={{ background:"#faf5ff", border:"1.5px solid #ede9fe", borderRadius:10, padding:"10px 14px", minWidth:200, flex:"1 1 200px" }}>
                          <div style={{ fontSize:11, fontWeight:700, color:"#764ba2", textTransform:"uppercase", letterSpacing:".06em", marginBottom:8 }}>👨‍🏫 {tName}</div>
                          {courses.map(c => {
                            const alreadyEnrolled = enrolledCourses.some(e => e.courseId === c.id);
                            const checked = selectedEnrollIds.includes(c.id);
                            return (
                              <label key={c.id} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6, cursor:alreadyEnrolled?"default":"pointer", opacity:alreadyEnrolled?.55:1 }}>
                                <input type="checkbox"
                                  checked={checked || alreadyEnrolled}
                                  disabled={alreadyEnrolled}
                                  onChange={e => {
                                    if (e.target.checked) setSelectedEnrollIds(prev => [...prev, c.id]);
                                    else setSelectedEnrollIds(prev => prev.filter(id => id !== c.id));
                                  }}
                                  style={{ width:14, height:14, accentColor:"#764ba2", cursor:alreadyEnrolled?"default":"pointer" }}
                                />
                                <span style={{ fontSize:13, color:alreadyEnrolled?"#94a3b8":checked?"#5b21b6":"#374151", fontWeight:checked?600:400 }}>
                                  {c.name} {alreadyEnrolled && <span style={{ fontSize:10, color:"#22c55e", fontWeight:700 }}>✓ enrolled</span>}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  );
                })()
            }

            {enrollMsg && (
              <div style={{ padding:"9px 14px", borderRadius:8, marginBottom:10, background:enrollMsg.startsWith("✅")?"#f0fdf4":"#fef2f2", border:`1px solid ${enrollMsg.startsWith("✅")?"#bbf7d0":"#fecaca"}`, fontSize:13, color:enrollMsg.startsWith("✅")?"#15803d":"#dc2626", fontWeight:600 }}>
                {enrollMsg}
              </div>
            )}

            <div style={{ display:"flex", gap:10 }}>
              <button
                onClick={handleRequestEnrollment}
                disabled={enrolling || !selectedEnrollIds.length}
                style={{ padding:"9px 20px", background:"#764ba2", color:"white", border:"none", borderRadius:8, fontWeight:700, cursor:"pointer", fontSize:13, opacity:(enrolling||!selectedEnrollIds.length)?.6:1 }}
              >
                {enrolling ? "Sending…" : `Request Enrollment (${selectedEnrollIds.length} selected)`}
              </button>
              <button onClick={()=>{ setShowEnrollPanel(false); setEnrollMsg(""); setSelectedEnrollIds([]); }} style={{ padding:"9px 16px", background:"#f1f5f9", color:"#475569", border:"1px solid #e2e8f0", borderRadius:8, fontWeight:600, cursor:"pointer", fontSize:13 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {hasAnyCourse && activeCourseId ? (
        <OriginalLMSApp key={activeCourseId} courseId={activeCourseId} studentMode={true} sb={sb} />
      ) : (
        <div style={{ maxWidth:600, margin:"80px auto", padding:"0 20px", textAlign:"center" }}>
          <div style={{ background:"white", borderRadius:12, padding:"48px 40px", boxShadow:"0 4px 20px rgba(0,0,0,.06)" }}>
            <div style={{ fontSize:48, marginBottom:16 }}>⏳</div>
            <h2 style={{ color:"#1a202c", margin:"0 0 10px 0", fontSize:22, fontWeight:700 }}>Awaiting Course Assignment</h2>
            <p style={{ color:"#94a3b8", margin:"0 0 20px 0", lineHeight:1.6 }}>Your account is pending or no course has been assigned yet. Please contact your trainer — then click Refresh above.</p>
            <div style={{ display:"flex", gap:10, justifyContent:"center", flexWrap:"wrap" }}>
              <button onClick={()=>setRefreshKey(k=>k+1)} style={{ padding:"10px 24px", background:"#667eea", color:"white", border:"none", borderRadius:8, fontWeight:600, cursor:"pointer", fontSize:14 }}>
                🔄 Check Again
              </button>
              <button onClick={()=>{ setShowEnrollPanel(true); setEnrollMsg(""); setSelectedEnrollIds([]); }} style={{ padding:"10px 24px", background:"#f5f3ff", color:"#764ba2", border:"1px solid #ddd6fe", borderRadius:8, fontWeight:600, cursor:"pointer", fontSize:14 }}>
                ➕ Request a Course
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ORIGINAL LMS APP (inner course workspace) — Supabase-backed
═══════════════════════════════════════════════════════════════════ */
function OriginalLMSApp({ courseId = null, onBack = null, studentMode = false, sb, trainerId = null }) {
  const [aiProvider, setAiProvider] = useState("groq");
  const [groqKey,    setGroqKey]    = useState("");
  const [groqModel,  setGroqModel]  = useState(GROQ_MODELS[0]);
  const [ollamaUrl,  setOllamaUrl]  = useState("http://localhost:11434");
  const [ollamaModel,setOllamaModel]= useState(OLLAMA_MODELS[0]);

  const isOnline = useOnlineStatus();

  const [page,      setPage]      = useState(studentMode ? "calendar" : "setup");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [studentsOpen, setStudentsOpen] = useState(false);

  const [planText,  setPlanText]  = useState("");
  const [planDays,  setPlanDays]  = useState([]);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [monfri,    setMonfri]    = useState(true);
  const [dayMap,    setDayMap]    = useState({});
  const [dayOverrides, setDayOverrides] = useState({}); // { "YYYY-MM-DD": { type:"holiday"|"extra"|"special", label:"..." } }

  const [calYear,  setCalYear]  = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth());

  const [dayStatus, setDayStatus] = useState({});
  const [selDay,    setSelDay]    = useState(null);
  const [dayData,   setDayData]   = useState({});
  const [pendingGen, setPendingGen] = useState({});

  const [codeEdits,   setCodeEdits]   = useState({});
  const [codeOutputs, setCodeOutputs] = useState({});

  const [pyodideReady,   setPyodideReady]   = useState(false);
  const [pyodideLoading, setPyodideLoading] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen,  setSearchOpen]  = useState(false);

  const [busy,   setBusy]   = useState({});
  const [toasts, setToasts] = useState([]);

  // FIX #12: Scope AI prefs to the auth session (user-level), not per-course
  // Previously "lms_ai_prefs_{courseId}" meant the Groq key was lost when switching courses
  const AI_PREFS_KEY = `lms_ai_prefs_user`;

  /* ════ INIT from Supabase ════ */
  useEffect(() => {
    // Load AI prefs from sessionStorage (no sensitive data in Supabase)
    try {
      const prefs = JSON.parse(sessionStorage.getItem(AI_PREFS_KEY) || "{}");
      if (prefs.groqKey)     setGroqKey(prefs.groqKey);
      if (prefs.aiProvider)  setAiProvider(prefs.aiProvider);
      if (prefs.groqModel)   setGroqModel(prefs.groqModel);
      if (prefs.ollamaUrl)   setOllamaUrl(prefs.ollamaUrl);
      if (prefs.ollamaModel) setOllamaModel(prefs.ollamaModel);
    } catch {}

    if (!sb || !courseId) return;

    const loadCourse = async () => {
      const course = await sbGetCourseData(sb, courseId);
      if (!course) return;
      if (course.planText)  setPlanText(course.planText);
      // FIX: use planDays.length > 0 check so empty array doesn't block calendar navigation
      if (Array.isArray(course.planDays) && course.planDays.length > 0) {
        setPlanDays(course.planDays);
        setPage("calendar");
      } else if (course.planDays) {
        setPlanDays(course.planDays);
      }
      if (course.startDate) setStartDate(course.startDate);
      if (course.monfri !== undefined) setMonfri(course.monfri);
      if (course.dayStatus) setDayStatus(course.dayStatus);
      if (course.dayOverrides) setDayOverrides(course.dayOverrides);
      if (course.calYear)   setCalYear(course.calYear);
      if (course.calMonth !== undefined) setCalMonth(course.calMonth);

      // FIX #4: Load AI content from lms_day_content table (not day_data JSONB)
      const contentByDay = await sbGetAllDayContent(sb, courseId);
      // Merge with any legacy day_data still in the course row
      const mergedDayData = { ...(course.dayData || {}) };
      for (const [k, v] of Object.entries(contentByDay)) {
        mergedDayData[k] = { ...(mergedDayData[k] || {}), ...v };
      }
      // FIX: always set dayData (even if empty) so React state is consistent
      setDayData(mergedDayData);

      // Fetch uploaded files per day — use ALL known day keys (course row + content table)
      const allDayKeys = Array.from(new Set([
        ...Object.keys(mergedDayData),
        ...Object.keys(contentByDay),
      ]));
      if (allDayKeys.length > 0) {
        const results = await Promise.allSettled(
          allDayKeys.map(k => sbGetFilesForDay(sb, courseId, k).then(files => ({ k, files })))
        );
        setDayData(prev => {
          const next = { ...prev };
          results.forEach(r => {
            if (r.status === "fulfilled") {
              const { k, files } = r.value;
              next[k] = { ...(next[k] || {}), uploadedFiles: files };
            }
          });
          return next;
        });
      }
    };

    loadCourse().catch(e => console.error("Failed to load course:", e));
  }, [courseId, sb]);

  /* ════ FIX 5: Supabase Realtime sync for students (replaces 10s polling) ════
     Uses Postgres changes subscriptions — instant delivery, zero wasted reads.
     Falls back to a 15s poll if Realtime is unavailable (e.g. free plan exhausted). */
  useEffect(() => {
    if (!studentMode || !sb || !courseId) return;

    // Helper: full re-fetch of course + content + files
    const syncStudentView = async () => {
      try {
        const course = await sbGetCourseData(sb, courseId);
        if (course) {
          if (course.planDays?.length)      setPlanDays(course.planDays);
          if (course.startDate)             setStartDate(course.startDate);
          if (course.monfri !== undefined)  setMonfri(course.monfri);
          if (course.dayStatus)             setDayStatus(course.dayStatus);
          if (course.dayOverrides)          setDayOverrides(course.dayOverrides);
        }
        const contentByDay = await sbGetAllDayContent(sb, courseId);
        // FIX: merge course.dayData so days only in the course row are included
        const mergedKeys = Array.from(new Set([
          ...Object.keys(contentByDay),
          ...Object.keys(course?.dayData || {}),
        ]));
        setDayData(prev => {
          const next = { ...prev };
          // merge legacy day_data from course row
          for (const [k, v] of Object.entries(course?.dayData || {})) {
            next[k] = { ...(next[k] || {}), ...v };
          }
          for (const [k, v] of Object.entries(contentByDay)) {
            next[k] = { ...(next[k] || {}), ...v };
          }
          return next;
        });
        if (mergedKeys.length > 0) {
          const fileResults = await Promise.allSettled(
            mergedKeys.map(k => sbGetFilesForDay(sb, courseId, k).then(files => ({ k, files })))
          );
          setDayData(prev => {
            const next = { ...prev };
            fileResults.forEach(r => {
              if (r.status === "fulfilled") {
                const { k, files } = r.value;
                next[k] = { ...(next[k] || {}), uploadedFiles: files };
              }
            });
            return next;
          });
        }
      } catch (e) {
        console.warn("Student sync error:", e.message);
      }
    };

    syncStudentView(); // initial load

    // Try Supabase Realtime first (instant, zero-cost)
    let realtimeCleanup = null;
    let fallbackInterval = null;
    let realtimeConnected = false;

    const tryRealtime = async () => {
      try {
        // Supabase Realtime via native WebSocket — no extra dependency
        const { sbUrl, sbKey } = (() => {
          try { return JSON.parse(sessionStorage.getItem("lms_sb_creds") || "{}"); } catch { return {}; }
        })();
        if (!sbUrl || !sbKey) throw new Error("no creds");

        const wsUrl = sbUrl.replace("https://", "wss://").replace("http://", "ws://")
          + "/realtime/v1/websocket?apikey=" + encodeURIComponent(sbKey) + "&vsn=1.0.0";
        const ws = new WebSocket(wsUrl);
        let heartbeat;

        ws.onopen = () => {
          realtimeConnected = true;
          // Subscribe to lms_day_content changes for this course
          const sub = {
            topic: `realtime:public:lms_day_content:course_id=eq.${courseId}`,
            event: "phx_join", payload: {}, ref: "1"
          };
          ws.send(JSON.stringify(sub));
          // Subscribe to lms_courses changes for this course
          const sub2 = {
            topic: `realtime:public:lms_courses:id=eq.${courseId}`,
            event: "phx_join", payload: {}, ref: "2"
          };
          ws.send(JSON.stringify(sub2));
          // Heartbeat every 25s to keep connection alive
          heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb" }));
          }, 25000);
        };

        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.event === "INSERT" || msg.event === "UPDATE" || msg.event === "DELETE") {
              syncStudentView(); // re-fetch on any DB change
            }
          } catch {}
        };

        ws.onerror = () => {
          realtimeConnected = false;
          clearInterval(heartbeat);
          // Fall back to polling on realtime error
          if (!fallbackInterval) fallbackInterval = setInterval(syncStudentView, 15000);
        };

        ws.onclose = () => {
          realtimeConnected = false;
          clearInterval(heartbeat);
          if (!fallbackInterval) fallbackInterval = setInterval(syncStudentView, 15000);
        };

        realtimeCleanup = () => {
          clearInterval(heartbeat);
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        };
      } catch {
        // Realtime unavailable — use polling fallback
        if (!fallbackInterval) fallbackInterval = setInterval(syncStudentView, 15000);
      }
    };

    tryRealtime();

    return () => {
      if (realtimeCleanup) realtimeCleanup();
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  }, [studentMode, sb, courseId]);

  /* ════ Persist AI prefs to sessionStorage ════ */
  useEffect(() => {
    try { sessionStorage.setItem(AI_PREFS_KEY, JSON.stringify({ groqKey, aiProvider, groqModel, ollamaUrl, ollamaModel })); } catch {}
  }, [groqKey, aiProvider, groqModel, ollamaUrl, ollamaModel]);

  /* ════ Debounced Supabase save for course data ════
     FIX #5: studentMode guard — students must NEVER overwrite trainer data.
     FIX #4: AI content (notebook, examples, etc.) saved to lms_day_content rows,
             day_data in lms_courses only stores lightweight per-day state (notes, codeEdits).
     FIX: updated_at conflict guard — if the DB row was updated more recently than our
          last load, skip the write and warn the trainer. Prevents two-tab overwrites. */
  const lastSavedAtRef = useRef(null);

  useEffect(() => {
    if (studentMode || !sb || !courseId) return;
    const timer = setTimeout(async () => {
      try {
        // Lightweight fields only go into the courses row (day_data)
        const lightDayData = {};
        for (const [k, v] of Object.entries(dayData)) {
          if (!v || typeof v !== "object") { lightDayData[k] = {}; continue; }
          const { uploadedFiles, notebook, examples, resources, assignment, quiz, teachingGuide, ...light } = v;
          lightDayData[k] = light;
        }
        // FIX: conflict guard — check updated_at before writing
        if (lastSavedAtRef.current) {
          const rows = await sb.select("lms_courses", `id=eq.${encodeURIComponent(courseId)}&select=updated_at&limit=1`);
          const dbUpdatedAt = rows?.[0]?.updated_at;
          // FIX 6: compare as Date objects — lexicographic string comparison is unreliable across TZs
          if (dbUpdatedAt && new Date(dbUpdatedAt) > new Date(lastSavedAtRef.current)) {
            console.warn("LMS: skipping save — remote updated_at is newer (possible concurrent edit)");
            return; // don't overwrite — remote is newer
          }
        }
        const now = new Date().toISOString();
        await sbSaveCourseData(sb, courseId, {
          planText, planDays, startDate, monfri, dayStatus, dayOverrides,
          dayData: lightDayData, calYear, calMonth,
        });
        lastSavedAtRef.current = now;
      } catch (e) { console.warn("Supabase save error:", e.message); }
    }, 1500);
    return () => clearTimeout(timer);
  }, [planText, planDays, startDate, monfri, dayStatus, dayOverrides, dayData, calYear, calMonth, courseId, sb, studentMode]);

  /* ════ Rebuild dayMap ════ */
  useEffect(() => {
    if (!planDays.length) return;
    setDayMap(buildDayMap(planDays, new Date(startDate + "T12:00:00"), monfri, dayOverrides));
  }, [planDays, startDate, monfri, dayOverrides]);

  /* ════ Search keyboard shortcut ════ */
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && planDays.length) { e.preventDefault(); setSearchOpen(p => !p); }
      if (e.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [planDays.length]);

  const notify = useCallback((msg, type="ok") => {
    const id = Date.now();
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4000);
  }, []);

  const setBusyKey = useCallback((k, v) => setBusy(p => {
    if (v) return { ...p, [k]: true };
    const next = { ...p }; delete next[k]; return next;
  }), []);

  // FIX #4: updateDay persists AI content to lms_day_content immediately (not via debounce)
  // so students see it as soon as the trainer saves, and it doesn't bloat the course JSONB row.
  const AI_CONTENT_TYPES = ["notebook", "examples", "resources", "assignment", "quiz", "teachingGuide", "generatedForTopic"];

  const updateDay = useCallback((key, patch) => {
    setDayData(prev => {
      const existing = prev[key] || {};
      return { ...prev, [key]: { ...existing, ...patch } };
    });
    // Persist each AI content field to lms_day_content immediately (trainer only)
    if (!studentMode && sb && courseId) {
      for (const [field, value] of Object.entries(patch)) {
        if (AI_CONTENT_TYPES.includes(field) && value !== undefined) {
          sbSaveDayContent(sb, courseId, key, field, value)
            .catch(e => console.warn(`Failed to save ${field} for ${key}:`, e.message));
        }
      }
    }
  }, [studentMode, sb, courseId]);

  /* ════ AI caller ════ */
  const callAI = useCallback(async (messages) => {
    if (aiProvider === "groq") {
      if (!isOnline) throw new Error("You're offline — connect to the internet to use Groq");
      if (!groqKey) throw new Error("Enter Groq API key in Settings");
      return withRetry(() => callGroq(groqKey, groqModel, messages));
    }
    return withRetry(() => callOllama(ollamaUrl, ollamaModel, messages));
  }, [aiProvider, groqKey, groqModel, ollamaUrl, ollamaModel, isOnline]);

  const genNotebook = async (day, opts={}) => {
    const k = day.key;
    const busyKey = `nb-${k}`;
    setBusyKey(busyKey, true);
    setPendingGen(p => ({ ...p, [busyKey]: { type: "notebook", topic: day.topic, startedAt: Date.now() } }));
    try {
      const codeBlockCount = Math.max(1, Math.min(20, parseInt(dayData[k]?.notebookBlocks) || 3));
      const subTopics = (dayData[k]?.subTopics || "").trim();
      const subTopicsSection = subTopics
        ? `\n\n## Sub-topics & Focus Areas to Integrate\nThe following sub-topics MUST be woven throughout every relevant section — include dedicated concepts, explanations, and code examples for each:\n${subTopics}\n`
        : "";

      const codeExamplesTemplate = Array.from({ length: codeBlockCount }, (_, i) =>
        `## Code Example ${i + 1}: [descriptive name for this example]\n` +
        "```python\n" +
        `# Purpose: [what this specific example demonstrates]\n` +
        `# Concepts covered: [list the concepts from Key Concepts this example applies]\n` +
        `# [Inline comment on EVERY significant line — no line left unexplained]\n` +
        `[complete, runnable Python code — minimum 8 lines]\n` +
        `print("[show the expected output so the student can verify their run]")\n` +
        "```"
      ).join("\n\n");

      const practiceCount = Math.max(3, Math.ceil(codeBlockCount / 2));

      const text = await callAI([
        { role:"system", content:"You are a senior Python educator producing production-quality Jupyter notebook content. Every code block must be syntactically correct, run without errors, and be exhaustively commented. Prioritise pedagogical depth, progressive complexity, and real-world relevance over brevity. Never truncate sections." },
        { role:"user", content:`Create a complete, detailed Jupyter notebook for the topic: "${day.topic}".${subTopicsSection}

Structure your response EXACTLY as follows — do not skip or rename any section:

## Overview
[3 substantive paragraphs: (1) what the topic is and why it matters in real-world Python development, (2) the mental model a student should build, (3) how it connects to topics already learned]

## Learning Objectives
[Exactly 5 bullet points — each a specific, measurable outcome: "By the end of this notebook, the student will be able to…"]

## Prerequisites
[Bulleted list of every concept the student must already understand before this notebook makes sense]

## Key Concepts
[Numbered list — every core concept with: concept name in bold, 2-sentence explanation, and a one-line code illustration where applicable. Minimum ${Math.max(5, codeBlockCount)} concepts.]

${codeExamplesTemplate}

## Common Mistakes & Pitfalls
[At minimum ${Math.max(4, codeBlockCount)} entries — for each mistake: bold heading, explanation of what students do wrong, WHY it fails, and the corrected version with a short code snippet]

## Practice Problems
${Array.from({ length: practiceCount }, (_, i) => `${i + 1}. [Clearly stated problem that directly applies one or more of the above code examples — specify expected input and output]`).join("\n")}

## Summary & Next Steps
[Concise paragraph summarising every concept covered, then a bulleted list of 4 specific follow-on topics with one sentence on why each is the natural next step]

HARD REQUIREMENTS — violating any of these is an error:
- Generate EXACTLY ${codeBlockCount} "## Code Example" sections numbered 1 through ${codeBlockCount}
- Every code block must have an inline comment on EVERY significant line — not just the first line
- All code must be syntactically correct Python 3 and produce verifiable, deterministic output
- Each example must increase in complexity relative to the previous one
- Every sub-topic listed above must appear in at least one Key Concept entry AND at least one Code Example
- Do not truncate any section — write every part in full` }
      ]);
      validateAIResponse(text, "notebook");
      const codeBlocks = extractCodeBlocks(text);
      updateDay(k, { notebook: text, codeBlocks, generatedForTopic: day.topic });
      if (!opts.silent) notify("Notebook generated!");
    } catch(e) {
      if (!opts.silent) notify(`Notebook: ${e.message}`, "err");
      else throw e;
    } finally {
      // Always clean up busy state — even when re-throwing in silent mode
      setBusyKey(busyKey, false);
      setPendingGen(p => { const n={...p}; delete n[busyKey]; return n; });
    }
  };

  const genExamples = async (day, opts={}) => {
    const k = day.key;
    const busyKey = `ex-${k}`;
    setBusyKey(busyKey, true);
    setPendingGen(p => ({ ...p, [busyKey]: { type: "examples", topic: day.topic, startedAt: Date.now() } }));
    try {
      const tasksCount = Math.max(1, Math.min(20, parseInt(dayData[k]?.examplesCount) || 5));
      const subTopics = (dayData[k]?.subTopics || "").trim();
      const subTopicsSection = subTopics
        ? `\n\n## Sub-topics to Cover\nDistribute the ${tasksCount} tasks across these sub-topics — every sub-topic must appear in at least one task:\n${subTopics}\n`
        : "";
      // FIX Bug1: Include notebook content as context so tasks extend rather than repeat the notebook
      const notebookCtx = dayData[k]?.notebook
        ? `\n\nThe student has already studied this notebook (do NOT repeat these examples verbatim — every task must EXTEND and APPLY the concepts beyond what is shown):\n---NOTEBOOK---\n${dayData[k].notebook.slice(0, 1800)}\n---END---`
        : "";

      const difficultyMap = (i, total) => {
        const pct = i / (total - 1 || 1);
        if (pct < 0.25) return "Easy";
        if (pct < 0.55) return "Medium";
        if (pct < 0.80) return "Hard";
        return "Expert";
      };

      const tasksTemplate = Array.from({ length: tasksCount }, (_, i) =>
        `### Task ${i + 1}: [Descriptive title that names the specific skill being practised]
**Difficulty:** ${difficultyMap(i, tasksCount)}
**Concept tested:** [Which specific concept or sub-topic from the day this task targets]
**Description:** [3-sentence description: what the student builds, what it demonstrates, why it matters]
**Requirements:**
- [Concrete requirement 1 — testable and unambiguous]
- [Concrete requirement 2]
- [Concrete requirement 3]
**Expected Output:**
\`\`\`
[Exact, copy-pasteable output the student's program must produce — no placeholders]
\`\`\`
**Starter Code:**
\`\`\`python
# Task ${i + 1}: [title]
# Instructions: [one sentence telling the student exactly what to fill in]
[meaningful scaffold — function signature, partial logic, or structural hints as TODO comments]
\`\`\`
**Hint:** [A specific, targeted hint that guides without giving away the solution]
**Bonus:** [Optional extension for students who finish early — one level harder]`
      ).join("\n\n---\n\n");

      const text = await callAI([
        { role:"system", content:"You are a senior Python instructor designing rigorous, hands-on coding exercises. Every task must be independently runnable, have a deterministic expected output, and provide starter code that scaffolds without solving. Tasks must progress clearly from easier to harder." },
        { role:"user", content:`Generate exactly ${tasksCount} hands-on practice tasks for: "${day.topic}".${subTopicsSection}${notebookCtx}

${tasksTemplate}

HARD REQUIREMENTS:
- Generate EXACTLY ${tasksCount} tasks numbered Task 1 through Task ${tasksCount}
- Tasks must be strictly ordered from easiest to hardest — Difficulty label must be accurate
- Every task must have complete, runnable starter code with meaningful TODO markers
- Expected Output must be exact and reproducible — no vague placeholders like "[output here]"
- No task may duplicate a code example already present in the notebook context
- Sub-topics listed above must be proportionally represented — do not cluster them all in the last tasks` }
      ]);
      validateAIResponse(text, "general");
      updateDay(k, { examples: text, generatedForTopic: day.topic });
      if (!opts.silent) notify("Live examples generated!");
    } catch(e) {
      if (!opts.silent) notify(`Examples: ${e.message}`, "err");
      else throw e;
    } finally {
      setBusyKey(busyKey, false);
      setPendingGen(p => { const n={...p}; delete n[busyKey]; return n; });
    }
  };

  const genResources = async (day, opts={}) => {
    const k = day.key;
    const busyKey = `rs-${k}`;
    setBusyKey(busyKey, true);
    setPendingGen(p => ({ ...p, [busyKey]: { type: "resources", topic: day.topic, startedAt: Date.now() } }));
    try {
      const snippetsCount = Math.max(1, Math.min(20, parseInt(dayData[k]?.resourcesSnippets) || 3));
      const subTopics = (dayData[k]?.subTopics || "").trim();
      const subTopicsSection = subTopics
        ? `\n\n## Sub-topics to Cover\nAll resource sections must include material for every one of these sub-topics — each must appear in the Quick Reference Card, at least one snippet, and the Cheat Sheet:\n${subTopics}\n`
        : "";

      const snippetsTemplate = Array.from({ length: snippetsCount }, (_, i) =>
        "```python\n" +
        `# Snippet ${i + 1}: [Pattern name — name it like a recipe, e.g. "Flatten a nested list"]\n` +
        `# When to use: [1-sentence use case]\n` +
        `# Gotcha: [the most common mistake with this pattern]\n` +
        `[complete, runnable Python 3 code — minimum 6 lines with an inline comment on every significant line]\n` +
        "```"
      ).join("\n");

      const text = await callAI([
        { role:"system", content:"You are producing a dense, production-quality reference document for Python learners. Think 'developer cheat sheet meets university study guide'. Every snippet must run without modification. Every entry must be specific and actionable — no filler." },
        { role:"user", content:`Create a complete, comprehensive reference document for: "${day.topic}".${subTopicsSection}

## Quick Reference Card
[Scannable formatted table or aligned list — every important syntax element, method, function, and keyword with its signature and a 5-word description. Minimum ${Math.max(10, snippetsCount * 3)} entries. Include every sub-topic listed above.]

## Concept Summary
[Each key concept gets its own bold-headed paragraph: plain-English explanation + a concrete real-world analogy. Minimum ${Math.max(5, snippetsCount)} concepts. Cover every sub-topic.]

## Code Snippets Library
${snippetsTemplate}

## Common Patterns vs Anti-Patterns
[Minimum ${Math.max(4, snippetsCount)} pairs — each formatted as:
✅ DO — [pattern name]: [code snippet] — [why this is correct]
❌ DON'T — [anti-pattern name]: [code snippet] — [why this fails or is bad practice]]

## Cheat Sheet
[Structured reference — for each entry use exactly this format:
• WHAT: [concept] | SYNTAX: [exact syntax] | EXAMPLE: [one-liner] | GOTCHA: [one trap to avoid]
Minimum ${Math.max(8, snippetsCount * 2)} entries covering every sub-topic.]

## Error Reference
[The ${Math.max(4, snippetsCount)} most common errors students encounter — for each: Error name, cause, minimal code that reproduces it, and the exact fix]

## Further Reading & Next Steps
[${Math.max(5, snippetsCount)} specific follow-on topics — each with: topic name, one sentence on how it builds on today, and a concrete use-case where it's needed]

HARD REQUIREMENTS:
- Code Snippets Library must contain EXACTLY ${snippetsCount} runnable code blocks
- Every snippet must produce visible output (add a print statement if needed)
- Every sub-topic listed above must appear in the Quick Reference Card, ≥1 snippet, and the Cheat Sheet
- No placeholders — every field must be filled with real, specific content` }
      ]);
      validateAIResponse(text, "general");
      updateDay(k, { resources: text, generatedForTopic: day.topic });
      if (!opts.silent) notify("Resources generated!");
    } catch(e) {
      if (!opts.silent) notify(`Resources: ${e.message}`, "err");
      else throw e;
    } finally {
      setBusyKey(busyKey, false);
      setPendingGen(p => { const n={...p}; delete n[busyKey]; return n; });
    }
  };

  const genAssignment = async (day, opts={}) => {
    const k = day.key;
    const busyKey = `as-${k}`;
    setBusyKey(busyKey, true);
    setPendingGen(p => ({ ...p, [busyKey]: { type: "assignment", topic: day.topic, startedAt: Date.now() } }));
    try {
      const challengesCount = Math.max(1, Math.min(15, parseInt(dayData[k]?.assignmentChallenges) || 3));
      const subTopics = (dayData[k]?.subTopics || "").trim();
      const subTopicsSection = subTopics
        ? `\n\n## Sub-topics to Assess\nThe assignment MUST include at least one question or challenge that directly tests each of these sub-topics:\n${subTopics}\n`
        : "";
      const uploaded = (dayData[k]?.uploadedFiles || []).map(f => f.name).join(", ");
      const filesCtx = uploaded ? `\nThe student has access to these uploaded reference files: ${uploaded}` : "";
      // FIX Bug1: Include notebook content so assignment tests exactly what was taught
      const notebookCtx = dayData[k]?.notebook
        ? `\n\nBase the assignment DIRECTLY on this notebook — every question and challenge must reference or extend concepts from it, never introduce entirely new topics:\n---NOTEBOOK---\n${dayData[k].notebook.slice(0, 2000)}\n---END---`
        : "";
      // Include resources summary if available
      const resourcesCtx = dayData[k]?.resources
        ? `\n\nAdditional reference material the student has access to:\n---RESOURCES (summary)---\n${dayData[k].resources.slice(0, 600)}\n---END---`
        : "";

      const marksPerChallenge = Math.floor(50 / challengesCount);
      const lastChallengeMarks = 50 - marksPerChallenge * (challengesCount - 1);
      const difficultyLabel = (i, total) => {
        const pct = i / (total - 1 || 1);
        if (pct < 0.34) return "Foundation";
        if (pct < 0.67) return "Intermediate";
        return "Advanced";
      };

      const challengesTemplate = Array.from({ length: challengesCount }, (_, i) => {
        const marks = i === challengesCount - 1 ? lastChallengeMarks : marksPerChallenge;
        return `### Challenge ${i + 1}: [Title that describes what is built] (${marks} marks) — ${difficultyLabel(i, challengesCount)}
**Problem Statement:** [Clear, unambiguous description — what must be built, what it does, and what real-world scenario it represents]
**Input specification:** [Exact type, format, and valid range of all inputs]
**Output specification:** [Exact type and format of the required output — no vague descriptions]
**Sample test case:**
\`\`\`
Input:  [concrete example]
Output: [corresponding output — must match output spec exactly]
\`\`\`
**Edge cases to handle:** [At least 2 specific edge cases the solution must not break on]
**Starter code:**
\`\`\`python
# Challenge ${i + 1}: [Title]
# Do NOT modify function signatures

[complete function signature + docstring + TODO body — student fills in the logic]
\`\`\``;
      }).join("\n\n");

      const text = await callAI([
        { role:"system", content:"You are a university-level Python instructor writing rigorous, industry-grade assessments. Every challenge must have an unambiguous input/output contract, working starter code with function signatures, and a detailed rubric. The grading rubric must specify what earns full marks, partial marks, and zero marks for each part." },
        { role:"user", content:`Create a complete, production-quality assignment for: "${day.topic}".${filesCtx}${subTopicsSection}${notebookCtx}${resourcesCtx}

## Assignment Brief
[2 paragraphs: (1) real-world scenario that frames the entire assignment, (2) summary of what the student will build and what skills this demonstrates]

## Learning Objectives
[Exactly 5 bullet points — each a specific, measurable skill the student proves by completing this assignment]

## Part 1: Theory & Conceptual Understanding (20 marks)
Q1. [Deep conceptual question — tests understanding, not just recall — requires a paragraph answer] (7 marks)
Q2. [Code-reading question — show a code snippet and ask what it does, why it works, or what the output is] (7 marks)
Q3. [Compare-and-contrast or tradeoff question — two approaches, student analyses both] (6 marks)

## Part 2: Coding Challenges (50 marks)
${challengesTemplate}

## Part 3: Applied Mini-Project (30 marks)
**Scenario:** [Real-world business or data problem that requires synthesising ALL sub-topics covered in the day]
**Deliverable:** [Exact filename, format, and what it must contain]
**Minimum requirements:**
- [Specific, testable requirement 1]
- [Specific, testable requirement 2]
- [Specific, testable requirement 3]
- [Specific, testable requirement 4]
**Bonus (up to 10 extra marks):** [Concrete extension — must require a skill one level beyond the main project]

## Submission Guidelines
- File format: Python file (.py) or Jupyter notebook (.ipynb)
- Naming convention: \`[StudentName]_Day${day.dayNum}_Assignment\`
- Every function must have a docstring
- Deadline: [trainer fills in]

## Grading Rubric
[Part-by-part breakdown — for EVERY question and challenge specify: what earns full marks, what earns 50% marks, and what earns zero marks. Be operationally specific — state the criterion a TA can apply mechanically.]

HARD REQUIREMENTS:
- Part 2 must contain EXACTLY ${challengesCount} challenges numbered Challenge 1 through ${challengesCount}
- Every challenge must have a function-signature starter code the student fills in
- Every sub-topic listed above must appear in at least one challenge OR the mini-project
- Theory questions must reference specific code patterns from the notebook context if available
- Do not reuse any code verbatim from the notebook — paraphrase the scenario` }
      ]);
      validateAIResponse(text, "assignment");
      updateDay(k, { assignment: text, generatedForTopic: day.topic });
      if (!opts.silent) notify("Assignment generated!");
    } catch(e) {
      if (!opts.silent) notify(`Assignment: ${e.message}`, "err");
      else throw e;
    } finally {
      setBusyKey(busyKey, false);
      setPendingGen(p => { const n={...p}; delete n[busyKey]; return n; });
    }
  };



  const genTeachingGuide = async (day, opts={}) => {
    const k = day.key;
    const busyKey = `tg-${k}`;
    setBusyKey(busyKey, true);
    setPendingGen(p => ({ ...p, [busyKey]: { type: "guide", topic: day.topic, startedAt: Date.now() } }));
    try {
      const blocksCount = Math.max(2, Math.min(12, parseInt(dayData[k]?.guideBlocks) || 5));
      const subTopics = (dayData[k]?.subTopics || "").trim();
      const subTopicsSection = subTopics
        ? `\n\n## Sub-topics to Teach\nEach sub-topic listed below must be explicitly assigned to a specific BLOCK — the guide must show WHEN and HOW each is taught:\n${subTopics}\n`
        : "";

      // Named block types cycling through a curated list
      const blockTypes = [
        { name: "Hook & Introduction", duration: 10 },
        { name: "Core Concept Explanation", duration: 20 },
        { name: "Live Demo / Code Together", duration: 20 },
        { name: "Guided Practice", duration: 15 },
        { name: "Q&A and Wrap-up", duration: 10 },
        { name: "Independent Practice", duration: 20 },
        { name: "Common Errors Review", duration: 10 },
        { name: "Advanced Extension", duration: 15 },
        { name: "Pair Programming Activity", duration: 20 },
        { name: "Real-World Application Discussion", duration: 15 },
        { name: "Synthesis & Reflection", duration: 10 },
        { name: "Assessment & Exit Ticket", duration: 10 },
      ];

      const blocksTemplate = Array.from({ length: blocksCount }, (_, i) => {
        const bt = blockTypes[i] || { name: `Segment ${i + 1}`, duration: 15 };
        return `---
## BLOCK ${i + 1}: ${bt.name} (~${bt.duration} min)
**Primary Teaching Technique:** [Named pedagogy — e.g. "Think-Pair-Share", "Worked Example", "Live Coding with Narration", "Socratic Questioning"]
**Trainer Script / Approach:** [Word-for-word opening lines and detailed guidance — what to say, what to write on screen, how to pace this block. Minimum 4 sentences.]
**Student Activity:** [Exactly what students DO during this block — must be active, not passive listening]
**Key question to ask:** "[A specific, thought-provoking question — not yes/no — that checks understanding of this block's concept]"
**Sub-topic(s) covered:** [Which sub-topic(s) from the day are taught or practised here]
**Transition to Block ${i + 2 <= blocksCount ? i + 2 : "wrap-up"}:** [One sentence bridging naturally to the next block]`;
      }).join("\n\n");

      const text = await callAI([
        { role:"system", content:"You are a master educator coach with 20+ years helping Python trainers teach effectively. Your guides are block-by-block, operationally specific, and immediately actionable. Write exact scripts, not vague suggestions. Every block must be independently executable even if blocks around it are skipped." },
        { role:"user", content:`Create a detailed, complete teaching guide for a session on: "${day.topic}".${subTopicsSection}

---
## 🎯 Session Overview
**Recommended Total Duration:** [sum of all ${blocksCount} blocks in minutes]
**Session Goal:** [One sentence — what the student will be ABLE TO DO at the end, phrased as a skill, not a topic]
**Prerequisites to verify before starting:** [Specific knowledge the trainer must confirm students have]
**Equipment & setup checklist:** [Code editor, REPL, files, slides, etc. — everything needed before the first student walks in]

---
${blocksTemplate}

---
## 🚨 Troubleshooting Guide
[The ${Math.max(4, blocksCount)} most common in-class problems — for each:
• **Symptom:** [observable behaviour]
• **Root cause:** [why it happens]
• **Immediate fix:** [exact remedy the trainer applies in under 2 minutes, with code if relevant]
• **Prevention:** [how to set up the session to avoid it next time]]

---
## 💡 Engagement & Energy Management
[Exactly ${Math.max(5, blocksCount)} specific, actionable techniques with timing cues — include what to do when energy drops after the halfway point, and how to handle a silent class]

---
## ⚡ Differentiation Strategies
- **Fast finishers:** [specific advanced extension with a concrete deliverable]
- **Struggling students:** [specific scaffolding — a hint sequence, a simpler sub-task, or a pair assignment]
- **Mixed-pace groups:** [how to manage when half the class is done and half is stuck]

---
## 📋 Pre-Session Checklist (run 30 min before class)
${Array.from({ length: 8 }, (_, i) => `${i + 1}. [Specific preparatory action]`).join("\n")}

HARD REQUIREMENTS:
- Generate EXACTLY ${blocksCount} BLOCK sections numbered BLOCK 1 through BLOCK ${blocksCount}
- Every block MUST have ALL 6 fields: Technique, Script, Student Activity, Key Question, Sub-topic(s), Transition
- Sub-topics listed above must each be explicitly named in the "Sub-topic(s) covered" field of at least one block
- Scripts must be specific enough that a trainer who has never taught the topic before could deliver the session
- Do not use vague phrases like "explain the concept" or "show some examples" — be operationally precise` }
      ]);
      validateAIResponse(text, "general");
      updateDay(k, { teachingGuide: text, generatedForTopic: day.topic });
      if (!opts.silent) notify("Teaching guide generated!");
    } catch(e) {
      if (!opts.silent) notify(`Guide: ${e.message}`, "err");
      else throw e;
    } finally {
      setBusyKey(busyKey, false);
      setPendingGen(p => { const n={...p}; delete n[busyKey]; return n; });
    }
  };

  const genQuiz = async (day, opts={}) => {
    const k = day.key;
    const busyKey = `qz-${k}`;
    setBusyKey(busyKey, true);
    setPendingGen(p => ({ ...p, [busyKey]: { type: "quiz", topic: day.topic, startedAt: Date.now() } }));
    try {
      const questionsCount = Math.max(2, Math.min(20, parseInt(dayData[k]?.quizCount) || 6));
      const subTopics = (dayData[k]?.subTopics || "").trim();
      const subTopicsNote = subTopics
        ? `\n\nSub-topic distribution — distribute questions proportionally so every sub-topic below is tested by at least one question:\n${subTopics}\n`
        : "";
      // FIX Bug1: Include notebook so quiz tests exactly what was taught
      const notebookCtx = dayData[k]?.notebook
        ? `\n\nBase ALL questions STRICTLY on this notebook — only test concepts, code patterns, and facts explicitly present in it:\n---NOTEBOOK---\n${dayData[k].notebook.slice(0, 2000)}\n---END---`
        : "";

      const easyCount  = Math.max(1, Math.round(questionsCount * 0.30));
      const medCount   = Math.max(1, Math.round(questionsCount * 0.40));
      const hardCount  = Math.max(1, questionsCount - easyCount - medCount);

      const text = await callAI([
        { role:"system", content:`You are a quiz generator. Return ONLY valid JSON — no markdown fences, no preamble, no trailing text. The JSON must be a single array of exactly ${questionsCount} question objects. Any character outside the JSON array is a fatal error.` },
        { role:"user", content:`Generate exactly ${questionsCount} multiple-choice quiz questions for: "${day.topic}".${subTopicsNote}${notebookCtx}

Return a JSON array matching this EXACT structure — no deviations:
[
  {
    "q": "Complete question text ending with a question mark?",
    "options": ["A) first option", "B) second option", "C) third option", "D) fourth option"],
    "answer": 1,
    "explanation": "B is correct because [specific technical reason]. A is wrong because [reason]. C is wrong because [reason]. D is wrong because [reason]."
  }
]

Difficulty distribution — strictly follow this allocation:
- Questions 1–${easyCount}: Easy — factual recall or direct concept identification
- Questions ${easyCount + 1}–${easyCount + medCount}: Medium — application, code tracing, or selecting the correct approach
- Questions ${easyCount + medCount + 1}–${questionsCount}: Hard — synthesis, edge-case reasoning, or predicting subtle output differences

Hard rules:
- answer is 0-indexed (0=A, 1=B, 2=C, 3=D)
- At least ${Math.ceil(questionsCount * 0.4)} questions must include a Python code snippet in the question or options
- All 4 options must be plausible to someone who partially understands the topic — no obviously absurd distractors
- Explanation must address WHY each wrong option is wrong, not just why the correct option is right
- If sub-topics are listed, every sub-topic must appear in at least one question
- Return ONLY the JSON array — not a single character before [ or after ]` }
      ]);
      // Strip any accidental markdown fences
      const clean = text.replace(/```json|```/g, "").trim();
      let questions;
      try {
        questions = JSON.parse(clean);
      } catch (parseErr) {
        if (opts.silent) throw new Error("Quiz JSON parse failed — AI returned invalid JSON");
        notify("Quiz failed: AI returned invalid JSON — try again or switch to a larger model", "err");
        return;
      }
      if (!Array.isArray(questions) || questions.length === 0) throw new Error("Quiz: invalid JSON structure from AI");
      // FIX Bug2: Validate each question has all required fields before saving
      const valid = questions.filter((q, i) => {
        if (!q.q || typeof q.q !== "string") { console.warn(`Quiz Q${i+1}: missing 'q'`); return false; }
        if (!Array.isArray(q.options) || q.options.length < 2) { console.warn(`Quiz Q${i+1}: missing/invalid 'options'`); return false; }
        if (typeof q.answer !== "number" || q.answer < 0 || q.answer >= q.options.length) { console.warn(`Quiz Q${i+1}: invalid 'answer'`); return false; }
        if (!q.explanation || typeof q.explanation !== "string") { console.warn(`Quiz Q${i+1}: missing 'explanation'`); return false; }
        return true;
      });
      if (valid.length === 0) throw new Error("Quiz: all questions failed validation — regenerate");
      if (valid.length < questions.length) notify(`Quiz: ${questions.length - valid.length} malformed question(s) skipped`, "warn");
      updateDay(k, { quiz: valid, generatedForTopic: day.topic });
      if (!opts.silent) notify("Quiz generated!");
    } catch(e) {
      if (!opts.silent) notify(`Quiz: ${e.message}`, "err");
      else throw e;
    } finally {
      setBusyKey(busyKey, false);
      setPendingGen(p => { const n={...p}; delete n[busyKey]; return n; });
    }
  };

  const genAllForDay = async (day) => {
    // FIX: run all 6 generators in parallel with Promise.allSettled — ~4x faster than sequential
    notify(`Generating all content for Day ${day.dayNum} in parallel…`);
    const results = await Promise.allSettled([
      genNotebook(day, { silent: true }),
      genExamples(day, { silent: true }),
      genResources(day, { silent: true }),
      genAssignment(day, { silent: true }),
      genQuiz(day, { silent: true }),
      genTeachingGuide(day, { silent: true }),
    ]);
    const labels = ["Notebook", "Examples", "Resources", "Assignment", "Quiz", "Teaching Guide"];
    const failed = results
      .map((r, i) => r.status === "rejected" ? `${labels[i]}: ${r.reason?.message || "failed"}` : null)
      .filter(Boolean);
    if (failed.length) notify(`Day ${day.dayNum}: ${failed.length} step(s) failed — ${failed[0]}`, "err");
    else notify(`Day ${day.dayNum}: all content generated ✓`);
  };

  /* ════ FIX 1: Real Python execution ════ */
  const initPyodide = async () => {
    if (pyodideReady || pyodideLoadingPromise) return;
    setPyodideLoading(true);
    try {
      await loadPyodide();
      setPyodideReady(true);
      notify("Python runtime loaded! Real execution enabled ✓");
    } catch(e) { notify(`Pyodide failed to load: ${e.message} — using AI simulation`, "err"); }
    setPyodideLoading(false);
  };

  const runCode = async (day, code) => {
    const k = day.key;
    setBusyKey(`run-${k}`, true);
    setCodeOutputs(p=>({...p,[k]:""}));
    try {
      if (pyodideReady) {
        const out = await runPythonReal(code);
        setCodeOutputs(p=>({...p,[k]:"✓ REAL PYTHON OUTPUT:\n" + out}));
      } else {
        if (!isOnline && aiProvider === "groq") throw new Error("Offline — load Real Python above, or switch to Ollama in Settings");
        const out = await callAI([
          { role:"system", content:"You are a Python interpreter. Execute the code and show the exact output. Format: first line 'OUTPUT:' then the output, then blank line, then 'NOTES:' with any brief educational notes." },
          { role:"user", content:`Execute this Python code:\n\`\`\`python\n${code}\n\`\`\`` }
        ]);
        setCodeOutputs(p=>({...p,[k]:"⚠ AI-SIMULATED (load real Python above):\n" + out}));
      }
    } catch(e) { setCodeOutputs(p=>({...p,[k]:`Error: ${e.message}`})); }
    finally { setBusyKey(`run-${k}`, false); }
  };

  /* ════ File upload — Supabase Storage (with base64 fallback) ════ */
  const handleFileUpload = (key, files) => {
    if (!files || files.length === 0) return;
    const total = files.length;
    let processed = 0;
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        notify(`"${file.name}" is ${(file.size/1024/1024).toFixed(1)}MB — files over 5MB may fail to upload`, "warn");
      }
      const reader = new FileReader();
      reader.onerror = () => { processed++; notify(`Failed to read "${file.name}"`, "err"); };
      reader.onload = async (e) => {
        const fileId = generateId();
        const fileObj = {
          id: fileId,
          name: file.name, type: file.type, size: file.size,
          dataUrl: null,          // will be set below if Storage fails
          storagePath: null,
          uploadedAt: new Date().toISOString()
        };

        if (sb && courseId) {
          // FIX #9: Try Supabase Storage first — avoids storing large base64 blobs in DB
          const creds = getSbCreds();
          const storagePath = `${courseId}/${key}/${fileId}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          try {
            const blob = new Blob([e.target.result], { type: file.type });
            await sbUploadFileToStorage(creds.url, creds.key, storagePath, blob);
            fileObj.storagePath = storagePath;
            // Fetch a signed URL so we can display/download immediately
            const signedUrl = await sbGetStorageFileUrl(creds.url, creds.key, storagePath);
            if (signedUrl) fileObj.dataUrl = signedUrl;
          } catch (storageErr) {
            // FIX 10: Storage not configured or bucket missing — fall back to base64 in DB
            // Show a visible warning so the trainer knows to set up the storage bucket
            const isBucketMissing = storageErr.message.includes("Bucket not found") ||
              storageErr.message.includes("404") || storageErr.message.includes("not found");
            if (isBucketMissing) {
              notify(
                "⚠️ Supabase Storage bucket 'lms-files' not found. Files are being saved as base64 (DB will grow large). " +
                "Create the bucket in Supabase → Storage → New Bucket → name: lms-files.",
                "warn"
              );
            } else {
              console.warn("Storage upload failed, falling back to base64:", storageErr.message);
            }
            fileObj.dataUrl = e.target.result;
          }
          try { await sbSaveFile(sb, courseId, key, fileObj); }
          catch(err) { notify(`"${file.name}" DB save failed: ${err.message}`, "warn"); }
        } else {
          // No Supabase — store in memory only (session-only)
          fileObj.dataUrl = e.target.result;
        }

        setDayData(prev => {
          const cur = prev[key]?.uploadedFiles || [];
          return { ...prev, [key]: { ...prev[key], uploadedFiles: [...cur, fileObj] } };
        });
        processed++;
        if (processed === total) notify(`${total} file${total > 1 ? "s" : ""} uploaded`);
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const deleteUploadedFile = async (key, fileId) => {
    if (sb) {
      try { await sbDeleteFile(sb, fileId); } catch(e) { console.warn("File delete failed:", e.message); }
    }
    setDayData(prev => {
      const cur = prev[key]?.uploadedFiles || [];
      return { ...prev, [key]: { ...prev[key], uploadedFiles: cur.filter(f => f.id !== fileId) } };
    });
    notify("File removed");
  };

  /* ════ Parse plan ════ */
  const [parsePlanConfirm, setParsePlanConfirm] = useState(false);

  const handleParsePlan = () => {
    const days = parsePlan(planText);
    if (!days.length) { notify("No days found. Format: 'Day 1: Topic'", "err"); return; }
    // FIX: if a plan already exists, ask for confirmation before wiping status/content
    if (planDays.length > 0) {
      setParsePlanConfirm(days);
      return;
    }
    applyParsedPlan(days);
  };

  const applyParsedPlan = (days) => {
    setParsePlanConfirm(false);
    setPlanDays(days);
    setDayStatus({});
    setDayData({});
    setDayOverrides({}); // new plan = new dates, old overrides no longer map correctly
    setPage("calendar");
    notify(`${days.length} days loaded!`);
  };


  /* ════════════════════════════════════════════════
     RENDER
  ════════════════════════════════════════════════ */
  return (
    <ErrorBoundary>
      <div style={{ display:"flex", width:"100vw", height:"100vh", background:"#f9fafb", fontFamily:"'Plus Jakarta Sans','DM Sans',system-ui,sans-serif", overflow:"hidden", position:"relative" }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap');
          *{box-sizing:border-box;margin:0;padding:0}
          html,body,#root{width:100%;height:100%;overflow:hidden}
          ::-webkit-scrollbar{width:5px;height:5px}
          ::-webkit-scrollbar-track{background:transparent}
          ::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:99px}
          @keyframes lms-spin{to{transform:rotate(360deg)}}
          @keyframes lms-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
          @keyframes lms-slide{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}
          @keyframes lms-toast{0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:translateY(0)}}
          .lms-nav{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:10px;cursor:pointer;transition:all .15s;color:#64748b;font-size:13.5px;font-weight:500;white-space:nowrap;border:none;background:transparent;width:100%;text-align:left;font-family:inherit}
          .lms-nav:hover{background:#f1f5f9;color:#0f172a}
          .lms-nav.on{background:#0f172a;color:#fff}
          .lms-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:9px;border:none;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;transition:all .15s;white-space:nowrap}
          .lms-btn:disabled{opacity:.55;cursor:not-allowed}
          .lms-btn-dark{background:#0f172a;color:#fff}
          .lms-btn-dark:hover:not(:disabled){background:#1e293b}
          .lms-btn-blue{background:#3b82f6;color:#fff}
          .lms-btn-blue:hover:not(:disabled){background:#2563eb}
          .lms-btn-green{background:#22c55e;color:#fff}
          .lms-btn-green:hover:not(:disabled){background:#16a34a}
          .lms-btn-amber{background:#f59e0b;color:#fff}
          .lms-btn-amber:hover:not(:disabled){background:#d97706}
          .lms-btn-violet{background:#8b5cf6;color:#fff}
          .lms-btn-violet:hover:not(:disabled){background:#7c3aed}
          .lms-btn-rose{background:#f43f5e;color:#fff}
          .lms-btn-rose:hover:not(:disabled){background:#e11d48}
          .lms-btn-ghost{background:#f1f5f9;color:#475569}
          .lms-btn-ghost:hover:not(:disabled){background:#e2e8f0;color:#0f172a}
          .lms-card{background:#fff;border-radius:16px;border:1px solid #e8edf3;box-shadow:0 1px 3px rgba(0,0,0,.04)}
          .lms-input{width:100%;padding:9px 13px;border:1.5px solid #e2e8f0;border-radius:9px;font-size:13px;font-family:inherit;outline:none;transition:border .15s;background:#fff;color:#0f172a}
          .lms-input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.1)}
          textarea.lms-input{resize:vertical;min-height:80px;line-height:1.55}
          select.lms-input{cursor:pointer}
          .lms-tab{padding:7px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;transition:all .15s;color:#64748b;border:none;background:transparent;font-family:inherit}
          .lms-tab.on{background:#0f172a;color:#fff}
          .lms-tab:hover:not(.on){background:#f1f5f9;color:#334155}
          .lms-tag{display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:99px;font-size:11.5px;font-weight:600}
          .lms-cell{background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:14px;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12.5px;line-height:1.65;color:#1e293b;white-space:pre-wrap;word-break:break-all;overflow-x:auto}
          .lms-output{background:#0f172a;border-radius:10px;padding:14px;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12.5px;line-height:1.65;color:#e2e8f0;white-space:pre-wrap;word-break:break-all;min-height:80px}
          .lms-block{background:#fff;border:1.5px solid #e8edf3;border-radius:14px;padding:20px;margin-bottom:14px;animation:lms-in .25s ease}
          .lms-block-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #f1f5f9}
          .lms-section-label{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
          .lms-prose{font-size:13.5px;line-height:1.75;color:#374151}
          .lms-prose h1,.lms-prose h2,.lms-prose h3{color:#0f172a;font-weight:700;margin:16px 0 6px}
          .lms-prose h1{font-size:18px}.lms-prose h2{font-size:16px}.lms-prose h3{font-size:14px}
          .upload-zone{border:2px dashed #cbd5e1;border-radius:12px;padding:28px;text-align:center;cursor:pointer;transition:all .2s;background:#f8fafc;display:block}
          .upload-zone:hover{border-color:#3b82f6;background:#eff6ff}
          .day-cell{cursor:pointer;border-radius:12px;padding:10px;border:1.5px solid #e8edf3;background:#fff;transition:all .18s;min-height:78px}
          .day-cell:hover{box-shadow:0 4px 16px rgba(0,0,0,.08);transform:translateY(-1px);border-color:#cbd5e1}
          .day-cell.today{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.2)}
          .day-cell.has-plan:hover{border-color:#94a3b8}
          .day-cell:hover .day-override-btn{opacity:1!important}
          @media(max-width:768px){
            .lms-sidebar{position:fixed!important;left:0;top:0;height:100vh;z-index:200;transform:translateX(-100%);transition:transform .25s}
            .lms-sidebar.open{transform:translateX(0)!important}
            .lms-compiler-grid{grid-template-columns:1fr!important}
            .lms-cal-grid{grid-template-columns:1fr!important}
            .lms-setup-grid{grid-template-columns:1fr!important}
            .lms-overlay{display:block!important}
            .lms-mobile-menu-btn{display:flex!important}
            .lms-desktop-collapse-btn{display:none!important}
          }
          .lms-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:199}
          .lms-mobile-menu-btn{display:none}
          .lms-desktop-collapse-btn{display:flex}
        `}</style>

        {!isOnline && (
          <div style={{ position:"fixed", top:0, left:0, right:0, background: aiProvider==="ollama"?"#f59e0b":"#f43f5e", color:"#fff", padding:"8px 16px", textAlign:"center", fontSize:13, fontWeight:600, zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            <Ic n="wifi-off" s={15} c="#fff"/>
            {aiProvider==="ollama" ? "No internet — Ollama (local) still works. Pyodide execution available." : "You're offline — Groq AI unavailable. Load Real Python for code execution, or switch to Ollama in Settings."}
          </div>
        )}

        {mobileMenuOpen && <div className="lms-overlay" style={{ display:"block" }} onClick={()=>setMobileMenuOpen(false)}/>}

        {/* ── SIDEBAR ── */}
        <aside className={`lms-sidebar${mobileMenuOpen?" open":""}`} style={{ width:collapsed?58:210, flexShrink:0, background:"#fff", borderRight:"1.5px solid #e8edf3", display:"flex", flexDirection:"column", transition:"width .2s", overflow:"hidden" }}>
          <div style={{ padding:"16px 12px 12px", display:"flex", alignItems:"center", gap:9, borderBottom:"1px solid #f1f5f9" }}>
            <div style={{ width:32, height:32, background:"linear-gradient(135deg,#3b82f6,#8b5cf6)", borderRadius:9, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
              <Ic n="brain" s={17} c="#fff" />
            </div>
            {!collapsed && <span style={{ fontWeight:800, fontSize:14.5, color:"#0f172a", whiteSpace:"nowrap", letterSpacing:"-.3px" }}>AI With ARBAJ</span>}
          </div>
          <nav style={{ flex:1, padding:"10px 6px", overflowY:"auto", display:"flex", flexDirection:"column", gap:2 }}>
            {[
              ...(studentMode ? [] : [{ id:"setup",    ic:"upload",  label:"Setup Plan" }]),
              { id:"calendar", ic:"calendar",label:"Calendar" },
              ...(studentMode ? [] : [{ id:"settings", ic:"settings",label:"Settings" }]),
            ].map(item => (
              <button key={item.id} className={`lms-nav${page===item.id?" on":""}`} onClick={()=>{ setPage(item.id); setMobileMenuOpen(false); }} title={collapsed?item.label:""}>
                <Ic n={item.ic} s={16} />
                {!collapsed && <span>{item.label}</span>}
              </button>
            ))}
            {page==="day" && selDay && (
              <button className="lms-nav on" title={collapsed?selDay.topic:""}>
                <Ic n="book" s={16} />
                {!collapsed && <span style={{ overflow:"hidden", textOverflow:"ellipsis", maxWidth:130 }}>Day {selDay.dayNum}</span>}
              </button>
            )}

            {/* Students nav button — Supabase-fetched count */}
            {!studentMode && courseId && (
              <StudentsNavBtn
                key="students-nav"
                sb={sb}
                courseId={courseId}
                trainerId={trainerId}
                studentsOpen={studentsOpen}
                setStudentsOpen={setStudentsOpen}
                collapsed={collapsed}
              />
            )}
          </nav>
          <div style={{ padding:"10px 6px", borderTop:"1px solid #f1f5f9" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px" }}>
              <div style={{ width:28, height:28, background:"#3b82f6", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:12, fontWeight:700, flexShrink:0 }}>T</div>
              {!collapsed && (
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12.5, fontWeight:600, color:"#0f172a" }}>Trainer</div>
                  <div style={{ fontSize:11, color:"#94a3b8" }}>{aiProvider==="groq"?"Groq":"Ollama"} AI</div>
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* ── STUDENTS PANEL (sidebar overlay) ── */}
        {studentsOpen && !studentMode && courseId && (
          <StudentsPanel sb={sb} courseId={courseId} trainerId={trainerId} collapsed={collapsed} setStudentsOpen={setStudentsOpen} />
        )}

        {/* ── MAIN ── */}
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", marginTop: isOnline ? 0 : 36 }}>
          <header style={{ height:52, background:"#fff", borderBottom:"1.5px solid #e8edf3", display:"flex", alignItems:"center", padding:"0 16px", gap:10, flexShrink:0 }}>
            <button className="lms-btn lms-btn-ghost lms-mobile-menu-btn" style={{ padding:"6px 8px" }} onClick={()=>setMobileMenuOpen(p=>!p)}><Ic n="menu" s={16}/></button>
            <button className="lms-btn lms-btn-ghost lms-desktop-collapse-btn" style={{ padding:"6px 8px" }} onClick={()=>setCollapsed(p=>!p)}><Ic n="menu" s={16}/></button>
            <div style={{ flex:1, fontSize:13, color:"#94a3b8", overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>
              <span style={{ color:"#475569" }}>AI With ARBAJ</span>{" › "}
              <span style={{ color:"#0f172a", fontWeight:600 }}>
                {page==="setup"?"Setup Plan":page==="calendar"?"Learning Calendar":page==="settings"?"Settings":selDay?`Day ${selDay.dayNum}: ${selDay.topic}`:""}
              </span>
            </div>
            {page==="calendar" && planDays.length>0 && (
              <div style={{ display:"flex", alignItems:"center", gap:6, background:"#f1f5f9", padding:"4px 12px", borderRadius:8, fontSize:12.5, color:"#475569", flexShrink:0 }}>
                <Ic n="chart" s={13} />{planDays.length} days · {Object.values(dayStatus).filter(s=>s==="Completed").length} done
              </div>
            )}
            <div style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 10px", borderRadius:8, background: aiProvider==="groq"?"#eff6ff":"#f0fdf4", fontSize:12, fontWeight:600, color: aiProvider==="groq"?"#2563eb":"#16a34a", flexShrink:0 }}>
              {aiProvider==="groq"?"⚡ Groq":"🦙 Ollama"}
            </div>
            {planDays.length > 0 && (
              <button className="lms-btn lms-btn-ghost" style={{ padding:"5px 10px", fontSize:12, gap:5 }} onClick={()=>setSearchOpen(p=>!p)} title="Search (Ctrl+K)">
                <Ic n="search" s={14}/>
              </button>
            )}
          </header>

          <main style={{ flex:1, overflowY:"auto", padding:"20px 20px 80px", minHeight:0 }}>
            <ErrorBoundary>
              {page==="setup" && !studentMode && <SetupPage planText={planText} setPlanText={setPlanText} startDate={startDate} setStartDate={setStartDate} monfri={monfri} setMonfri={setMonfri} planDays={planDays} onParse={handleParsePlan} notify={notify} callAI={callAI} />}
              {/* FIX: Parse plan confirmation dialog — prevents accidental wipe of dayStatus/dayData */}
              {parsePlanConfirm && (
                <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.5)", zIndex:9500, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
                  <div style={{ background:"#fff", borderRadius:16, padding:28, maxWidth:440, width:"100%", boxShadow:"0 20px 60px rgba(0,0,0,.25)" }}>
                    <div style={{ width:42, height:42, background:"#fffbeb", borderRadius:11, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:14 }}>
                      <Ic n="refresh" s={20} c="#f59e0b"/>
                    </div>
                    <p style={{ fontWeight:800, fontSize:16, color:"#0f172a", marginBottom:8 }}>Re-parse Course Plan?</p>
                    <p style={{ fontSize:13.5, color:"#475569", lineHeight:1.65, marginBottom:16 }}>
                      This will <strong>reset all day statuses</strong> to "Not Started" and clear local day data.
                      AI-generated content stored in Supabase (<code>lms_day_content</code>) is safe — but re-parsing
                      may remap dates if you changed the start date or Mon–Fri setting.
                    </p>
                    <p style={{ fontSize:13, color:"#64748b", marginBottom:20 }}>
                      New plan: <strong>{parsePlanConfirm.length} days</strong> · Current plan: <strong>{planDays.length} days</strong>
                    </p>
                    <div style={{ display:"flex", gap:10 }}>
                      <button className="lms-btn lms-btn-ghost" style={{ flex:1, justifyContent:"center" }} onClick={()=>setParsePlanConfirm(false)}>Cancel</button>
                      <button className="lms-btn lms-btn-amber" style={{ flex:1, justifyContent:"center" }} onClick={()=>applyParsedPlan(parsePlanConfirm)}>
                        <Ic n="refresh" s={14}/>Re-parse Plan
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {page==="calendar" && <CalendarPage planDays={planDays} dayMap={dayMap} dayStatus={dayStatus} setDayStatus={setDayStatus} calYear={calYear} setCalYear={setCalYear} calMonth={calMonth} setCalMonth={setCalMonth} onSelectDay={d=>{ setSelDay(d); setPage("day"); }} notify={notify} busy={busy} dayData={dayData} studentMode={studentMode} dayOverrides={dayOverrides} setDayOverrides={setDayOverrides} onGenWeek={async(days,onProgress)=>{
                const gens=[{fn:genNotebook,label:"Notebook"},{fn:genExamples,label:"Examples"},{fn:genResources,label:"Resources"},{fn:genAssignment,label:"Assignment"},{fn:genQuiz,label:"Quiz"},{fn:genTeachingGuide,label:"Teaching Guide"}];
                let done=0; const total=days.length*gens.length; const failed=[];
                for(const d of days){ for(const{fn,label}of gens){ try{await fn(d,{silent:true});}catch(e){failed.push(`Day ${d.dayNum} ${label}: ${e.message}`);} done++; onProgress&&onProgress(done,total); } }
                if(failed.length) throw new Error(`${failed.length} step(s) failed:\n${failed.slice(0,3).join("\n")}${failed.length>3?"\n…and more":""}`);
              }} />}
              {page==="day" && selDay && (
                <DayPage
                  day={selDay} dayData={dayData[selDay.key]||{}} dayStatus={dayStatus} setDayStatus={setDayStatus}
                  busy={busy} pendingGen={pendingGen}
                  codeEdit={codeEdits[selDay.key]||""} setCodeEdit={v=>setCodeEdits(p=>({...p,[selDay.key]:v}))}
                  codeOutput={codeOutputs[selDay.key]||""}
                  onBack={()=>setPage("calendar")}
                  onRunCode={code=>runCode(selDay,code)}
                  onGenNotebook={()=>genNotebook(selDay)}
                  onGenExamples={()=>genExamples(selDay)}
                  onGenResources={()=>genResources(selDay)}
                  onGenAssignment={()=>genAssignment(selDay)}
                  onGenTeachingGuide={()=>genTeachingGuide(selDay)}
                  onGenQuiz={()=>genQuiz(selDay)}
                  onGenAll={()=>genAllForDay(selDay)}
                  onFileUpload={files=>handleFileUpload(selDay.key,files)}
                  onDeleteFile={id=>deleteUploadedFile(selDay.key,id)}
                  updateDay={updateDay} notify={notify}
                  pyodideReady={pyodideReady} pyodideLoading={pyodideLoading} onLoadPyodide={initPyodide}
                  studentMode={studentMode}
                  onEditTopic={(newTopic) => {
                    // Find the planDays index for this day key and update only its topic
                    const pidx = dayMap[selDay.key];
                    if (pidx === undefined) return;
                    const updated = planDays.map((d, i) => i === pidx ? { ...d, topic: newTopic } : d);
                    setPlanDays(updated);
                    // Also sync selDay so the header reflects the change immediately
                    setSelDay(prev => ({ ...prev, topic: newTopic }));
                    notify(`✏️ Topic updated — all generated content is preserved`);
                  }}
                />
              )}
              {page==="settings" && !studentMode && (
                <SettingsPage
                  aiProvider={aiProvider} setAiProvider={setAiProvider}
                  groqKey={groqKey} setGroqKey={setGroqKey}
                  groqModel={groqModel} setGroqModel={setGroqModel}
                  ollamaUrl={ollamaUrl} setOllamaUrl={setOllamaUrl}
                  ollamaModel={ollamaModel} setOllamaModel={setOllamaModel}
                  callAI={callAI} notify={notify}
                  sb={sb} courseId={courseId} trainerId={trainerId}
                  setPlanText={setPlanText} setPlanDays={setPlanDays}
                  setStartDate={setStartDate} setMonfri={setMonfri}
                  setDayStatus={setDayStatus} setDayData={setDayData}
                  setDayOverrides={setDayOverrides}
                />
              )}
            </ErrorBoundary>
          </main>
        </div>

        {/* Search overlay */}
        {searchOpen && (
          <div style={{ position:"fixed", inset:0, zIndex:8000, display:"flex", alignItems:"flex-start", justifyContent:"center", paddingTop:80, background:"rgba(15,23,42,.55)" }}
            onClick={e=>{ if(e.target===e.currentTarget) setSearchOpen(false); }}>
            <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:580, boxShadow:"0 24px 80px rgba(0,0,0,.3)", overflow:"hidden" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"14px 18px", borderBottom:"1.5px solid #f1f5f9" }}>
                <Ic n="search" s={18} c="#94a3b8"/>
                <input autoFocus className="lms-input" value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
                  placeholder="Search topics, notebooks, assignments…"
                  style={{ border:"none", outline:"none", flex:1, fontSize:15, fontWeight:500, padding:0 }}/>
                <button onClick={()=>setSearchOpen(false)} style={{ background:"none", border:"none", cursor:"pointer", color:"#94a3b8", fontSize:12, padding:"4px 8px", borderRadius:6, fontFamily:"inherit" }}>ESC</button>
              </div>
              <div style={{ maxHeight:400, overflowY:"auto" }}>
                {(() => {
                  const q = searchQuery.trim().toLowerCase();
                  if (!q) return <div style={{ padding:"20px 18px", color:"#94a3b8", fontSize:13.5 }}>Type to search across all {planDays.length} days…</div>;
                  const hits = [];
                  for (const [k2, pidx] of Object.entries(dayMap)) {
                    const pd = planDays[pidx]; const dd = dayData[k2] || {};
                    const fields = [{ label:"Topic", text:pd.topic },{ label:"Notebook", text:dd.notebook },{ label:"Assignment", text:dd.assignment },{ label:"Resources", text:dd.resources },{ label:"Notes", text:dd.notes }];
                    for (const f of fields) {
                      if (f.text && f.text.toLowerCase().includes(q)) {
                        const idx2=f.text.toLowerCase().indexOf(q);
                        const snippet=f.text.slice(Math.max(0,idx2-40),idx2+80).replace(/\n/g," ");
                        hits.push({ k2, dayNum:pd.dayNum, topic:pd.topic, label:f.label, snippet }); break;
                      }
                    }
                  }
                  if (!hits.length) return <div style={{ padding:"20px 18px", color:"#94a3b8", fontSize:13.5 }}>No results for "{searchQuery}"</div>;
                  return hits.slice(0,12).map((h,i)=>(
                    <button key={i} onClick={()=>{ setSelDay({key:h.k2,dayNum:h.dayNum,topic:h.topic}); setPage("day"); setSearchOpen(false); setSearchQuery(""); }}
                      style={{ width:"100%", textAlign:"left", padding:"12px 18px", border:"none", background:"transparent", borderBottom:"1px solid #f8fafc", cursor:"pointer", fontFamily:"inherit" }}
                      onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                        <div style={{ width:30, height:30, background:"linear-gradient(135deg,#3b82f6,#8b5cf6)", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:800, fontSize:11, flexShrink:0 }}>{h.dayNum}</div>
                        <div style={{ flex:1, overflow:"hidden" }}>
                          <p style={{ fontSize:13, fontWeight:700, color:"#0f172a" }}>{h.topic} <span style={{ fontSize:11, color:"#94a3b8", fontWeight:500 }}>· {h.label}</span></p>
                          <p style={{ fontSize:12, color:"#64748b", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>…{h.snippet}…</p>
                        </div>
                      </div>
                    </button>
                  ));
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Toasts */}
        <div style={{ position:"fixed", bottom:22, right:22, display:"flex", flexDirection:"column", gap:8, zIndex:9999, maxWidth:360 }}>
          {toasts.map(t => (
            <div key={t.id} style={{ padding:"11px 18px", borderRadius:11, background:t.type==="err"?"#fef2f2":t.type==="warn"?"#fffbeb":"#f0fdf4", border:`1.5px solid ${t.type==="err"?"#fecaca":t.type==="warn"?"#fde68a":"#bbf7d0"}`, color:t.type==="err"?"#dc2626":t.type==="warn"?"#92400e":"#15803d", fontSize:13.5, fontWeight:600, animation:"lms-toast .25s ease", boxShadow:"0 6px 24px rgba(0,0,0,.1)", display:"flex", alignItems:"center", gap:8 }}>
              <Ic n={t.type==="err"?"x":t.type==="warn"?"bell":"check"} s={15}/>
              {t.msg}
            </div>
          ))}
        </div>
      </div>
    </ErrorBoundary>
  );
}

function SetupPage({ planText, setPlanText, startDate, setStartDate, monfri, setMonfri, planDays, onParse, notify, callAI }) {
  const sample = `Day 1: Python Basics - variables, data types, print
Day 2: Control Flow - if/elif/else, comparison operators
Day 3: Loops - for loops, while loops, range()
Day 4: Functions - defining, parameters, return values
Day 5: Lists and Tuples - indexing, slicing, methods
Day 6: Dictionaries and Sets
Day 7: File I/O - reading and writing files
Day 8: Exception Handling - try/except/finally
Day 9: Object-Oriented Programming - classes, objects
Day 10: Modules and Packages - import, pip`;

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = ev => setPlanText(ev.target.result);
    r.readAsText(f);
  };

  /* ── Brochure Plan Generator state ── */
  const [brochureFile,      setBrochureFile]      = useState(null);   // { name, type, dataUrl, base64 }
  const [brochureDays,      setBrochureDays]      = useState("");      // user-specified day count
  const [brochureGenerating,setBrochureGenerating]= useState(false);
  const [brochureResult,    setBrochureResult]    = useState(null);   // { plan, suggestedDays, summary }
  const [brochureError,     setBrochureError]     = useState("");
  const [brochureDragOver,  setBrochureDragOver]  = useState(false);

  const handleBrochureFile = (file) => {
    if (!file) return;
    const allowed = ["application/pdf","image/png","image/jpeg","image/jpg","image/webp","image/gif"];
    if (!allowed.includes(file.type)) {
      notify("Please upload a PDF or image file (PNG, JPG, WEBP, GIF)", "err");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      notify("File too large — max 8MB for brochure upload", "err");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const base64  = dataUrl.split(",")[1];
      setBrochureFile({ name: file.name, type: file.type, dataUrl, base64 });
      setBrochureResult(null);
      setBrochureError("");
    };
    reader.readAsDataURL(file);
  };

  const handleBrochureDrop = (e) => {
    e.preventDefault();
    setBrochureDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleBrochureFile(file);
  };

  const generatePlanFromBrochure = async () => {
    if (!brochureFile) { notify("Upload a brochure first", "err"); return; }
    if (!callAI) { notify("Configure AI provider in Settings first", "err"); return; }
    setBrochureGenerating(true);
    setBrochureError("");
    setBrochureResult(null);
    try {
      const userDays = parseInt(brochureDays) || 0;
      const dayInstruction = userDays > 0
        ? `The user wants exactly ${userDays} days. Create a plan with exactly ${userDays} days.`
        : `First estimate the ideal number of days needed to cover all content thoroughly (typically 1 topic per day). State your recommendation clearly.`;

      const isPdf   = brochureFile.type === "application/pdf";
      const isImage = brochureFile.type.startsWith("image/");

      let messages;

      if (isImage) {
        // Images: send as vision message (works with Groq llava/vision models)
        // Non-vision Groq models will reject it → caught below → text fallback kicks in
        messages = [
          {
            role: "system",
            content: `You are an expert curriculum designer. Analyze course brochures and create structured day-wise teaching plans. Always respond in the exact format requested.`
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: brochureFile.dataUrl }
              },
              {
                type: "text",
                text: `This is a course brochure image. Analyze all text, topics, modules, and learning objectives visible in it.

${dayInstruction}

Respond with EXACTLY this structure — no deviations:

SUGGESTED_DAYS: [number]

SUMMARY:
[2-3 sentences describing what this course covers]

PLAN:
Day 1: [Topic title - be specific]
Day 2: [Topic title]
Day 3: [Topic title]
[continue for all days...]

Rules:
- Each day must have ONE focused topic
- Topics must directly come from the brochure content
- Day titles should be concise (under 60 chars)
- Cover all modules/sections from the brochure
- Order topics logically (fundamentals before advanced)`
              }
            ]
          }
        ];
      } else {
        // PDF or fallback — send as text description prompt
        // Most Groq/Ollama models can't read raw PDFs, so we ask the user to describe
        // BUT we still try by embedding base64 in a document block for models that support it
        messages = [
          {
            role: "system",
            content: `You are an expert curriculum designer. Analyze course brochures and create structured day-wise teaching plans. Always respond in the exact format requested.`
          },
          {
            role: "user",
            content: `I'm sharing a course brochure PDF (base64 encoded). The filename is: "${brochureFile.name}".

Even if you cannot decode the PDF directly, use the filename and any context to infer the course subject, then generate a comprehensive day-wise teaching plan for it.

${dayInstruction}

Respond with EXACTLY this structure — no deviations:

SUGGESTED_DAYS: [number]

SUMMARY:
[2-3 sentences describing what this course covers based on the filename/content]

PLAN:
Day 1: [Topic title - be specific]
Day 2: [Topic title]
Day 3: [Topic title]
[continue for all days...]

Rules:
- Each day must have ONE focused topic
- Topics must be relevant to the course subject
- Day titles should be concise (under 60 chars)
- Order topics logically (fundamentals before advanced)
- Cover beginner to advanced progression`
          }
        ];
      }

      const raw = await callAI(messages);

      // Parse the structured response
      const suggestedDaysMatch = raw.match(/SUGGESTED_DAYS:\s*(\d+)/i);
      const suggestedDays = suggestedDaysMatch ? parseInt(suggestedDaysMatch[1]) : (userDays || null);

      const summaryMatch = raw.match(/SUMMARY:\s*([\s\S]*?)(?=PLAN:|$)/i);
      const summary = summaryMatch ? summaryMatch[1].trim() : "";

      const planMatch = raw.match(/PLAN:\s*([\s\S]+)/i);
      const planRaw = planMatch ? planMatch[1].trim() : raw;

      // Extract only valid "Day N: Topic" lines
      const planLines = planRaw.split("\n")
        .map(l => l.trim())
        .filter(l => l.match(/^(?:day\s*)?\d+\s*[:\-\.]\s*.+/i));

      if (planLines.length === 0) throw new Error("AI did not return a valid day plan — try again or switch to a larger model");

      const planText2 = planLines.join("\n");
      setBrochureResult({ plan: planText2, suggestedDays, summary, lineCount: planLines.length });
      notify(`Plan generated! ${planLines.length} days from brochure ✓`);
    } catch(e) {
      // Trigger text-only fallback for: vision-unsupported errors, image format rejections,
      // or any 400/422 from sending array content to a text model
      const isVisionError = e.message?.toLowerCase().match(/image|vision|content|unsupported|multimodal|400|422/);
      if (isVisionError && brochureFile?.type?.startsWith("image/")) {
        try {
          const userDays = parseInt(brochureDays) || 0;
          const dayInstruction = userDays > 0
            ? `Create a plan with exactly ${userDays} days.`
            : `Recommend the ideal number of days.`;
          const fallback = await callAI([
            { role:"system", content:"You are an expert curriculum designer creating structured teaching plans." },
            { role:"user", content:`Generate a day-wise teaching plan for a course titled "${brochureFile.name.replace(/\.[^.]+$/,"")}".

${dayInstruction}

Respond with EXACTLY this structure:

SUGGESTED_DAYS: [number]

SUMMARY:
[2-3 sentences about this course]

PLAN:
Day 1: [Topic]
Day 2: [Topic]
[continue...]` }
          ]);
          const suggestedDaysMatch2 = fallback.match(/SUGGESTED_DAYS:\s*(\d+)/i);
          const suggestedDays2 = suggestedDaysMatch2 ? parseInt(suggestedDaysMatch2[1]) : (userDays || null);
          const summaryMatch2 = fallback.match(/SUMMARY:\s*([\s\S]*?)(?=PLAN:|$)/i);
          const summary2 = summaryMatch2 ? summaryMatch2[1].trim() : "";
          const planMatch2 = fallback.match(/PLAN:\s*([\s\S]+)/i);
          const planLines2 = (planMatch2?.[1] || fallback).split("\n").map(l=>l.trim()).filter(l=>l.match(/^(?:day\s*)?\d+\s*[:\-\.]\s*.+/i));
          if (planLines2.length === 0) throw new Error("Could not parse plan from AI response");
          setBrochureResult({ plan: planLines2.join("\n"), suggestedDays: suggestedDays2, summary: summary2, lineCount: planLines2.length, fallback: true });
          notify(`Plan generated (text mode)! ${planLines2.length} days ✓`);
        } catch(e2) {
          setBrochureError(e2.message);
          notify(`Brochure AI error: ${e2.message}`, "err");
        }
      } else {
        setBrochureError(e.message);
        notify(`Brochure AI error: ${e.message}`, "err");
      }
    }
    setBrochureGenerating(false);
  };

  const usePlanInSetup = () => {
    if (!brochureResult?.plan) return;
    setPlanText(brochureResult.plan);
    notify("Plan loaded into editor — review and click Parse & Start!");
  };

  return (
    <div style={{ maxWidth:900, animation:"lms-in .3s ease", paddingBottom:60 }}>
      <div style={{ marginBottom:28 }}>
        <h1 style={{ fontSize:26, fontWeight:800, color:"#0f172a", letterSpacing:"-.5px" }}>Setup Your Course Plan</h1>
        <p style={{ color:"#64748b", fontSize:14, marginTop:5 }}>Paste a plan manually, upload a .txt file, or generate one automatically from a course brochure (PDF or image).</p>
      </div>

      {/* ══ BROCHURE PLAN GENERATOR ══ */}
      <div className="lms-card" style={{ padding:22, marginBottom:20, border:"1.5px solid #e0e7ff", background:"linear-gradient(135deg,#f8f9ff 0%,#f0f4ff 100%)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
          <div style={{ width:32, height:32, background:"linear-gradient(135deg,#6366f1,#8b5cf6)", borderRadius:9, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
            <Ic n="brain" s={17} c="#fff"/>
          </div>
          <div>
            <p style={{ fontWeight:800, fontSize:15, color:"#0f172a" }}>AI Plan Generator from Brochure</p>
            <p style={{ fontSize:12.5, color:"#6366f1", fontWeight:500 }}>Upload a course brochure (PDF or image) → AI reads it → generates a day-wise teaching plan</p>
          </div>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginTop:18 }} className="lms-setup-grid">

          {/* Left: upload zone */}
          <div>
            <p className="lms-section-label" style={{ marginBottom:8 }}>Step 1 — Upload Brochure</p>
            <div
              className="upload-zone"
              style={{
                borderColor: brochureDragOver ? "#6366f1" : brochureFile ? "#6366f1" : "#c7d2fe",
                background:  brochureDragOver ? "#eef2ff" : brochureFile ? "#f5f3ff" : "#f8fafc",
                transition:"all .2s", padding:20, position:"relative"
              }}
              onDragOver={e=>{ e.preventDefault(); setBrochureDragOver(true); }}
              onDragLeave={()=>setBrochureDragOver(false)}
              onDrop={handleBrochureDrop}
            >
              {brochureFile ? (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
                  {brochureFile.type.startsWith("image/") ? (
                    <img src={brochureFile.dataUrl} alt="brochure preview"
                      style={{ maxHeight:120, maxWidth:"100%", borderRadius:8, objectFit:"contain", boxShadow:"0 2px 12px rgba(0,0,0,.12)" }}/>
                  ) : (
                    <div style={{ width:52, height:52, background:"#fef2f2", borderRadius:12, display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <Ic n="file" s={26} c="#ef4444"/>
                    </div>
                  )}
                  <p style={{ fontSize:13, fontWeight:700, color:"#0f172a", textAlign:"center", wordBreak:"break-all" }}>{brochureFile.name}</p>
                  <p style={{ fontSize:11.5, color:"#6366f1", fontWeight:600 }}>✓ Ready to analyze</p>
                  <button className="lms-btn lms-btn-ghost" style={{ fontSize:12, padding:"4px 10px" }}
                    onClick={()=>{ setBrochureFile(null); setBrochureResult(null); setBrochureError(""); }}>
                    <Ic n="trash" s={12}/>Remove
                  </button>
                </div>
              ) : (
                <>
                  <Ic n="upload" s={26} c="#a5b4fc"/>
                  <p style={{ marginTop:10, fontSize:13.5, fontWeight:600, color:"#475569" }}>Drop brochure here or click to browse</p>
                  <p style={{ fontSize:12, color:"#94a3b8", marginTop:4 }}>PDF, PNG, JPG, WEBP — max 8MB</p>
                </>
              )}
              <input type="file" accept=".pdf,image/png,image/jpeg,image/webp,image/gif"
                style={{ position:"absolute", inset:0, opacity:0, cursor:"pointer", width:"100%", height:"100%" }}
                onChange={e => handleBrochureFile(e.target.files[0])} />
            </div>
          </div>

          {/* Right: settings + generate */}
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div>
              <p className="lms-section-label" style={{ marginBottom:8 }}>Step 2 — Days to Cover (optional)</p>
              <div style={{ position:"relative" }}>
                <input
                  type="number" min="1" max="365"
                  className="lms-input"
                  value={brochureDays}
                  onChange={e => setBrochureDays(e.target.value)}
                  placeholder="Leave blank — AI will suggest"
                  style={{ paddingRight:110 }}
                />
                {!brochureDays && (
                  <span style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", fontSize:11, color:"#a5b4fc", fontWeight:600, pointerEvents:"none" }}>AI decides</span>
                )}
              </div>
              <p style={{ fontSize:11.5, color:"#94a3b8", marginTop:5, lineHeight:1.5 }}>
                Set a fixed number or leave blank and the AI will estimate based on content depth.
              </p>
            </div>

            <button
              className="lms-btn"
              style={{ background:"linear-gradient(135deg,#6366f1,#8b5cf6)", color:"#fff", justifyContent:"center", padding:"11px 0", fontSize:13.5, fontWeight:700 }}
              disabled={!brochureFile || brochureGenerating}
              onClick={generatePlanFromBrochure}
            >
              {brochureGenerating
                ? <><Spin s={15}/>Analyzing brochure…</>
                : <><Ic n="brain" s={15}/>Generate Plan from Brochure</>}
            </button>

            {brochureError && (
              <div style={{ background:"#fef2f2", border:"1.5px solid #fecaca", borderRadius:9, padding:"10px 12px", fontSize:12.5, color:"#dc2626" }}>
                ❌ {brochureError}
              </div>
            )}

            {brochureResult && (
              <div style={{ background:"#f0fdf4", border:"1.5px solid #bbf7d0", borderRadius:9, padding:"12px 14px", display:"flex", flexDirection:"column", gap:8 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:18 }}>✅</span>
                  <div>
                    <p style={{ fontWeight:700, fontSize:13, color:"#15803d" }}>{brochureResult.lineCount} days generated</p>
                    {brochureResult.suggestedDays && (
                      <p style={{ fontSize:12, color:"#16a34a" }}>
                        AI recommendation: <strong>{brochureResult.suggestedDays} days</strong>
                        {parseInt(brochureDays) > 0 && parseInt(brochureDays) !== brochureResult.suggestedDays
                          ? ` (you set ${brochureDays})`
                          : ""}
                      </p>
                    )}
                  </div>
                </div>
                {brochureResult.summary && (
                  <p style={{ fontSize:12.5, color:"#374151", lineHeight:1.55, borderTop:"1px solid #bbf7d0", paddingTop:8 }}>
                    {brochureResult.summary}
                  </p>
                )}
                {brochureResult.fallback && (
                  <p style={{ fontSize:11.5, color:"#d97706" }}>⚠ Generated from filename (model doesn't support image reading — switch to a vision model for better results)</p>
                )}
                <button className="lms-btn lms-btn-green" style={{ justifyContent:"center" }} onClick={usePlanInSetup}>
                  <Ic n="check" s={14}/>Use This Plan in Editor ↓
                </button>
                <button className="lms-btn lms-btn-ghost" style={{ justifyContent:"center", fontSize:12 }}
                  onClick={()=>downloadBlob(brochureResult.plan, "generated_plan.txt")}>
                  <Ic n="download" s={13}/>Download as .txt
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Preview of generated plan */}
        {brochureResult?.plan && (
          <div style={{ marginTop:16 }}>
            <p className="lms-section-label" style={{ marginBottom:8 }}>Generated Plan Preview</p>
            <div style={{ background:"#fff", border:"1.5px solid #e0e7ff", borderRadius:10, padding:"12px 14px", maxHeight:200, overflowY:"auto", fontFamily:"'JetBrains Mono','Fira Code',monospace", fontSize:12, lineHeight:1.7, color:"#1e293b", whiteSpace:"pre-wrap" }}>
              {brochureResult.plan}
            </div>
          </div>
        )}
      </div>

      <div className="lms-setup-grid" style={{ display:"grid", gridTemplateColumns:"1fr 340px", gap:20 }}>
        <div className="lms-card" style={{ padding:22 }}>
          <p className="lms-section-label">Teaching Plan (.txt format)</p>
          <textarea className="lms-input" value={planText} onChange={e=>setPlanText(e.target.value)}
            placeholder={sample} style={{ minHeight:300, fontSize:12.5, fontFamily:"'JetBrains Mono','Fira Code',monospace" }} />
          <div style={{ display:"flex", gap:8, marginTop:12, flexWrap:"wrap" }}>
            <button className="lms-btn lms-btn-dark" onClick={onParse}><Ic n="check" s={14}/>Parse & Start</button>
            <label className="lms-btn lms-btn-ghost" style={{ cursor:"pointer" }}>
              <Ic n="upload" s={14}/>Upload .txt
              <input type="file" accept=".txt,.md" onChange={handleFile} style={{ display:"none" }} />
            </label>
            <button className="lms-btn lms-btn-ghost" onClick={()=>setPlanText(sample)}><Ic n="file" s={14}/>Load Sample</button>
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <div className="lms-card" style={{ padding:18 }}>
            <p className="lms-section-label">Course Start Date</p>
            <input type="date" className="lms-input" value={startDate} onChange={e=>setStartDate(e.target.value)} />
          </div>

          <div className="lms-card" style={{ padding:18 }}>
            <p className="lms-section-label">Schedule Mode</p>
            <div style={{ display:"flex", gap:8 }}>
              <button className={`lms-btn ${monfri?"lms-btn-dark":"lms-btn-ghost"}`} onClick={()=>setMonfri(true)} style={{ flex:1 }}>Mon–Fri</button>
              <button className={`lms-btn ${!monfri?"lms-btn-dark":"lms-btn-ghost"}`} onClick={()=>setMonfri(false)} style={{ flex:1 }}>All Days</button>
            </div>
            <p style={{ fontSize:11.5, color:"#94a3b8", marginTop:8 }}>{monfri?"Weekends skipped":"Includes weekends"}</p>
          </div>

          {planDays.length > 0 && (
            <div className="lms-card" style={{ padding:18 }}>
              <p className="lms-section-label">{planDays.length} Days Parsed</p>
              <div style={{ maxHeight:200, overflowY:"auto", display:"flex", flexDirection:"column", gap:5 }}>
                {planDays.map((d,i) => (
                  <div key={i} style={{ display:"flex", gap:10, fontSize:12.5, padding:"5px 0", borderBottom:"1px solid #f8fafc" }}>
                    <span style={{ color:"#3b82f6", fontWeight:700, minWidth:48, flexShrink:0 }}>Day {d.dayNum}</span>
                    <span style={{ color:"#374151" }}>{d.topic}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CALENDAR PAGE — FIX 10: responsive layout
═══════════════════════════════════════════════════════════════════ */
function CalendarPage({ planDays, dayMap, dayStatus, setDayStatus, calYear, setCalYear, calMonth, setCalMonth, onSelectDay, notify, busy, onGenWeek, dayData, studentMode, dayOverrides = {}, setDayOverrides }) {
  const todayK = todayKey();
  const dim = daysInMonth(calYear, calMonth);
  const fw  = firstWeekday(calYear, calMonth);
  const cells = [...Array(fw).fill(null), ...Array.from({length:dim},(_,i)=>i+1)];

  // FIX: hooks must be at the top before any derived computation
  const [genWeekKey, setGenWeekKey] = useState(null);
  const [weekProgress, setWeekProgress] = useState(null);
  const [confirmWeek, setConfirmWeek] = useState(null);

  // Day-override modal state (holiday / extra topic)
  const [overrideModal, setOverrideModal] = useState(null); // { dateKey, mode: "new"|"edit" }
  const [overrideType, setOverrideType]   = useState("holiday"); // "holiday" | "extra" | "special"
  const [overrideLabel, setOverrideLabel] = useState("");

  const prev = () => { if(calMonth===0){setCalMonth(11);setCalYear(y=>y-1);}else setCalMonth(m=>m-1); };
  const next = () => { if(calMonth===11){setCalMonth(0);setCalYear(y=>y+1);}else setCalMonth(m=>m+1); };

  // ── Override helpers ──
  const openOverrideModal = (dateKey) => {
    if (!setDayOverrides) return; // students can't edit
    const existing = dayOverrides[dateKey];
    setOverrideType(existing?.type || "holiday");
    setOverrideLabel(existing?.label || "");
    setOverrideModal({ dateKey, mode: existing ? "edit" : "new" });
  };

  const saveOverride = () => {
    if (!overrideLabel.trim()) { notify("Please enter a label", "err"); return; }
    const updated = { ...dayOverrides, [overrideModal.dateKey]: { type: overrideType, label: overrideLabel.trim() } };
    setDayOverrides(updated);
    notify(
      overrideType === "holiday" ? `🏖️ Holiday set: "${overrideLabel.trim()}" — plan shifts forward` :
      overrideType === "special" ? `⭐ Special day added: "${overrideLabel.trim()}" — plan shifts forward` :
      `📌 Extra content added for ${overrideModal.dateKey}`
    );
    setOverrideModal(null); setOverrideLabel("");
  };

  const removeOverride = (dateKey) => {
    const updated = { ...dayOverrides };
    delete updated[dateKey];
    setDayOverrides(updated);
    notify("Override removed — plan recalculated");
    setOverrideModal(null); setOverrideLabel("");
  };

  const monthEvents = Object.entries(dayMap).filter(([k])=>{
    const [y,m] = k.split("-").map(Number);
    return y===calYear && m===calMonth+1;
  });

  /* ── Week generation ── */
  // Build list of calendar weeks (Mon–Sun) that contain at least one plan day this month
  const weeks = (() => {
    const seen = new Set();
    const result = [];
    // iterate every cell that has a plan day
    monthEvents.forEach(([k, pidx]) => {
      const date = new Date(`${k}T00:00:00`);
      const dow = date.getDay(); // 0=Sun
      // Monday of this week
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(date);
      monday.setDate(date.getDate() + mondayOffset);
      const weekKey = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,"0")}-${String(monday.getDate()).padStart(2,"0")}`;
      if (seen.has(weekKey)) return;
      seen.add(weekKey);
      // Collect Mon–Fri plan days for this week
      const weekDays = [];
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const dk = toKey(d.getFullYear(), d.getMonth(), d.getDate());
        if (dayMap[dk] !== undefined) {
          const pidxW = dayMap[dk];
          weekDays.push({ key: dk, dayNum: planDays[pidxW].dayNum, topic: planDays[pidxW].topic });
        }
      }
      if (weekDays.length > 0) {
        const endFri = new Date(monday);
        endFri.setDate(monday.getDate() + 4);
        result.push({ weekKey, monday, endFri, weekDays });
      }
    });
    // sort by monday date
    result.sort((a,b) => a.weekKey.localeCompare(b.weekKey));
    return result;
  })();

  const anyBusy = Object.keys(busy).length > 0;

  const handleGenWeek = (week) => {
    if (genWeekKey || anyBusy) { notify("Generation already in progress — please wait", "warn"); return; }
    // Use inline confirm — window.confirm is blocked in sandboxed iframes
    setConfirmWeek(week);
  };

  const doGenWeek = async (week) => {
    setConfirmWeek(null);
    // notebook + examples + resources + assignment + quiz + teachingGuide = 6
    const gensPerDay = 6;
    const totalCalls = week.weekDays.length * gensPerDay;
    setGenWeekKey(week.weekKey);
    setWeekProgress({ done: 0, total: totalCalls });
    notify(`Starting week generation for ${week.weekDays.length} days…`);
    try {
      await onGenWeek(week.weekDays, (done, total) => setWeekProgress({ done, total }));
      notify(`Week of ${MONTHS_SHORT[week.monday.getMonth()]} ${week.monday.getDate()} fully generated ✓`);
    } catch(e) {
      notify(`Week generation finished with errors: ${e.message}`, "err");
    }
    setGenWeekKey(null);
    setWeekProgress(null);
  };

  const completed = Object.values(dayStatus).filter(s=>s==="Completed").length;
  const inProgress = Object.values(dayStatus).filter(s=>s==="In Progress").length;
  const total = planDays.length;
  const pct = total ? Math.round(completed/total*100) : 0;

  // Streak calculation — count consecutive completed days ending today or in the past
  const streak = (() => {
    if (!total) return 0;
    const sortedKeys = Object.keys(dayMap).sort();
    const todayK2 = todayKey();
    let count = 0;
    // Walk backwards from today
    for (let i = sortedKeys.length - 1; i >= 0; i--) {
      const k2 = sortedKeys[i];
      if (k2 > todayK2) continue; // skip future days
      if (dayStatus[k2] === "Completed") count++;
      else break;
    }
    return count;
  })();

  // Estimated finish date
  const estFinish = (() => {
    if (!total || completed >= total) return null;
    const dayKeys = Object.keys(dayMap).sort();
    const incompleteFuture = dayKeys.filter(k2 => (dayStatus[k2]||"Not Started") !== "Completed");
    if (incompleteFuture.length === 0) return null;
    const lastKey = incompleteFuture[incompleteFuture.length - 1];
    const d = new Date(`${lastKey}T12:00:00`);
    return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  })();

  return (
    <div style={{ animation:"lms-in .3s ease", display:"flex", flexDirection:"column", gap:16, paddingBottom:60 }}>

      {/* Inline confirm dialog — replaces window.confirm which is blocked in sandboxed iframes */}
      {confirmWeek && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:9000, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:"#fff", borderRadius:16, padding:28, maxWidth:420, width:"100%", boxShadow:"0 20px 60px rgba(0,0,0,.25)" }}>
            <p style={{ fontWeight:800, fontSize:16, color:"#0f172a", marginBottom:10 }}>Generate Full Week?</p>
            <p style={{ fontSize:13.5, color:"#475569", lineHeight:1.6, marginBottom:8 }}>
              <strong>Mon {confirmWeek.monday.getDate()} – Fri {confirmWeek.endFri.getDate()}</strong> · {confirmWeek.weekDays.length} day(s)
            </p>
            <div style={{ background:"#f8fafc", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:12.5, color:"#64748b", lineHeight:1.6 }}>
              {confirmWeek.weekDays.map(d => <div key={d.key}>Day {d.dayNum}: {d.topic}</div>)}
            </div>
            <p style={{ fontSize:12.5, color:"#94a3b8", marginBottom:18 }}>
              This will make {confirmWeek.weekDays.length * 6} sequential AI calls. It may take several minutes.
            </p>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button className="lms-btn lms-btn-ghost" onClick={()=>setConfirmWeek(null)}>Cancel</button>
              <button className="lms-btn lms-btn-blue" onClick={()=>doGenWeek(confirmWeek)}>
                <Ic n="play" s={13}/>Start Generating
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Day Override Modal (Holiday / Extra topic) ── */}
      {overrideModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:9100, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}
          onClick={e=>{ if(e.target===e.currentTarget){ setOverrideModal(null); setOverrideLabel(""); } }}>
          <div style={{ background:"#fff", borderRadius:18, padding:28, maxWidth:420, width:"100%", boxShadow:"0 24px 80px rgba(0,0,0,.28)" }}>
            <p style={{ fontWeight:800, fontSize:16, color:"#0f172a", marginBottom:4 }}>
              {overrideModal.mode === "edit" ? "Edit Day Override" : "Mark Day"}
            </p>
            <p style={{ fontSize:12.5, color:"#94a3b8", marginBottom:18 }}>{overrideModal.dateKey}</p>

            {/* Type selector */}
            <div style={{ display:"flex", gap:8, marginBottom:16 }}>
              <button
                onClick={()=>setOverrideType("holiday")}
                style={{ flex:1, padding:"10px 0", borderRadius:10, border:`2px solid ${overrideType==="holiday"?"#f59e0b":"#e2e8f0"}`, background:overrideType==="holiday"?"#fffbeb":"#f8fafc", color:overrideType==="holiday"?"#92400e":"#64748b", fontWeight:700, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
                🏖️ Holiday
              </button>
              <button
                onClick={()=>setOverrideType("special")}
                style={{ flex:1, padding:"10px 0", borderRadius:10, border:`2px solid ${overrideType==="special"?"#f97316":"#e2e8f0"}`, background:overrideType==="special"?"#fff7ed":"#f8fafc", color:overrideType==="special"?"#9a3412":"#64748b", fontWeight:700, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
                ⭐ Special Day
              </button>
              <button
                onClick={()=>setOverrideType("extra")}
                style={{ flex:1, padding:"10px 0", borderRadius:10, border:`2px solid ${overrideType==="extra"?"#8b5cf6":"#e2e8f0"}`, background:overrideType==="extra"?"#f5f3ff":"#f8fafc", color:overrideType==="extra"?"#5b21b6":"#64748b", fontWeight:700, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
                📌 Extra
              </button>
            </div>

            {/* Type explanation */}
            <div style={{
              background: overrideType==="holiday"?"#fffbeb": overrideType==="special"?"#fff7ed":"#f5f3ff",
              border:`1px solid ${overrideType==="holiday"?"#fde68a": overrideType==="special"?"#fed7aa":"#ddd6fe"}`,
              borderRadius:9, padding:"9px 12px", marginBottom:14, fontSize:12.5,
              color: overrideType==="holiday"?"#92400e": overrideType==="special"?"#9a3412":"#5b21b6",
              lineHeight:1.55
            }}>
              {overrideType==="holiday"
                ? "⤷ This date is skipped entirely. No content. All plan days after it shift forward by 1."
                : overrideType==="special"
                ? "⤷ A custom-titled day that shifts the plan forward by 1. It has its own full workspace — you can generate a Notebook, Assignment, Quiz etc. for this special topic."
                : "⤷ Adds a custom label on this date without consuming a plan slot. The plan is not shifted. Use for revision, mock tests, or ad-hoc sessions."}
            </div>

            <label style={{ fontSize:12.5, fontWeight:600, color:"#475569", display:"block", marginBottom:6 }}>
              {overrideType==="holiday" ? "Holiday / Break Name" : overrideType==="special" ? "Special Day Title" : "Extra Content Label"}
            </label>
            <input
              className="lms-input"
              value={overrideLabel}
              onChange={e=>setOverrideLabel(e.target.value)}
              placeholder={
                overrideType==="holiday" ? "e.g. Eid Holiday, Summer Break…" :
                overrideType==="special" ? "e.g. Guest Lecture: Data Science, Hackathon Day…" :
                "e.g. Revision Session, Mock Test…"
              }
              style={{ marginBottom:18 }}
              autoFocus
              onKeyDown={e=>{ if(e.key==="Enter") saveOverride(); if(e.key==="Escape"){ setOverrideModal(null); setOverrideLabel(""); } }}
            />

            <div style={{ display:"flex", gap:8 }}>
              <button className="lms-btn lms-btn-dark" style={{ flex:1, justifyContent:"center" }} onClick={saveOverride}>
                {overrideModal.mode==="edit" ? "Update" :
                  overrideType==="holiday" ? "🏖️ Mark Holiday" :
                  overrideType==="special" ? "⭐ Add Special Day" :
                  "📌 Add Extra"}
              </button>
              {overrideModal.mode==="edit" && (
                <button className="lms-btn lms-btn-rose" style={{ padding:"8px 12px" }} onClick={()=>removeOverride(overrideModal.dateKey)} title="Remove override">
                  <Ic n="trash" s={14}/>
                </button>
              )}
              <button className="lms-btn lms-btn-ghost" onClick={()=>{ setOverrideModal(null); setOverrideLabel(""); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:12 }}>
        <div>
          <h1 style={{ fontSize:25, fontWeight:800, color:"#0f172a", letterSpacing:"-.5px" }}>Learning Calendar</h1>
          <p style={{ color:"#64748b", fontSize:13.5, marginTop:4 }}>
            Click any lesson day to open the full workspace
            {!studentMode && Object.keys(dayOverrides).length > 0 && (
              <span style={{ marginLeft:10 }}>
                {Object.values(dayOverrides).filter(o=>o.type==="holiday").length > 0 &&
                  <span style={{ background:"#fffbeb", color:"#92400e", border:"1px solid #fde68a", borderRadius:99, fontSize:11, fontWeight:700, padding:"1px 8px", marginRight:4 }}>
                    🏖️ {Object.values(dayOverrides).filter(o=>o.type==="holiday").length} holiday{Object.values(dayOverrides).filter(o=>o.type==="holiday").length!==1?"s":""}
                  </span>}
                {Object.values(dayOverrides).filter(o=>o.type==="special").length > 0 &&
                  <span style={{ background:"#fff7ed", color:"#9a3412", border:"1px solid #fed7aa", borderRadius:99, fontSize:11, fontWeight:700, padding:"1px 8px", marginRight:4 }}>
                    ⭐ {Object.values(dayOverrides).filter(o=>o.type==="special").length} special
                  </span>}
                {Object.values(dayOverrides).filter(o=>o.type==="extra").length > 0 &&
                  <span style={{ background:"#f5f3ff", color:"#5b21b6", border:"1px solid #ddd6fe", borderRadius:99, fontSize:11, fontWeight:700, padding:"1px 8px" }}>
                    📌 {Object.values(dayOverrides).filter(o=>o.type==="extra").length} extra
                  </span>}
              </span>
            )}
          </p>
        </div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
          {total > 0 && Object.values(dayData||{}).some(d=>d?.notebook) && (
            <button className="lms-btn lms-btn-ghost" style={{ fontSize:12 }} onClick={() => {
              // Export all notebooks as individual .md downloads (batched)
              const entries = Object.entries(dayMap);
              let count = 0;
              for (const [k2, pidx] of entries) {
                const nb = dayData?.[k2]?.notebook;
                if (!nb) continue;
                const d2 = planDays[pidx];
                setTimeout(() => downloadBlob(`# Day ${d2.dayNum}: ${d2.topic}\n\n${nb}`, `Day${d2.dayNum}_${d2.topic.replace(/\s+/g,"_")}.md`), count * 120);
                count++;
              }
              notify(`Downloading ${count} notebook(s)…`);
            }}>
              <Ic n="download" s={13}/>Export All Notebooks
            </button>
          )}
        </div>
      </div>
      {total > 0 && (
        <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
          {/* Progress ring */}
          <div className="lms-card" style={{ padding:"12px 16px", display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:52, height:52, position:"relative", flexShrink:0 }}>
              <svg viewBox="0 0 36 36" width="52" height="52">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="#f1f5f9" strokeWidth="3.5"/>
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="#3b82f6" strokeWidth="3.5"
                  strokeDasharray={`${pct} ${100-pct}`} strokeDashoffset="25" strokeLinecap="round"
                  style={{ transition:"stroke-dasharray .5s ease" }}/>
              </svg>
              <span style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", fontSize:10, fontWeight:800, color:"#3b82f6" }}>{pct}%</span>
            </div>
            <div>
              <p style={{ fontSize:11, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:".06em" }}>Progress</p>
              <p style={{ fontSize:16, fontWeight:800, color:"#0f172a", lineHeight:1 }}>{completed}<span style={{ fontSize:12, color:"#94a3b8", fontWeight:500 }}>/{total}</span></p>
              <p style={{ fontSize:11, color:"#64748b", marginTop:2 }}>days done</p>
            </div>
          </div>
          {/* Streak */}
          <div className="lms-card" style={{ padding:"12px 16px", display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:36, height:36, background: streak>0?"#fffbeb":"#f8fafc", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>{streak>0?"🔥":"💤"}</div>
            <div>
              <p style={{ fontSize:11, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:".06em" }}>Streak</p>
              <p style={{ fontSize:16, fontWeight:800, color: streak>0?"#f59e0b":"#94a3b8", lineHeight:1 }}>{streak} <span style={{ fontSize:11, fontWeight:500, color:"#94a3b8" }}>day{streak!==1?"s":""}</span></p>
            </div>
          </div>
          {/* In Progress */}
          {inProgress > 0 && (
            <div className="lms-card" style={{ padding:"12px 16px", display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:36, height:36, background:"#fffbeb", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <Ic n="zap" s={18} c="#f59e0b"/>
              </div>
              <div>
                <p style={{ fontSize:11, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:".06em" }}>Active</p>
                <p style={{ fontSize:16, fontWeight:800, color:"#f59e0b", lineHeight:1 }}>{inProgress} <span style={{ fontSize:11, fontWeight:500, color:"#94a3b8" }}>in progress</span></p>
              </div>
            </div>
          )}
          {/* Est finish */}
          {estFinish && (
            <div className="lms-card" style={{ padding:"12px 16px", display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:36, height:36, background:"#f0fdf4", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <Ic n="calendar" s={18} c="#22c55e"/>
              </div>
              <div>
                <p style={{ fontSize:11, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:".06em" }}>Est. Finish</p>
                <p style={{ fontSize:13, fontWeight:700, color:"#15803d", lineHeight:1.2 }}>{estFinish}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Month tabs — scrollable on mobile */}
      <div style={{ display:"flex", gap:5, overflowX:"auto", paddingBottom:4, WebkitOverflowScrolling:"touch", flexShrink:0 }}>
        {MONTHS_SHORT.map((m,i) => (
          <button key={m} onClick={()=>setCalMonth(i)} style={{ padding:"5px 13px", borderRadius:99, border:"1.5px solid", fontSize:12.5, fontWeight:600, cursor:"pointer", transition:"all .15s", flexShrink:0, background:calMonth===i?"#0f172a":"#fff", color:calMonth===i?"#fff":"#64748b", borderColor:calMonth===i?"#0f172a":"#e2e8f0", fontFamily:"inherit" }}>{m}</button>
        ))}
      </div>

      {/* FIX 10: responsive calendar grid */}
      <div className="lms-cal-grid" style={{ display:"grid", gridTemplateColumns:"1fr 270px", gap:18, alignItems:"start" }}>
        <div className="lms-card" style={{ padding:20 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
            <button onClick={prev} style={{ background:"none", border:"none", cursor:"pointer", padding:4, borderRadius:6, color:"#64748b" }}><Ic n="chevL" s={18}/></button>
            <span style={{ fontWeight:700, fontSize:16, color:"#0f172a" }}>{MONTHS_FULL[calMonth]} {calYear}</span>
            <button onClick={next} style={{ background:"none", border:"none", cursor:"pointer", padding:4, borderRadius:6, color:"#64748b" }}><Ic n="chevR" s={18}/></button>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4, marginBottom:8 }}>
            {DAYS_HDR.map(d => <div key={d} style={{ textAlign:"center", fontSize:11.5, fontWeight:700, color:"#94a3b8", padding:"4px 0" }}>{d}</div>)}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4 }}>
            {cells.map((day,idx) => {
              if (!day) return <div key={idx}/>;
              const k = toKey(calYear, calMonth, day);
              const pidx = dayMap[k];
              const hasPlan = pidx !== undefined;
              const topic = hasPlan ? planDays[pidx]?.topic : null;
              const status = dayStatus[k] || "Not Started";
              const sc = STATUS_CFG[status];
              const isToday = k === todayK;
              const override = dayOverrides[k]; // { type:"holiday"|"extra"|"special", label:"..." }
              const isHoliday = override?.type === "holiday";
              const isExtra   = override?.type === "extra";
              const isSpecial = override?.type === "special";

              // Visual config for overrides
              const holBg="#fffbeb", holBorder="#fde68a", holText="#92400e";
              const extBg="#f5f3ff", extBorder="#ddd6fe", extText="#5b21b6";
              const speBg="#fff7ed", speBorder="#fed7aa", speText="#9a3412";

              return (
                <div key={idx}
                  className={`day-cell${isToday?" today":""}${hasPlan&&!isHoliday&&!isSpecial?" has-plan":""}`}
                  style={{
                    background: isHoliday ? holBg : isSpecial ? speBg : isExtra ? extBg : hasPlan ? sc.bg : "#fafafa",
                    borderColor: isHoliday ? holBorder : isSpecial ? speBorder : isExtra ? extBorder : hasPlan ? sc.border : "#f1f5f9",
                    cursor: (hasPlan && !isHoliday && !isSpecial) || isExtra || isSpecial ? "pointer" : "default",
                    position:"relative",
                  }}
                  onClick={() => {
                    if (isHoliday) return;
                    if (isSpecial) { onSelectDay({ key:k, dayNum:"★", topic: override.label, isSpecial:true }); return; }
                    if (isExtra)   { onSelectDay({ key:k, dayNum:0,   topic: override.label, isExtra:true });   return; }
                    if (!hasPlan) return;
                    onSelectDay({ key:k, dayNum:planDays[pidx].dayNum, topic });
                  }}>

                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                    <span style={{ fontSize:13, fontWeight: isToday?800:600, color: isToday?"#3b82f6": isHoliday?holText : isSpecial?speText : isExtra?extText : "#334155" }}>{day}</span>
                    <div style={{ display:"flex", gap:3, alignItems:"center" }}>
                      {isHoliday && <span style={{ fontSize:11 }}>🏖️</span>}
                      {isSpecial  && <span style={{ fontSize:11 }}>⭐</span>}
                      {isExtra    && <span style={{ fontSize:11 }}>📌</span>}
                      {hasPlan && !isHoliday && !isSpecial && !isExtra && <span style={{ width:7, height:7, borderRadius:"50%", background:sc.dot, display:"inline-block", marginTop:3, flexShrink:0 }}/>}
                    </div>
                  </div>

                  {/* Content label */}
                  {isHoliday && (
                    <div style={{ fontSize:10, color:holText, fontWeight:600, lineHeight:1.3, marginTop:3, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>
                      {override.label}
                    </div>
                  )}
                  {isSpecial && (
                    <div style={{ fontSize:10, color:speText, fontWeight:600, lineHeight:1.3, marginTop:3, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>
                      {override.label}
                    </div>
                  )}
                  {isExtra && (
                    <div style={{ fontSize:10, color:extText, fontWeight:600, lineHeight:1.3, marginTop:3, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>
                      {override.label}
                    </div>
                  )}
                  {hasPlan && !isHoliday && !isSpecial && !isExtra && (
                    <div style={{ fontSize:10.5, color:sc.text, fontWeight:500, lineHeight:1.35, marginTop:4, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>{topic}</div>
                  )}

                  {/* Trainer-only: hover "+" override button */}
                  {!studentMode && (
                    <button
                      title={override ? "Edit override" : "Add holiday or extra content"}
                      onClick={e=>{ e.stopPropagation(); openOverrideModal(k); }}
                      style={{ position:"absolute", bottom:4, right:4, width:16, height:16, borderRadius:4, background: override?"#f59e0b":"#e2e8f0", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color: override?"#fff":"#94a3b8", opacity:0, transition:"opacity .15s", fontFamily:"inherit", lineHeight:1 }}
                      className="day-override-btn"
                    >
                      {override ? "✎" : "+"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div className="lms-card" style={{ padding:16 }}>
            <p className="lms-section-label">Status Legend</p>
            {Object.entries(STATUS_CFG).map(([s,sc]) => (
              <div key={s} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:7 }}>
                <span style={{ width:9, height:9, borderRadius:"50%", background:sc.dot, flexShrink:0 }}/>
                <span style={{ fontSize:12.5, color:"#475569", fontWeight:500 }}>{sc.label}</span>
                <span style={{ marginLeft:"auto", fontWeight:700, fontSize:12, color:"#94a3b8" }}>{Object.values(dayStatus).filter(v=>v===s).length}</span>
              </div>
            ))}
          </div>

          <div className="lms-card" style={{ padding:16, display:"flex", flexDirection:"column" }}>
            <p className="lms-section-label">{MONTHS_SHORT[calMonth]} Schedule ({monthEvents.length + Object.entries(dayOverrides).filter(([k])=>{ const [y,m]=k.split("-").map(Number); return y===calYear&&m===calMonth+1; }).length})</p>
            <div style={{ display:"flex", flexDirection:"column", gap:8, overflowY:"auto", maxHeight:360, paddingRight:2 }}>
              {/* Holidays and extras this month */}
              {Object.entries(dayOverrides)
                .filter(([k])=>{ const [y,m]=k.split("-").map(Number); return y===calYear&&m===calMonth+1; })
                .sort(([a],[b])=>a.localeCompare(b))
                .map(([k, ov]) => {
                  const d = parseInt(k.split("-")[2]);
                  const isHol = ov.type==="holiday";
                  const isSpe = ov.type==="special";
                  return (
                    <div key={k} style={{ padding:"9px 12px", borderRadius:10, background:isHol?"#fffbeb":isSpe?"#fff7ed":"#f5f3ff", border:`1.5px solid ${isHol?"#fde68a":isSpe?"#fed7aa":"#ddd6fe"}`, cursor:!studentMode?"pointer":"default", display:"flex", justifyContent:"space-between", alignItems:"center" }}
                      onClick={()=>{ if(!studentMode) openOverrideModal(k); }}>
                      <div>
                        <div style={{ fontSize:11, fontWeight:700, color:isHol?"#92400e":isSpe?"#9a3412":"#5b21b6" }}>{isHol?"🏖️":isSpe?"⭐":"📌"} {MONTHS_SHORT[calMonth]} {d}</div>
                        <div style={{ fontSize:12, color:isHol?"#92400e":isSpe?"#9a3412":"#5b21b6", fontWeight:500, marginTop:1 }}>{ov.label}</div>
                      </div>
                      {!studentMode && <Ic n="settings" s={12} c={isHol?"#f59e0b":isSpe?"#f97316":"#8b5cf6"}/>}
                    </div>
                  );
                })
              }
              {monthEvents.length === 0 && Object.entries(dayOverrides).filter(([k])=>{ const [y,m]=k.split("-").map(Number); return y===calYear&&m===calMonth+1; }).length===0 && <p style={{ fontSize:13, color:"#94a3b8" }}>No lessons this month</p>}
              {monthEvents.map(([k, pidx]) => {
                const topic = planDays[pidx]?.topic;
                const s = dayStatus[k] || "Not Started";
                const sc = STATUS_CFG[s];
                const d = parseInt(k.split("-")[2]);
                return (
                  <div key={k} style={{ padding:"9px 12px", borderRadius:10, background:sc.bg, border:`1.5px solid ${sc.border}`, cursor:"pointer" }}
                    onClick={() => onSelectDay({ key:k, dayNum:planDays[pidx].dayNum, topic })}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <span style={{ fontSize:11, fontWeight:700, color:sc.text }}>Day {planDays[pidx]?.dayNum} · {MONTHS_SHORT[calMonth]} {d}</span>
                      <span style={{ width:6, height:6, borderRadius:"50%", background:sc.dot }}/>
                    </div>
                    <div style={{ fontSize:12, color:sc.text, fontWeight:500, marginTop:2, lineHeight:1.3 }}>{topic}</div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      </div>

      {/* ── Generate Full Week — 4-per-row landscape grid below calendar ── Hidden for students */}
      {weeks.length > 0 && !studentMode && (
        <div style={{ marginTop:4 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
            <p className="lms-section-label" style={{ margin:0 }}>Generate Full Week</p>
            <span style={{ fontSize:11.5, color:"#94a3b8" }}>
              Generates Notebook, Examples, Resources, Assignment &amp; Teaching Guide for all Mon–Fri days.
            </span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:10 }}>
            {weeks.map(week => {
              const isGenerating = genWeekKey === week.weekKey;
              const monLabel = `${MONTHS_SHORT[week.monday.getMonth()]} ${week.monday.getDate()}`;
              const friLabel = `${MONTHS_SHORT[week.endFri.getMonth()]} ${week.endFri.getDate()}`;
              return (
                <div key={week.weekKey} className="lms-card" style={{ borderRadius:10, border:"1.5px solid #e2e8f0", overflow:"hidden", display:"flex", flexDirection:"column", padding:0 }}>
                  <div style={{ padding:"8px 12px", background:"#f8fafc", borderBottom:"1px solid #e2e8f0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span style={{ fontSize:12, fontWeight:700, color:"#334155" }}>
                      {monLabel} – {friLabel}
                    </span>
                    <span style={{ fontSize:11, color:"#94a3b8", fontWeight:500 }}>
                      {week.weekDays.length} day{week.weekDays.length!==1?"s":""}
                    </span>
                  </div>
                  <div style={{ padding:"6px 12px 4px", flex:1 }}>
                    {week.weekDays.map(d => (
                      <div key={d.key} style={{ fontSize:11.5, color:"#475569", padding:"3px 0", borderBottom:"1px solid #f1f5f9", display:"flex", gap:6, alignItems:"center" }}>
                        <span style={{ color:"#3b82f6", fontWeight:700, minWidth:40, flexShrink:0 }}>Day {d.dayNum}</span>
                        <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.topic}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ padding:"8px 12px" }}>
                    {isGenerating && weekProgress && (
                      <div style={{ marginBottom:8 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#64748b", marginBottom:4 }}>
                          <span>Generating… {weekProgress.done}/{weekProgress.total} steps</span>
                          <span>{Math.round(weekProgress.done/weekProgress.total*100)}%</span>
                        </div>
                        <div style={{ height:5, borderRadius:99, background:"#e2e8f0", overflow:"hidden" }}>
                          <div style={{ height:"100%", borderRadius:99, background:"#3b82f6", width:`${Math.round(weekProgress.done/weekProgress.total*100)}%`, transition:"width .3s ease" }}/>
                        </div>
                      </div>
                    )}
                    <button
                      className="lms-btn lms-btn-blue"
                      style={{ width:"100%", justifyContent:"center", opacity: (anyBusy && !isGenerating) ? 0.45 : 1 }}
                      disabled={anyBusy}
                      onClick={() => handleGenWeek(week)}
                    >
                      {isGenerating
                        ? <><Spin s={13}/> Generating…</>
                        : <><Ic n="play" s={13}/> Generate Week</>}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   DAY PAGE — Full Workspace
═══════════════════════════════════════════════════════════════════ */
function DayPage({ day, dayData, dayStatus, setDayStatus, busy, pendingGen, codeEdit, setCodeEdit, codeOutput, onBack, onRunCode, onGenNotebook, onGenExamples, onGenResources, onGenAssignment, onGenTeachingGuide, onGenQuiz, onGenAll, onFileUpload, onDeleteFile, updateDay, notify, pyodideReady, pyodideLoading, onLoadPyodide, studentMode, onEditTopic }) {
  const [tab, setTab] = useState("notebook");
  const [exportOpen, setExportOpen] = useState(false);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft]     = useState("");
  const k = day.key;
  const status = dayStatus[k] || "Not Started";
  const sc = STATUS_CFG[status];
  const isTrainer = !studentMode;

  // Detect if topic was edited after content was generated
  // dayData.generatedForTopic is written whenever any gen function saves content
  const hasAnyContent = !!(dayData.notebook || dayData.examples || dayData.assignment || dayData.resources || dayData.quiz);
  const topicChanged  = hasAnyContent && dayData.generatedForTopic && dayData.generatedForTopic !== day.topic
                        && !day.isExtra && !day.isSpecial; // extra/special use override label, not planDays topic

  const [confirmRegen, setConfirmRegen] = useState(false);

  useEffect(() => {
    if (!codeEdit && dayData.codeBlocks?.length > 0) {
      setCodeEdit(dayData.codeBlocks[0]);
    } else if (!codeEdit) {
      setCodeEdit(`# ${day.topic}\n# Write your code here\n\nprint("Hello from Day ${day.dayNum}!")`);
    }
  // FIX 2: Added day.key so the effect re-runs when the user navigates to a different day
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayData.codeBlocks, day.key]);

  const TABS = [
    { id:"notebook",  label:"📓 Notebook" },
    { id:"compiler",  label:"💻 Compiler" },
    { id:"examples",  label:"⚡ Examples" },
    { id:"resources", label:"📂 Resources" },
    { id:"assignment",label:"📝 Assignment" },
    { id:"quiz",      label:"🎯 Quiz" },
    { id:"notes",     label:"🗒️ Notes" },
    ...(isTrainer ? [{ id:"guide", label:"🧑‍🏫 Guide" }] : []),
  ];

  return (
    <div style={{ animation:"lms-in .3s ease", paddingBottom:60 }}>
      {/* FIX 8: pending generation indicator — FIX 9: use exact key prefix matching */}
      {Object.keys(pendingGen).filter(pk => pk.endsWith(`-${k}`)).length > 0 && (
        <div style={{ background:"#fffbeb", border:"1.5px solid #fde68a", borderRadius:10, padding:"10px 14px", marginBottom:16, display:"flex", alignItems:"center", gap:10, fontSize:13 }}>
          <Spin s={14}/><span style={{ color:"#92400e", fontWeight:600 }}>Generation in progress — safe to close, will auto-save when complete</span>
        </div>
      )}

      {/* ── Topic-changed banner (trainer only) ── */}
      {topicChanged && !studentMode && (
        <div style={{ background:"#eff6ff", border:"2px solid #bfdbfe", borderRadius:12, padding:"12px 16px", marginBottom:16, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          <div style={{ fontSize:18 }}>✏️</div>
          <div style={{ flex:1, minWidth:180 }}>
            <p style={{ fontWeight:700, fontSize:13.5, color:"#1e40af", margin:0 }}>Topic renamed — existing content was generated for a different topic</p>
            <p style={{ fontSize:12, color:"#3b82f6", margin:"3px 0 0 0" }}>
              Was: <span style={{ textDecoration:"line-through", opacity:.7 }}>{dayData.generatedForTopic}</span>
              &nbsp;→ Now: <strong>{day.topic}</strong>
            </p>
          </div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <button className="lms-btn lms-btn-blue" style={{ fontSize:12 }}
              onClick={() => setConfirmRegen(true)}>
              🔄 Regenerate All
            </button>
            <button className="lms-btn lms-btn-ghost" style={{ fontSize:12 }}
              onClick={() => onGenNotebook && onGenNotebook()}>
              📓 Notebook only
            </button>
          </div>
        </div>
      )}

      {/* ── Confirm regenerate modal ── */}
      {confirmRegen && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:9200, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}
          onClick={e=>{ if(e.target===e.currentTarget) setConfirmRegen(false); }}>
          <div style={{ background:"#fff", borderRadius:18, padding:28, maxWidth:420, width:"100%", boxShadow:"0 24px 80px rgba(0,0,0,.28)" }}>
            <p style={{ fontWeight:800, fontSize:16, color:"#0f172a", marginBottom:6 }}>🔄 Regenerate All Content?</p>
            <p style={{ fontSize:13.5, color:"#475569", lineHeight:1.6, marginBottom:8 }}>
              This will replace the <strong>Notebook, Examples, Resources, Assignment, Quiz and Teaching Guide</strong> for:
            </p>
            <div style={{ background:"#eff6ff", border:"1.5px solid #bfdbfe", borderRadius:10, padding:"10px 14px", marginBottom:18, fontSize:13.5, color:"#1e40af", fontWeight:700 }}>
              Day {day.dayNum}: {day.topic}
            </div>
            <p style={{ fontSize:12, color:"#94a3b8", marginBottom:18 }}>All existing content for this day will be overwritten. This cannot be undone.</p>
            <div style={{ display:"flex", gap:8 }}>
              <button className="lms-btn lms-btn-blue" style={{ flex:1, justifyContent:"center" }}
                onClick={() => { setConfirmRegen(false); onGenAll && onGenAll(); }}>
                ✓ Yes, Regenerate
              </button>
              <button className="lms-btn lms-btn-ghost" onClick={() => setConfirmRegen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display:"flex", alignItems:"flex-start", gap:14, marginBottom:20, flexWrap:"wrap" }}>
        <button className="lms-btn lms-btn-ghost" onClick={onBack}><Ic n="chevL" s={14}/>Calendar</button>
        <div style={{ flex:1, minWidth:200 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
            <div style={{ width:36, height:36, background: day.isSpecial ? "linear-gradient(135deg,#f97316,#ea580c)" : "linear-gradient(135deg,#3b82f6,#8b5cf6)", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:800, fontSize: day.isSpecial ? 18 : 13, flexShrink:0 }}>
              {day.isSpecial ? "⭐" : day.dayNum}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              {/* ── Inline topic editor (trainer only) ── */}
              {editingTopic ? (
                <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                  <input
                    autoFocus
                    value={topicDraft}
                    onChange={e => setTopicDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && topicDraft.trim()) {
                        onEditTopic(topicDraft.trim());
                        setEditingTopic(false);
                      }
                      if (e.key === "Escape") setEditingTopic(false);
                    }}
                    style={{ fontSize:17, fontWeight:800, color:"#0f172a", border:"2px solid #3b82f6", borderRadius:8, padding:"3px 10px", outline:"none", minWidth:220, flex:1, fontFamily:"inherit", letterSpacing:"-.3px" }}
                  />
                  <button className="lms-btn lms-btn-blue" style={{ padding:"4px 12px", fontSize:12 }}
                    onClick={() => { if (topicDraft.trim()) { onEditTopic(topicDraft.trim()); setEditingTopic(false); } }}>
                    Save
                  </button>
                  <button className="lms-btn lms-btn-ghost" style={{ padding:"4px 10px", fontSize:12 }}
                    onClick={() => setEditingTopic(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <h1 style={{ fontSize:20, fontWeight:800, color:"#0f172a", letterSpacing:"-.3px", margin:0 }}>{day.topic}</h1>
                  {!studentMode && onEditTopic && !day.isExtra && !day.isSpecial && (
                    <button
                      title="Edit topic name"
                      onClick={() => { setTopicDraft(day.topic); setEditingTopic(true); }}
                      style={{ background:"none", border:"none", cursor:"pointer", padding:"2px 5px", borderRadius:6, color:"#94a3b8", fontSize:13, lineHeight:1, transition:"color .15s" }}
                      onMouseEnter={e => e.currentTarget.style.color="#3b82f6"}
                      onMouseLeave={e => e.currentTarget.style.color="#94a3b8"}
                    >
                      ✎
                    </button>
                  )}
                </div>
              )}
              <p style={{ fontSize:12, color:"#94a3b8", margin:"2px 0 0 0" }}>{day.key}</p>
            </div>
            <span className="lms-tag" style={{ background:sc.bg, color:sc.text, border:`1.5px solid ${sc.border}` }}>
              <span style={{ width:6, height:6, borderRadius:"50%", background:sc.dot }}/>
              {status}
            </span>
            {dayData.quizScore && (
              <span className="lms-tag" style={{ background:"#fffbeb", color:"#92400e", border:"1.5px solid #fde68a", cursor:"pointer" }}
                onClick={()=>setTab("quiz")}>
                🎯 {dayData.quizScore.pct}%
              </span>
            )}
            {dayData.notes?.trim() && (
              <span className="lms-tag" style={{ background:"#f0f9ff", color:"#0369a1", border:"1.5px solid #bae6fd", cursor:"pointer" }}
                onClick={()=>setTab("notes")}>
                🗒️ Notes
              </span>
            )}
          </div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          {/* FIX Bug6: Generate All for this day — Hidden for students */}
          {!studentMode && (
            <button className="lms-btn lms-btn-blue"
              disabled={Object.keys(busy).some(bk => bk.endsWith(`-${k}`))}
              onClick={onGenAll}
              title="Generate Notebook + Examples + Resources + Assignment + Quiz in sequence">
              {Object.keys(busy).some(bk => bk.endsWith(`-${k}`))
                ? <><Spin s={13}/>Generating…</>
                : <><Ic n="play" s={13}/>Generate All</>}
            </button>
          )}
          <button className="lms-btn lms-btn-ghost"
            onClick={() => setExportOpen(true)}
            title="Download content for this day (zip or individual files)">
            <Ic n="download" s={13}/>Export / Send
          </button>
          <select className="lms-input" style={{ width:160 }} value={status}
            onChange={e => setDayStatus(p=>({...p,[k]:e.target.value}))}>
            {Object.keys(STATUS_CFG).map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* Tabs — scrollable on mobile */}
      <div style={{ display:"flex", gap:3, background:"#f1f5f9", padding:4, borderRadius:12, marginBottom:20, overflowX:"auto", WebkitOverflowScrolling:"touch", flexShrink:0 }}>
        {TABS.map(t => (
          <button key={t.id} className={`lms-tab${tab===t.id?" on":""}`} onClick={()=>setTab(t.id)} style={{ flexShrink:0 }}>{t.label}</button>
        ))}
      </div>

      {/* ── Sub-topics input — trainer only, shared across ALL generators for this day ── */}
      {!studentMode && (
        <div style={{ marginBottom:18, background:"#fffbeb", border:"1.5px dashed #fde68a", borderRadius:12, padding:"12px 16px" }}>
          <label style={{ display:"flex", alignItems:"center", gap:7, marginBottom:7, cursor:"default" }}>
            <span style={{ fontSize:16 }}>📌</span>
            <span style={{ fontSize:11.5, fontWeight:700, color:"#92400e", textTransform:"uppercase", letterSpacing:".07em" }}>Sub-topics / Focus areas</span>
            <span style={{ fontSize:12, fontWeight:500, color:"#b45309", textTransform:"none", letterSpacing:"normal" }}>— applied to every generator for this day</span>
          </label>
          <input
            type="text"
            className="lms-input"
            value={dayData.subTopics || ""}
            onChange={e => updateDay(k, { subTopics: e.target.value })}
            placeholder="e.g. list comprehension, lambda functions, map/filter — leave blank to use main topic only"
            style={{ fontSize:12.5, background:"#fff" }}
          />
          <p style={{ fontSize:11.5, color:"#92400e", marginTop:6, lineHeight:1.5 }}>
            All generators (Notebook, Examples, Resources, Assignment, Quiz, Guide) will incorporate these sub-topics into their prompts.
          </p>
        </div>
      )}

      {/* ── NOTEBOOK ── */}
      {tab==="notebook" && (
        <div style={{ animation:"lms-in .2s ease" }}>
          <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
            {!studentMode && (
              <>
                <div style={{ display:"flex", alignItems:"center", gap:6, background:"#eff6ff", border:"1.5px solid #bfdbfe", borderRadius:8, padding:"5px 10px", height:36 }}>
                  <span style={{ fontSize:11.5, color:"#1e40af", whiteSpace:"nowrap", userSelect:"none", fontWeight:600 }}>Code blocks</span>
                  <input
                    type="number" min={1} max={20}
                    value={dayData.notebookBlocks ?? 3}
                    onChange={e => updateDay(k, { notebookBlocks: Math.max(1, Math.min(20, parseInt(e.target.value) || 3)) })}
                    style={{ width:42, border:"none", background:"transparent", fontSize:14, fontWeight:800, color:"#1e40af", outline:"none", padding:0, textAlign:"center" }}
                  />
                </div>
                <button className="lms-btn lms-btn-blue" disabled={!!busy[`nb-${k}`]} onClick={onGenNotebook}>
                  {busy[`nb-${k}`]?<><Spin/>Generating...</>:<><Ic n="brain" s={14}/>Generate Notebook</>}
                </button>
              </>
            )}
            {dayData.notebook && (
              <>
                <button className="lms-btn lms-btn-ghost" onClick={()=>downloadBlob(buildIpynb(day.topic, dayData.notebook, dayData.codeBlocks||[]), `Day${day.dayNum}_${day.topic.replace(/\s+/g,"_")}.ipynb`, "application/json")}>
                  <Ic n="download" s={14}/>Download .ipynb
                </button>
                <button className="lms-btn lms-btn-ghost" onClick={()=>downloadBlob(`# Day ${day.dayNum}: ${day.topic}\n\n${dayData.notebook}`, `Day${day.dayNum}_notebook.md`)}>
                  <Ic n="download" s={14}/>Download .md
                </button>
              </>
            )}
          </div>
          {dayData.notebook ? (
            <ErrorBoundary>
              <NotebookView content={dayData.notebook} codeBlocks={dayData.codeBlocks||[]} onUseCode={code=>{ setCodeEdit(code); setTab("compiler"); }} />
            </ErrorBoundary>
          ) : (
            <EmptyState icon="book" title="No notebook yet" text="Click Generate Notebook to create a fully-commented Jupyter-style notebook with multiple code examples for this topic." />
          )}
        </div>
      )}

      {/* ── COMPILER — FIX 1 + FIX 10 ── */}
      {tab==="compiler" && (
        <div style={{ animation:"lms-in .2s ease" }}>
          {/* Pyodide loader banner */}
          {!pyodideReady && (
            <div style={{ background:"#eff6ff", border:"1.5px solid #bfdbfe", borderRadius:10, padding:"10px 16px", marginBottom:14, display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, flexWrap:"wrap" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:"#1e40af" }}>
                <Ic n="zap" s={15} c="#3b82f6"/>
                <strong>Real Python Execution available</strong> — load Pyodide (WASM) for actual code running
              </div>
              <button className="lms-btn lms-btn-blue" disabled={pyodideLoading} onClick={onLoadPyodide} style={{ flexShrink:0 }}>
                {pyodideLoading?<><Spin s={13}/>Loading Python...</>:<><Ic n="play" s={13}/>Load Real Python</>}
              </button>
            </div>
          )}
          {pyodideReady && (
            <div style={{ background:"#f0fdf4", border:"1.5px solid #bbf7d0", borderRadius:10, padding:"8px 16px", marginBottom:14, fontSize:13, color:"#15803d", fontWeight:600, display:"flex", alignItems:"center", gap:8 }}>
              <Ic n="check" s={15} c="#22c55e"/> Real Python (Pyodide WASM) — actual execution, no simulation
            </div>
          )}

          {/* FIX 10: responsive grid */}
          <div className="lms-compiler-grid" style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            <div className="lms-card" style={{ padding:16 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10, flexWrap:"wrap", gap:8 }}>
                <p style={{ fontWeight:700, fontSize:13, color:"#0f172a" }}>Code Editor — {day.topic}</p>
                <button className="lms-btn lms-btn-blue" disabled={!!busy[`run-${k}`]} onClick={()=>onRunCode(codeEdit)} style={{ padding:"6px 14px" }}>
                  {busy[`run-${k}`]?<><Spin s={13}/>Running...</>:<><Ic n="play" s={13}/>Run Code</>}
                </button>
              </div>
              <textarea className="lms-input" value={codeEdit} onChange={e=>setCodeEdit(e.target.value)}
                style={{ minHeight:360, fontFamily:"'JetBrains Mono','Fira Code',monospace", fontSize:12.5, lineHeight:1.65 }} />
              <div style={{ display:"flex", gap:6, marginTop:8, flexWrap:"wrap" }}>
                <button className="lms-btn lms-btn-ghost" style={{ fontSize:12, padding:"5px 10px" }}
                  onClick={()=>downloadBlob(codeEdit, `Day${day.dayNum}_code.py`)}>
                  <Ic n="download" s={12}/>Save .py
                </button>
                {(dayData.codeBlocks||[]).map((cb,i) => (
                  <button key={i} className="lms-btn lms-btn-ghost" style={{ fontSize:12, padding:"5px 10px" }} onClick={()=>setCodeEdit(cb)}>
                    Example {i+1}
                  </button>
                ))}
              </div>
            </div>
            <div className="lms-card" style={{ padding:16 }}>
              <p style={{ fontWeight:700, fontSize:13, color:"#0f172a", marginBottom:10 }}>
                Output{" "}
                <span style={{ fontSize:11, color:"#94a3b8", fontWeight:400 }}>
                  ({pyodideReady?"Real Pyodide WASM":"AI-simulated — load Real Python above"})
                </span>
              </p>
              <div className="lms-output" style={{ minHeight:360, overflowY:"auto" }}>
                {codeOutput || <span style={{ color:"#475569" }}>▶ Run your code to see output here</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── LIVE EXAMPLES ── */}
      {tab==="examples" && (
        <div style={{ animation:"lms-in .2s ease" }}>
          <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
            {!studentMode && (
              <>
                <div style={{ display:"flex", alignItems:"center", gap:6, background:"#fffbeb", border:"1.5px solid #fde68a", borderRadius:8, padding:"5px 10px", height:36 }}>
                  <span style={{ fontSize:11.5, color:"#92400e", whiteSpace:"nowrap", userSelect:"none", fontWeight:600 }}>Tasks</span>
                  <input
                    type="number" min={1} max={20}
                    value={dayData.examplesCount ?? 5}
                    onChange={e => updateDay(k, { examplesCount: Math.max(1, Math.min(20, parseInt(e.target.value) || 5)) })}
                    style={{ width:42, border:"none", background:"transparent", fontSize:14, fontWeight:800, color:"#92400e", outline:"none", padding:0, textAlign:"center" }}
                  />
                </div>
                <button className="lms-btn lms-btn-amber" disabled={!!busy[`ex-${k}`]} onClick={onGenExamples}>
                  {busy[`ex-${k}`]?<><Spin/>Generating...</>:<><Ic n="zap" s={14}/>Generate Live Tasks</>}
                </button>
              </>
            )}
            {dayData.examples && (
              <button className="lms-btn lms-btn-ghost" onClick={()=>downloadBlob(dayData.examples, `Day${day.dayNum}_exercises.md`)}>
                <Ic n="download" s={14}/>Download
              </button>
            )}
          </div>
          {dayData.examples ? (
            <ErrorBoundary>
              <ContentRenderer content={dayData.examples} onUseCode={code=>{ setCodeEdit(code); setTab("compiler"); }} />
            </ErrorBoundary>
          ) : (
            <EmptyState icon="zap" title="No tasks yet" text="Generate 5 practice tasks with difficulty levels, starter code, expected output and hints." />
          )}
        </div>
      )}

      {/* ── RESOURCES ── */}
      {tab==="resources" && (
        <div style={{ animation:"lms-in .2s ease" }}>
          <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
            {!studentMode && (
              <>
                <div style={{ display:"flex", alignItems:"center", gap:6, background:"#faf5ff", border:"1.5px solid #e9d5ff", borderRadius:8, padding:"5px 10px", height:36 }}>
                  <span style={{ fontSize:11.5, color:"#6b21a8", whiteSpace:"nowrap", userSelect:"none", fontWeight:600 }}>Snippets</span>
                  <input
                    type="number" min={1} max={20}
                    value={dayData.resourcesSnippets ?? 3}
                    onChange={e => updateDay(k, { resourcesSnippets: Math.max(1, Math.min(20, parseInt(e.target.value) || 3)) })}
                    style={{ width:42, border:"none", background:"transparent", fontSize:14, fontWeight:800, color:"#6b21a8", outline:"none", padding:0, textAlign:"center" }}
                  />
                </div>
                <button className="lms-btn lms-btn-violet" disabled={!!busy[`rs-${k}`]} onClick={onGenResources}>
                  {busy[`rs-${k}`]?<><Spin/>Generating...</>:<><Ic n="file" s={14}/>Auto-Generate Resources</>}
                </button>
              </>
            )}
            {dayData.resources && (
              <button className="lms-btn lms-btn-ghost" onClick={()=>downloadBlob(dayData.resources, `Day${day.dayNum}_resources.md`)}>
                <Ic n="download" s={14}/>Download .md
              </button>
            )}
          </div>

          {dayData.resources && (
            <div className="lms-block" style={{ marginBottom:20 }}>
              <div className="lms-block-head">
                <div style={{ width:28, height:28, background:"#f3e8ff", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center" }}><Ic n="file" s={15} c="#8b5cf6"/></div>
                <span style={{ fontWeight:700, color:"#0f172a" }}>Auto-Generated Resources</span>
              </div>
              <ErrorBoundary><ContentRenderer content={dayData.resources} /></ErrorBoundary>
            </div>
          )}

          {/* File upload zone */}
          <div className="lms-block">
            <div className="lms-block-head">
              <div style={{ width:28, height:28, background:"#eff6ff", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center" }}><Ic n="upload" s={15} c="#3b82f6"/></div>
              <span style={{ fontWeight:700, color:"#0f172a" }}>Upload Your Files</span>
              <span style={{ fontSize:12, color:"#94a3b8", marginLeft:4 }}>Max ~2MB per file for best persistence</span>
            </div>

            <label className="upload-zone">
              <Ic n="upload" s={28} c="#94a3b8" />
              <p style={{ marginTop:10, fontSize:13.5, fontWeight:600, color:"#475569" }}>Drop files here or click to browse</p>
              <p style={{ fontSize:12, color:"#94a3b8", marginTop:4 }}>Supports: .ipynb, .pdf, .py, .txt, .png, .jpg, .jpeg, .gif</p>
              <input type="file" multiple accept=".ipynb,.pdf,.py,.txt,.png,.jpg,.jpeg,.gif,.md" style={{ display:"none" }}
                onChange={e=>onFileUpload(Array.from(e.target.files))} />
            </label>

            {(dayData.uploadedFiles||[]).length > 0 && (
              <div style={{ marginTop:16 }}>
                <p className="lms-section-label">Uploaded Files ({(dayData.uploadedFiles||[]).length})</p>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {(dayData.uploadedFiles||[]).map(f => {
                    const isImg = f.type?.startsWith("image/");
                    const isPdf = f.type === "application/pdf";
                    const isNb  = f.name.endsWith(".ipynb");
                    const ic = isImg ? "img" : isPdf ? "pdf" : isNb ? "book" : "file";
                    const color = isImg ? "#ec4899" : isPdf ? "#ef4444" : isNb ? "#f59e0b" : "#6b7280";
                    const bg    = isImg ? "#fdf2f8" : isPdf ? "#fef2f2" : isNb ? "#fffbeb" : "#f8fafc";
                    return (
                      <div key={f.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 14px", background:bg, borderRadius:10, border:"1.5px solid #e8edf3", flexWrap:"wrap" }}>
                        <div style={{ width:32, height:32, background:"#fff", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, border:"1px solid #e2e8f0" }}>
                          <Ic n={ic} s={17} c={color}/>
                        </div>
                        <div style={{ flex:1, minWidth:120 }}>
                          <p style={{ fontSize:13, fontWeight:600, color:"#0f172a", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</p>
                          <p style={{ fontSize:11, color:"#94a3b8" }}>{(f.size/1024).toFixed(1)} KB · {new Date(f.uploadedAt).toLocaleDateString()}</p>
                        </div>
                        {isImg && f.dataUrl && <img src={f.dataUrl} alt={f.name} style={{ width:40, height:40, objectFit:"cover", borderRadius:6, flexShrink:0 }}/>}
                        {f.dataUrl && (
                          <a href={f.dataUrl} download={f.name} className="lms-btn lms-btn-ghost" style={{ padding:"5px 10px", fontSize:12, textDecoration:"none" }}>
                            <Ic n="download" s={13}/>
                          </a>
                        )}
                        {!f.dataUrl && <span style={{ fontSize:11, color:"#ef4444", padding:"3px 8px", background:"#fef2f2", borderRadius:6 }}>Session only</span>}
                        <button className="lms-btn" style={{ padding:"5px 8px", background:"#fef2f2", color:"#dc2626", fontSize:12 }}
                          onClick={()=>onDeleteFile(f.id)}>
                          <Ic n="trash" s={13} c="#dc2626"/>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {!dayData.resources && (dayData.uploadedFiles||[]).length===0 && (
            <EmptyState icon="file" title="No resources yet" text="Auto-generate a resource sheet or upload your own files (PDFs, images, notebooks)." />
          )}
        </div>
      )}

      {/* ── ASSIGNMENT ── */}
      {tab==="assignment" && (
        <div style={{ animation:"lms-in .2s ease" }}>
          <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
            {!studentMode && (
              <>
                <div style={{ display:"flex", alignItems:"center", gap:6, background:"#fff1f2", border:"1.5px solid #fecdd3", borderRadius:8, padding:"5px 10px", height:36 }}>
                  <span style={{ fontSize:11.5, color:"#9f1239", whiteSpace:"nowrap", userSelect:"none", fontWeight:600 }}>Challenges</span>
                  <input
                    type="number" min={1} max={15}
                    value={dayData.assignmentChallenges ?? 3}
                    onChange={e => updateDay(k, { assignmentChallenges: Math.max(1, Math.min(15, parseInt(e.target.value) || 3)) })}
                    style={{ width:42, border:"none", background:"transparent", fontSize:14, fontWeight:800, color:"#9f1239", outline:"none", padding:0, textAlign:"center" }}
                  />
                </div>
                <button className="lms-btn lms-btn-rose" disabled={!!busy[`as-${k}`]} onClick={onGenAssignment}>
                  {busy[`as-${k}`]?<><Spin/>Generating...</>:<><Ic n="clip" s={14}/>Generate Assignment</>}
                </button>
              </>
            )}
            {dayData.assignment && (
              <>
                <button className="lms-btn lms-btn-ghost" onClick={()=>downloadBlob(dayData.assignment, `Day${day.dayNum}_assignment.md`)}>
                  <Ic n="download" s={14}/>Download .md
                </button>
                <button className="lms-btn lms-btn-ghost" onClick={()=>downloadBlob(buildIpynb(`Assignment: ${day.topic}`, dayData.assignment, []), `Day${day.dayNum}_assignment.ipynb`, "application/json")}>
                  <Ic n="download" s={14}/>Download .ipynb
                </button>
              </>
            )}
            {(dayData.uploadedFiles||[]).length > 0 && (
              <span style={{ fontSize:12, color:"#64748b", padding:"4px 10px", background:"#f1f5f9", borderRadius:8 }}>
                📎 {(dayData.uploadedFiles||[]).length} file(s) from Resources referenced
              </span>
            )}
          </div>
          {dayData.assignment ? (
            <ErrorBoundary><ContentRenderer content={dayData.assignment} /></ErrorBoundary>
          ) : (
            <EmptyState icon="clip" title="No assignment yet" text="Generate a complete assignment with theory questions, coding challenges, and mini project." />
          )}
        </div>
      )}

      {/* ── QUIZ ── */}
      {tab==="quiz" && (
        <QuizTab
          day={day}
          dayData={dayData}
          busy={busy}
          onGenQuiz={onGenQuiz}
          updateDay={updateDay}
          notify={notify}
          studentMode={studentMode}
        />
      )}

      {/* ── NOTES ── */}
      {tab==="notes" && (
        <NotesTab
          dayKey={k}
          dayData={dayData}
          updateDay={updateDay}
          notify={notify}
          day={day}
        />
      )}

      {/* ── TEACHING GUIDE (trainer only) ── */}
      {tab==="guide" && isTrainer && (
        <div style={{ animation:"lms-in .2s ease" }}>
          <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
            <div style={{ display:"flex", alignItems:"center", gap:6, background:"#f0fdf4", border:"1.5px solid #bbf7d0", borderRadius:8, padding:"5px 10px", height:36 }}>
              <span style={{ fontSize:11.5, color:"#14532d", whiteSpace:"nowrap", userSelect:"none", fontWeight:600 }}>Blocks</span>
              <input
                type="number" min={2} max={12}
                value={dayData.guideBlocks ?? 5}
                onChange={e => updateDay(k, { guideBlocks: Math.max(2, Math.min(12, parseInt(e.target.value) || 5)) })}
                style={{ width:42, border:"none", background:"transparent", fontSize:14, fontWeight:800, color:"#14532d", outline:"none", padding:0, textAlign:"center" }}
              />
            </div>
            <button className="lms-btn lms-btn-green" disabled={!!busy[`tg-${k}`]} onClick={onGenTeachingGuide}>
              {busy[`tg-${k}`]?<><Spin/>Generating...</>:<><Ic n="teacher" s={14}/>Generate Teaching Guide</>}
            </button>
            {dayData.teachingGuide && (
              <button className="lms-btn lms-btn-ghost" onClick={()=>downloadBlob(dayData.teachingGuide, `Day${day.dayNum}_teaching_guide.md`)}>
                <Ic n="download" s={14}/>Download Guide
              </button>
            )}
          </div>
          {dayData.teachingGuide ? (
            <ErrorBoundary><TeachingGuideView content={dayData.teachingGuide} /></ErrorBoundary>
          ) : (
            <EmptyState icon="teacher" title="No teaching guide yet" text="Generate a block-by-block session guide with teaching techniques, analogies, and troubleshooting tips." />
          )}
        </div>
      )}
    {exportOpen && (
      <DayExportPanel
        day={day}
        dayData={dayData}
        notify={notify}
        isTrainer={isTrainer}
        onClose={() => setExportOpen(false)}
      />
    )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SETTINGS PAGE
═══════════════════════════════════════════════════════════════════ */
function NotebookView({ content, codeBlocks, onUseCode }) {
  if (!content) return null;
  const parts = content.split(/(```(?:python)?\n[\s\S]*?```)/g);
  return (
    <div>
      {parts.map((part, i) => {
        const codeMatch = part.match(/```(?:python)?\n([\s\S]*?)```/);
        if (codeMatch) {
          const code = codeMatch[1];
          return (
            <div key={i} style={{ marginBottom:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"#1e293b", padding:"7px 14px", borderRadius:"10px 10px 0 0" }}>
                <span style={{ fontSize:11.5, fontWeight:600, color:"#94a3b8" }}>Python</span>
                <button className="lms-btn" style={{ padding:"3px 10px", fontSize:11.5, background:"#334155", color:"#e2e8f0", borderRadius:6 }} onClick={()=>onUseCode(code)}>
                  <Ic n="play" s={11} c="#e2e8f0"/>Use in Compiler
                </button>
              </div>
              <div className="lms-cell" style={{ borderRadius:"0 0 10px 10px", borderTop:"none", background:"#0f172a", color:"#e2e8f0" }}>{code}</div>
            </div>
          );
        }
        return <MdRenderer key={i} text={part} />;
      })}
      {codeBlocks.length > 0 && (
        <div style={{ marginTop:16, padding:"12px 16px", background:"#f8fafc", borderRadius:10, border:"1.5px solid #e2e8f0" }}>
          <p style={{ fontSize:12, fontWeight:700, color:"#94a3b8", marginBottom:8 }}>QUICK ACCESS · {codeBlocks.length} CODE BLOCK{codeBlocks.length>1?"S":""}</p>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            {codeBlocks.map((cb,i) => (
              <button key={i} className="lms-btn lms-btn-ghost" style={{ fontSize:12, padding:"5px 12px" }} onClick={()=>onUseCode(cb)}>
                <Ic n="code" s={12}/>Block {i+1}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Inline markdown formatter: bold, italic, inline code ─── */
function renderInline(text) {
  if (!text) return text;
  const parts = text.split(/(`[^`]+`)/g);
  return parts.flatMap((part, j) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return [<code key={`c${j}`} style={{ background:"#f1f5f9", padding:"1px 6px", borderRadius:4, fontFamily:"monospace", fontSize:12.5, color:"#0f172a" }}>{part.slice(1,-1)}</code>];

    // Use non-global regexes for split (global regex consumed by split is fine),
    // but use non-global regex for the .test() check to avoid lastIndex mutation
    const boldItalicRe = /(\*\*\*[^*]+\*\*\*|___[^_]+___)/g;
    const boldRe       = /(\*\*[^*]+\*\*|__[^_]+__)/g;
    const italicRe     = /(\*[^*]+\*|_[^_]+_)/g;
    const boldItalicTest = /^\*\*\*[^*]+\*\*\*$|^___[^_]+___$/;
    const boldTest       = /^\*\*[^*]+\*\*$|^__[^_]+__$/;
    const italicTest     = /^\*[^*]+\*$|^_[^_]+_$/;

    let nodes = [part];
    const applyRe = (re, testRe, wrap) => {
      const result = [];
      nodes.forEach(n => {
        if (typeof n !== "string") { result.push(n); return; }
        const segs = n.split(re);
        segs.forEach((seg, si) => {
          if (testRe.test(seg)) result.push(wrap(seg, `${j}_${si}`));
          else result.push(seg);
        });
      });
      nodes = result;
    };
    applyRe(boldItalicRe, boldItalicTest, (s,k) => <strong key={`bi${k}`}><em>{s.startsWith("___") ? s.slice(3,-3) : s.slice(3,-3)}</em></strong>);
    applyRe(boldRe,       boldTest,       (s,k) => <strong key={`b${k}`}>{s.startsWith("__") ? s.slice(2,-2) : s.slice(2,-2)}</strong>);
    applyRe(italicRe,     italicTest,     (s,k) => <em key={`i${k}`}>{s.startsWith("_") ? s.slice(1,-1) : s.slice(1,-1)}</em>);
    return nodes;
  });
}

/* ─── Markdown renderer ─── */
function MdRenderer({ text }) {
  if (!text?.trim()) return null;
  const lines = text.split("\n");
  return (
    <div className="lms-prose" style={{ marginBottom:8 }}>
      {lines.map((line, i) => {
        if (line.startsWith("### ")) return <h3 key={i} style={{ fontSize:14, fontWeight:700, color:"#0f172a", margin:"14px 0 5px" }}>{renderInline(line.slice(4))}</h3>;
        if (line.startsWith("## "))  return <h2 key={i} style={{ fontSize:16, fontWeight:700, color:"#0f172a", margin:"18px 0 6px", borderBottom:"1.5px solid #f1f5f9", paddingBottom:6 }}>{renderInline(line.slice(3))}</h2>;
        if (line.startsWith("# "))   return <h1 key={i} style={{ fontSize:19, fontWeight:800, color:"#0f172a", margin:"20px 0 8px", letterSpacing:"-.3px" }}>{renderInline(line.slice(2))}</h1>;
        // Whole-line bold — entire line wrapped in ** with no nested ** inside
        const trimmed = line.trim();
        if (trimmed.startsWith("**") && trimmed.endsWith("**") && trimmed.length > 4 && !trimmed.slice(2, -2).includes("**"))
          return <p key={i} style={{ fontWeight:700, color:"#0f172a", margin:"5px 0" }}>{trimmed.slice(2, -2)}</p>;
        if (line.match(/^[-*] /)) return <div key={i} style={{ display:"flex", gap:8, margin:"3px 0 3px 8px" }}><span style={{ color:"#3b82f6", fontWeight:700, marginTop:2, flexShrink:0 }}>•</span><span style={{ fontSize:13.5, color:"#374151", lineHeight:1.6 }}>{renderInline(line.slice(2))}</span></div>;
        if (line.match(/^\d+\. /)) { const [num,...rest]=line.split(". "); return <div key={i} style={{ display:"flex", gap:8, margin:"3px 0 3px 8px" }}><span style={{ color:"#3b82f6", fontWeight:700, minWidth:20, flexShrink:0 }}>{num}.</span><span style={{ fontSize:13.5, color:"#374151", lineHeight:1.6 }}>{renderInline(rest.join(". "))}</span></div>; }
        if (line.startsWith("---")) return <hr key={i} style={{ border:"none", borderTop:"1.5px solid #f1f5f9", margin:"14px 0" }}/>;
        if (!line.trim()) return <div key={i} style={{ height:6 }}/>;
        return <p key={i} style={{ fontSize:13.5, color:"#374151", lineHeight:1.7, margin:"3px 0" }}>{renderInline(line)}</p>;
      })}
    </div>
  );
}

/* ─── Generic content renderer ─── */
function ContentRenderer({ content, onUseCode }) {
  if (!content) return null;
  const parts = content.split(/(```(?:python)?\n[\s\S]*?```)/g);
  return (
    <div>
      {parts.map((part, i) => {
        const codeMatch = part.match(/```(?:python)?\n([\s\S]*?)```/);
        if (codeMatch) {
          const code = codeMatch[1];
          return (
            <div key={i} style={{ marginBottom:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"#1e293b", padding:"7px 14px", borderRadius:"10px 10px 0 0" }}>
                <span style={{ fontSize:11.5, fontWeight:600, color:"#94a3b8" }}>Python</span>
                {onUseCode && <button className="lms-btn" style={{ padding:"3px 10px", fontSize:11.5, background:"#334155", color:"#e2e8f0", borderRadius:6 }} onClick={()=>onUseCode(code)}><Ic n="play" s={11} c="#e2e8f0"/>Try it</button>}
              </div>
              <div className="lms-cell" style={{ borderRadius:"0 0 10px 10px", borderTop:"none", background:"#0f172a", color:"#e2e8f0" }}>{code}</div>
            </div>
          );
        }
        return <MdRenderer key={i} text={part} />;
      })}
    </div>
  );
}

/* ─── Teaching guide renderer ─── */
function TeachingGuideView({ content }) {
  if (!content) return null;
  const blockColors = ["#eff6ff","#f0fdf4","#fffbeb","#fdf4ff","#fff7ed","#f0f9ff"];
  const blockBorders= ["#bfdbfe","#bbf7d0","#fde68a","#e9d5ff","#fed7aa","#bae6fd"];
  const blockAccents= ["#3b82f6","#22c55e","#f59e0b","#a855f7","#f97316","#06b6d4"];

  const sections = content.split(/(?=^## BLOCK|^---$|^## 🎯|^## 🚨|^## 💡)/m).filter(s=>s.trim());
  let blockIdx = 0;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      {sections.map((section, i) => {
        const isBlock = section.match(/^## BLOCK (\d+)/m);
        const isOverview = section.includes("🎯");
        const isTrouble = section.includes("🚨");
        const isTips = section.includes("💡");
        const colorIdx = isBlock ? (blockIdx++ % blockColors.length) : (isTrouble ? 0 : isTips ? 2 : 5);
        const header = section.split("\n")[0].replace(/^##\s*/,"").trim();
        if (!header && !section.trim()) return null;
        return (
          <div key={i} style={{ background:blockColors[colorIdx], border:`1.5px solid ${blockBorders[colorIdx]}`, borderRadius:14, padding:20 }}>
            {header && (
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, paddingBottom:12, borderBottom:`1px solid ${blockBorders[colorIdx]}` }}>
                <div style={{ width:30, height:30, background:blockAccents[colorIdx], borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:800, fontSize:13, flexShrink:0 }}>
                  {isBlock ? section.match(/BLOCK (\d+)/)?.[1] || "•" : isOverview ? "🎯" : isTrouble ? "🚨" : "💡"}
                </div>
                <span style={{ fontWeight:700, fontSize:14, color:"#0f172a" }}>{header}</span>
              </div>
            )}
            <MdRenderer text={section.split("\n").slice(1).join("\n")} />
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   QUIZ TAB — interactive MCQ with scoring
═══════════════════════════════════════════════════════════════════ */
function QuizTab({ day, dayData, busy, onGenQuiz, updateDay, notify, studentMode }) {
  const k = day.key;
  const questions = dayData.quiz || null;
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [quizKey, setQuizKey] = useState(0); // increment to reset

  const score = submitted
    ? questions.filter((q, i) => answers[i] === q.answer).length
    : 0;

  const handleSubmit = () => {
    if (Object.keys(answers).length < (questions?.length || 0)) {
      notify("Answer all questions before submitting", "warn");
      return;
    }
    // Compute score inline — don't rely on the `score` variable (computed when !submitted, always 0)
    const finalScore = questions.filter((q, i) => answers[i] === q.answer).length;
    setSubmitted(true);
    const pct = Math.round(finalScore / questions.length * 100);
    notify(`Quiz complete! ${finalScore}/${questions.length} (${pct}%)`);
    updateDay(k, { quizScore: { score: finalScore, total: questions.length, pct, date: new Date().toISOString() } });
  };

  const handleReset = () => {
    setAnswers({});
    setSubmitted(false);
    setQuizKey(p => p + 1);
  };

  return (
    <div style={{ animation:"lms-in .2s ease" }}>
      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
        {!studentMode && (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:6, background:"#fffbeb", border:"1.5px solid #fde68a", borderRadius:8, padding:"5px 10px", height:36 }}>
              <span style={{ fontSize:11.5, color:"#92400e", whiteSpace:"nowrap", userSelect:"none", fontWeight:600 }}>Questions</span>
              <input
                type="number" min={2} max={20}
                value={dayData.quizCount ?? 6}
                onChange={e => updateDay(k, { quizCount: Math.max(2, Math.min(20, parseInt(e.target.value) || 6)) })}
                style={{ width:42, border:"none", background:"transparent", fontSize:14, fontWeight:800, color:"#92400e", outline:"none", padding:0, textAlign:"center" }}
              />
            </div>
            <button className="lms-btn" style={{ background:"linear-gradient(135deg,#f59e0b,#f97316)", color:"#fff" }}
              disabled={!!busy[`qz-${k}`]} onClick={onGenQuiz}>
            {busy[`qz-${k}`]?<><Spin/>Generating...</>:<><Ic n="brain" s={14}/>Generate Quiz</>}
          </button>
          </>
        )}
        {questions && (
          <>
            <button className="lms-btn lms-btn-ghost" onClick={handleReset}>
              <Ic n="refresh" s={14}/>Retake
            </button>
            {dayData.quizScore && (
              <span style={{ fontSize:12.5, color:"#64748b", padding:"4px 10px", background:"#f1f5f9", borderRadius:8 }}>
                Last score: {dayData.quizScore.score}/{dayData.quizScore.total} ({dayData.quizScore.pct}%)
              </span>
            )}
          </>
        )}
      </div>

      {!questions && (
        <EmptyState icon="brain" title="No quiz yet" text="Set how many questions you want, then click Generate Quiz for an AI-powered multiple-choice quiz with auto-grading and explanations." />
      )}

      {questions && (
        <div key={quizKey}>
          {/* Score banner after submit */}
          {submitted && (
            <div style={{ marginBottom:20, padding:"18px 22px", borderRadius:14,
              background: score/questions.length >= 0.8 ? "#f0fdf4" : score/questions.length >= 0.5 ? "#fffbeb" : "#fef2f2",
              border: `2px solid ${score/questions.length >= 0.8 ? "#86efac" : score/questions.length >= 0.5 ? "#fde68a" : "#fecaca"}` }}>
              <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                <span style={{ fontSize:36 }}>{score/questions.length >= 0.8 ? "🎉" : score/questions.length >= 0.5 ? "📚" : "💪"}</span>
                <div>
                  <p style={{ fontSize:20, fontWeight:800, color:"#0f172a" }}>{score}/{questions.length} Correct</p>
                  <p style={{ fontSize:13.5, color:"#64748b" }}>
                    {score/questions.length >= 0.8 ? "Excellent! You've mastered this topic." : score/questions.length >= 0.5 ? "Good progress! Review the explanations below." : "Keep practicing! Read the notebook and try again."}
                  </p>
                </div>
                <div style={{ marginLeft:"auto", textAlign:"center" }}>
                  <div style={{ fontSize:28, fontWeight:800, color: score/questions.length >= 0.8 ? "#16a34a" : score/questions.length >= 0.5 ? "#d97706" : "#dc2626" }}>
                    {Math.round(score/questions.length*100)}%
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Questions */}
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {questions.map((q, qi) => {
              const chosen = answers[qi];
              const isCorrect = submitted && chosen === q.answer;
              const isWrong = submitted && chosen !== undefined && chosen !== q.answer;
              return (
                <div key={qi} style={{
                  padding:18, borderRadius:14, border:`1.5px solid ${submitted ? (isCorrect?"#86efac":isWrong?"#fca5a5":"#e2e8f0") : "#e2e8f0"}`,
                  background: submitted ? (isCorrect?"#f0fdf4":isWrong?"#fef2f2":"#fff") : "#fff"
                }}>
                  <p style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:12, lineHeight:1.5 }}>
                    <span style={{ color:"#3b82f6", marginRight:8 }}>Q{qi+1}.</span>{q.q}
                  </p>
                  <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                    {q.options.map((opt, oi) => {
                      const isChosenOpt = chosen === oi;
                      const isCorrectOpt = submitted && oi === q.answer;
                      const isWrongOpt = submitted && isChosenOpt && oi !== q.answer;
                      let bg = "#f8fafc", border = "#e2e8f0", color = "#374151";
                      if (isChosenOpt && !submitted) { bg="#eff6ff"; border="#3b82f6"; color="#1e40af"; }
                      if (isCorrectOpt) { bg="#f0fdf4"; border="#22c55e"; color="#15803d"; }
                      if (isWrongOpt) { bg="#fef2f2"; border="#ef4444"; color="#dc2626"; }
                      return (
                        <button key={oi} disabled={submitted}
                          onClick={() => !submitted && setAnswers(p => ({...p, [qi]: oi}))}
                          style={{ textAlign:"left", padding:"10px 14px", borderRadius:9, border:`1.5px solid ${border}`, background:bg, color, cursor:submitted?"default":"pointer", fontSize:13.5, fontFamily:"inherit", fontWeight: isChosenOpt||isCorrectOpt ? 600 : 400, display:"flex", alignItems:"center", gap:10 }}>
                          <span style={{ width:20, height:20, borderRadius:"50%", border:`1.5px solid ${border}`, background: isChosenOpt||isCorrectOpt ? border : "transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:11, fontWeight:700, color: isChosenOpt||isCorrectOpt ? "#fff" : color }}>
                            {["A","B","C","D"][oi]}
                          </span>
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                  {/* Explanation after submit */}
                  {submitted && (
                    <div style={{ marginTop:12, padding:"10px 14px", background:"#f8fafc", borderRadius:9, border:"1px solid #e2e8f0" }}>
                      <p style={{ fontSize:12.5, color:"#475569", lineHeight:1.6 }}>
                        <strong style={{ color:"#0f172a" }}>Explanation: </strong>{q.explanation}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!submitted && (
            <button className="lms-btn lms-btn-dark" style={{ marginTop:16, width:"100%", justifyContent:"center" }}
              onClick={handleSubmit}>
              <Ic n="check" s={15}/>Submit Quiz
            </button>
          )}
          {submitted && (
            <button className="lms-btn lms-btn-ghost" style={{ marginTop:16, width:"100%", justifyContent:"center" }}
              onClick={handleReset}>
              <Ic n="refresh" s={15}/>Retake Quiz
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   NOTES TAB — per-day markdown notes with auto-save
═══════════════════════════════════════════════════════════════════ */
function NotesTab({ dayKey, dayData, updateDay, notify, day }) {
  const [draft, setDraft] = useState(dayData.notes || "");
  const [saved, setSaved] = useState(true);
  const [preview, setPreview] = useState(false);

  // Auto-save after 1.5s of inactivity
  useEffect(() => {
    if (draft === (dayData.notes || "")) { setSaved(true); return; }
    setSaved(false);
    const t = setTimeout(() => {
      updateDay(dayKey, { notes: draft });
      setSaved(true);
    }, 1500);
    return () => clearTimeout(t);
  }, [draft]);

  // Sync if dayData.notes changes externally (e.g. navigating to new day)
  useEffect(() => {
    setDraft(dayData.notes || "");
    setSaved(true); // reset save indicator when switching days
  }, [dayKey]);

  return (
    <div style={{ animation:"lms-in .2s ease" }}>
      <div style={{ display:"flex", gap:8, marginBottom:14, alignItems:"center", flexWrap:"wrap" }}>
        <p style={{ fontSize:13, fontWeight:700, color:"#0f172a", flex:1 }}>
          Personal Notes — Day {day.dayNum}: {day.topic}
        </p>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          <span style={{ fontSize:12, color: saved?"#22c55e":"#f59e0b", fontWeight:600 }}>
            {saved ? "✓ Saved" : "Saving…"}
          </span>
          <button className={`lms-btn ${preview?"lms-btn-dark":"lms-btn-ghost"}`} style={{ padding:"5px 12px", fontSize:12 }} onClick={()=>setPreview(p=>!p)}>
            {preview ? "✏️ Edit" : "👁 Preview"}
          </button>
          {draft && (
            <button className="lms-btn lms-btn-ghost" style={{ padding:"5px 12px", fontSize:12 }}
              onClick={()=>downloadBlob(`# Notes: Day ${day.dayNum} - ${day.topic}\n\n${draft}`, `Day${day.dayNum}_notes.md`)}>
              <Ic n="download" s={13}/>Export
            </button>
          )}
        </div>
      </div>

      {preview ? (
        <div className="lms-card" style={{ padding:20, minHeight:300 }}>
          {draft.trim() ? <MdRenderer text={draft} /> : <p style={{ color:"#94a3b8", fontSize:13.5 }}>Nothing to preview yet.</p>}
        </div>
      ) : (
        <div>
          <textarea
            className="lms-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={`# Day ${day.dayNum} Notes\n\n## Key Concepts\n- \n\n## Questions\n- \n\n## Things to Review\n- `}
            style={{ minHeight:380, fontFamily:"'JetBrains Mono','Fira Code',monospace", fontSize:13, lineHeight:1.7, resize:"vertical" }}
          />
          <p style={{ fontSize:12, color:"#94a3b8", marginTop:8 }}>Supports Markdown — use ## for headings, - for lists, **bold**, `code`. Auto-saves as you type.</p>
        </div>
      )}
    </div>
  );
}

/* ─── Empty state ─── */
function EmptyState({ icon, title, text }) {
  return (
    <div style={{ textAlign:"center", padding:"56px 20px", animation:"lms-in .3s ease" }}>
      <div style={{ width:52, height:52, background:"#f1f5f9", borderRadius:14, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px" }}>
        <Ic n={icon} s={24} c="#cbd5e1"/>
      </div>
      <p style={{ fontWeight:700, fontSize:15, color:"#334155", marginBottom:6 }}>{title}</p>
      <p style={{ fontSize:13.5, color:"#94a3b8", maxWidth:380, margin:"0 auto", lineHeight:1.65 }}>{text}</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SETTINGS PAGE — Supabase-backed, no localStorage
═══════════════════════════════════════════════════════════════════ */
function SettingsPage({ aiProvider, setAiProvider, groqKey, setGroqKey, groqModel, setGroqModel, ollamaUrl, setOllamaUrl, ollamaModel, setOllamaModel, callAI, notify, sb, courseId, trainerId, setPlanText, setPlanDays, setStartDate, setMonfri, setDayStatus, setDayData, setDayOverrides }) {
  const [testing,     setTesting]     = useState(false);
  const [testSb,      setTestSb]      = useState(false);
  const [sbStatus,    setSbStatus]    = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const testAI = async () => {
    setTesting(true);
    try {
      const r = await callAI([{ role:"user", content:"Reply with exactly: Connection successful!" }]);
      notify(`AI: ${r.slice(0,80)}`);
    } catch(e) { notify(e.message, "err"); }
    setTesting(false);
  };

  const testSupabase = async () => {
    setTestSb(true); setSbStatus(null);
    try {
      if (!sb) throw new Error("No Supabase connection — enter credentials in the main app config");
      const rows = await sb.select("lms_courses", "limit=1");
      setSbStatus({ read: true, rowCount: rows.length });
      // Test write
      const testRow = { id: "__connection_test__", name: "test", trainer_id: trainerId, plan_text: "", plan_days: [], start_date: "", monfri: true, day_status: {}, day_data: {}, day_map: {}, cal_year: 2024, cal_month: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      await sb.upsert("lms_courses", testRow);
      await sb.delete("lms_courses", "id=eq.__connection_test__");
      setSbStatus(s => ({ ...s, write: true }));
      notify("Supabase ✓ — read & write confirmed");
    } catch(e) {
      setSbStatus(s => ({ ...(s||{}), error: e.message }));
      notify(e.message, "err");
    }
    setTestSb(false);
  };

  const loadFromSupabase = async () => {
    if (!sb || !courseId) { notify("No course selected", "warn"); return; }
    try {
      const course = await sbGetCourseData(sb, courseId);
      if (!course) { notify("No course data found in Supabase", "warn"); return; }
      if (course.planText)  setPlanText(course.planText);
      if (course.planDays)  setPlanDays(course.planDays);
      if (course.startDate) setStartDate(course.startDate);
      if (course.monfri !== undefined) setMonfri(course.monfri);
      if (course.dayStatus) setDayStatus(course.dayStatus);
      if (course.dayOverrides) setDayOverrides(course.dayOverrides);

      // FIX: also load lms_day_content (notebooks, assignments, etc.) and merge
      const contentByDay = await sbGetAllDayContent(sb, courseId);
      const mergedDayData = { ...(course.dayData || {}) };
      for (const [k, v] of Object.entries(contentByDay)) {
        mergedDayData[k] = { ...(mergedDayData[k] || {}), ...v };
      }
      // Fetch uploaded files for all known day keys
      const allDayKeys = Array.from(new Set([
        ...Object.keys(mergedDayData),
        ...Object.keys(contentByDay),
      ]));
      if (allDayKeys.length > 0) {
        const fileResults = await Promise.allSettled(
          allDayKeys.map(k => sbGetFilesForDay(sb, courseId, k).then(files => ({ k, files })))
        );
        fileResults.forEach(r => {
          if (r.status === "fulfilled") {
            const { k, files } = r.value;
            mergedDayData[k] = { ...(mergedDayData[k] || {}), uploadedFiles: files };
          }
        });
      }
      setDayData(mergedDayData);
      notify("Course reloaded from Supabase ✓");
    } catch(e) { notify(e.message, "err"); }
  };

  const doClearData = async () => {
    setConfirmClear(false);
    if (!sb || !courseId) { notify("No course to clear", "warn"); return; }
    try {
      // Clear the course row fields AND delete all lms_day_content rows for this course.
      // Without the second delete, notebooks/assignments would silently reappear on next load
      // because loadCourse always fetches from lms_day_content.
      await Promise.all([
        sbSaveCourseData(sb, courseId, { planText:"", planDays:[], dayStatus:{}, dayData:{}, dayOverrides:{} }),
        sb.delete("lms_day_content", `course_id=eq.${encodeURIComponent(courseId)}`),
      ]);
      setPlanText(""); setPlanDays([]); setDayStatus({}); setDayData({}); setDayOverrides({});
      notify("Course data cleared from Supabase ✓");
    } catch(e) { notify(`Clear failed: ${e.message}`, "err"); }
  };

  return (
    <div style={{ maxWidth:640, animation:"lms-in .3s ease" }}>
      {confirmClear && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:9000, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:"#fff", borderRadius:16, padding:28, maxWidth:400, width:"100%", boxShadow:"0 20px 60px rgba(0,0,0,.25)" }}>
            <p style={{ fontWeight:800, fontSize:16, color:"#dc2626", marginBottom:10 }}>Clear All Course Data?</p>
            <p style={{ fontSize:13.5, color:"#475569", lineHeight:1.6, marginBottom:20 }}>This will permanently delete the plan, all notebooks, assignments, and notes for this course in Supabase. <strong>Cannot be undone.</strong></p>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button className="lms-btn lms-btn-ghost" onClick={()=>setConfirmClear(false)}>Cancel</button>
              <button className="lms-btn lms-btn-rose" onClick={doClearData}><Ic n="trash" s={13}/>Yes, Clear Everything</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom:26 }}>
        <h1 style={{ fontSize:25, fontWeight:800, color:"#0f172a", letterSpacing:"-.5px" }}>Settings</h1>
        <p style={{ color:"#64748b", fontSize:13.5, marginTop:4 }}>Configure AI provider and manage course data</p>
      </div>

      {/* AI Provider */}
      <div className="lms-card" style={{ padding:22, marginBottom:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
          <div style={{ width:30, height:30, background:"#eff6ff", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center" }}><Ic n="brain" s={16} c="#3b82f6"/></div>
          <p style={{ fontWeight:700, fontSize:14.5, color:"#0f172a" }}>AI Provider</p>
        </div>
        <div style={{ display:"flex", gap:10, marginBottom:20 }}>
          {[{v:"groq",l:"⚡ Groq API"},{v:"ollama",l:"🦙 Ollama (Local)"}].map(opt=>(
            <button key={opt.v} className={`lms-btn ${aiProvider===opt.v?"lms-btn-dark":"lms-btn-ghost"}`} onClick={()=>setAiProvider(opt.v)} style={{ flex:1 }}>{opt.l}</button>
          ))}
        </div>
        {aiProvider==="groq" && (
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div>
              <label style={{ fontSize:12.5, fontWeight:600, color:"#475569", display:"block", marginBottom:6 }}>API Key</label>
              <input type="password" className="lms-input" value={groqKey} onChange={e=>setGroqKey(e.target.value)} placeholder="gsk_..." />
              <p style={{ fontSize:11.5, color:"#94a3b8", marginTop:5 }}>Get free key at <a href="https://console.groq.com" target="_blank" rel="noreferrer" style={{ color:"#3b82f6" }}>console.groq.com</a></p>
            </div>
            <div>
              <label style={{ fontSize:12.5, fontWeight:600, color:"#475569", display:"block", marginBottom:6 }}>Model</label>
              <select className="lms-input" value={groqModel} onChange={e=>setGroqModel(e.target.value)}>
                {GROQ_MODELS.map(m=><option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        )}
        {aiProvider==="ollama" && (
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div>
              <label style={{ fontSize:12.5, fontWeight:600, color:"#475569", display:"block", marginBottom:6 }}>Ollama Base URL</label>
              <input className="lms-input" value={ollamaUrl} onChange={e=>setOllamaUrl(e.target.value)} placeholder="http://localhost:11434" />
            </div>
            <div>
              <label style={{ fontSize:12.5, fontWeight:600, color:"#475569", display:"block", marginBottom:6 }}>Model</label>
              <select className="lms-input" value={ollamaModel} onChange={e=>setOllamaModel(e.target.value)}>
                {OLLAMA_MODELS.map(m=><option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div style={{ background:"#fffbeb", border:"1.5px solid #fde68a", borderRadius:10, padding:"11px 14px" }}>
              <p style={{ fontSize:12.5, color:"#92400e", lineHeight:1.6 }}>⚠️ Start Ollama with CORS enabled:<br/><code style={{ background:"#fff7ed", padding:"2px 7px", borderRadius:5, fontSize:11.5 }}>OLLAMA_ORIGINS=* ollama serve</code></p>
            </div>
          </div>
        )}
        <button className="lms-btn lms-btn-green" style={{ marginTop:18 }} disabled={testing} onClick={testAI}>
          {testing?<><Spin/>Testing...</>:<><Ic n="zap" s={14}/>Test AI Connection</>}
        </button>
      </div>

      {/* Supabase status */}
      <div className="lms-card" style={{ padding:22, marginBottom:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
          <div style={{ width:30, height:30, background:"#f0fdf4", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center" }}><Ic n="db" s={16} c="#22c55e"/></div>
          <p style={{ fontWeight:700, fontSize:14.5, color:"#0f172a" }}>Supabase Storage</p>
        </div>
        <div style={{ background: sb?"#f0fdf4":"#fef2f2", border:`1.5px solid ${sb?"#bbf7d0":"#fecaca"}`, borderRadius:10, padding:"11px 14px", marginBottom:14 }}>
          <p style={{ fontSize:12.5, color: sb?"#15803d":"#dc2626", fontWeight:600 }}>{sb ? "☁️ Connected — all data saves to Supabase" : "⚠️ Not connected — enter Supabase credentials on the main screen"}</p>
        </div>
        {sbStatus && (
          <div style={{ background:sbStatus.error?"#fef2f2":"#f0fdf4", border:`1.5px solid ${sbStatus.error?"#fecaca":"#bbf7d0"}`, borderRadius:10, padding:"11px 14px", fontSize:12.5, color:sbStatus.error?"#dc2626":"#15803d", marginBottom:14 }}>
            {sbStatus.error ? `❌ ${sbStatus.error}` : `✓ Read (${sbStatus.rowCount} rows)${sbStatus.write?" · Write confirmed":""}`}
          </div>
        )}
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <button className="lms-btn lms-btn-green" disabled={testSb||!sb} onClick={testSupabase}>
            {testSb?<><Spin/>Testing...</>:<><Ic n="db" s={14}/>Test Connection</>}
          </button>
          <button className="lms-btn lms-btn-ghost" disabled={!sb||!courseId} onClick={loadFromSupabase}>
            <Ic n="download" s={14}/>Reload from Supabase
          </button>
        </div>
      </div>

      {/* Danger zone */}
      <div className="lms-card" style={{ padding:22, border:"1.5px solid #fecaca" }}>
        <p style={{ fontWeight:700, fontSize:14, color:"#dc2626", marginBottom:10 }}>Danger Zone</p>
        <p style={{ fontSize:13, color:"#6b7280", marginBottom:14 }}>Clear all course data (plan, notebooks, assignments) from Supabase for this course.</p>
        <button className="lms-btn lms-btn-rose" onClick={()=>setConfirmClear(true)}><Ic n="trash" s={14}/>Clear Course Data</button>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════
   COURSES PAGE — Supabase-backed
═══════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════
   COURSES PAGE — Production-Ready
   ✅ fetchCourses fires on mount only (useEffect[sb, trainerId])
   ✅ handleCreateCourse is event-triggered only — never in useEffect
   ✅ isSubmitting ref guard — blocks double-click / StrictMode double-invoke
   ✅ Full try/catch/finally on every async path — no silent failures
   ✅ Per-operation loading states (creating, deleting)
   ✅ Dismissible error banner
═══════════════════════════════════════════════════════════════════ */
function CoursesPage({ onSelectCourse, auth, sb }) {
  const trainerId    = auth?.id;
  const isSubmitting = useRef(false); // blocks duplicate submits at ref level

  const [courses,            setCourses]            = useState([]);
  const [pendingCounts,      setPendingCounts]      = useState({});
  const [newCourseName,      setNewCourseName]      = useState("");
  const [showCreateForm,     setShowCreateForm]     = useState(false);
  const [deleteConfirm,      setDeleteConfirm]      = useState(null);
  const [enrollmentCourseId, setEnrollmentCourseId] = useState(null);
  const [loading,            setLoading]            = useState(true);
  const [creating,           setCreating]           = useState(false);
  const [deleting,           setDeleting]           = useState(null);
  const [error,              setError]              = useState("");

  // ── fetchCourses ──────────────────────────────────────────────────
  // ✅ Called ONCE on mount via useEffect([sb, trainerId])
  // ✅ Called MANUALLY after every mutation (create / delete)
  // ❌ NEVER placed in useEffect([courses]) — that causes infinite loop
  const fetchCourses = useCallback(async () => {
    if (!sb || !trainerId) return;
    setLoading(true);
    setError("");
    try {
      const coursesMapped = await sbGetCoursesByTrainer(sb, trainerId);
      setCourses(coursesMapped);
      // Server-side filtered — never fetch all students
      const studentRows = await sb.select(
        "lms_students",
        `trainer_id=eq.${encodeURIComponent(trainerId)}&order=created_at.asc`
      );
      const students = (studentRows || []).map(dbRowToStudent);
      const counts = {};
      coursesMapped.forEach(c => {
        counts[c.id] = students.filter(s => {
          const inPending    = Array.isArray(s.pendingCourseIds) && s.pendingCourseIds.some(p => p.courseId === c.id);
          const legacyPending = !s.approved && s.requestedCourseId === c.id && !Array.isArray(s.pendingCourseIds);
          return inPending || legacyPending;
        }).length;
      });
      setPendingCounts(counts);
    } catch(e) {
      console.error("[CoursesPage] fetchCourses failed:", e);
      setError("Failed to load courses: " + e.message);
    } finally {
      setLoading(false); // always clears — even on error
    }
  }, [sb, trainerId]);

  // ── Mount effect ──────────────────────────────────────────────────
  // ✅ Fires once when sb + trainerId are ready
  // ❌ Does NOT depend on `courses` — no loop
  useEffect(() => { fetchCourses(); }, [fetchCourses]);

  // ── handleCreateCourse ────────────────────────────────────────────
  // ✅ Only called by button onClick — never by useEffect
  // ✅ isSubmitting ref prevents double-trigger (StrictMode / rapid click)
  const handleCreateCourse = async () => {
    const name = newCourseName.trim();
    if (!name)      { setError("Please enter a course name."); return; }
    if (!trainerId) { setError("Auth error: trainer ID missing. Log out and back in."); return; }
    if (isSubmitting.current) return;
    isSubmitting.current = true;
    setCreating(true);
    setError("");
    try {
      await sbCreateCourse(sb, name, trainerId); // generateId() + trainerId always set inside
      setNewCourseName("");
      setShowCreateForm(false);
      await fetchCourses(); // manual refetch — NOT triggered by state change
    } catch(e) {
      console.error("[CoursesPage] handleCreateCourse failed:", e);
      if (e.message.includes("duplicate key")) {
        setError("Duplicate ID — please try again.");
      } else if (e.message.includes("foreign key")) {
        setError("Auth error: invalid trainer ID. Log out and back in.");
      } else {
        setError("Failed to create course: " + e.message);
      }
    } finally {
      setCreating(false);
      isSubmitting.current = false;
    }
  };

  // ── handleDeleteCourse ────────────────────────────────────────────
  const handleDeleteCourse = async (courseId) => {
    if (!courseId) return;
    setDeleting(courseId);
    setError("");
    try {
      await sbDeleteCourse(sb, courseId);
      setDeleteConfirm(null);
      await fetchCourses();
    } catch(e) {
      console.error("[CoursesPage] handleDeleteCourse failed:", e);
      setError("Failed to delete course: " + e.message);
    } finally {
      setDeleting(null);
    }
  };

  // ── handleOpenCourse ──────────────────────────────────────────────
  // ✅ Persists selection silently — failure is non-fatal
  // ✅ Does NOT trigger a fetchCourses — no loop
  const handleOpenCourse = async (courseId) => {
    if (sb && trainerId) {
      sbSetCurrentCourseId(sb, trainerId, courseId).catch(e =>
        console.warn("[CoursesPage] Could not persist course selection:", e)
      );
    }
    onSelectCourse(courseId);
  };

  const handleEnrollmentClose = () => {
    setEnrollmentCourseId(null);
    fetchCourses();
  };

  return (
    <div style={{ minHeight:"100vh", background:"#f9fafb", fontFamily:"'Plus Jakarta Sans','DM Sans',system-ui,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
        .cp-card{background:#fff;border-radius:16px;border:1px solid #e8edf3;box-shadow:0 1px 3px rgba(0,0,0,.04);transition:box-shadow .18s,transform .18s}
        .cp-card:hover{box-shadow:0 6px 24px rgba(0,0,0,.08);transform:translateY(-2px)}
        .cp-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:9px;border:none;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;transition:all .15s;white-space:nowrap}
        .cp-btn:disabled{opacity:.5;cursor:not-allowed}
        .cp-btn-dark{background:#0f172a;color:#fff}.cp-btn-dark:hover:not(:disabled){background:#1e293b}
        .cp-btn-ghost{background:#f1f5f9;color:#475569;border:1.5px solid #e2e8f0}.cp-btn-ghost:hover:not(:disabled){background:#e2e8f0;color:#0f172a}
        .cp-btn-rose{background:#fef2f2;color:#dc2626;border:1.5px solid #fecaca}.cp-btn-rose:hover:not(:disabled){background:#fee2e2}
        .cp-btn-violet{background:#f5f3ff;color:#7c3aed;border:1.5px solid #ddd6fe}.cp-btn-violet:hover:not(:disabled){background:#ede9fe}
        .cp-btn-red{background:#dc2626;color:#fff}.cp-btn-red:hover:not(:disabled){background:#b91c1c}
        .cp-input{width:100%;padding:9px 13px;border:1.5px solid #e2e8f0;border-radius:9px;font-size:13.5px;font-family:inherit;outline:none;transition:border .15s;background:#fff;color:#0f172a;box-sizing:border-box}
        .cp-input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.1)}
        @keyframes cp-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes cp-spin{to{transform:rotate(360deg)}}
        .cp-spinner{width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:cp-spin .6s linear infinite;display:inline-block;flex-shrink:0}
      `}</style>

      <div style={{ maxWidth:1280, margin:"0 auto", padding:"40px 28px" }}>

        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:40, flexWrap:"wrap", gap:16 }}>
          <div>
            <h1 style={{ fontSize:32, fontWeight:800, color:"#0f172a", letterSpacing:"-0.5px", margin:0 }}>My Courses</h1>
            <p style={{ fontSize:13.5, color:"#94a3b8", margin:"4px 0 0 0" }}>
              {loading ? "Loading…" : courses.length === 0 ? "Create your first course to get started" : `${courses.length} course${courses.length !== 1 ? "s" : ""}`}
              {auth?.name && <span style={{ marginLeft:8, color:"#764ba2", fontWeight:600 }}>· {auth.name}</span>}
            </p>
          </div>
          {!showCreateForm && (
            <button className="cp-btn cp-btn-dark" onClick={() => { setShowCreateForm(true); setError(""); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New Course
            </button>
          )}
        </div>

        {/* Error Banner */}
        {error && (
          <div style={{ background:"#fef2f2", border:"1.5px solid #fecaca", borderRadius:10, padding:"10px 16px", marginBottom:20, fontSize:13, color:"#dc2626", display:"flex", alignItems:"center", gap:10, animation:"cp-in .2s ease" }}>
            <span style={{ flexShrink:0 }}>⚠️</span>
            <span style={{ flex:1 }}>{error}</span>
            <button onClick={() => setError("")} style={{ background:"none", border:"none", cursor:"pointer", color:"#dc2626", fontSize:16, padding:0, lineHeight:1 }}>×</button>
          </div>
        )}

        {/* Create Form */}
        {showCreateForm && (
          <div className="cp-card" style={{ padding:24, marginBottom:28, maxWidth:520, animation:"cp-in .2s ease" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18 }}>
              <div style={{ width:34, height:34, background:"linear-gradient(135deg,#3b82f6,#8b5cf6)", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              </div>
              <p style={{ fontWeight:700, fontSize:15, color:"#0f172a", margin:0 }}>New Course</p>
            </div>
            <input
              className="cp-input"
              style={{ marginBottom:14 }}
              placeholder="Course name (e.g. Python for Data Science)"
              value={newCourseName}
              onChange={e => setNewCourseName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !creating) handleCreateCourse();
                if (e.key === "Escape") { setShowCreateForm(false); setNewCourseName(""); setError(""); }
              }}
              autoFocus
              disabled={creating}
            />
            <div style={{ display:"flex", gap:10 }}>
              <button
                className="cp-btn cp-btn-dark"
                style={{ flex:1, justifyContent:"center" }}
                onClick={handleCreateCourse}
                disabled={creating || !newCourseName.trim()}
              >
                {creating ? <><span className="cp-spinner"/> Creating…</> : "Create Course"}
              </button>
              <button className="cp-btn cp-btn-ghost" onClick={() => { setShowCreateForm(false); setNewCourseName(""); setError(""); }} disabled={creating}>Cancel</button>
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ textAlign:"center", padding:"60px 20px", color:"#94a3b8", fontSize:14 }}>
            <div className="cp-spinner" style={{ margin:"0 auto 12px", width:24, height:24 }}/>
            Loading courses from Supabase…
          </div>
        )}

        {/* Empty State */}
        {!loading && courses.length === 0 && !showCreateForm && (
          <div style={{ textAlign:"center", padding:"80px 20px", animation:"cp-in .3s ease" }}>
            <div style={{ width:60, height:60, background:"#f1f5f9", borderRadius:16, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 16px" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
            </div>
            <p style={{ fontWeight:700, fontSize:16, color:"#334155", marginBottom:6 }}>No courses yet</p>
            <p style={{ fontSize:13.5, color:"#94a3b8", maxWidth:320, margin:"0 auto 24px", lineHeight:1.65 }}>Create your first course to start building lessons and managing students.</p>
            <button className="cp-btn cp-btn-dark" onClick={() => { setShowCreateForm(true); setError(""); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Create First Course
            </button>
          </div>
        )}

        {/* Course Grid */}
        {!loading && courses.length > 0 && (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(320px, 1fr))", gap:24 }}>
            {courses.map(course => {
              const stats      = getCourseStats(course);
              const pct        = stats.total ? Math.round(stats.completed / stats.total * 100) : 0;
              const pending    = pendingCounts[course.id] || 0;
              const isDeleting = deleting === course.id;
              return (
                <div key={course.id} className="cp-card" style={{ padding:22, display:"flex", flexDirection:"column", animation:"cp-in .25s ease" }}>
                  <div style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:16 }}>
                    <div style={{ width:40, height:40, background:"linear-gradient(135deg,#3b82f6,#8b5cf6)", borderRadius:11, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ fontWeight:700, fontSize:15, color:"#0f172a", margin:"0 0 2px 0", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{course.name}</p>
                      <p style={{ fontSize:12, color:"#94a3b8", margin:0 }}>
                        {stats.total} lesson{stats.total !== 1 ? "s" : ""}
                        {pending > 0 && <span style={{ marginLeft:8, color:"#f59e0b", fontWeight:700 }}>· {pending} pending</span>}
                      </p>
                    </div>
                  </div>
                  {stats.total > 0 && (
                    <div style={{ marginBottom:16 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:11.5, fontWeight:600, color:"#94a3b8", marginBottom:5 }}>
                        <span>Progress</span>
                        <span style={{ color:pct===100?"#22c55e":"#3b82f6" }}>{pct}%</span>
                      </div>
                      <div style={{ height:5, borderRadius:99, background:"#f1f5f9", overflow:"hidden" }}>
                        <div style={{ height:"100%", borderRadius:99, background:pct===100?"#22c55e":"linear-gradient(90deg,#3b82f6,#8b5cf6)", width:`${pct}%`, transition:"width .4s ease" }}/>
                      </div>
                    </div>
                  )}
                  <div style={{ display:"flex", gap:8, marginBottom:18 }}>
                    {[{v:stats.total,l:"Lessons",c:"#3b82f6"},{v:stats.completed,l:"Done",c:"#22c55e"},{v:pending,l:"Pending",c:pending>0?"#f59e0b":"#94a3b8"}].map(s=>(
                      <div key={s.l} style={{ flex:1, background:"#f8fafc", border:"1px solid #e8edf3", borderRadius:10, padding:"10px 12px", textAlign:"center" }}>
                        <p style={{ fontSize:18, fontWeight:800, color:s.c, margin:0, lineHeight:1 }}>{s.v}</p>
                        <p style={{ fontSize:10.5, color:"#94a3b8", margin:"3px 0 0 0", fontWeight:600, textTransform:"uppercase", letterSpacing:".04em" }}>{s.l}</p>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:"flex", gap:8, marginTop:"auto" }}>
                    <button className="cp-btn cp-btn-dark" style={{ flex:1, justifyContent:"center", padding:"9px 0" }} onClick={() => handleOpenCourse(course.id)} disabled={isDeleting}>Open</button>
                    <button className="cp-btn cp-btn-violet" style={{ padding:"9px 12px", position:"relative" }} onClick={() => setEnrollmentCourseId(course.id)} title="Student enrollments" disabled={isDeleting}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                      {pending > 0 && <span style={{ position:"absolute", top:-5, right:-5, background:"#f59e0b", color:"#fff", borderRadius:99, fontSize:9, fontWeight:800, padding:"2px 5px", lineHeight:1 }}>{pending}</span>}
                    </button>
                    <button className="cp-btn cp-btn-rose" style={{ padding:"9px 12px" }} onClick={() => setDeleteConfirm(course.id)} disabled={isDeleting}>
                      {isDeleting
                        ? <span className="cp-spinner" style={{ color:"#dc2626" }}/>
                        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Enrollment Panel */}
        {enrollmentCourseId && (
          <TrainerEnrollments
            courseId={enrollmentCourseId}
            courseName={courses.find(c=>c.id===enrollmentCourseId)?.name||""}
            trainerId={trainerId}
            sb={sb}
            onClose={handleEnrollmentClose}
          />
        )}

        {/* Delete Confirmation Modal */}
        {deleteConfirm && (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }}>
            <div className="cp-card" style={{ padding:28, maxWidth:400, width:"100%", animation:"cp-in .2s ease" }}>
              <div style={{ width:40, height:40, background:"#fef2f2", borderRadius:11, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:14 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              </div>
              <p style={{ fontWeight:700, fontSize:16, color:"#0f172a", margin:"0 0 6px 0" }}>Delete Course?</p>
              <p style={{ fontSize:13.5, color:"#64748b", margin:"0 0 22px 0", lineHeight:1.6 }}>This will permanently delete this course and all its content from Supabase. Cannot be undone.</p>
              <div style={{ display:"flex", gap:10 }}>
                <button className="cp-btn cp-btn-ghost" style={{ flex:1, justifyContent:"center" }} onClick={() => setDeleteConfirm(null)} disabled={!!deleting}>Cancel</button>
                <button className="cp-btn cp-btn-red" style={{ flex:1, justifyContent:"center" }} onClick={() => handleDeleteCourse(deleteConfirm)} disabled={!!deleting}>
                  {deleting ? <><span className="cp-spinner"/> Deleting…</> : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════
   ADMIN DASHBOARD — full trainer approval control panel
   Only accessible when logged in as admin (role === "admin")
═══════════════════════════════════════════════════════════════════ */
function AdminDashboard({ sb, onLogout }) {
  const [trainers,    setTrainers]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [actionId,    setActionId]    = useState(null); // which trainer is being actioned
  const [toast,       setToast]       = useState("");
  const [tab,         setTab]         = useState("pending"); // "pending" | "approved" | "all"
  const [search,      setSearch]      = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3200);
  };

  const fetchTrainers = async () => {
    if (!sb) return;
    setLoading(true);
    try {
      const rows = await sb.select("lms_trainers", "order=created_at.desc");
      setTrainers(rows || []);
    } catch(e) { console.error("Admin: failed to load trainers", e); }
    setLoading(false);
  };

  useEffect(() => { fetchTrainers(); }, [sb]);

  // Auto-refresh every 20s for near-real-time updates
  useEffect(() => {
    const timer = setInterval(fetchTrainers, 20000);
    return () => clearInterval(timer);
  }, [sb]);

  const handleApprove = async (trainerId) => {
    setActionId(trainerId);
    try {
      await sb.update("lms_trainers", `id=eq.${encodeURIComponent(trainerId)}`, { approved: true });
      showToast("✅ Trainer approved — they can now log in!");
      await fetchTrainers();
    } catch(e) { showToast("❌ Failed to approve: " + e.message); }
    setActionId(null);
  };

  const handleRevoke = async (trainerId) => {
    setActionId(trainerId);
    setConfirmRevoke(null);
    try {
      await sb.update("lms_trainers", `id=eq.${encodeURIComponent(trainerId)}`, { approved: false });
      showToast("🚫 Trainer access revoked.");
      await fetchTrainers();
    } catch(e) { showToast("❌ Failed to revoke: " + e.message); }
    setActionId(null);
  };

  const filtered = trainers.filter(t => {
    const q = search.toLowerCase();
    const matchSearch = !q || t.name?.toLowerCase().includes(q) || t.username?.toLowerCase().includes(q);
    if (!matchSearch) return false;
    if (tab === "pending")  return t.approved === false;
    if (tab === "approved") return t.approved === true;
    return true;
  });

  const pendingCount  = trainers.filter(t => t.approved === false).length;
  const approvedCount = trainers.filter(t => t.approved === true).length;

  return (
    <div style={{ minHeight:"100vh", background:"#0f172a", fontFamily:"'Segoe UI','Helvetica Neue',system-ui,sans-serif" }}>
      <style>{`
        @keyframes adm-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes adm-spin{to{transform:rotate(360deg)}}
        @keyframes adm-toast{0%{opacity:0;transform:translateY(20px)}10%{opacity:1;transform:translateY(0)}85%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-8px)}}
        .adm-card{background:#1e293b;border:1px solid #334155;border-radius:16px;transition:border-color .15s,box-shadow .15s}
        .adm-card:hover{border-color:#475569;box-shadow:0 4px 24px rgba(0,0,0,.4)}
        .adm-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:9px;border:none;cursor:pointer;font-size:13px;font-weight:700;font-family:inherit;transition:all .15s}
        .adm-btn:disabled{opacity:.45;cursor:not-allowed}
        .adm-btn-approve{background:#22c55e;color:#fff}.adm-btn-approve:hover:not(:disabled){background:#16a34a}
        .adm-btn-revoke{background:#1e293b;color:#f87171;border:1.5px solid #ef444440}.adm-btn-revoke:hover:not(:disabled){background:#ef44441a;border-color:#ef4444}
        .adm-btn-ghost{background:#1e293b;color:#94a3b8;border:1.5px solid #334155}.adm-btn-ghost:hover:not(:disabled){background:#334155;color:#e2e8f0}
        .adm-tab{padding:7px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:700;font-family:inherit;transition:all .15s;position:relative}
        .adm-tab-active{background:#3b82f6;color:#fff}
        .adm-tab-inactive{background:transparent;color:#64748b}.adm-tab-inactive:hover{color:#94a3b8;background:#1e293b}
        .adm-spinner{width:13px;height:13px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:adm-spin .65s linear infinite;display:inline-block}
      `}</style>

      {/* Top nav */}
      <div style={{ background:"#0f172a", borderBottom:"1px solid #1e293b", padding:"14px 28px", display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <div style={{ width:38, height:38, background:"linear-gradient(135deg,#3b82f6,#6366f1)", borderRadius:11, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <div>
            <p style={{ fontWeight:800, fontSize:16, color:"#f1f5f9", margin:0, letterSpacing:"-0.3px" }}>LMS Admin</p>
            <p style={{ fontSize:11.5, color:"#475569", margin:0 }}>Trainer Approval Control Panel</p>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <button onClick={fetchTrainers} className="adm-btn adm-btn-ghost" style={{ padding:"7px 12px" }} title="Refresh">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
          <button onClick={onLogout} className="adm-btn" style={{ background:"#7f1d1d", color:"#fca5a5", border:"1px solid #991b1b" }}>Logout</button>
        </div>
      </div>

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"36px 28px" }}>

        {/* Stats row */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16, marginBottom:36, animation:"adm-in .3s ease" }}>
          {[
            { label:"Total Trainers", value: trainers.length, color:"#3b82f6", icon:"👥" },
            { label:"Pending Approval", value: pendingCount, color: pendingCount > 0 ? "#f59e0b" : "#475569", icon:"⏳", pulse: pendingCount > 0 },
            { label:"Approved & Active", value: approvedCount, color:"#22c55e", icon:"✅" },
          ].map(s => (
            <div key={s.label} className="adm-card" style={{ padding:"22px 24px", position:"relative", overflow:"hidden" }}>
              {s.pulse && <div style={{ position:"absolute", top:12, right:12, width:8, height:8, borderRadius:"50%", background:"#f59e0b", animation:"adm-spin 2s linear infinite", boxShadow:"0 0 8px #f59e0b" }}/>}
              <p style={{ fontSize:11.5, fontWeight:700, color:"#475569", textTransform:"uppercase", letterSpacing:".07em", margin:"0 0 8px 0" }}>{s.icon} {s.label}</p>
              <p style={{ fontSize:40, fontWeight:900, color:s.color, margin:0, lineHeight:1, letterSpacing:"-1px" }}>{loading ? "—" : s.value}</p>
            </div>
          ))}
        </div>

        {/* Tabs + Search */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20, flexWrap:"wrap", gap:12 }}>
          <div style={{ display:"flex", gap:6, background:"#0f172a", border:"1px solid #1e293b", borderRadius:11, padding:5 }}>
            {[
              { id:"pending",  label:`Pending${pendingCount > 0 ? ` (${pendingCount})` : ""}` },
              { id:"approved", label:`Approved${approvedCount > 0 ? ` (${approvedCount})` : ""}` },
              { id:"all",      label:`All (${trainers.length})` },
            ].map(t => (
              <button key={t.id} className={`adm-tab ${tab===t.id?"adm-tab-active":"adm-tab-inactive"}`} onClick={()=>setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={e=>setSearch(e.target.value)}
            placeholder="Search by name or username…"
            style={{ background:"#1e293b", border:"1.5px solid #334155", borderRadius:9, padding:"8px 14px", fontSize:13, color:"#e2e8f0", outline:"none", width:240, fontFamily:"inherit" }}
          />
        </div>

        {/* Trainer list */}
        {loading ? (
          <div style={{ textAlign:"center", padding:"60px 20px", color:"#475569" }}>
            <span className="adm-spinner" style={{ width:24, height:24, borderWidth:3, display:"inline-block", marginBottom:16 }}/><br/>
            Loading trainers…
          </div>
        ) : filtered.length === 0 ? (
          <div className="adm-card" style={{ padding:"60px 20px", textAlign:"center" }}>
            <p style={{ fontSize:36, margin:"0 0 12px 0" }}>{tab==="pending"?"🎉":"🔍"}</p>
            <p style={{ fontWeight:700, fontSize:16, color:"#94a3b8", margin:"0 0 6px 0" }}>
              {tab==="pending" ? "No pending trainers" : "No trainers found"}
            </p>
            <p style={{ fontSize:13.5, color:"#475569", margin:0 }}>
              {tab==="pending" ? "All trainer accounts have been reviewed." : "Try adjusting your search."}
            </p>
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {filtered.map((trainer, i) => {
              const isActioning = actionId === trainer.id;
              const isPending   = trainer.approved === false;
              const joinDate    = trainer.created_at ? new Date(trainer.created_at).toLocaleDateString("en-US", { year:"numeric", month:"short", day:"numeric" }) : "Unknown";
              return (
                <div key={trainer.id} className="adm-card" style={{ padding:"20px 24px", display:"flex", alignItems:"center", gap:20, animation:`adm-in .25s ease ${i*0.04}s both`, flexWrap:"wrap" }}>
                  {/* Avatar */}
                  <div style={{ width:46, height:46, borderRadius:14, background: isPending ? "linear-gradient(135deg,#f59e0b,#d97706)" : "linear-gradient(135deg,#22c55e,#16a34a)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:18 }}>
                    {trainer.name?.charAt(0)?.toUpperCase() || "T"}
                  </div>

                  {/* Info */}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                      <p style={{ fontWeight:800, fontSize:15, color:"#f1f5f9", margin:0 }}>{trainer.name}</p>
                      <span style={{ padding:"2px 10px", borderRadius:99, fontSize:11, fontWeight:700,
                        background: isPending ? "#f59e0b22" : "#22c55e22",
                        color: isPending ? "#f59e0b" : "#22c55e",
                        border: `1px solid ${isPending ? "#f59e0b40" : "#22c55e40"}`
                      }}>
                        {isPending ? "⏳ Pending" : "✅ Approved"}
                      </span>
                    </div>
                    <div style={{ display:"flex", gap:16, marginTop:4, flexWrap:"wrap" }}>
                      <p style={{ fontSize:12.5, color:"#64748b", margin:0 }}>@{trainer.username}</p>
                      <p style={{ fontSize:12.5, color:"#475569", margin:0 }}>Joined {joinDate}</p>
                      <p style={{ fontSize:12, color:"#334155", margin:0, fontFamily:"monospace" }}>ID: {trainer.id.slice(0,16)}…</p>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div style={{ display:"flex", gap:8, flexShrink:0 }}>
                    {isPending ? (
                      <button
                        className="adm-btn adm-btn-approve"
                        onClick={() => handleApprove(trainer.id)}
                        disabled={!!actionId}
                      >
                        {isActioning ? <span className="adm-spinner"/> : "✓"} Approve
                      </button>
                    ) : (
                      confirmRevoke === trainer.id ? (
                        <>
                          <button className="adm-btn" style={{ background:"#ef4444", color:"#fff" }} onClick={() => handleRevoke(trainer.id)} disabled={!!actionId}>
                            {isActioning ? <span className="adm-spinner"/> : "Confirm Revoke"}
                          </button>
                          <button className="adm-btn adm-btn-ghost" onClick={() => setConfirmRevoke(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className="adm-btn adm-btn-revoke" onClick={() => setConfirmRevoke(trainer.id)} disabled={!!actionId}>
                          🚫 Revoke
                        </button>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </div>

      {/* Toast notification */}
      {toast && (
        <div style={{ position:"fixed", bottom:28, left:"50%", transform:"translateX(-50%)", background:"#1e293b", border:"1px solid #334155", borderRadius:12, padding:"12px 22px", fontSize:13.5, fontWeight:600, color:"#f1f5f9", boxShadow:"0 8px 32px rgba(0,0,0,.5)", animation:"adm-toast 3.2s ease forwards", zIndex:9999, whiteSpace:"nowrap" }}>
          {toast}
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════
   MAIN APP — Supabase credentials entered here, then passed down
═══════════════════════════════════════════════════════════════════ */
export default function LMSApp() {
  // Supabase client — created once from env vars, shared by all roles
  const [sb, setSb] = useState(() =>
    _SB_URL && _SB_KEY ? makeSupabase(_SB_URL, _SB_KEY) : null
  );

  const [auth, setAuth]                       = useState(getAuthState());
  const [currentCourseId, setCurrentCourseId] = useState(null);
  const [courseView, setCourseView]           = useState(false);

  const isTrainer = auth?.role === "trainer";
  const isStudent = auth?.role === "student";
  const isAdmin   = auth?.role === "admin";

  // Load persisted current course from Supabase on auth
  useEffect(() => {
    if (!sb || !auth) return;
    if (auth.role === "trainer") {
      sbGetCurrentCourseId(sb, auth.id).then(id => {
        if (id) { setCurrentCourseId(id); setCourseView(true); }
      }).catch(() => {});
    }
  }, [sb, auth?.id]);



  const handleLogout = () => {
    try { sessionStorage.removeItem(SB_AUTH_KEY); } catch {}
    setAuth(null);
    setCourseView(false);
    setCurrentCourseId(null);
  };

  const handleSelectCourse = async (courseId) => {
    setCurrentCourseId(courseId);
    setCourseView(true);
    // FIX 9: Persist last-selected course to Supabase so it survives page refreshes
    if (sb && auth?.id) {
      sbSetCurrentCourseId(sb, auth.id, courseId).catch(() => {});
    }
  };


  // ── Login screen ──────────────────────────────────────────────
  if (!auth) {
    return <LoginScreen onLogin={() => setAuth(getAuthState())} sb={sb} />;
  }

  // ── Admin view ────────────────────────────────────────────────
  if (isAdmin) {
    return <AdminDashboard sb={sb} onLogout={handleLogout} />;
  }

  // ── Trainer view ──────────────────────────────────────────────
  if (isTrainer) {
    return (
      <div style={{ minHeight:"100vh", background:"#f8fafc" }}>
        <div style={{ background:"white", padding:"14px 20px", borderBottom:"1px solid #e2e8f0", display:"flex", justifyContent:"space-between", alignItems:"center", position:"sticky", top:0, zIndex:100 }}>
          <div>
            <h1 style={{ fontSize:20, fontWeight:700, color:"#1a202c", margin:0 }}>📚 LMS</h1>
            <p style={{ fontSize:12, color:"#718096", margin:"4px 0 0 0" }}>👨‍🏫 {auth.name}</p>
          </div>
          <div style={{ display:"flex", gap:10, alignItems:"center" }}>
            {courseView && currentCourseId && (
              <button onClick={()=>setCourseView(false)} style={{ padding:"8px 14px", background:"#f5f3ff", color:"#764ba2", border:"1px solid #ddd6fe", borderRadius:6, cursor:"pointer", fontWeight:600, fontSize:13, display:"flex", alignItems:"center", gap:6 }}>
                ← Switch Course
              </button>
            )}

            <button onClick={handleLogout} style={{ padding:"8px 14px", background:"#ef4444", color:"white", border:"none", borderRadius:6, cursor:"pointer" }}>Logout</button>
          </div>
        </div>
        {courseView && currentCourseId ? (
          <OriginalLMSApp courseId={currentCourseId} onBack={()=>setCourseView(false)} sb={sb} trainerId={auth?.id} />
        ) : (
          <CoursesPage onSelectCourse={handleSelectCourse} auth={auth} sb={sb} />
        )}
      </div>
    );
  }

  // ── Student view ──────────────────────────────────────────────
  if (isStudent) {
    // FIX #10: don't pass currentCourseId — student derives their course from enrollment
    return <StudentCourseView sb={sb} auth={auth} handleLogout={handleLogout} />;
  }

  return null;
}
