/* ═══════════════════════════════════════════════════════════════════
   LMS_Learn.jsx — study + interaction tools built on the board engine
   ───────────────────────────────────────────────────────────────────
   Everything here follows the same rules as the rest of the LMS:
     saving   -> through updateDay (trainer) / trackActivity (student)
     locking  -> every export funnels through the host's canDownload()
     editing  -> trainers can add, rewrite and delete; students cannot
     access   -> studentMode gates authoring, never gates learning
     accuracy -> AI answers are checked against the lesson's own content,
                 and nothing is invented where a deterministic answer exists

   Exports
     harvestCards / FlashcardsPanel   — spaced repetition off the board
     renderNotesSheet / notes export  — handwritten revision notes
     DoubtHeatmap                     — where students actually get stuck
     CheckpointPanel                  — explain it back, scored, gaps re-taught
     CodeBoard                        — chalk the code, run it, chalk the output
     AlgoBoard                        — algorithms drawn step by step
   ═══════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useRef, useMemo } from "react";
import {
  BW, BH, mulberry, buildTimeline, chalkSegment, makeBoardTexture,
  textStrokes, measure, deTex, chalkOf, resetSeed, sanitizeSegments
} from "./LMS_Board";

/* ---------------------------------------------------------------- shared */
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const LIc = ({ d, s = 14 }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d={d} /></svg>
);
const I_CARD = "M2 7a2 2 0 012-2h16a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2zM2 10h20";
const I_DL = "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3";
const I_LOCK = "M5 11h14a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a2 2 0 012-2zm3 0V7a4 4 0 018 0v4";
const I_MIC = "M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3zM19 10a7 7 0 01-14 0M12 17v5";
const I_PLAY = "M5 3l14 9-14 9V3z";
const I_STEP = "M5 4l10 8-10 8V4zM19 5v14";
const I_RESET = "M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5";
const I_RUN = "M5 3l14 9-14 9V3z";
const I_ADD = "M12 5v14M5 12h14";
const I_TRASH = "M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6";

const card = (dark) => ({
  background: dark ? "#0f172a" : "#fff",
  border: `1px solid ${dark ? "#1e293b" : "#e2e8f0"}`,
  borderRadius: 12, padding: 14
});
const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "#94a3b8", ...mono };

/* ═══════════════════════════════════════════════════════════════════
   1. FLASHCARDS — harvested from the board, no extra AI call
   The boxed lines and formulas a teacher chose to frame ARE the key
   ideas, so the cards are as good as the lesson and cost nothing.
   ═══════════════════════════════════════════════════════════════════ */


/* Leitner boxes. Interval doubles per box; a miss drops you to box 1. */


/* ═══════════════════════════════════════════════════════════════════
   2. HANDWRITTEN NOTES — the lesson as a page you could have written
   ═══════════════════════════════════════════════════════════════════ */
