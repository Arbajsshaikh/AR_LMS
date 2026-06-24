/**
 * ═══════════════════════════════════════════════════════════════════
 *  LMS AGENTIC AI FEATURES — All 10 Agents
 *  Drop this file alongside LMSApp.jsx and import what you need.
 *
 *  TRAINER AGENTS (1–5):
 *   1. AutonomousCourseArchitect  — one-prompt → full course loop
 *   2. SmartGapDetector           — reads lms_student_activity, flags failing days
 *   3. AIScheduleOptimizer        — reorders topic list by learning dependencies
 *   4. AutoContentRefresh         — monitors pass rates, stages improved content
 *   5. AutomatedAnnouncementsAgent — event-driven draft queue, trainer approves
 *
 *  STUDENT AGENTS (6–9):
 *   6. PersonalizedAITutor        — scoped chat panel on every day view
 *   7. AdaptiveLearningPath       — post-day mastery analysis → next-5 reorder
 *   8. AIAssignmentReviewer       — reuploads → AI rubric feedback → stored
 *   9. DynamicQuizGenerator       — per-student personalised quiz variant
 *
 *  ADMIN AGENT (10):
 *   10. PlatformIntelligenceAgent — cross-trainer audit: anomalies, cheating, trends
 *
 *  ── HOW TO WIRE ──
 *  1. Copy this file next to LMSApp.jsx.
 *  2. Import the components you need at the top of LMSApp.jsx:
 *       import {
 *         AutonomousCourseArchitect, SmartGapDetector,
 *         AIScheduleOptimizer, AutoContentRefresh,
 *         AutomatedAnnouncementsAgent, PersonalizedAITutor,
 *         AdaptiveLearningPath, AIAssignmentReviewer,
 *         DynamicQuizGenerator, PlatformIntelligenceAgent,
 *       } from "./LMS_Agents";
 *
 *  3. DB changes needed (run once in Supabase SQL editor):
 *     — see SQL_MIGRATIONS below for 2 small additions.
 *
 *  4. Wire each component as shown in the integration notes above
 *     each export.
 * ═══════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback } from "react";

/* ─────────────────────────────────────────────────────────────────
   SQL_MIGRATIONS  (run once in Supabase SQL editor)
   ─────────────────────────────────────────────────────────────────
   -- Agent 5: announcement drafts queue
   create table if not exists lms_announcement_drafts (
     id           text primary key,
     course_id    text not null,
     trainer_id   text,
     trigger_type text not null,  -- 'inactive_student'|'course_halfway'|'quiz_ace'|'manual'
     subject      text not null,
     body         text not null,
     recipients   jsonb default '[]',
     status       text default 'pending',  -- 'pending'|'sent'|'dismissed'
     created_at   timestamptz default now()
   );

   -- Agent 8: assignment review results
   -- Uses existing lms_day_files; just adds 2 columns (safe alter):
   alter table lms_day_files
     add column if not exists ai_review   jsonb,
     add column if not exists review_at   timestamptz;

   -- Agent 7: adaptive path overrides per student
   create table if not exists lms_student_adaptive_path (
     id          text primary key,   -- "{studentId}__{courseId}"
     student_id  text not null,
     course_id   text not null,
     reordered   jsonb default '[]', -- [{dayNum, topic, reason}]
     updated_at  timestamptz default now()
   );
─────────────────────────────────────────────────────────────────── */

/* ═══════════════════════════════════════════════════════════════════
   SHARED HELPERS
═══════════════════════════════════════════════════════════════════ */

/** Tiny Groq caller — same pattern as the main app's callGroq helper.
 *  Accepts the already-validated groqKey + model so it never needs
 *  to touch React state.  Throws on API error. */
async function agentCallGroq(groqKey, model, messages, opts = {}) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: model || "llama-3.3-70b-versatile",
      temperature: opts.temperature ?? 0.5,
      max_tokens: opts.maxTokens ?? 4000,
      response_format: opts.json ? { type: "json_object" } : undefined,
      messages,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Groq ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  return j.choices?.[0]?.message?.content || "";
}

/** Parse JSON safely; returns null on failure. */
function safeJson(str) {
  try {
    const clean = (str || "").replace(/^```json\s*/i, "").replace(/```\s*$/g, "").trim();
    return JSON.parse(clean);
  } catch { return null; }
}

/** Shared Spin component (mirrors the main app's). */
function Spin({ s = 14 }) {
  return (
    <span style={{
      display: "inline-block", width: s, height: s,
      border: "2px solid currentColor", borderTopColor: "transparent",
      borderRadius: "50%", animation: "lms-spin .7s linear infinite", flexShrink: 0,
    }} />
  );
}