export function renderNotesSheet(source, { width = 1240, margin = 90 } = {}) {
  // Accepts a board lesson ({segments}) or AI-written notes ({blocks}).
  const segments = Array.isArray(source?.segments) ? source.segments
    : Array.isArray(source?.blocks) ? [{ say: "", blocks: source.blocks }]
    : null;
  if (!segments?.length) return null;
  const lesson = source;
  resetSeed(7);
  // Reuse the board composer, then re-colour for paper and lay it on rules.
  const { timeline } = buildTimeline(segments);
  const strokes = [];
  for (const t of timeline) for (const st of (t.strokes || [])) {
    if (st.brk) { strokes.push({ brk: true }); continue; }
    strokes.push(st);
  }
  // Split into pages at breaks, measuring real ink extent so paper is tight.
  const pages = [[]]; let cur = 0;
  for (const st of strokes) {
    if (st.brk) { pages.push([]); cur++; continue; }
    pages[cur].push(st);
  }
  const live = pages.filter(p => p.length);
  if (!live.length) return null;

  const scale = (width - margin * 2) / BW;
  const pageH = Math.round(BH * scale);
  const gap = 54;
  const c = document.createElement("canvas");
  c.width = width;
  c.height = margin * 2 + live.length * pageH + (live.length - 1) * gap;
  const x = c.getContext("2d");

  // paper
  const g = x.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, "#fbf7ec"); g.addColorStop(1, "#f3ecdc");
  x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
  const r = mulberry(11);
  for (let i = 0; i < 9000; i++) {                       // paper tooth
    x.fillStyle = `rgba(120,100,70,${r() * 0.035})`;
    x.fillRect(r() * c.width, r() * c.height, r() * 1.6, r() * 1.6);
  }
  // ruled lines + margin rule
  x.strokeStyle = "rgba(120,150,190,.34)"; x.lineWidth = 1;
  for (let y = margin; y < c.height - margin * 0.4; y += 34) {
    x.beginPath(); x.moveTo(margin * 0.55, y); x.lineTo(c.width - margin * 0.45, y); x.stroke();
  }
  x.strokeStyle = "rgba(200,90,90,.42)"; x.lineWidth = 1.4;
  x.beginPath(); x.moveTo(margin * 0.92, 12); x.lineTo(margin * 0.92, c.height - 12); x.stroke();

  // title
  x.fillStyle = "#2b3a4a"; x.font = `600 26px Georgia, serif`;
  x.fillText(lesson.lessonTitle || lesson.topic || "Notes", margin, margin - 26);

  // ink — dark blue pen on paper instead of chalk on slate
  const inkFor = hex => {
    const h = String(hex).toLowerCase();
    if (h === "#ffd782" || h === "#ffc48a") return "#a9701a";      // was yellow chalk
    if (h === "#9fd8e8") return "#1d4e7a";                          // headings
    if (h === "#b7e6b0") return "#1d6b45";                          // formulas
    if (h === "#ffb2a3") return "#a33232";                          // warnings
    if (h === "#d4bcf5") return "#6b4a9c";
    if (h === "#d8d3c2") return "#6b7280";
    return "#1f2d3d";
  };
  live.forEach((pg, pi) => {
    const oy = margin + pi * (pageH + gap);
    for (const st of pg) {
      x.strokeStyle = inkFor(st.c);
      x.lineWidth = Math.max(0.9, st.w * scale * 0.92);
      x.lineCap = "round"; x.lineJoin = "round";
      x.globalAlpha = 0.9;
      x.beginPath();
      st.p.forEach(([px, py], k) => {
        const X = margin + px * scale, Y = oy + py * scale;
        k ? x.lineTo(X, Y) : x.moveTo(X, Y);
      });
      x.stroke();
    }
    x.globalAlpha = 1;
    if (pi < live.length - 1) {
      x.strokeStyle = "rgba(120,150,190,.5)"; x.lineWidth = 1;
      x.setLineDash([7, 7]);
      x.beginPath(); x.moveTo(margin, oy + pageH + gap / 2); x.lineTo(c.width - margin, oy + pageH + gap / 2); x.stroke();
      x.setLineDash([]);
    }
  });
  return { canvas: c, pages: live.length };
}

/* ═══════════════════════════════════════════════════════════════════
   NOTES AGENT — revision notes that go beyond the board
   The board is deliberately terse; notes are not. This takes everything
   that was written in the lecture and expands it into a study document,
   adding the definitions, derivations, worked examples and pitfalls a
   student needs when the teacher is no longer in the room.
   ═══════════════════════════════════════════════════════════════════ */
const NOTES_SYS = `You are writing revision notes for a student who attended a lecture and now has to study alone.
Return JSON only: {"title":"...","blocks":[ ...note blocks... ]}

What the notes must contain, in this order:
1. A title block, then a one-paragraph orientation of what this topic is for.
2. "What you need first" — the assumed background, as bullets.
3. Every single thing that was on the board, kept and EXPANDED. A formula on the board becomes
   the formula plus what each symbol means plus when it applies. A table stays a table but gains
   a row of explanation. Nothing from the board may be dropped.
4. Beyond the board: the definitions, derivation steps, special cases and second worked example
   that a lecture had no time for. This is the part that makes notes worth more than the slides.
5. "Worked example" — a complete problem solved line by line, with the arithmetic shown.
6. "Common mistakes" — at least three, each stated as the wrong belief followed by the correction.
7. "In the real world" — two concrete named examples.
8. "Quick reference" — a boxed summary of every formula and rule, together.
9. "Test yourself" — five questions as numbered steps, answers NOT given.

Note block types (JSON):
{"kind":"title","text":"..."}
{"kind":"heading","text":"...","color":"blue"}
{"kind":"text","text":"a full sentence of explanation — notes may use sentences, unlike a board"}
{"kind":"note","text":"a smaller aside"}
{"kind":"bullets","items":["...","..."]}
{"kind":"steps","items":["...","..."]}
{"kind":"formula","tex":"a^2+b^2=c^2","label":"what it is for","color":"green"}
{"kind":"boxed","text":"the thing to remember","color":"yellow"}
{"kind":"table","headers":["A","B"],"rows":[["1","2"]]}
{"kind":"graph","xLabel":"x","yLabel":"y","domain":[-6,6],"curves":[{"expr":"x^2","label":"y=x^2"}]}
{"kind":"diagram","nodes":[{"id":"a","label":"Input","x":0.2,"y":0.3}],"edges":[{"from":"a","to":"b","label":"then"}]}
{"kind":"divider"}   {"kind":"newpage"}

Rules:
- Start a {"kind":"newpage"} before each major section from item 3 onwards, so the notes paginate cleanly.
- tex supports ^ _ \\frac{}{} \\sqrt{} \\sum \\int \\pi \\theta \\alpha \\Delta \\pm \\times \\approx \\leq \\geq \\to. No \\begin/\\end.
- graph "expr" is plain maths in x: write 2*x, never 2x.
- Keep any single text block under 240 characters; split longer explanations into several.
- Colours: blue for headings, green for formulas, yellow for things to remember, pink for mistakes,
  violet for real-world, white for ordinary text.
- Be accurate. Do not invent a figure, constant, date or citation. If unsure, teach around it.`;

/** Writes the notes. Uses the host's callAI, so the same keys and limits. */
export async function runNotesAgent({ topic, subTopics = "", lesson, callAI, onProgress = () => { } }) {
  // A compact digest of what was actually taught, so the notes match the lecture.
  const digest = (lesson?.segments || []).flatMap(sg => (sg.blocks || []).map(b => {
    if (!b) return null;
    switch (b.kind) {
      case "title": case "heading": return `## ${deTex(b.text)}`;
      case "text": case "note": case "boxed": return deTex(b.text);
      case "bullets": case "steps": return (b.items || []).map(i => `- ${deTex(i)}`).join("\n");
      case "formula": return `FORMULA ${b.tex}${b.label ? ` (${b.label})` : ""}`;
      case "table": return `TABLE ${(b.headers || []).join(" | ")} :: ${(b.rows || []).slice(0, 4).map(r => r.join(" | ")).join(" ; ")}`;
      case "graph": return `GRAPH ${(b.curves || []).map(c => c.expr).join(", ")}`;
      case "diagram": return `DIAGRAM ${(b.nodes || []).map(n => deTex(n.label)).join(" -> ")}`;
      default: return null;
    }
  })).filter(Boolean).join("\n").slice(0, 6000);

  onProgress({ label: "Writing revision notes" });
  const ask = async (maxTokens) => {
    const msgs = [
      { role: "system", content: NOTES_SYS },
      {
        role: "user", content:
          `Topic: ${topic}${subTopics.trim() ? `\nSub-topics that must each be covered:\n${subTopics.trim()}` : ""}\n\n` +
          (digest
            ? `Everything that was written on the board in the lecture — keep ALL of it and expand it:\n"""\n${digest}\n"""\n\n`
            : `There is no board lesson for this day yet, so write the notes from the topic alone.\n\n`) +
          `Return JSON only.`
      }
    ];
    try {
      return String(await callAI(msgs, { maxTokens, temperature: 0.35, responseFormat: { type: "json_object" } }) || "");
    } catch (e) {
      if (!/response_format|json_object|json mode/i.test(String(e?.message || ""))) throw e;
      return String(await callAI(msgs, { maxTokens, temperature: 0.35 }) || "");
    }
  };

  const grab = raw => {
    const t = String(raw || "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    const slice = t.slice(a, b + 1);
    try { return JSON.parse(slice); } catch { }
    try { return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")); } catch { }
    // Truncated: salvage the blocks that did close.
    const blocks = [];
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] !== "{") continue;
      let d = 0, str = false, esc = false, end = -1;
      for (let j = i; j < slice.length; j++) {
        const ch = slice[j];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { str = !str; continue; }
        if (str) continue;
        if (ch === "{") d++; else if (ch === "}") { d--; if (!d) { end = j; break; } }
      }
      if (end < 0) continue;
      const chunk = slice.slice(i, end + 1);
      if (chunk.indexOf('"kind"') >= 0) { try { const o = JSON.parse(chunk); if (o.kind) { blocks.push(o); i = end; } } catch { } }
    }
    return blocks.length ? { blocks } : null;
  };

  let d = grab(await ask(7000));
  if (!d?.blocks?.length) d = grab(await ask(3500));
  const blocks = (d?.blocks || []).filter(b => b && typeof b.kind === "string");
  if (!blocks.length) throw new Error("The notes came back empty — try again or switch model.");

  return {
    title: String(d.title || topic || "Notes").slice(0, 120),
    topic, subTopics,
    blocks: blocks.slice(0, 220),
    builtAt: Date.now(),
    v: 1
  };
}