/** Agent card shell — consistent neumorphic styling. */
function AgentCard({ title, icon, children, darkMode }) {
  const bg = darkMode ? "#1e293b" : "linear-gradient(145deg,#EDF1F7,#E4E9F2)";
  const border = darkMode ? "#334155" : "#fff";
  return (
    <div style={{
      background: bg, border: `1px solid ${border}`, borderRadius: 20,
      boxShadow: darkMode ? "none" : "12px 12px 28px #C4CDD9,-8px -8px 20px #fff",
      padding: "22px 24px", marginBottom: 20,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, paddingBottom: 14, borderBottom: `1px solid ${darkMode ? "#334155" : "#C4CDD9"}` }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <span style={{ fontWeight: 800, fontSize: 16, color: darkMode ? "#e2e8f0" : "#0f172a" }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT 1 — AUTONOMOUS COURSE ARCHITECT
   ─────────────────────────────────────────────────────────────────
   INTEGRATION (Trainer sidebar, Setup page):
     <AutonomousCourseArchitect
       groqKey={groqKey} groqModel={groqModel}
       planDays={planDays} startDate={startDate}
       courseId={courseId} sb={sb}
       onCourseBuilt={(days) => { setPlanDays(days); setPage("calendar"); notify("Course built!"); }}
       genNotebook={genNotebook} genExamples={genExamples}
       genResources={genResources} genAssignment={genAssignment}
       genQuiz={genQuiz} genTeachingGuide={genTeachingGuide}
       dayMap={dayMap} notify={notify}
     />
═══════════════════════════════════════════════════════════════════ */
export function AutonomousCourseArchitect({
  groqKey, groqModel, planDays = [], dayMap = {},
  onCourseBuilt, genNotebook, genExamples,
  genResources, genAssignment, genQuiz, genTeachingGuide,
  notify, darkMode,
}) {
  const [prompt, setPrompt] = useState("");
  const [numDays, setNumDays] = useState(10);
  const [phase, setPhase] = useState("idle"); // idle | planning | generating | done
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [log, setLog] = useState([]);
  const [open, setOpen] = useState(false);
  const abortRef = useRef(false);

  const addLog = (msg) => setLog((p) => [...p, { msg, ts: Date.now() }]);

  const run = async () => {
    if (!groqKey) { notify("Enter Groq API key in Settings first", "err"); return; }
    if (!prompt.trim()) { notify("Describe your course topic", "err"); return; }
    abortRef.current = false;
    setPhase("planning");
    setLog([]);
    addLog("🧠 Planning course structure…");

    let days;
    try {
      const planJson = await agentCallGroq(groqKey, groqModel, [
        {
          role: "system",
          content: `You are a curriculum architect. Return ONLY valid JSON — no markdown, no preamble.
Format: {"days":[{"dayNum":1,"topic":"Topic Name","subTopics":"sub-topic 1, sub-topic 2"},...]}
Rules: exactly ${numDays} days, each topic is a clear Python/ML lesson title, subTopics is a comma-separated string of 3-4 sub-topics per day.`,
        },
        {
          role: "user",
          content: `Create a ${numDays}-day course plan for: "${prompt.trim()}". Progressive difficulty, no duplicates.`,
        },
      ], { json: true, maxTokens: 2000 });

      const parsed = safeJson(planJson);
      days = parsed?.days;
      if (!Array.isArray(days) || days.length === 0) throw new Error("Invalid plan structure");
      addLog(`✅ Plan ready — ${days.length} days`);
    } catch (e) {
      notify(`Planning failed: ${e.message}`, "err");
      setPhase("idle");
      return;
    }

    // Fire onCourseBuilt so planDays are registered and dayMap gets built
    if (onCourseBuilt) onCourseBuilt(days);

    // Give React one tick to rebuild dayMap before generating content
    await new Promise((r) => setTimeout(r, 400));

    setPhase("generating");
    setProgress({ current: 0, total: days.length, label: "" });
    addLog("🏗 Generating content for each day…");

    // Re-derive dayMap from the date-string keys React just set
    // We iterate planDays by index and reconstruct day objects with keys
    for (let i = 0; i < days.length; i++) {
      if (abortRef.current) { addLog("⛔ Stopped by user"); break; }
      const d = days[i];
      // Build a synthetic day key matching the LMS convention YYYY-MM-DD
      // Real dayMap is only available inside OriginalLMSApp; we call gen functions
      // with the day object and let them resolve the key internally.
      // Gen functions expect { key, dayNum, topic } — key comes from dayMap built in parent.
      // We inject subTopics via a side-channel in dayData in the parent through opts.
      const dayObj = { key: null, dayNum: d.dayNum, topic: d.topic, subTopics: d.subTopics };
      setProgress({ current: i + 1, total: days.length, label: `Day ${d.dayNum}: ${d.topic}` });
      addLog(`📓 Day ${d.dayNum}: Notebook…`);

      try {
        // Gen functions handle their own error; silent:true so they throw instead of toasting
        if (genNotebook) await genNotebook(dayObj, { silent: true, subTopicsOverride: d.subTopics });
        if (abortRef.current) break;
        addLog(`⚡ Day ${d.dayNum}: Examples…`);
        if (genExamples) await genExamples(dayObj, { silent: true });
        if (abortRef.current) break;
        addLog(`📂 Day ${d.dayNum}: Resources…`);
        if (genResources) await genResources(dayObj, { silent: true });
        if (abortRef.current) break;
        addLog(`📝 Day ${d.dayNum}: Assignment…`);
        if (genAssignment) await genAssignment(dayObj, { silent: true });
        if (abortRef.current) break;
        addLog(`🎯 Day ${d.dayNum}: Quiz…`);
        if (genQuiz) await genQuiz(dayObj, { silent: true });
        if (abortRef.current) break;
        addLog(`🧑‍🏫 Day ${d.dayNum}: Teaching Guide…`);
        if (genTeachingGuide) await genTeachingGuide(dayObj, { silent: true });
        addLog(`✅ Day ${d.dayNum} complete`);
      } catch (e) {
        addLog(`⚠ Day ${d.dayNum} error: ${e.message} — continuing`);
      }

      // Polite delay to avoid rate-limits
      await new Promise((r) => setTimeout(r, 600));
    }

    setPhase("done");
    notify("🎉 Course fully generated!");
  };

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <AgentCard title="Autonomous Course Architect" icon="🏗" darkMode={darkMode}>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="lms-btn lms-btn-violet"
          style={{ width: "100%" }}
        >
          🤖 Build Full Course Automatically
        </button>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <textarea
            className="lms-input"
            rows={3}
            placeholder="e.g. 'Machine Learning for beginners using scikit-learn' — one sentence describing the course"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ fontSize: 13, fontWeight: 700, color: "#64748b", whiteSpace: "nowrap" }}>Days</label>
            <input
              type="number" min={3} max={60} value={numDays}
              onChange={(e) => setNumDays(Math.max(3, Math.min(60, +e.target.value)))}
              className="lms-input" style={{ width: 80 }}
            />
          </div>

          {phase !== "idle" && (
            <div style={{ background: "#0d1117", borderRadius: 12, padding: 14 }}>
              {phase === "generating" && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8", marginBottom: 5 }}>
                    <span>{progress.label}</span>
                    <span>{pct}%</span>
                  </div>
                  <div style={{ height: 5, borderRadius: 99, background: "#1e293b", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#8b5cf6,#3b82f6)", transition: "width .4s" }} />
                  </div>
                </div>
              )}
              <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                {log.map((l, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace" }}>{l.msg}</div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            {(phase === "idle" || phase === "done") && (
              <button className="lms-btn lms-btn-violet" onClick={run} style={{ flex: 1 }}>
                {phase === "done" ? "🔄 Rebuild Course" : "🚀 Build Course"}
              </button>
            )}
            {(phase === "planning" || phase === "generating") && (
              <button className="lms-btn lms-btn-rose" onClick={() => { abortRef.current = true; setPhase("idle"); }}>
                ⛔ Stop
              </button>
            )}
            <button className="lms-btn lms-btn-ghost" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </AgentCard>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT 2 — SMART GAP DETECTOR
   ─────────────────────────────────────────────────────────────────
   INTEGRATION (Trainer Performance page or sidebar):
     <SmartGapDetector
       sb={sb} courseId={courseId} planDays={planDays}
       dayMap={dayMap} groqKey={groqKey} groqModel={groqModel}
       notify={notify} darkMode={darkMode}
     />
═══════════════════════════════════════════════════════════════════ */
export function SmartGapDetector({ sb, courseId, planDays = [], dayMap = {}, groqKey, groqModel, notify, darkMode }) {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);

  const analyze = async () => {
    if (!sb || !courseId) { notify("Supabase not connected", "err"); return; }
    if (!groqKey) { notify("Enter Groq API key in Settings", "err"); return; }
    setLoading(true);
    setReport(null);
    try {
      // Load all student activity rows for this course
      const rows = await sb.select("lms_student_activity", `course_id=eq.${encodeURIComponent(courseId)}`);
      const activityMap = {};
      for (const r of (rows || [])) activityMap[r.student_id] = r.activity || {};

      if (Object.keys(activityMap).length === 0) {
        setReport({ error: "No student activity data yet. Students need to start using the course." });
        return;
      }

      // Build a concise summary for the AI
      const indexToKey = {};
      for (const [k, idx] of Object.entries(dayMap)) indexToKey[idx] = k;

      const daySummaries = planDays.map((d, i) => {
        const key = indexToKey[i];
        const scores = [], views = [], runs = [];
        for (const act of Object.values(activityMap)) {
          if (act.quizScores?.[key]) scores.push(act.quizScores[key].pct);
          if (act.notebookViews?.[key]) views.push(1);
          if (act.codeRuns?.[key]) runs.push(act.codeRuns[key]);
        }
        const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
        return {
          dayNum: d.dayNum, topic: d.topic,
          avgQuizPct: avgScore, quizAttempts: scores.length,
          notebookViews: views.length, codeRuns: runs.reduce((a, b) => a + b, 0),
          totalStudents: Object.keys(activityMap).length,
        };
      });

      // Find inactive students (last seen > 3 days ago)
      const inactiveStudents = [];
      const cutoff = Date.now() - 3 * 86400000;
      for (const [sid, act] of Object.entries(activityMap)) {
        const ls = act.lastSeen ? new Date(act.lastSeen).getTime() : 0;
        if (ls < cutoff) inactiveStudents.push({ studentId: sid, lastSeen: act.lastSeen });
      }

      const dataStr = JSON.stringify({ daySummaries: daySummaries.slice(0, 30), inactiveStudents }, null, 2);

      const analysis = await agentCallGroq(groqKey, groqModel, [
        {
          role: "system",
          content: `You are an expert learning analytics consultant. Analyse LMS activity data and return ONLY valid JSON.
Format:
{
  "failing_days": [{"dayNum":N,"topic":"...","avgQuizPct":N,"reason":"...","recommendation":"..."}],
  "quiz_weak_topics": [{"topic":"...","issue":"..."}],
  "dropout_risk_count": N,
  "top_issues": ["concise issue 1","issue 2","issue 3"],
  "trainer_actions": ["specific action 1","action 2","action 3"]
}`,
        },
        {
          role: "user",
          content: `Analyse this LMS course data and identify gaps, failing days, at-risk students, and weak quiz topics:\n\n${dataStr}`,
        },
      ], { json: true, maxTokens: 1500 });

      const parsed = safeJson(analysis);
      if (!parsed) throw new Error("Could not parse AI analysis");
      setReport({ ...parsed, inactiveCount: inactiveStudents.length, totalStudents: Object.keys(activityMap).length });
    } catch (e) {
      notify(`Gap analysis failed: ${e.message}`, "err");
    } finally {
      setLoading(false);
    }
  };

  const tag = (color, text) => (
    <span style={{ padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: color + "18", color, border: `1px solid ${color}44` }}>{text}</span>
  );

  return (
    <AgentCard title="Smart Gap Detector" icon="🔍" darkMode={darkMode}>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
        Reads all student activity to flag failing days, weak quiz topics, and dropout risks — no manual analysis needed.
      </p>
      <button className="lms-btn lms-btn-blue" onClick={analyze} disabled={loading} style={{ width: "100%" }}>
        {loading ? <><Spin />Analysing…</> : "🔍 Run Gap Analysis"}
      </button>

      {report?.error && (
        <div style={{ marginTop: 14, padding: "12px 16px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 12, fontSize: 13, color: "#dc2626" }}>
          {report.error}
        </div>
      )}

      {report && !report.error && (
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              { label: "Total Students", val: report.totalStudents, color: "#3b82f6" },
              { label: "Inactive (3d+)", val: report.inactiveCount, color: report.inactiveCount > 0 ? "#f59e0b" : "#22c55e" },
              { label: "Failing Days", val: report.failing_days?.length || 0, color: (report.failing_days?.length || 0) > 0 ? "#ef4444" : "#22c55e" },
            ].map((s) => (
              <div key={s.label} style={{ textAlign: "center", background: "linear-gradient(145deg,#EDF1F7,#E4E9F2)", border: "1px solid #fff", borderRadius: 14, padding: "10px 8px", boxShadow: "6px 6px 14px #C4CDD9,-4px -4px 10px #fff" }}>
                <div style={{ fontSize: 22, fontWeight: 900, color: s.color }}>{s.val}</div>
                <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Failing days */}
          {report.failing_days?.length > 0 && (
            <div>
              <p style={{ fontSize: 12, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Failing Days</p>
              {report.failing_days.map((d, i) => (
                <div key={i} style={{ background: "#fef2f222", border: "1px solid #fecaca44", borderRadius: 12, padding: "10px 14px", marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 800, fontSize: 13.5, color: "#dc2626" }}>Day {d.dayNum}: {d.topic}</span>
                    {d.avgQuizPct != null && tag("#ef4444", `Avg Quiz: ${d.avgQuizPct}%`)}
                  </div>
                  <p style={{ fontSize: 12.5, color: "#64748b", margin: "2px 0" }}>{d.reason}</p>
                  <p style={{ fontSize: 12.5, color: "#0d9488", fontWeight: 600, margin: "4px 0 0" }}>→ {d.recommendation}</p>
                </div>
              ))}
            </div>
          )}

          {/* Trainer actions */}
          {report.trainer_actions?.length > 0 && (
            <div>
              <p style={{ fontSize: 12, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Recommended Actions</p>
              {report.trainer_actions.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 12px", background: "rgba(20,184,166,.06)", border: "1px solid rgba(20,184,166,.2)", borderRadius: 10, marginBottom: 6 }}>
                  <span style={{ color: "#0d9488", fontWeight: 800, flexShrink: 0 }}>{i + 1}.</span>
                  <span style={{ fontSize: 13, color: "#0f172a" }}>{a}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </AgentCard>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT 3 — AI SCHEDULE OPTIMIZER
   ─────────────────────────────────────────────────────────────────
   INTEGRATION (Setup page, between planText textarea and Parse button):
     <AIScheduleOptimizer
       planText={planText} groqKey={groqKey} groqModel={groqModel}
       onOptimized={(optimizedPlanText) => setPlanText(optimizedPlanText)}
       notify={notify} darkMode={darkMode}
     />
═══════════════════════════════════════════════════════════════════ */
export function AIScheduleOptimizer({ planText, groqKey, groqModel, onOptimized, notify, darkMode }) {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);

  const optimize = async () => {
    if (!planText?.trim()) { notify("Paste a topic list above first", "err"); return; }
    if (!groqKey) { notify("Enter Groq API key in Settings", "err"); return; }
    setLoading(true);
    setPreview(null);
    try {
      const result = await agentCallGroq(groqKey, groqModel, [
        {
          role: "system",
          content: `You are a curriculum sequencing expert. Reorder the provided lesson list so prerequisites always come before advanced topics, and lighter days are spaced between heavy ones. Return ONLY valid JSON:
{"plan": "Day 1: Topic\\nDay 2: Topic\\n...", "changes": ["moved X before Y because...", ...], "rationale": "2-sentence explanation"}`,
        },
        {
          role: "user",
          content: `Optimise this lesson schedule by learning dependencies:\n\n${planText.trim()}`,
        },
      ], { json: true, maxTokens: 2000 });

      const parsed = safeJson(result);
      if (!parsed?.plan) throw new Error("Could not parse optimized schedule");
      setPreview(parsed);
    } catch (e) {
      notify(`Schedule optimisation failed: ${e.message}`, "err");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop: 10, marginBottom: 10 }}>
      <button className="lms-btn lms-btn-green" onClick={optimize} disabled={loading || !planText?.trim()}>
        {loading ? <><Spin />Optimizing…</> : "✨ AI Optimize Schedule Order"}
      </button>

      {preview && (
        <div style={{ marginTop: 14, background: "linear-gradient(145deg,#EDF1F7,#E4E9F2)", border: "1px solid #fff", borderRadius: 16, padding: 18, boxShadow: "8px 8px 20px #C4CDD9,-5px -5px 14px #fff" }}>
          <p style={{ fontSize: 13, fontWeight: 800, color: "#0d9488", marginBottom: 8 }}>✅ Optimized Schedule Preview</p>
          <p style={{ fontSize: 12.5, color: "#64748b", marginBottom: 10, lineHeight: 1.6 }}>{preview.rationale}</p>
          {preview.changes?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: 11.5, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Key changes</p>
              {preview.changes.slice(0, 4).map((c, i) => (
                <div key={i} style={{ fontSize: 12, color: "#475569", padding: "4px 0", borderBottom: "1px solid #e2e8f0" }}>→ {c}</div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="lms-btn lms-btn-green" onClick={() => { onOptimized(preview.plan); setPreview(null); notify("Schedule updated!"); }}>
              ✓ Apply Optimized Schedule
            </button>
            <button className="lms-btn lms-btn-ghost" onClick={() => setPreview(null)}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT 4 — AUTO CONTENT REFRESH
   ─────────────────────────────────────────────────────────────────
   INTEGRATION (Trainer Performance page):
     <AutoContentRefresh
       sb={sb} courseId={courseId} planDays={planDays}
       dayMap={dayMap} dayData={dayData}
       groqKey={groqKey} groqModel={groqModel}
       genNotebook={genNotebook} genQuiz={genQuiz}
       notify={notify} trainerId={trainerId} darkMode={darkMode}
     />
═══════════════════════════════════════════════════════════════════ */
export function AutoContentRefresh({
  sb, courseId, planDays = [], dayMap = {}, dayData = {},
  groqKey, groqModel, genNotebook, genQuiz,
  notify, trainerId, darkMode,
}) {
  const [loading, setLoading] = useState(false);
  const [staged, setStaged] = useState([]); // [{dayNum, topic, key, type, reason}]
  const [refreshing, setRefreshing] = useState(null);
  const FAIL_THRESHOLD = 60; // quiz avg below this triggers refresh

  const scan = async () => {
    if (!sb || !courseId) { notify("Supabase not connected", "err"); return; }
    setLoading(true);
    setStaged([]);
    try {
      const rows = await sb.select("lms_student_activity", `course_id=eq.${encodeURIComponent(courseId)}`);
      const allActivity = (rows || []).map((r) => r.activity || {});
      if (allActivity.length === 0) { notify("No student data yet", "warn"); setLoading(false); return; }

      const indexToKey = {};
      for (const [k, idx] of Object.entries(dayMap)) indexToKey[idx] = k;

      const toRefresh = [];
      for (let i = 0; i < planDays.length; i++) {
        const d = planDays[i];
        const key = indexToKey[i];
        if (!key) continue;

        const scores = allActivity.map((a) => a.quizScores?.[key]?.pct).filter((x) => x != null);
        if (scores.length < 2) continue; // not enough data

        const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
        const views = allActivity.filter((a) => a.notebookViews?.[key]).length;
        const viewRate = Math.round((views / allActivity.length) * 100);

        if (avg < FAIL_THRESHOLD) {
          toRefresh.push({ dayNum: d.dayNum, topic: d.topic, key, type: "quiz", avgScore: avg, reason: `Avg quiz score ${avg}% — below ${FAIL_THRESHOLD}% threshold` });
        }
        if (viewRate < 30 && dayData[key]?.notebook) {
          toRefresh.push({ dayNum: d.dayNum, topic: d.topic, key, type: "notebook", viewRate, reason: `Only ${viewRate}% of students opened the notebook — content may not be engaging` });
        }
      }

      setStaged(toRefresh);
      if (toRefresh.length === 0) notify("All content is performing well! No refresh needed.");
    } catch (e) {
      notify(`Scan failed: ${e.message}`, "err");
    } finally {
      setLoading(false);
    }
  };

  const applyRefresh = async (item) => {
    setRefreshing(item.key + item.type);
    try {
      const dayObj = { key: item.key, dayNum: item.dayNum, topic: item.topic };
      if (item.type === "quiz" && genQuiz) await genQuiz(dayObj, { silent: false });
      if (item.type === "notebook" && genNotebook) await genNotebook(dayObj, { silent: false });
      setStaged((p) => p.filter((x) => !(x.key === item.key && x.type === item.type)));
      notify(`Day ${item.dayNum} ${item.type} refreshed ✓`);
    } catch (e) {
      notify(`Refresh failed: ${e.message}`, "err");
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <AgentCard title="Auto Content Refresh" icon="🔄" darkMode={darkMode}>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
        Scans quiz pass rates and notebook engagement. Days below {FAIL_THRESHOLD}% are flagged for one-click content regeneration.
      </p>
      <button className="lms-btn lms-btn-amber" onClick={scan} disabled={loading} style={{ width: "100%" }}>
        {loading ? <><Spin />Scanning…</> : "📊 Scan Content Quality"}
      </button>

      {staged.length > 0 && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ fontSize: 12, fontWeight: 800, color: "#f59e0b", textTransform: "uppercase", letterSpacing: ".07em" }}>
            {staged.length} day{staged.length > 1 ? "s" : ""} flagged for refresh
          </p>
          {staged.map((item) => (
            <div key={item.key + item.type} style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.3)", borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 700, fontSize: 13.5, color: "#0f172a", margin: "0 0 3px 0" }}>
                  Day {item.dayNum}: {item.topic} — <span style={{ color: "#f59e0b", textTransform: "capitalize" }}>{item.type}</span>
                </p>
                <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>{item.reason}</p>
              </div>
              <button
                className="lms-btn lms-btn-amber"
                style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }}
                disabled={refreshing === item.key + item.type}
                onClick={() => applyRefresh(item)}
              >
                {refreshing === item.key + item.type ? <><Spin />Refreshing…</> : "🔄 Refresh"}
              </button>
            </div>
          ))}
        </div>
      )}
    </AgentCard>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT 5 — AUTOMATED ANNOUNCEMENTS AGENT
   ─────────────────────────────────────────────────────────────────
   INTEGRATION (Trainer sidebar or dedicated "Announcements" tab):
     <AutomatedAnnouncementsAgent
       sb={sb} courseId={courseId} trainerId={trainerId}
       planDays={planDays} dayMap={dayMap}
       groqKey={groqKey} groqModel={groqModel}
       notify={notify} darkMode={darkMode}
     />

   NOTE: Sending email is outside scope — "Send" here copies the
   message to clipboard / shows it for trainer to paste. Extend with
   your email provider SDK if needed.
═══════════════════════════════════════════════════════════════════ */
export function AutomatedAnnouncementsAgent({
  sb, courseId, trainerId, planDays = [], dayMap = {},
  groqKey, groqModel, notify, darkMode,
}) {
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  const loadDrafts = useCallback(async () => {
    if (!sb || !courseId) return;
    try {
      const rows = await sb.select(
        "lms_announcement_drafts",
        `course_id=eq.${encodeURIComponent(courseId)}&status=eq.pending&order=created_at.desc&limit=20`
      );
      setDrafts(rows || []);
    } catch { /* table may not exist yet */ }
  }, [sb, courseId]);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  const detectAndDraft = async () => {
    if (!sb || !courseId || !groqKey) { notify("Supabase + Groq key required", "err"); return; }
    setLoading(true);
    try {
      const actRows = await sb.select("lms_student_activity", `course_id=eq.${encodeURIComponent(courseId)}`);
      const totalDays = planDays.length;
      const events = [];

      for (const row of (actRows || [])) {
        const act = row.activity || {};
        // Inactive 3+ days
        const ls = act.lastSeen ? new Date(act.lastSeen).getTime() : 0;
        if (Date.now() - ls > 3 * 86400000) events.push({ type: "inactive_student", studentId: row.student_id });
        // Aced a quiz (100%)
        for (const [key, qs] of Object.entries(act.quizScores || {})) {
          if (qs.pct === 100) events.push({ type: "quiz_ace", studentId: row.student_id, dayKey: key });
        }
        // Halfway through
        const completed = Object.values(act.quizScores || {}).length;
        if (totalDays > 0 && completed >= Math.floor(totalDays / 2) && completed < Math.ceil(totalDays / 2) + 1) {
          events.push({ type: "course_halfway", studentId: row.student_id });
        }
      }

      if (events.length === 0) { notify("No events to announce right now", "warn"); setLoading(false); return; }

      setGenerating(true);
      // Generate announcement drafts for unique event types
      const seen = new Set();
      const newDrafts = [];
      for (const ev of events) {
        const typeKey = ev.type;
        if (seen.has(typeKey)) continue;
        seen.add(typeKey);

        const result = await agentCallGroq(groqKey, groqModel, [
          {
            role: "system",
            content: `You are a friendly LMS platform assistant writing trainer-to-student announcements. Return ONLY JSON:
{"subject":"...","body":"...(2-3 warm, encouraging sentences)..."}`,
          },
          {
            role: "user",
            content: `Write an announcement for event type "${ev.type}". Course has ${totalDays} days total.`,
          },
        ], { json: true, maxTokens: 300 });

        const parsed = safeJson(result);
        if (!parsed?.subject) continue;
        const draft = {
          id: `${courseId}_${ev.type}_${Date.now()}`,
          course_id: courseId,
          trainer_id: trainerId,
          trigger_type: ev.type,
          subject: parsed.subject,
          body: parsed.body,
          recipients: [],
          status: "pending",
          created_at: new Date().toISOString(),
        };
        try { await sb.upsert("lms_announcement_drafts", draft); } catch { /* table not yet created — work in-memory */ }
        newDrafts.push(draft);
      }
      setDrafts((p) => [...newDrafts, ...p]);
      notify(`${newDrafts.length} announcement draft(s) ready for review`);
    } catch (e) {
      notify(`Detection failed: ${e.message}`, "err");
    } finally {
      setLoading(false);
      setGenerating(false);
    }
  };

  const dismiss = async (id) => {
    try { await sb.update("lms_announcement_drafts", `id=eq.${encodeURIComponent(id)}`, { status: "dismissed" }); } catch { /* ok */ }
    setDrafts((p) => p.filter((d) => d.id !== id));
  };

  const send = async (draft) => {
    // Copy to clipboard — trainer pastes into their email / messaging tool
    try { await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`); notify("Announcement copied to clipboard — paste into your email tool ✓"); }
    catch { notify(`Subject: ${draft.subject}\n\n${draft.body}`, "warn"); }
    try { await sb.update("lms_announcement_drafts", `id=eq.${encodeURIComponent(draft.id)}`, { status: "sent" }); } catch { /* ok */ }
    setDrafts((p) => p.filter((d) => d.id !== draft.id));
  };

  return (
    <AgentCard title="Automated Announcements" icon="📢" darkMode={darkMode}>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
        Detects platform events (inactive students, halfway milestones, quiz aces) and drafts contextual messages for your review.
      </p>
      <button className="lms-btn lms-btn-violet" onClick={detectAndDraft} disabled={loading} style={{ width: "100%" }}>
        {loading ? <><Spin />{generating ? "Drafting…" : "Scanning events…"}</> : "🔔 Detect Events & Draft Messages"}
      </button>

      {drafts.length > 0 && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ fontSize: 12, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: ".07em" }}>
            {drafts.length} pending draft{drafts.length > 1 ? "s" : ""}
          </p>
          {drafts.map((d) => (
            <div key={d.id} style={{ background: "rgba(139,92,246,.06)", border: "1px solid rgba(139,92,246,.25)", borderRadius: 12, padding: "12px 14px" }}>
              <p style={{ fontWeight: 700, fontSize: 13, color: "#0f172a", margin: "0 0 4px 0" }}>{d.subject}</p>
              <p style={{ fontSize: 12.5, color: "#64748b", margin: "0 0 10px 0", lineHeight: 1.55 }}>{d.body}</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="lms-btn lms-btn-green" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => send(d)}>📋 Copy & Send</button>
                <button className="lms-btn lms-btn-ghost" style={{ fontSize: 12, padding: "6px 12px" }} onClick={() => dismiss(d.id)}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </AgentCard>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT 6 — PERSONALIZED AI TUTOR
   ─────────────────────────────────────────────────────────────────
   INTEGRATION (DayPage, student view, add as a new tab or floating panel):
     <PersonalizedAITutor
       day={selDay} dayData={dayData[selDay?.key] || {}}
       groqKey={groqKey} groqModel={groqModel}
       studentName={auth?.name} darkMode={darkMode}
     />
   Also: add a "💬 Ask Tutor" button in the quiz section that calls
     tutoRef.current.askAboutQuestion(questionText)
═══════════════════════════════════════════════════════════════════ */
export function PersonalizedAITutor({ day, dayData = {}, groqKey, groqModel, studentName, darkMode, ref: forwardedRef }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [open, setOpen] = useState(false);
  const bottomRef = useRef(null);

  // Public API for quiz hint button
  useEffect(() => {
    if (forwardedRef) forwardedRef.current = { askAboutQuestion: (q) => { setOpen(true); setInput(q); } };
  }, [forwardedRef]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const systemPrompt = `You are a friendly, encouraging AI tutor helping a student named ${studentName || "the student"}.
They are studying Day ${day?.dayNum}: "${day?.topic}".
${dayData.notebook ? `Today's notebook covers:\n${dayData.notebook.slice(0, 1200)}\n` : ""}
${dayData.quiz ? `Today's quiz topics: ${(dayData.quiz || []).map((q) => q.q).slice(0, 5).join(" | ")}\n` : ""}
${dayData.assignment ? `Today's assignment summary:\n${(dayData.assignment || "").slice(0, 400)}\n` : ""}
Only answer questions related to today's content. Be concise, use examples, and encourage the student.`;

  const ask = async () => {
    if (!input.trim() || thinking) return;
    if (!groqKey) { alert("Groq API key not set — go to Settings"); return; }
    const userMsg = input.trim();
    setInput("");
    setMessages((p) => [...p, { role: "user", content: userMsg }]);
    setThinking(true);
    try {
      const history = [...messages, { role: "user", content: userMsg }].slice(-10);
      const reply = await agentCallGroq(groqKey, groqModel, [
        { role: "system", content: systemPrompt },
        ...history,
      ], { maxTokens: 600, temperature: 0.7 });
      setMessages((p) => [...p, { role: "assistant", content: reply }]);
    } catch (e) {
      setMessages((p) => [...p, { role: "assistant", content: `Sorry, I hit an error: ${e.message}` }]);
    } finally {
      setThinking(false);
    }
  };

  const bubble = (m, i) => {
    const isUser = m.role === "user";
    return (
      <div key={i} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 10 }}>
        <div style={{
          maxWidth: "82%", padding: "10px 14px", borderRadius: isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
          background: isUser ? "linear-gradient(135deg,#8b5cf6,#6366f1)" : darkMode ? "#1e293b" : "#f8fafc",
          color: isUser ? "#fff" : darkMode ? "#e2e8f0" : "#0f172a",
          fontSize: 13.5, lineHeight: 1.6,
          boxShadow: isUser ? "0 4px 14px rgba(139,92,246,.3)" : "4px 4px 12px #C4CDD9,-2px -2px 8px #fff",
          border: isUser ? "none" : "1px solid #fff",
        }}>
          {m.content}
        </div>
      </div>
    );
  };

  if (!open) {
    return (
      <button className="lms-btn lms-btn-violet" onClick={() => setOpen(true)}>
        💬 Ask AI Tutor
      </button>
    );
  }

  return (
    <div style={{
      position: "fixed", bottom: 20, right: 20, width: 360, height: 520,
      background: darkMode ? "#0d1117" : "linear-gradient(145deg,#EDF1F7,#E4E9F2)",
      border: `1px solid ${darkMode ? "#334155" : "#fff"}`,
      borderRadius: 24, boxShadow: "20px 20px 48px #C4CDD9,-12px -12px 32px #fff",
      display: "flex", flexDirection: "column", zIndex: 8000,
    }}>
      {/* Header */}
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${darkMode ? "#334155" : "#C4CDD9"}`, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>🤖</span>
        <div style={{ flex: 1 }}>
          <p style={{ fontWeight: 800, fontSize: 14, color: darkMode ? "#e2e8f0" : "#0f172a", margin: 0 }}>AI Tutor</p>
          <p style={{ fontSize: 11, color: "#94a3b8", margin: 0 }}>Day {day?.dayNum}: {day?.topic}</p>
        </div>
        <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "#94a3b8" }}>✕</button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", paddingTop: 40 }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>👋</div>
            <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6 }}>
              Hi {studentName || "there"}! I'm your tutor for today's session on <strong>{day?.topic}</strong>. Ask me anything about the notebook, quiz, or assignment!
            </p>
          </div>
        )}
        {messages.map(bubble)}
        {thinking && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", color: "#94a3b8", fontSize: 13 }}>
            <Spin /> Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding: "10px 14px", borderTop: `1px solid ${darkMode ? "#334155" : "#C4CDD9"}`, display: "flex", gap: 8 }}>
        <input
          className="lms-input"
          style={{ flex: 1, padding: "9px 13px", fontSize: 13.5 }}
          placeholder="Ask a question…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
        />
        <button className="lms-btn lms-btn-violet" style={{ padding: "8px 14px" }} onClick={ask} disabled={thinking || !input.trim()}>
          ➤
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT 7 — ADAPTIVE LEARNING PATH
   ─────────────────────────────────────────────────────────────────
   INTEGRATION (StudentDashboard, below the "Next up" card):
     <AdaptiveLearningPath
       sb={sb} studentId={studentId} courseId={courseId}
       planDays={planDays} dayMap={dayMap}
       studentActivity={studentActivity}
       groqKey={groqKey} groqModel={groqModel}
       onSelectDay={onSelectDay} notify={notify} darkMode={darkMode}
     />
═══════════════════════════════════════════════════════════════════ */
export function AdaptiveLearningPath({
  sb, studentId, courseId, planDays = [], dayMap = {},
  studentActivity = {}, groqKey, groqModel,
  onSelectDay, notify, darkMode,
}) {
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(false);

  const buildPath = async () => {
    if (!groqKey) { notify("Groq API key needed", "err"); return; }
    setLoading(true);
    try {
      const indexToKey = {};
      for (const [k, idx] of Object.entries(dayMap)) indexToKey[idx] = k;

      const masteryProfile = planDays.map((d, i) => {
        const key = indexToKey[i];
        const qs = studentActivity.quizScores?.[key];
        const cr = studentActivity.codeRuns?.[key] || 0;
        return {
          dayNum: d.dayNum, topic: d.topic,
          quizPct: qs?.pct ?? null, codeRuns: cr,
          viewed: !!studentActivity.notebookViews?.[key],
        };
      });

      const incompleteTopics = masteryProfile.filter((d) => !d.viewed || d.quizPct === null || d.quizPct < 70);

      const result = await agentCallGroq(groqKey, groqModel, [
        {
          role: "system",
          content: `You are an adaptive learning engine. Analyse the student's mastery profile and recommend the best 5 days to focus on next. Return ONLY JSON:
{"recommendations":[{"dayNum":N,"topic":"...","reason":"...","priority":"high|medium|low"}],"summary":"2-sentence explanation of the learning path"}`,
        },
        {
          role: "user",
          content: `Student mastery profile:\n${JSON.stringify(masteryProfile, null, 2)}\n\nRecommend the best 5 days to tackle next, prioritizing weak areas and ensuring prerequisites are covered.`,
        },
      ], { json: true, maxTokens: 800 });

      const parsed = safeJson(result);
      if (!parsed?.recommendations) throw new Error("Could not parse recommendations");

      setRecommendations(parsed.recommendations.slice(0, 5));

      // Persist to DB
      if (sb && studentId && courseId) {
        const id = `${studentId}__${courseId}`;
        await sb.upsert("lms_student_adaptive_path", {
          id, student_id: studentId, course_id: courseId,
          reordered: parsed.recommendations,
          updated_at: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch (e) {
      notify(`Path generation failed: ${e.message}`, "err");
    } finally {
      setLoading(false);
    }
  };

  const priorityColor = { high: "#ef4444", medium: "#f59e0b", low: "#22c55e" };

  return (
    <AgentCard title="Your Adaptive Learning Path" icon="🧭" darkMode={darkMode}>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
        AI analyses your quiz scores and activity to build a personalized next-5-days plan based on your weak areas.
      </p>
      <button className="lms-btn lms-btn-blue" onClick={buildPath} disabled={loading} style={{ width: "100%" }}>
        {loading ? <><Spin />Analysing your progress…</> : "🧭 Build My Learning Path"}
      </button>

      {recommendations.length > 0 && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {recommendations.map((r, i) => (
            <button
              key={i}
              onClick={() => { const d = planDays.find((p) => p.dayNum === r.dayNum); if (d && onSelectDay) onSelectDay(d); }}
              style={{
                display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px",
                background: "linear-gradient(145deg,#EDF1F7,#E4E9F2)", border: "1px solid #fff",
                borderRadius: 14, cursor: "pointer", textAlign: "left", width: "100%",
                boxShadow: "6px 6px 14px #C4CDD9,-4px -4px 10px #fff", transition: "transform .18s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "none"; }}
            >
              <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 13, flexShrink: 0 }}>
                {i + 1}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontWeight: 700, fontSize: 13.5, color: "#0f172a", margin: "0 0 2px 0" }}>Day {r.dayNum}: {r.topic}</p>
                <p style={{ fontSize: 12, color: "#64748b", margin: 0, lineHeight: 1.4 }}>{r.reason}</p>
              </div>
              <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 800, background: priorityColor[r.priority] + "18", color: priorityColor[r.priority], border: `1px solid ${priorityColor[r.priority]}44`, flexShrink: 0, textTransform: "uppercase" }}>
                {r.priority}
              </span>
            </button>
          ))}
        </div>
      )}
    </AgentCard>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT 8 — AI ASSIGNMENT REVIEWER
   ─────────────────────────────────────────────────────────────────
   INTEGRATION (DayPage, assignment tab, student view):
     <AIAssignmentReviewer
       day={selDay} dayData={dayData[selDay?.key] || {}}
       sb={sb} courseId={courseId} studentId={studentId}
       groqKey={groqKey} groqModel={groqModel}
       notify={notify} darkMode={darkMode}
     />
═══════════════════════════════════════════════════════════════════ */
export function AIAssignmentReviewer({ day, dayData = {}, sb, courseId, studentId, groqKey, groqModel, notify, darkMode }) {
  const [submissionText, setSubmissionText] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState(null);
  const [open, setOpen] = useState(false);

  const submitForReview = async () => {
    if (!submissionText.trim()) { notify("Paste your assignment solution below", "warn"); return; }
    if (!groqKey) { notify("Groq API key needed", "err"); return; }
    if (!dayData.assignment) { notify("No assignment found for this day", "err"); return; }
    setReviewing(true);
    setReview(null);
    try {
      const result = await agentCallGroq(groqKey, groqModel, [
        {
          role: "system",
          content: `You are a rigorous but encouraging Python assignment reviewer. Return ONLY valid JSON:
{
  "draft_score": 0-100,
  "strengths": ["strength 1","strength 2","strength 3"],
  "gaps": ["gap 1","gap 2"],
  "specific_feedback": "2-3 sentences of specific, actionable feedback",
  "improvement_hints": ["specific hint 1","specific hint 2"],
  "ready_for_trainer": true|false
}`,
        },
        {
          role: "user",
          content: `ASSIGNMENT BRIEF:\n${dayData.assignment.slice(0, 2000)}\n\nSTUDENT SUBMISSION:\n${submissionText.slice(0, 3000)}\n\nReview the submission against the assignment rubric.`,
        },
      ], { json: true, maxTokens: 800 });

      const parsed = safeJson(result);
      if (!parsed?.strengths) throw new Error("Could not parse review");
      setReview(parsed);

      // Store in lms_day_files as a review record
      if (sb && courseId && studentId && day?.key) {
        const fileRecord = {
          id: `review_${studentId}_${day.key}`,
          course_id: courseId,
          day_key: day.key,
          trainer_id: studentId,
          name: `AI Review - ${studentId}`,
          type: "application/json",
          size: 0,
          ai_review: parsed,
          review_at: new Date().toISOString(),
        };
        await sb.upsert("lms_day_files", fileRecord).catch(() => {});
      }
    } catch (e) {
      notify(`Review failed: ${e.message}`, "err");
    } finally {
      setReviewing(false);
    }
  };

  if (!dayData.assignment) return null;

  const scoreColor = (s) => s >= 80 ? "#22c55e" : s >= 60 ? "#f59e0b" : "#ef4444";

  return (
    <div style={{ marginTop: 18 }}>
      {!open ? (
        <button className="lms-btn lms-btn-blue" onClick={() => setOpen(true)}>
          🤖 Submit for AI Review
        </button>
      ) : (
        <AgentCard title="AI Assignment Reviewer" icon="📋" darkMode={darkMode}>
          <p style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>
            Paste your completed solution below for instant AI feedback against the rubric — before the trainer sees it.
          </p>
          <textarea
            className="lms-input"
            rows={8}
            placeholder="Paste your Python code and answers here…"
            value={submissionText}
            onChange={(e) => setSubmissionText(e.target.value)}
            style={{ fontFamily: "monospace", fontSize: 13 }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="lms-btn lms-btn-blue" onClick={submitForReview} disabled={reviewing || !submissionText.trim()} style={{ flex: 1 }}>
              {reviewing ? <><Spin />Reviewing…</> : "🔍 Get AI Feedback"}
            </button>
            <button className="lms-btn lms-btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>

          {review && (
            <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Score */}
              <div style={{ background: "linear-gradient(145deg,#EDF1F7,#E4E9F2)", border: "1px solid #fff", borderRadius: 16, padding: 16, boxShadow: "8px 8px 20px #C4CDD9,-5px -5px 14px #fff", display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 64, height: 64, borderRadius: "50%", background: scoreColor(review.draft_score), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 900, fontSize: 22, boxShadow: `0 4px 16px ${scoreColor(review.draft_score)}66`, flexShrink: 0 }}>
                  {review.draft_score}
                </div>
                <div>
                  <p style={{ fontWeight: 800, fontSize: 15, color: "#0f172a", margin: "0 0 3px" }}>Draft Score: {review.draft_score}/100</p>
                  <p style={{ fontSize: 12.5, color: "#64748b", margin: 0 }}>{review.specific_feedback}</p>
                </div>
              </div>

              {/* Strengths */}
              <div>
                <p style={{ fontSize: 12, fontWeight: 800, color: "#22c55e", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>✅ Strengths</p>
                {review.strengths.map((s, i) => <div key={i} style={{ fontSize: 13, color: "#0f172a", padding: "5px 0", borderBottom: "1px solid #e2e8f0" }}>• {s}</div>)}
              </div>

              {/* Gaps */}
              {review.gaps?.length > 0 && (
                <div>
                  <p style={{ fontSize: 12, fontWeight: 800, color: "#ef4444", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>⚠ Areas to Improve</p>
                  {review.gaps.map((g, i) => <div key={i} style={{ fontSize: 13, color: "#0f172a", padding: "5px 0", borderBottom: "1px solid #e2e8f0" }}>• {g}</div>)}
                </div>
              )}

              {/* Hints */}
              {review.improvement_hints?.length > 0 && (
                <div>
                  <p style={{ fontSize: 12, fontWeight: 800, color: "#6366f1", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 6 }}>💡 Hints</p>
                  {review.improvement_hints.map((h, i) => (
                    <div key={i} style={{ fontSize: 13, color: "#475569", padding: "6px 10px", background: "rgba(99,102,241,.05)", borderLeft: "3px solid #6366f1", borderRadius: "0 8px 8px 0", marginBottom: 5 }}>{h}</div>
                  ))}
                </div>
              )}

              {!review.ready_for_trainer && (
                <div style={{ padding: "10px 14px", background: "rgba(245,158,11,.08)", border: "1px solid rgba(245,158,11,.3)", borderRadius: 10, fontSize: 13, color: "#92400e" }}>
                  💡 Work on the gaps above before submitting to your trainer.
                </div>
              )}
              {review.ready_for_trainer && (
                <div style={{ padding: "10px 14px", background: "rgba(20,184,166,.08)", border: "1px solid rgba(20,184,166,.3)", borderRadius: 10, fontSize: 13, color: "#0d9488" }}>
                  ✅ Looks ready to submit to your trainer!
                </div>
              )}
            </div>
          )}
        </AgentCard>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT 9 — DYNAMIC QUIZ GENERATOR
   ─────────────────────────────────────────────────────────────────
   INTEGRATION (DayPage, quiz tab, student view — replace/augment the static quiz):
     <DynamicQuizGenerator
       day={selDay} dayData={dayData[selDay?.key] || {}}
       studentId={studentId} studentActivity={studentActivity}
       groqKey={groqKey} groqModel={groqModel}
       onQuizReady={(quiz) => updateDay(day.key, { quiz })}
       notify={notify} darkMode={darkMode}
     />
═══════════════════════════════════════════════════════════════════ */
export function DynamicQuizGenerator({ day, dayData = {}, studentId, studentActivity = {}, groqKey, groqModel, onQuizReady, notify, darkMode }) {
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    if (!groqKey) { notify("Groq API key needed", "err"); return; }
    if (!dayData.notebook && !dayData.quiz) { notify("No notebook or base quiz found for this day", "err"); return; }
    setGenerating(true);
    try {
      // Build weak-area context from student's past quiz history
      const weakTopics = [];
      for (const [key, qs] of Object.entries(studentActivity.quizScores || {})) {
        if (qs.pct < 70) weakTopics.push(`Quiz on day ${key}: ${qs.pct}%`);
      }

      const result = await agentCallGroq(groqKey, groqModel, [
        {
          role: "system",
          content: `You are a quiz generator creating personalized quiz variants. Return ONLY a JSON array of 6 question objects:
[{"q":"...?","options":["A) ...","B) ...","C) ...","D) ..."],"answer":0,"explanation":"..."}]
answer is 0-indexed. Make every quiz unique by varying question wording, option ordering, and scenario framing.`,
        },
        {
          role: "user",
          content: `Generate a PERSONALIZED quiz for student ${studentId?.slice(0, 8)} on topic "${day.topic}".
${dayData.notebook ? `Notebook content (use this as source):\n${dayData.notebook.slice(0, 1500)}\n` : ""}
Student's weak areas: ${weakTopics.length ? weakTopics.join(", ") : "none identified yet — use mixed difficulty"}.
Target their weak areas with 60% of questions. Vary scenario and wording from any standard quiz.`,
        },
      ], { json: false, maxTokens: 1800, temperature: 0.8 });

      const cleaned = result.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/gi, "").trim();
      const quiz = JSON.parse(cleaned);
      if (!Array.isArray(quiz) || quiz.length === 0) throw new Error("Invalid quiz format");
      if (onQuizReady) onQuizReady(quiz);
      notify("Personalized quiz generated ✓");
    } catch (e) {
      notify(`Quiz generation failed: ${e.message}`, "err");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <button
      className="lms-btn lms-btn-violet"
      onClick={generate}
      disabled={generating}
      title="Generate a quiz variant tailored to your weak areas"
    >
      {generating ? <><Spin />Personalizing quiz…</> : "🎯 Get My Personalized Quiz"}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AGENT 10 — PLATFORM INTELLIGENCE AGENT (ADMIN)
   ─────────────────────────────────────────────────────────────────
   INTEGRATION (AdminDashboard, add a new "intelligence" section tab):
     <PlatformIntelligenceAgent
       sb={sb} darkMode={darkMode}
     />
═══════════════════════════════════════════════════════════════════ */
export function PlatformIntelligenceAgent({ sb, darkMode }) {
  const [loading, setLoading] = useState(false);
  const [audit, setAudit] = useState(null);
  // Admin uses a local groqKey input since they may not share trainer settings
  const [adminGroqKey, setAdminGroqKey] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem("lms_ai_prefs_user") || "{}")?.groqKey || ""; } catch { return ""; }
  });

  const runAudit = async () => {
    if (!sb) { alert("Supabase not connected"); return; }
    if (!adminGroqKey) { alert("Enter a Groq API key above"); return; }
    setLoading(true);
    setAudit(null);
    try {
      const [trainers, courses, students, activityRows, quizRows] = await Promise.all([
        sb.select("lms_trainers", "order=created_at.desc").catch(() => []),
        sb.select("lms_courses", "order=created_at.desc").catch(() => []),
        sb.select("lms_students", "order=created_at.asc&limit=500").catch(() => []),
        sb.select("lms_student_activity", "limit=500").catch(() => []),
        sb.select("lms_quiz_attempts", "limit=2000").catch(() => []),
      ]);

      // Build per-course quiz stats
      const courseQuizMap = {};
      for (const q of (quizRows || [])) {
        if (!courseQuizMap[q.course_id]) courseQuizMap[q.course_id] = [];
        courseQuizMap[q.course_id].push({ studentId: q.student_id, dayKey: q.day_key, pct: q.pct, at: q.attempted_at });
      }

      // Cheating detection: same wrong answers submitted within 60 seconds on same day
      const cheatingFlags = [];
      for (const [courseId, attempts] of Object.entries(courseQuizMap)) {
        const byDay = {};
        for (const a of attempts) {
          if (!byDay[a.dayKey]) byDay[a.dayKey] = [];
          byDay[a.dayKey].push(a);
        }
        for (const [dayKey, dayAttempts] of Object.entries(byDay)) {
          if (dayAttempts.length < 2) continue;
          for (let i = 0; i < dayAttempts.length; i++) {
            for (let j = i + 1; j < dayAttempts.length; j++) {
              const dt = Math.abs(new Date(dayAttempts[i].at).getTime() - new Date(dayAttempts[j].at).getTime());
              if (dt < 60000 && dayAttempts[i].pct === dayAttempts[j].pct) {
                cheatingFlags.push({ courseId, dayKey, studentA: dayAttempts[i].studentId, studentB: dayAttempts[j].studentId, deltaMs: dt, pct: dayAttempts[i].pct });
              }
            }
          }
        }
      }

      // Engagement cliffs: days with 0 activity across >50% of enrolled students
      const courseEngagement = {};
      for (const row of (activityRows || [])) {
        if (!courseEngagement[row.course_id]) courseEngagement[row.course_id] = [];
        courseEngagement[row.course_id].push(row.activity || {});
      }

      // Build summary for AI
      const summary = {
        totalTrainers: trainers.length,
        approvedTrainers: trainers.filter((t) => t.approved).length,
        totalCourses: courses.length,
        totalStudents: students.length,
        cheatingFlagsCount: cheatingFlags.length,
        cheatingFlags: cheatingFlags.slice(0, 5),
        topCoursesByStudents: Object.entries(courseEngagement)
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 5)
          .map(([id, acts]) => ({ courseId: id, studentCount: acts.length, name: courses.find((c) => c.id === id)?.name || id })),
      };

      const aiResult = await agentCallGroq(adminGroqKey, "llama-3.3-70b-versatile", [
        {
          role: "system",
          content: `You are a platform intelligence analyst for an LMS platform. Analyse the provided metrics and return ONLY valid JSON:
{
  "health_score": 0-100,
  "top_anomalies": ["anomaly 1","anomaly 2","anomaly 3"],
  "cheating_assessment": "...",
  "best_performing_courses": [{"name":"...","reason":"..."}],
  "engagement_insights": ["insight 1","insight 2"],
  "admin_actions": ["action 1","action 2","action 3"]
}`,
        },
        {
          role: "user",
          content: `Platform audit data:\n${JSON.stringify(summary, null, 2)}`,
        },
      ], { json: true, maxTokens: 1000 });

      const parsed = safeJson(aiResult);
      setAudit({ ...summary, ai: parsed });
    } catch (e) {
      alert(`Audit failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const S = ({ label, val, color }) => (
    <div style={{ textAlign: "center", background: "#0f172a", borderRadius: 12, padding: "14px 10px" }}>
      <div style={{ fontSize: 26, fontWeight: 900, color: color || "#e2e8f0" }}>{val}</div>
      <div style={{ fontSize: 11, color: "#475569", marginTop: 3 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ background: "#1e293b", borderRadius: 20, padding: 24, color: "#e2e8f0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <span style={{ fontSize: 28 }}>🛡</span>
        <div>
          <h2 style={{ fontWeight: 800, fontSize: 18, color: "#f1f5f9", margin: 0 }}>Platform Intelligence Agent</h2>
          <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Cross-trainer audit: anomalies, cheating detection, engagement analysis</p>
        </div>
      </div>

      {/* Groq key input for admin */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 6 }}>Groq API Key</label>
        <input
          type="password"
          value={adminGroqKey}
          onChange={(e) => setAdminGroqKey(e.target.value)}
          placeholder="gsk_…"
          style={{ width: "100%", padding: "9px 13px", background: "#0f172a", border: "1.5px solid #334155", borderRadius: 10, fontSize: 13, color: "#e2e8f0", outline: "none", fontFamily: "inherit" }}
        />
      </div>

      <button
        onClick={runAudit}
        disabled={loading}
        style={{ width: "100%", padding: "13px 20px", background: "linear-gradient(135deg,#6366f1,#8b5cf6)", color: "#fff", border: "none", borderRadius: 12, cursor: "pointer", fontWeight: 800, fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontFamily: "inherit" }}
      >
        {loading ? <><Spin />Running Platform Audit…</> : "🔍 Run Platform Audit"}
      </button>

      {audit && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Health score */}
          {audit.ai?.health_score != null && (
            <div style={{ textAlign: "center", padding: 16, background: "#0f172a", borderRadius: 16 }}>
              <div style={{ fontSize: 52, fontWeight: 900, color: audit.ai.health_score >= 70 ? "#22c55e" : audit.ai.health_score >= 50 ? "#f59e0b" : "#ef4444" }}>
                {audit.ai.health_score}
              </div>
              <div style={{ fontSize: 13, color: "#64748b" }}>Platform Health Score</div>
            </div>
          )}

          {/* Stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(110px,1fr))", gap: 8 }}>
            <S label="Trainers" val={audit.totalTrainers} color="#3b82f6" />
            <S label="Approved" val={audit.approvedTrainers} color="#22c55e" />
            <S label="Courses" val={audit.totalCourses} color="#8b5cf6" />
            <S label="Students" val={audit.totalStudents} color="#14b8a6" />
            <S label="Cheat Flags" val={audit.cheatingFlagsCount} color={audit.cheatingFlagsCount > 0 ? "#ef4444" : "#22c55e"} />
          </div>

          {/* Cheating flags */}
          {audit.cheatingFlagsCount > 0 && (
            <div style={{ background: "#7f1d1d22", border: "1px solid #991b1b44", borderRadius: 12, padding: 14 }}>
              <p style={{ fontWeight: 800, fontSize: 13, color: "#fca5a5", marginBottom: 8 }}>⚠ Potential Cheating — {audit.cheatingFlagsCount} flag(s)</p>
              {audit.cheatingFlags.slice(0, 3).map((f, i) => (
                <div key={i} style={{ fontSize: 12, color: "#94a3b8", padding: "4px 0", borderBottom: "1px solid #334155" }}>
                  Course {f.courseId?.slice(0, 8)}… Day {f.dayKey?.slice(0, 8)}… — {f.deltaMs}ms apart — same score {f.pct}%
                </div>
              ))}
              {audit.ai?.cheating_assessment && <p style={{ fontSize: 12.5, color: "#fca5a5", marginTop: 8 }}>{audit.ai.cheating_assessment}</p>}
            </div>
          )}

          {/* Anomalies */}
          {audit.ai?.top_anomalies?.length > 0 && (
            <div>
              <p style={{ fontSize: 12, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Top Anomalies</p>
              {audit.ai.top_anomalies.map((a, i) => (
                <div key={i} style={{ fontSize: 13, color: "#e2e8f0", padding: "6px 10px", background: "#0f172a", borderRadius: 8, marginBottom: 5, borderLeft: "3px solid #f59e0b" }}>
                  {a}
                </div>
              ))}
            </div>
          )}

          {/* Admin actions */}
          {audit.ai?.admin_actions?.length > 0 && (
            <div>
              <p style={{ fontSize: 12, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>Recommended Actions</p>
              {audit.ai.admin_actions.map((a, i) => (
                <div key={i} style={{ fontSize: 13, color: "#e2e8f0", display: "flex", gap: 8, padding: "6px 10px", background: "#0f172a", borderRadius: 8, marginBottom: 5 }}>
                  <span style={{ color: "#14b8a6", fontWeight: 800, flexShrink: 0 }}>{i + 1}.</span> {a}
                </div>
              ))}
            </div>
          )}

          {/* Best courses */}
          {audit.ai?.best_performing_courses?.length > 0 && (
            <div>
              <p style={{ fontSize: 12, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>🏆 Best Performing Courses</p>
              {audit.ai.best_performing_courses.map((c, i) => (
                <div key={i} style={{ fontSize: 13, color: "#e2e8f0", padding: "8px 12px", background: "#0f172a", borderRadius: 10, marginBottom: 5 }}>
                  <span style={{ fontWeight: 700 }}>{c.name}</span> — {c.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