/* ═══════════════════════════════════════════════════════════════════
   3. DOUBT HEATMAP — where students actually get stuck
   Trainer-only. Reads lms_student_activity, which the app already loads.
   ═══════════════════════════════════════════════════════════════════ */
export function DoubtHeatmap({ allActivity = {}, students = [], dayMap = {}, planDays = [], darkMode, onOpenDay }) {
  /* planDays carries no dayKey — keys are date strings mapped by index — so
     resolve titles from dayMap and number the days by date order. */
  const resolve = useMemo(() => {
    const dated = Object.keys(dayMap || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    const num = {}; dated.forEach((k, i) => { num[k] = i + 1; });
    return key => {
      const d = dayMap?.[key] || {};
      const n = num[key];
      return {
        title: d.topic || d.generatedForTopic || (n ? planDays[n - 1]?.topic : "") || key,
        dayNum: n ?? null
      };
    };
  }, [dayMap, planDays]);
  const rows = useMemo(() => {
    const bucket = new Map();     // dayKey -> { day, total, students:Set, beats:Map, samples:[] }
    for (const [sid, act] of Object.entries(allActivity || {})) {
      for (const d of (act?.boardDoubts || [])) {
        if (!d?.dayKey) continue;
        if (!bucket.has(d.dayKey))
          bucket.set(d.dayKey, { dayKey: d.dayKey, total: 0, students: new Set(), beats: new Map(), samples: [] });
        const b = bucket.get(d.dayKey);
        b.total++; b.students.add(sid);
        const key = d.chapter || (d.beat != null ? `Part ${d.beat + 1}` : "unmarked");
        b.beats.set(key, (b.beats.get(key) || 0) + 1);
        if (b.samples.length < 6 && d.q) b.samples.push(d.q);
      }
    }
    return [...bucket.values()]
      .map(b => {
        const worst = [...b.beats.entries()].sort((p, q) => q[1] - p[1])[0];
        const meta = resolve(b.dayKey);
        return {
          ...b,
          students: b.students.size,
          hotspot: worst ? worst[0] : "—",
          hotspotN: worst ? worst[1] : 0,
          title: meta.title,
          dayNum: meta.dayNum
        };
      })
      .sort((a, b) => b.total - a.total);
  }, [allActivity, resolve]);

  const max = Math.max(1, ...rows.map(r => r.total));
  const enrolled = Math.max(1, students.length);

  if (!rows.length) return (
    <div style={{ ...card(darkMode), color: "#94a3b8", fontSize: 13 }}>
      No questions asked yet. Once students interrupt a board lesson, the days
      they stall on show up here, ranked.
    </div>
  );

  return (
    <div style={card(darkMode)}>
      <div style={{ ...label, marginBottom: 4 }}>Where students get stuck</div>
      <div style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 12 }}>
        Every question asked mid-lecture, grouped by day. The hotspot is the part of the
        lesson that drew the most.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map(r => {
          const pct = Math.round((r.students / enrolled) * 100);
          const heat = r.total / max;
          return (
            <div key={r.dayKey}
              onClick={() => onOpenDay?.(r.dayKey)}
              style={{
                cursor: onOpenDay ? "pointer" : "default",
                borderRadius: 10, padding: "10px 12px",
                background: `rgba(239,68,68,${0.05 + heat * 0.17})`,
                border: `1px solid rgba(239,68,68,${0.15 + heat * 0.3})`
              }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10.5, color: "#94a3b8", ...mono }}>
                  {r.dayNum != null ? `DAY ${r.dayNum}` : r.dayKey}
                </span>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: darkMode ? "#e2e8f0" : "#1e293b" }}>{r.title}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: "#f87171", fontWeight: 700, ...mono }}>{r.total} questions</span>
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 3 }}>
                {r.students} of {enrolled} students ({pct}%) · most on <b style={{ color: darkMode ? "#fca5a5" : "#b91c1c" }}>{r.hotspot}</b>
                {r.hotspotN > 1 ? ` (${r.hotspotN})` : ""}
              </div>
              {r.samples.length > 0 && (
                <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 6, lineHeight: 1.6 }}>
                  {r.samples.slice(0, 3).map((q, i) => (
                    <div key={i} style={{ borderLeft: "2px solid rgba(148,163,184,.35)", paddingLeft: 8, marginBottom: 2 }}>“{q}”</div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   STUDY TAB — one place for recall, notes, checkpoints and the sandboxes
   ═══════════════════════════════════════════════════════════════════ */
export function NotesPanel({
  day, dayKey, dayData, updateDay, lesson, callAI, studentMode, darkMode,
  notify, trackActivity, studentId, canDownload, downloadsLocked, busy, onGenerate
}) {
  const [view, setView] = useState("notes");
  const [beatIdx, setBeatIdx] = useState(0);
  const [preview, setPreview] = useState("");
  const [rendering, setRendering] = useState(false);
  const sheetRef = useRef(null);
  const mayDownload = (silent = false) => (canDownload ? canDownload(silent) : true);

  const notes = dayData?.boardNotes || null;      // AI-written, saved to Supabase
  const beats = lesson?.beatTitles || [];
  const isBuilding = !!busy?.[`notes-${dayKey}`];

  // Render the AI notes if they exist, otherwise fall back to the board itself.
  const source = notes?.blocks?.length ? notes : (lesson?.segments?.length ? lesson : null);

  useEffect(() => {
    if (view !== "notes" || !source) { setPreview(""); return; }
    setRendering(true);
    // Yield a frame so the message paints before the render blocks the thread.
    const t = setTimeout(() => {
      try {
        const out = renderNotesSheet(source);
        sheetRef.current = out;
        setPreview(out ? out.canvas.toDataURL("image/png") : "");
      } catch { setPreview(""); }
      setRendering(false);
    }, 30);
    return () => clearTimeout(t);
  }, [view, notes?.builtAt, lesson?.builtAt, source]);

  function download() {
    if (!mayDownload()) return;
    const out = sheetRef.current || renderNotesSheet(source);
    if (!out) { notify?.("Nothing to save yet", "err"); return; }
    out.canvas.toBlob(blob => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `Day${day?.dayNum || 1}_handwritten_notes.png`;
      a.click();
      notify?.(`Notes saved — ${out.pages} page${out.pages === 1 ? "" : "s"}`);
    }, "image/png");
  }

  return (
    <div style={{ animation: "lms-in .2s ease" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        {[["notes", "Notes"], ["check", "Checkpoint"]].map(([kk, lbl]) => (
          <button key={kk} onClick={() => setView(kk)}
            style={{
              padding: "7px 14px", borderRadius: 8, fontSize: 12.5, cursor: "pointer",
              fontWeight: view === kk ? 700 : 500,
              border: `1.5px solid ${view === kk ? "#3b82f6" : (darkMode ? "#334155" : "#e2e8f0")}`,
              background: view === kk ? "rgba(59,130,246,.14)" : "transparent",
              color: view === kk ? (darkMode ? "#93c5fd" : "#1d4ed8") : (darkMode ? "#94a3b8" : "#475569")
            }}>{lbl}</button>
        ))}
        <div style={{ flex: 1 }} />
        {view === "notes" && !studentMode && (
          <button className="lms-btn lms-btn-blue" onClick={onGenerate} disabled={isBuilding}>
            {isBuilding ? "Writing notes…" : (notes ? "Rewrite notes" : "Write notes with AI")}
          </button>
        )}
      </div>

      {view === "notes" && (
        <div style={card(darkMode)}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={label}>{notes ? "Revision notes" : source ? "Straight from the board" : "No notes yet"}</span>
            {notes && (
              <span style={{ fontSize: 11.5, color: "#94a3b8", ...mono }}>
                {notes.blocks.length} blocks{sheetRef.current ? ` \u00b7 ${sheetRef.current.pages} page${sheetRef.current.pages === 1 ? "" : "s"}` : ""}
              </span>
            )}
            <div style={{ flex: 1 }} />
            {source && (downloadsLocked ? (
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#94a3b8" }}>
                <LIc d={I_LOCK} s={13} />View only for this course
              </span>
            ) : (
              <button className="lms-btn lms-btn-ghost" onClick={download} disabled={!preview}>
                <LIc d={I_DL} />Download
              </button>
            ))}
          </div>

          {!notes && (
            <div style={{ fontSize: 12.5, color: darkMode ? "#94a3b8" : "#64748b", lineHeight: 1.6, marginBottom: 12 }}>
              {source
                ? "This is the board written out on paper. Press \u201cWrite notes with AI\u201d to expand it into full revision notes \u2014 every formula explained, a second worked example, common mistakes, a quick-reference sheet and practice questions."
                : "Generate a board lesson first, or write notes straight from the topic with the button above."}
            </div>
          )}

          {rendering && (
            <div style={{ padding: "40px 0", textAlign: "center", color: "#94a3b8", fontSize: 12.5 }}>
              Laying out the page\u2026
            </div>
          )}

          {!rendering && preview && (
            <div style={{ maxHeight: "70vh", overflowY: "auto", borderRadius: 10, border: `1px solid ${darkMode ? "#1e293b" : "#e2e8f0"}`, background: "#f3ecdc" }}>
              <img src={preview} alt="Handwritten notes" style={{ width: "100%", display: "block" }} />
            </div>
          )}

          {!rendering && !preview && !source && (
            <div style={{ padding: "30px 0", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
              Nothing to show yet.
            </div>
          )}
        </div>
      )}

      {view === "check" && (
        beats.length ? (
          <>
            <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
              {beats.map((b, i) => (
                <button key={i} onClick={() => setBeatIdx(i)}
                  style={{
                    padding: "5px 10px", borderRadius: 7, fontSize: 11.5, cursor: "pointer",
                    border: `1.5px solid ${beatIdx === i ? "#3b82f6" : (darkMode ? "#334155" : "#e2e8f0")}`,
                    background: beatIdx === i ? "rgba(59,130,246,.14)" : "transparent",
                    color: beatIdx === i ? (darkMode ? "#93c5fd" : "#1d4ed8") : "#94a3b8"
                  }}>{i + 1}. {String(b).slice(0, 28)}</button>
              ))}
            </div>
            <CheckpointPanel key={beatIdx} lesson={lesson} beatIndex={beatIdx} dayKey={dayKey}
              callAI={callAI} darkMode={darkMode} studentMode={studentMode}
              trackActivity={trackActivity} notify={notify} />
          </>
        ) : (
          <div style={{ ...card(darkMode), color: "#94a3b8", fontSize: 13 }}>
            Checkpoints appear once a board lesson has been generated for this day.
          </div>
        )
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   4. CHECKPOINTS — explain it back, scored against the beat's own
      "covers" list, and only the missed points get re-taught.
   Accuracy note: the marker is given the lesson's own content as the
   rubric, so it grades against what was actually taught rather than
   against whatever the model happens to believe.
   ═══════════════════════════════════════════════════════════════════ */
const MARK_SYS = `You are marking whether a student can explain an idea back in their own words.
You are given the points the lesson actually taught and the student's explanation.
Return JSON only:
{"score":0-100,
 "got":["the taught points they clearly demonstrated"],
 "missed":["the taught points they did not show, copied verbatim from the list given"],
 "wrong":["anything they stated that is factually incorrect"],
 "feedback":"two sentences, second person, warm and specific — name what they got right first"}
Rules:
- Mark ONLY against the listed points. Do not invent extra requirements.
- Wording does not matter. A correct idea in plain language scores full marks.
- "missed" entries must be copied exactly from the points list so they can be matched.
- A blank or joke answer scores 0 with an encouraging one-line feedback, never a lecture.
- Be fair, not generous: if they restated the question without explaining, that is not understanding.`;

const RETEACH_SYS = `You are the teacher going back over ONLY the points a student missed.
Return JSON only: {"segments":[{"say":"...","blocks":[...]}]}
- One segment per missed point, 45 to 80 spoken words each.
- Start the board with {"kind":"heading","text":"Let's revisit","color":"yellow"}.
- Teach it a DIFFERENT way than a lecture would the first time: use a concrete example,
  an analogy, or a drawn diagram rather than restating the definition.
- Allowed blocks: heading, text, bullets, steps, formula, boxed, table, diagram.
- Keep board lines under 60 characters. Any block may take "color":
  white, yellow, blue, green, pink, violet, orange.`;

function useChalkSurface(canvasRef) {
  const bg = useRef(null), layer = useRef(null);
  useEffect(() => {
    bg.current = makeBoardTexture();
    const l = document.createElement("canvas"); l.width = BW; l.height = BH;
    layer.current = l;
    paint();
    // eslint-disable-next-line
  }, []);
  const paint = () => {
    const c = canvasRef.current; if (!c || !bg.current) return;
    const x = c.getContext("2d");
    x.drawImage(bg.current, 0, 0);
    if (layer.current) x.drawImage(layer.current, 0, 0);
  };
  const clear = () => { layer.current?.getContext("2d").clearRect(0, 0, BW, BH); paint(); };
  const draw = (strokes, seedBase = 1) => {
    const ctx = layer.current?.getContext("2d"); if (!ctx) return;
    let n = seedBase;
    for (const st of strokes) {
      if (st.brk) { ctx.clearRect(0, 0, BW, BH); continue; }
      const r = mulberry(++n * 131);
      for (let j = 1; j < st.p.length; j++)
        chalkSegment(ctx, st.p[j - 1][0], st.p[j - 1][1], st.p[j][0], st.p[j][1], st.w, st.c, r);
    }
    paint();
  };
  const drawBlocks = (blocks, seedBase = 1) => {
    resetSeed(seedBase);
    const { timeline } = buildTimeline([{ say: "", blocks }]);
    draw(timeline.flatMap(t => t.strokes || []), seedBase);
  };
  return { paint, clear, draw, drawBlocks, layer, bg };
}

export function CheckpointPanel({
  lesson, beatIndex, dayKey, callAI, groqKey, darkMode, studentMode,
  onReteach, trackActivity, notify
}) {
  const beat = lesson?.beatTitles?.[beatIndex];
  const covers = useMemo(() => {
    // Points to mark against: the beat's own board headings and framed lines.
    const pts = [];
    (lesson?.segments || []).forEach(s => {
      if (s.b !== beatIndex) return;
      for (const bl of (s.blocks || [])) {
        if (!bl) continue;
        if (bl.kind === "boxed") pts.push(deTex(bl.text));
        else if (bl.kind === "heading" && pts.length < 6) pts.push(deTex(bl.text));
        else if (bl.kind === "bullets") (bl.items || []).slice(0, 3).forEach(i => pts.push(deTex(i)));
        else if (bl.kind === "formula" && bl.label) pts.push(deTex(bl.label));
      }
    });
    return [...new Set(pts.filter(p => p && p.length > 6))].slice(0, 6);
  }, [lesson, beatIndex]);

  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [listening, setListening] = useState(false);
  const [recap, setRecap] = useState([]);
  const recRef = useRef(null);
  const recapCanvas = useRef(null);
  const recapSurf = useChalkSurface(recapCanvas);
  useEffect(() => {
    if (!recap.length) return;
    recapSurf.clear();
    resetSeed(21);
    const { timeline } = buildTimeline(recap);
    recapSurf.draw(timeline.flatMap(t => t.strokes || []), 21);
    // eslint-disable-next-line
  }, [recap]);

  const listen = () => {
    if (listening) { try { recRef.current?.stop(); } catch { } setListening(false); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { notify?.("Your browser can't do speech input — type it instead", "warn"); return; }
    const r = new SR(); r.lang = "en-US"; r.interimResults = true; r.continuous = true;
    r.onresult = e => setAnswer(Array.from(e.results).map(x => x[0].transcript).join(""));
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    recRef.current = r; r.start(); setListening(true);
  };

  const submit = async () => {
    if (!answer.trim() || !callAI) return;
    try { recRef.current?.stop(); } catch { }
    setListening(false); setBusy(true);
    try {
      const raw = await callAI([
        { role: "system", content: MARK_SYS },
        {
          role: "user", content:
            `Idea being checked: ${beat || lesson?.lessonTitle || "this topic"}\n\n` +
            `Points the lesson taught:\n${covers.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
            `Student's explanation:\n"""${answer.slice(0, 1500)}"""\n\nReturn JSON only.`
        }
      ], { maxTokens: 900, temperature: 0.2, responseFormat: { type: "json_object" } });

      let d; try { d = JSON.parse(String(raw).slice(String(raw).indexOf("{"), String(raw).lastIndexOf("}") + 1)); }
      catch { d = null; }
      if (!d || typeof d.score !== "number") throw new Error("The marker didn't come back — try again.");
      const missed = (d.missed || []).filter(m => covers.some(c => c.toLowerCase() === String(m).toLowerCase()));
      const res = { ...d, missed, score: Math.max(0, Math.min(100, Math.round(d.score))) };
      setResult(res);
      if (studentMode && trackActivity)
        trackActivity("checkpoint", dayKey, { beat: beatIndex, score: res.score, missed: missed.length });
    } catch (e) {
      notify?.(e.message || "Marking failed — try again", "err");
    } finally { setBusy(false); }
  };

  const reteach = async () => {
    if (!result?.missed?.length || !callAI) return;
    setBusy(true);
    try {
      const raw = await callAI([
        { role: "system", content: RETEACH_SYS },
        {
          role: "user", content:
            `Topic: ${lesson?.lessonTitle || ""} — ${beat || ""}\n` +
            `Points to go back over:\n${result.missed.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n` +
            `What the student said, so you can meet them where they are:\n"""${answer.slice(0, 700)}"""\n\nReturn JSON only.`
        }
      ], { maxTokens: 2200, temperature: 0.35, responseFormat: { type: "json_object" } });
      let segs = [];
      try {
        const d = JSON.parse(String(raw).slice(String(raw).indexOf("{"), String(raw).lastIndexOf("}") + 1));
        segs = sanitizeSegments(d.segments || []).segments;
      } catch { segs = []; }
      if (!segs.length) throw new Error("Couldn't build the recap — try again.");
      setRecap(segs);
      onReteach?.(segs);            // board tab plays it with voice if wired
    } catch (e) { notify?.(e.message, "err"); }
    finally { setBusy(false); }
  };

  if (!covers.length) return null;
  const band = result ? (result.score >= 75 ? "#10b981" : result.score >= 45 ? "#f59e0b" : "#ef4444") : "#3b82f6";

  return (
    <div style={{ ...card(darkMode), borderLeft: `3px solid ${band}` }}>
      <div style={{ ...label, marginBottom: 6 }}>Checkpoint — say it back</div>
      <div style={{ fontSize: 13.5, color: darkMode ? "#e2e8f0" : "#1e293b", marginBottom: 10, lineHeight: 1.55 }}>
        In your own words: <b>{beat || lesson?.lessonTitle}</b>. Don't look at the board.
      </div>

      {!result ? (
        <>
          <textarea value={answer} onChange={e => setAnswer(e.target.value)} rows={4}
            placeholder={listening ? "Listening — just talk…" : "Explain it as if to a friend who missed the class…"}
            disabled={busy}
            style={{
              width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 9, fontSize: 13.5,
              lineHeight: 1.55, resize: "vertical", outline: "none",
              background: darkMode ? "#1e293b" : "#fff", color: darkMode ? "#e2e8f0" : "#1e293b",
              border: `1.5px solid ${listening ? "#f43f5e" : (darkMode ? "#334155" : "#e2e8f0")}`
            }} />
          <div style={{ display: "flex", gap: 8, marginTop: 9, alignItems: "center" }}>
            <button className="lms-btn lms-btn-ghost" onClick={listen} disabled={busy}
              style={listening ? { borderColor: "#f43f5e", color: "#f43f5e" } : undefined}>
              <LIc d={I_MIC} />{listening ? "Stop" : "Speak it"}
            </button>
            <button className="lms-btn lms-btn-blue" onClick={submit} disabled={busy || !answer.trim() || !callAI}>
              {busy ? "Marking…" : "Check my understanding"}
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "#94a3b8", ...mono }}>{answer.trim().split(/\s+/).filter(Boolean).length} words</span>
          </div>
          {!callAI && <div style={{ fontSize: 11.5, color: "#f59e0b", marginTop: 8 }}>Add your API key in Settings to have this marked.</div>}
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: band, ...mono }}>{result.score}</div>
            <div style={{ fontSize: 13, color: darkMode ? "#cbd5e1" : "#334155", lineHeight: 1.5 }}>{result.feedback}</div>
          </div>
          {result.got?.length > 0 && (
            <div style={{ fontSize: 12, color: "#10b981", marginBottom: 4 }}>
              ✓ {result.got.slice(0, 4).join(" · ")}
            </div>
          )}
          {result.wrong?.length > 0 && (
            <div style={{ fontSize: 12, color: "#f87171", marginBottom: 4 }}>
              Worth correcting: {result.wrong.slice(0, 3).join(" · ")}
            </div>
          )}
          {result.missed?.length > 0 && (
            <div style={{ fontSize: 12, color: "#f59e0b", marginBottom: 10 }}>
              Not shown yet: {result.missed.join(" · ")}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {result.missed?.length > 0 && (
              <button className="lms-btn lms-btn-blue" onClick={reteach} disabled={busy}>
                {busy ? "Building…" : `Go over the ${result.missed.length} I missed`}
              </button>
            )}
            <button className="lms-btn lms-btn-ghost" onClick={() => { setResult(null); setAnswer(""); setRecap([]); }}>
              Try again
            </button>
          </div>
        </>
      )}

      {recap.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...label, marginBottom: 6 }}>Gone over again</div>
          <div style={{ borderRadius: 10, overflow: "hidden", boxShadow: "inset 0 0 40px rgba(0,0,0,.5)" }}>
            <canvas ref={recapCanvas} width={BW} height={BH} style={{ width: "100%", display: "block" }} />
          </div>
          <div style={{ fontSize: 12.5, color: darkMode ? "#cbd5e1" : "#475569", marginTop: 8, lineHeight: 1.6 }}>
            {recap.map((r, k) => <div key={k} style={{ marginBottom: 4 }}>{r.say}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   5 + 6. A reusable chalk surface, then code and algorithms drawn on it
   ═══════════════════════════════════════════════════════════════════ */
/* ---- 5. CODE ON THE BOARD ------------------------------------------ */


/* ---- 6. ALGORITHM VISUALISER ---------------------------------------- */
/* Deterministic step engines. Each returns frames of board blocks, so the
   drawing is reproducible, exportable and reviewable like any other board. */


