/* ═══════════════════════════════════════════════════════════════════
   LMS_Studio.jsx — poster-grade visual notes for a day's topic
   ───────────────────────────────────────────────────────────────────
   Notes Forge rebuilds a PHOTO into a study sheet. Studio is the other
   direction: it builds a designed one-page infographic from the day's
   TOPIC and SUB-TOPICS, so every day gets one whether or not anybody
   photographed a whiteboard. Photos, when present, are read first and
   become source material rather than a requirement.

   The sheet has a FIXED ANATOMY, taken from the reference posters:

     ┌ [Series]                                    brand ┐
     │            ≡  BIG TITLE  ≡                        │
     │  ┌ definition, centred, thick teal rule ────────┐ │
     │  ┌ triad ┐ ┌ triad ┐ ┌ triad ┐   3 across       │
     │  ┌ panel ────────┐ ┌ panel ────────┐  2 across  │
     │  ┌ HOW IT IS USED — chain band ─────────────────┐ │
     │  ┌ THE FLOW — dashed chain band ────────────────┐ │
     │  ┌ 🏆  takeaway, two lines                   🚀 ┐ │
     └───────────────────────────────────────────────────┘

   Fixed anatomy is the whole trick. A model asked for "a nice layout"
   returns something different every run; a model asked to fill named
   slots returns something the renderer can typeset identically every
   time. Layout lives here in code — the model only supplies content.

   Generation: Groq (fast, and the course already holds keys).
   Vision:     Gemini (best free-tier handwriting), via LMS_Forge.
   ═══════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useMemo, useRef } from "react";
import {
  forgeAsk, forgeExtractJSON, forgeShrinkImage,
  forgeMapWithLimit, forgeCleanSVG, FORGE_P_SCRIBE,
} from "./LMS_Forge.jsx";

/* ─────────────────────────── design tokens ───────────────────────────
   Lifted from the reference posters rather than invented: a deep teal
   for headings, six accent hues that rotate across cards, and a warm
   near-white paper. Every colour the model may name resolves here, so
   a hallucinated colour degrades to slate instead of breaking the page. */

export const SX = {
  ink:      "#233043",
  deep:     "#125750",   // the big title + definition rule
  paper:    "#faf9f7",
  card:     "#ffffff",
  rule:     "#e4e1db",
  muted:    "#6b7280",
};

export const SX_HUE = {
  violet:  { line: "#6d28d9", tint: "#f3efff", ink: "#5b21b6" },
  sky:     { line: "#2563eb", tint: "#eff6ff", ink: "#1d4ed8" },
  emerald: { line: "#059669", tint: "#e8f9f1", ink: "#047857" },
  amber:   { line: "#d97706", tint: "#fff8ea", ink: "#b45309" },
  rose:    { line: "#e11d48", tint: "#fff1f4", ink: "#be123c" },
  teal:    { line: "#0f766e", tint: "#eafaf7", ink: "#0f766e" },
  slate:   { line: "#64748b", tint: "#f4f6f9", ink: "#475569" },
};
const HUES = Object.keys(SX_HUE);
const hue = (c) => SX_HUE[HUES.includes(c) ? c : "slate"];
const ROTATE = ["emerald", "sky", "violet", "amber", "rose", "teal"];

/* ───────────────────────────── text helpers ───────────────────────── */

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* Inline markup kept deliberately tiny — three forms, all of which the
   reference posters actually use:
     **bold**            emphasis
     __highlight__       marker-pen sweep
     [[word|violet]]     a single coloured term mid-sentence, which is
                         what gives those posters their voice          */
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, '<mark class="sx-hl">$1</mark>')
    .replace(/\[\[(.+?)\|(\w+)\]\]/g, (m, w, c) =>
      '<span style="color:' + hue(c).line + ';font-weight:700">' + w + "</span>");
}

/* ── maths ──────────────────────────────────────────────────────────
   The posters show real stacked fractions, not "pos / 10000^(2i/d)".
   A full LaTeX engine is far too much weight for six formulas a page,
   so this handles exactly the subset that appears: frac, ^, _, and a
   few named symbols. Anything it does not recognise passes through as
   text, so an unexpected expression degrades instead of vanishing.    */

const MATH_SYM = {
  "\\times": "×", "\\cdot": "·", "\\div": "÷", "\\pm": "±",
  "\\leq": "≤", "\\geq": "≥", "\\neq": "≠", "\\approx": "≈",
  "\\to": "→", "\\Rightarrow": "⇒", "\\sum": "Σ", "\\prod": "∏",
  "\\sqrt": "√", "\\infty": "∞", "\\alpha": "α", "\\beta": "β",
  "\\theta": "θ", "\\lambda": "λ", "\\mu": "μ", "\\sigma": "σ",
  "\\partial": "∂", "\\Delta": "Δ", "\\in": "∈", "\\odot": "⊙",
};

const MATH_FN = ["sin","cos","tan","log","ln","exp","max","min","softmax","argmax","sqrt"];

function mathToHTML(src) {
  let s = String(src ?? "");
  for (const [k, v] of Object.entries(MATH_SYM)) s = s.split(k).join(v);

  const readGroup = (str, i) => {          // returns [content, nextIndex]
    if (str[i] !== "{") return [str[i] ?? "", i + 1];
    let depth = 0;
    for (let j = i; j < str.length; j++) {
      if (str[j] === "{") depth++;
      else if (str[j] === "}") { depth--; if (!depth) return [str.slice(i + 1, j), j + 1]; }
    }
    return [str.slice(i + 1), str.length];
  };

  /* \left( … \right) is a matched pair, so it needs the same depth walk as
     braces — a nested pair inside would otherwise close the outer one. */
  const readDelim = (str, i) => {
    let depth = 0;
    for (let j = i; j < str.length; j++) {
      if (str.startsWith("\\left", j)) depth++;
      else if (str.startsWith("\\right", j)) {
        depth--;
        if (!depth) return [str.slice(i + 6, j), j + 7];
      }
    }
    return [str.slice(i + 6), str.length];
  };

  const walk = (str) => {
    let out = "";
    for (let i = 0; i < str.length;) {
      if (str.startsWith("\\frac", i)) {
        const [num, a] = readGroup(str, i + 5);
        const [den, b] = readGroup(str, a);
        out += '<span class="sx-frac"><span class="n">' + walk(num) +
               '</span><span class="d">' + walk(den) + "</span></span>";
        i = b;
      } else if (str.startsWith("\\left", i)) {
        const open = str[i + 5] || "(";
        const [body, next] = readDelim(str, i);
        const inner = walk(body);
        // Parentheses around a stacked fraction have to grow or the formula
        // reads as two lines that happen to sit near a bracket.
        const tall = /sx-frac/.test(inner) ? ' class="sx-paren tall"' : ' class="sx-paren"';
        const close = { "(": ")", "[": "]", "{": "}" }[open] || ")";
        out += "<span" + tall + ">" + esc(open) + "</span>" + inner +
               "<span" + tall + ">" + esc(close) + "</span>";
        i = next;
      } else if (str[i] === "^" || str[i] === "_") {
        const tag = str[i] === "^" ? "sup" : "sub";
        const [g, n] = readGroup(str, i + 1);
        out += "<" + tag + ">" + walk(g) + "</" + tag + ">";
        i = n;
      } else if (str[i] === "\\") {
        const name = (str.slice(i + 1).match(/^[a-zA-Z]+/) || [""])[0];
        if (MATH_FN.includes(name)) {
          out += '<span class="sx-fn">' + name + "</span>";
          i += name.length + 1;
        } else { i += 1 + (name.length || 1); }   // drop unknown commands
      } else {
        out += esc(str[i]); i++;
      }
    }
    return out;
  };
  return walk(s);
}

/* ─────────────────────────── the stylesheet ───────────────────────── */

const FONT_IMPORT =
  "@import url('https://fonts.googleapis.com/css2?family=Kalam:wght@300;400;700&display=swap');\n";

const STUDIO_CSS = `
.sx{
  --ink:${SX.ink}; --deep:${SX.deep}; --paper:${SX.paper};
  --rule:${SX.rule}; --muted:${SX.muted};
  background:var(--paper); color:var(--ink);
  font-family:'Kalam','Comic Sans MS',cursive;
  font-size:15.5px; line-height:1.62; letter-spacing:.1px;
  max-width:1080px; margin:0 auto; padding:30px 30px 34px;
}
.sx *{box-sizing:border-box}
.sx p{margin:0}

/* ── eyebrow ── */
.sx-top{display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px}
.sx-series{border:1.6px solid ${SX_HUE.violet.line}; color:${SX_HUE.violet.line};
  border-radius:9px; padding:3px 13px; font-size:14px; font-weight:700; background:#fff}
.sx-brand{font-size:15px; font-weight:700; color:var(--ink);
  border-bottom:2px solid ${SX_HUE.rose.line}; padding-bottom:1px}

/* ── title with the sparkle marks ── */
.sx-titlebar{display:flex; align-items:center; justify-content:center; gap:16px; margin:6px 0 16px}
.sx-title{font-size:clamp(30px,5.6vw,54px); font-weight:700; color:var(--deep);
  text-align:center; line-height:1.02; letter-spacing:.4px; text-transform:uppercase}
.sx-spark{flex:none; width:26px; height:34px; color:${SX_HUE.teal.line}; opacity:.85}

/* ── definition ── */
.sx-def{border:2.4px solid var(--deep); border-radius:14px; background:#fff;
  padding:15px 22px; text-align:center; font-size:17px; line-height:1.55; margin-bottom:18px}

/* ── shared card ── */
.sx-card{border:1.5px solid var(--rule); border-radius:14px; background:#fff;
  padding:14px 16px 16px; min-width:0}
.sx-h{font-size:16.5px; font-weight:700; text-transform:uppercase; letter-spacing:.5px;
  margin-bottom:9px; display:flex; align-items:center; gap:8px; line-height:1.25}
.sx-h .ic{flex:none; width:29px; height:29px; border-radius:50%; display:grid; place-items:center;
  font-size:15px; border:1.5px solid currentColor; background:#fff}

/* ── triad row ── */
.sx-triad{display:grid; grid-template-columns:repeat(3,1fr); gap:13px; margin-bottom:18px; align-items:start}

.sx-checks{list-style:none; margin:0; padding:0}
.sx-checks li{display:flex; gap:8px; margin:7px 0; font-size:14.5px; line-height:1.5}
.sx-checks .tick{flex:none; width:17px; height:17px; margin-top:3px; border-radius:50%;
  border:1.5px solid currentColor; display:grid; place-items:center; font-size:9.5px; font-weight:700}

.sx-num{margin:0; padding:0; list-style:none; counter-reset:sxn}
.sx-num > li{margin:0 0 9px}
.sx-num .lab{font-weight:700; font-size:14.5px}
.sx-num ul{margin:2px 0 0; padding-left:17px}
.sx-num ul li{font-size:13.8px; line-height:1.5; margin:2px 0; color:#3f4a5a}
.sx-num ul li::marker{color:var(--muted)}

/* ── chains: the boxes-and-arrows strip the posters lean on ── */
.sx-chain{display:flex; align-items:flex-start; justify-content:center;
  flex-wrap:wrap; gap:7px; margin:4px 0}
.sx-node{border:1.5px solid currentColor; border-radius:10px; padding:8px 12px;
  text-align:center; font-size:13.5px; line-height:1.3; min-width:74px; font-weight:700}
.sx-node .sub{display:block; font-weight:400; font-size:11.5px; opacity:.9; margin-top:2px}
.sx-nwrap{display:flex; flex-direction:column; align-items:center; gap:3px; max-width:190px}
.sx-ncap{font-size:11.5px; font-style:italic; text-align:center; line-height:1.35}
.sx-arrow{align-self:flex-start; margin-top:13px; font-size:17px; color:#4b5563; flex:none}
.sx-op{align-self:flex-start; margin-top:8px; flex:none; width:25px; height:25px; border-radius:50%;
  border:1.6px solid #4b5563; color:#374151; display:grid; place-items:center;
  font-size:14px; font-weight:700; background:#fff}
.sx-cnote{text-align:center; font-size:13px; font-style:italic; margin-top:9px}

/* ── deep-dive panels ── */
.sx-panels{display:grid; grid-template-columns:repeat(2,1fr); gap:13px; margin-bottom:18px; align-items:start}
.sx-panel-h{font-size:17px; font-weight:700; margin-bottom:8px; line-height:1.25}
.sx-split{display:grid; grid-template-columns:1.35fr 1fr; gap:12px; align-items:start}
.sx-kv{margin:0; font-size:13px; line-height:1.55}
.sx-kv .k{font-weight:700}
.sx-kv li{margin:6px 0; list-style:none}

.sx-formula{border:1.5px solid ${SX_HUE.emerald.line}; background:${SX_HUE.emerald.tint};
  border-radius:11px; padding:12px 15px; margin:9px 0; text-align:center}
.sx-formula .fx{font-size:17px; color:#065f46; line-height:2.05}
.sx-formula .fn{font-size:12.5px; color:#3f6b5c; margin-top:5px; font-style:italic}
.sx-frac{display:inline-flex; flex-direction:column; vertical-align:middle;
  text-align:center; margin:0 4px; line-height:1.25}
.sx-frac .n{padding:0 5px 1px}
.sx-frac .d{padding:1px 5px 0; border-top:1.5px solid currentColor}
.sx sup,.sx sub{font-size:.66em; line-height:0}
.sx-fn{font-style:normal; padding-right:1px}
.sx-paren{display:inline-block; vertical-align:middle}
.sx-paren.tall{transform:scaleY(2.15); margin:0 3px; font-weight:300}
.sx-chain.tight{gap:4px}
.sx-chain.tight .sx-node{font-size:12.5px; padding:6px 9px; min-width:0}
.sx-chain.tight .sx-nwrap{max-width:150px}
.sx-chain.tight .sx-arrow{margin-top:10px; font-size:15px}
.sx-chain.tight .sx-op{margin-top:6px; width:21px; height:21px; font-size:12px}

.sx-tcap{font-size:13px; text-align:center; margin:9px 0 5px; font-weight:700}
.sx-table{border-collapse:collapse; width:100%; font-size:12.5px; background:#fff}
.sx-table th,.sx-table td{border:1px solid #d7d4cd; padding:5px 8px; text-align:center; white-space:nowrap}
.sx-table th{background:#f6f4ef; font-weight:700}
.sx-twrap{overflow-x:auto}

.sx-star{display:flex; gap:9px; align-items:flex-start; border-radius:11px;
  padding:10px 13px; margin-top:10px; font-size:13.5px; line-height:1.5; border:1.5px solid currentColor}
.sx-star .s{flex:none; font-size:16px; line-height:1.3}

.sx-fig{margin:9px 0 4px}
.sx-fig svg{display:block; width:100%; height:auto}
.sx-fig-t{font-size:13px; text-align:center; font-weight:700; margin-bottom:4px}
.sx-cap{font-size:12px; font-style:italic; text-align:center; color:var(--muted); margin-top:5px}

/* ── bands ── */
.sx-band{border-radius:14px; padding:15px 18px 16px; margin-bottom:14px; position:relative}
.sx-band.solid{border:1.6px solid currentColor}
.sx-band.dashed{border:1.8px dashed currentColor}
.sx-band-l{text-align:center; font-size:15px; font-weight:700; text-transform:uppercase;
  letter-spacing:.9px; margin-bottom:11px}
.sx-band.dashed .sx-band-l{position:absolute; top:-13px; left:50%; transform:translateX(-50%);
  background:var(--paper); padding:0 13px; margin:0; border:1.6px solid currentColor; border-radius:8px;
  font-size:13.5px; line-height:1.75}
.sx-band.dashed{padding-top:22px}

/* ── takeaway ── */
.sx-take{border:1.6px solid currentColor; border-radius:14px; padding:15px 20px;
  display:flex; align-items:center; gap:16px}
.sx-take .em{font-size:34px; flex:none; line-height:1}
.sx-take .body{flex:1; text-align:center}
.sx-take .l1{font-size:16.5px; color:var(--ink)}
.sx-take .l2{font-size:16.5px; font-weight:700; margin-top:3px}
.sx-hl{background:linear-gradient(transparent 58%,#ffe9a8 58%); padding:0 1px}
.sx-foot{margin-top:12px; font-size:11px; color:#a8adb6; text-align:right}

@media print{
  .sx{padding:0; max-width:none; background:#fff}
  .sx-card,.sx-band,.sx-panel,.sx-take{break-inside:avoid; page-break-inside:avoid}
}
@media (max-width:820px){
  .sx-triad,.sx-panels{grid-template-columns:1fr}
  .sx-split{grid-template-columns:1fr}
  .sx{padding:18px 13px}
}
`;

/* ───────────────────────── deterministic renderer ─────────────────────
   No model output reaches the page as markup. Every field is escaped and
   dropped into a slot this function owns, which is why two runs of the
   same topic look like the same publication instead of two guesses.     */

const SPARK = (dir) =>
  '<svg class="sx-spark" viewBox="0 0 26 34" fill="none" aria-hidden="true">' +
  [0, 1, 2].map((i) => {
    const y = 7 + i * 10, w = i === 1 ? 20 : 14;
    const x1 = dir === "l" ? 22 - w : 4, x2 = dir === "l" ? 22 : 4 + w;
    return '<path d="M' + x1 + " " + (y + 4) + "L" + x2 + " " + y +
      '" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>';
  }).join("") + "</svg>";

/** One box in a chain, with its optional caption underneath. */
function chainNode(n) {
  const h = hue(n.color);
  return '<div class="sx-nwrap">' +
    '<div class="sx-node" style="color:' + h.ink + ";background:" + h.tint + '">' +
      esc(n.label) + (n.sub ? '<span class="sub">' + esc(n.sub) + "</span>" : "") +
    "</div>" +
    (n.caption ? '<div class="sx-ncap" style="color:' + h.ink + '">' + esc(n.caption) + "</div>" : "") +
  "</div>";
}

/** A chain: nodes joined by arrows, or by a circled operator where the
 *  content is genuinely an operation (the ⊕ in "embedding + position"). */
function chain(nodes, compact) {
  const out = ['<div class="sx-chain' + (compact ? " tight" : "") + '">'];
  (nodes || []).forEach((n, i) => {
    if (i) out.push(n.op
      ? '<span class="sx-op">' + esc(n.op) + "</span>"
      : '<span class="sx-arrow">→</span>');
    out.push(chainNode(n));
  });
  out.push("</div>");
  return out.join("");
}

function figureHTML(fig, svgMap, h) {
  if (!fig) return "";
  const svg = svgMap[fig.fig_id];
  if (!svg) return "";
  return '<div class="sx-fig">' +
    (fig.title ? '<div class="sx-fig-t" style="color:' + h.ink + '">' + esc(fig.title) + "</div>" : "") +
    svg +
    (fig.caption ? '<div class="sx-cap">' + esc(fig.caption) + "</div>" : "") +
  "</div>";
}

function tableHTML(t) {
  if (!t || !Array.isArray(t.headers) || !t.headers.length) return "";
  return (t.caption ? '<div class="sx-tcap">' + esc(t.caption) + "</div>" : "") +
    '<div class="sx-twrap"><table class="sx-table"><thead><tr>' +
    t.headers.map((x) => "<th>" + esc(x) + "</th>").join("") +
    "</tr></thead><tbody>" +
    (t.rows || []).map((r) => "<tr>" + (r || []).map((d) => "<td>" + esc(d) + "</td>").join("") + "</tr>").join("") +
    "</tbody></table></div>";
}

function starHTML(text, h) {
  if (!text) return "";
  return '<div class="sx-star" style="color:' + h.ink + ";background:" + h.tint +
    '"><span class="s">⭐</span><span style="color:#3f4a5a">' + inline(text) + "</span></div>";
}

/** Triad card — three shapes, chosen by what the content actually is. */
function triadHTML(t, i) {
  const h = hue(t.color || ROTATE[i % ROTATE.length]);
  const out = ['<div class="sx-card">'];
  out.push('<div class="sx-h" style="color:' + h.ink + '">' +
    (t.icon ? '<span class="ic">' + esc(t.icon) + "</span>" : "") + esc(t.heading) + "</div>");

  if (t.style === "chain" && Array.isArray(t.chain) && t.chain.length) {
    out.push(chain(t.chain, true));
    if (t.note) out.push('<div class="sx-cnote" style="color:' + h.ink + '">' + inline(t.note) + "</div>");
  } else if (t.style === "numbered" && Array.isArray(t.groups) && t.groups.length) {
    out.push('<ol class="sx-num">');
    t.groups.forEach((g, gi) => {
      out.push('<li><div class="lab">' + (gi + 1) + ". " + esc(g.label) + "</div>");
      if (Array.isArray(g.items) && g.items.length) {
        out.push("<ul>" + g.items.map((x) => "<li>" + inline(x) + "</li>").join("") + "</ul>");
      }
      out.push("</li>");
    });
    out.push("</ol>");
  } else {
    out.push('<ul class="sx-checks" style="color:' + h.ink + '">' +
      (t.items || []).map((x) =>
        '<li><span class="tick">✓</span><span style="color:#3f4a5a">' + inline(x) + "</span></li>"
      ).join("") + "</ul>");
  }
  out.push("</div>");
  return out.join("");
}

/** Deep-dive panel — the numbered half-width cards carrying the real work. */
function panelHTML(p, i, svgMap) {
  const h = hue(p.color || ROTATE[i % ROTATE.length]);
  const out = ['<div class="sx-card">'];
  out.push('<div class="sx-panel-h" style="color:' + h.ink + '">' +
    (p.n ? p.n + ") " : "") + esc(p.heading) + "</div>");
  if (p.intro) out.push('<p style="font-size:14px;line-height:1.55">' + inline(p.intro) + "</p>");

  const formulas = (p.formulas || []).map((f) =>
    '<div class="sx-formula"><div class="fx">' + mathToHTML(f.expr) + "</div>" +
    (f.note ? '<div class="fn">' + inline(f.note) + "</div>" : "") + "</div>").join("");

  const kv = (p.keyvals || []).length
    ? '<ul class="sx-kv">' + p.keyvals.map((k) =>
        '<li><span class="k" style="color:' + h.ink + '">' + esc(k.k) + "</span> " +
        (k.v ? "= " + inline(k.v) : "") + "</li>").join("") + "</ul>"
    : "";

  // Formula beside its symbol legend is the reference layout; without a
  // legend the formula takes the full width instead of leaving a hole.
  if (formulas && kv) out.push('<div class="sx-split"><div>' + formulas + "</div>" + kv + "</div>");
  else out.push(formulas + kv);

  if (Array.isArray(p.bullets) && p.bullets.length) {
    out.push('<ul class="sx-checks" style="color:' + h.ink + '">' +
      p.bullets.map((x) =>
        '<li><span class="tick">✓</span><span style="color:#3f4a5a">' + inline(x) + "</span></li>"
      ).join("") + "</ul>");
  }
  if (Array.isArray(p.chain) && p.chain.length) out.push(chain(p.chain));
  out.push(figureHTML(p.figure, svgMap, h));
  out.push(tableHTML(p.table));
  out.push(starHTML(p.star, h));
  out.push("</div>");
  return out.join("");
}

function bandHTML(b) {
  const h = hue(b.color);
  const dashed = b.style === "dashed";
  const out = ['<div class="sx-band ' + (dashed ? "dashed" : "solid") +
    '" style="color:' + h.line + ";background:" + (dashed ? "transparent" : h.tint) + '">'];
  if (b.label) out.push('<div class="sx-band-l" style="color:' + h.ink + '">' + esc(b.label) + "</div>");
  out.push(chain(b.chain));
  if (b.note) out.push('<div class="sx-cnote" style="color:' + h.ink + '">' + inline(b.note) + "</div>");
  out.push("</div>");
  return out.join("");
}

export function renderStudio(spec, svgMap = {}) {
  if (!spec) return "";
  const S = spec;
  const out = ['<article class="sx">'];

  out.push('<div class="sx-top">' +
    '<span class="sx-series">' + esc(S.series || "Notes") + "</span>" +
    '<span class="sx-brand">' + esc(S.brand || "") + "</span></div>");

  out.push('<div class="sx-titlebar">' + SPARK("l") +
    '<h1 class="sx-title">' + esc(S.title || "Topic") + "</h1>" + SPARK("r") + "</div>");

  if (S.definition) out.push('<div class="sx-def">' + inline(S.definition) + "</div>");

  if (Array.isArray(S.triad) && S.triad.length) {
    out.push('<div class="sx-triad">' + S.triad.slice(0, 3).map(triadHTML).join("") + "</div>");
  }
  if (Array.isArray(S.panels) && S.panels.length) {
    out.push('<div class="sx-panels">' +
      S.panels.map((p, i) => panelHTML(p, i, svgMap)).join("") + "</div>");
  }
  (S.bands || []).forEach((b) => {
    if (Array.isArray(b.chain) && b.chain.length) out.push(bandHTML(b));
  });

  if (S.takeaway && (S.takeaway.line1 || S.takeaway.line2)) {
    const h = hue(S.takeaway.color || "violet");
    out.push('<div class="sx-take" style="color:' + h.line + ";background:" + h.tint + '">' +
      '<span class="em">🏆</span><div class="body">' +
      (S.takeaway.line1 ? '<div class="l1">' + inline(S.takeaway.line1) + "</div>" : "") +
      (S.takeaway.line2 ? '<div class="l2" style="color:' + h.ink + '">' + inline(S.takeaway.line2) + "</div>" : "") +
      '</div><span class="em">🚀</span></div>');
  }

  out.push('<div class="sx-foot">' + esc(S.footer || "") + "</div>");
  out.push("</article>");
  return out.join("\n");
}

/** One self-contained file — opens offline, costs no egress to re-read. */
export function studioHTML(sheet, title) {
  const body = renderStudio(sheet.spec, sheet.svgMap || {});
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + esc(title || sheet.spec?.title || "Visual notes") + "</title>",
    "<style>" + FONT_IMPORT + "body{margin:0;background:#eeece6}" + STUDIO_CSS + "</style>",
    "</head><body>", body, "</body></html>",
  ].join("\n");
}

/* ══════════════════════════════════════════════════════════════════════
   GENERATION
   Groq writes the sheet. Gemini is used only to read photographs, and
   only when photographs exist — the day still gets a sheet without one.
   ══════════════════════════════════════════════════════════════════════ */

const P_STUDIO = [
  "You are the designer of a single-page teaching poster. The page layout is FIXED and already",
  "built. You do not choose the layout — you fill named slots with content that fits them.",
  "Return ONLY JSON in exactly this shape:",
  "",
  '{"title":string, "series":string,',
  ' "definition":string,',
  ' "triad":[ 3 cards ],',
  ' "panels":[ 2 cards ],',
  ' "bands":[ 2 strips ],',
  ' "takeaway":{"line1":string,"line2":string,"color":string} }',
  "",
  "SLOT RULES — a slot filled wrongly breaks the page, so follow these exactly.",
  "",
  "title       2-4 words, the concept itself. No colon, no subtitle, no 'Introduction to'.",
  "series      the course or module name, 1-3 words.",
  "definition  2-3 sentences answering 'what IS this'. Written for someone meeting it today.",
  "            Colour the 2-3 load-bearing terms with [[term|violet]] or [[term|sky]].",
  "",
  "triad — EXACTLY 3 cards across the top. Each needs heading + color, and ONE of these shapes:",
  '  {"heading":"Why is it needed?","color":"emerald","icon":"💡","style":"checks",',
  '   "items":[4 short sentences, each a complete thought]}',
  '  {"heading":"Where does it fit?","color":"sky","style":"chain",',
  '   "chain":[{"label":"Input","color":"violet"},{"label":"This step","color":"emerald","op":"+"},',
  '            {"label":"Output","color":"amber"}], "note":"one italic line under the chain"}',
  '  {"heading":"Types","color":"violet","style":"numbered",',
  '   "groups":[{"label":"Name","items":["fact","fact"]},{"label":"Name","items":["fact","fact"]}]}',
  "  Use all three shapes — three lists in a row is a wasted band. Chain labels: 2-4 words MAX,",
  "  they sit in a narrow column. Use op:\"+\" or op:\"×\" only for a genuine operation.",
  "",
  "panels — EXACTLY 2 cards, numbered 1 and 2. This is where the real teaching happens.",
  "  Each: {\"n\",\"heading\",\"color\",\"intro\", and then whichever of these the content needs}",
  '  "formulas":[{"expr":"LaTeX","note":"what it means"}]   ← see MATHS below',
  '  "keyvals":[{"k":"symbol","v":"what it stands for"}]    ← the legend beside a formula',
  '  "table":{"caption","headers":[...],"rows":[[...]]}     ← 3-5 cols, 3-4 rows, REAL numbers',
  '  "bullets":[...]  "chain":[...]  "star":"one insight worth remembering"',
  '  "figure":{"fig_id":"f1","kind":"graph|diagram|flow|matrix","title":...,"spec":"what to draw"}',
  "  At least one panel MUST carry a figure, and at least one MUST carry a formula or a table.",
  "  A panel that is only prose is a failed panel.",
  "",
  "bands — EXACTLY 2 full-width strips at the bottom.",
  '  [0] {"label":"How it is used","color":"amber","style":"solid","chain":[4-5 nodes]}',
  '  [1] {"label":"The flow","color":"violet","style":"dashed","chain":[4-6 nodes]}',
  "  Band chain nodes may carry \"sub\" (a tiny example under the label) and \"caption\"",
  "  (an italic note beneath the box). Band 0 is the concrete pipeline with real example values;",
  "  band 1 is the abstract sequence of stages. They must NOT be the same list twice.",
  "",
  "takeaway   line1 = what this earns you, plainly. line2 = the sentence a student recites in an",
  "           exam, ideally a two-part rhythm. Both under 90 characters.",
  "",
  "MATHS — expr is LaTeX limited to: \\frac{a}{b}  ^{}  _{}  \\left( \\right)  \\sum \\sqrt",
  "  \\times \\approx \\to \\theta \\alpha \\sigma \\mu \\partial, and \\sin \\cos \\log \\exp \\max.",
  "  Nothing else is rendered. Never write \\begin, \\text, \\mathrm, $ or display delimiters.",
  "  Every symbol used in a formula must appear in that panel's keyvals.",
  "",
  "COLOURS — only: violet, sky, emerald, amber, rose, teal. Vary them; do not use one hue twice",
  "in the triad. Emphasis inside any string: **bold**, __highlight__, [[coloured term|hue]].",
  "",
  "Be concrete. Real numbers, real variable names, real examples from the field. Never write",
  "'various', 'several' or 'etc.'. No prose outside the JSON.",
].join("\n");

const P_STUDIO_FIG = [
  "You are a technical illustrator. Output ONE self-contained SVG for the figure spec given.",
  "Textbook quality: it must teach something a sentence cannot.",
  "",
  'Root: <svg viewBox="0 0 W H" xmlns="http://www.w3.org/2000/svg"> with NO width/height attributes.',
  "W between 420 and 560 (it sits in a half-width column). H whatever fits without crowding.",
  "No <script>, no <foreignObject>, no external images, no CSS classes, no web fonts.",
  'Style with attributes only. font-family="Kalam, Comic Sans MS, cursive".',
  "Colours ONLY from: " + Object.entries(SX_HUE).map(([k, v]) => k + " " + v.line).join(", ") + ",",
  "  plus #ffffff, #faf9f7, #e4e1db, #233043, #6b7280.",
  "Arrows: define a <marker> in <defs>, prefix its id with the fig_id you are given so ids from",
  "  different figures never collide, and reference it with marker-end.",
  "Do NOT draw the figure title inside the SVG — the page prints it above.",
  "Label every axis, node and meaningful edge. 12-14px for labels, 10-11px for ticks.",
  "Keep 18px padding inside the viewBox. Estimate text width as 0.55 × font-size per character",
  "  and size every box to fit its label — overlapping text is the most common failure.",
  "For a graph: draw real axes with ticks and units, plot the actual curve as a smooth path,",
  "  and mark the point that carries the lesson.",
  "",
  'Return ONLY JSON: {"svg":"<svg ...>...</svg>"}',
].join("\n");

/* Structural repair. A prompt can ask for the anatomy; it cannot guarantee
   it. This fills gaps from content the spec already has, so a short model
   response still renders as a complete page rather than a page with holes. */
export function completeStudioSpec(spec, topic = "", series = "") {
  const S = { ...(spec || {}) };
  S.title  = String(S.title || topic || "Topic").slice(0, 60);
  S.series = String(S.series || series || "Notes").slice(0, 28);
  if (!S.definition) S.definition = `An introduction to ${S.title}.`;

  const usedHue = new Set();
  const pickHue = (c, i) => {
    let h = HUES.includes(c) ? c : null;
    if (!h || usedHue.has(h)) h = ROTATE.find((x) => !usedHue.has(x)) || ROTATE[i % ROTATE.length];
    usedHue.add(h);
    return h;
  };

  S.triad = (Array.isArray(S.triad) ? S.triad : []).slice(0, 3).map((t, i) => {
    const o = { ...t, color: pickHue(t.color, i) };
    // Infer the shape from what is actually present, so a card that named a
    // style it did not fill still renders as whatever it does have.
    if (Array.isArray(o.chain) && o.chain.length) o.style = "chain";
    else if (Array.isArray(o.groups) && o.groups.length) o.style = "numbered";
    else o.style = "checks";
    if (o.style === "checks" && !Array.isArray(o.items)) o.items = [];
    return o;
  }).filter((t) => t.heading);

  S.panels = (Array.isArray(S.panels) ? S.panels : []).slice(0, 4).map((p, i) => ({
    ...p, n: Number.isFinite(+p.n) ? +p.n : i + 1,
    color: HUES.includes(p.color) ? p.color : ROTATE[(i + 3) % ROTATE.length],
  })).filter((p) => p.heading);

  S.bands = (Array.isArray(S.bands) ? S.bands : [])
    .filter((b) => Array.isArray(b.chain) && b.chain.length)
    .slice(0, 3)
    .map((b, i) => ({
      ...b,
      color: HUES.includes(b.color) ? b.color : (i ? "violet" : "amber"),
      style: b.style === "dashed" || i ? "dashed" : "solid",
    }));

  if (!S.takeaway || (!S.takeaway.line1 && !S.takeaway.line2)) {
    S.takeaway = {
      line1: S.panels[0]?.star || S.definition.split(/(?<=\.)\s/)[0] || "",
      line2: `${S.title} — the part worth remembering.`,
      color: "violet",
    };
  }
  return S;
}

/** Read photos, when there are any, so the sheet reflects the real lesson. */
async function readPages(images, keys, signal, mark) {
  const pages = (images || []).filter(Boolean).slice(0, 4);
  if (!pages.length) return "";
  const provider = keys.gemini?.length ? "gemini" : "groq";
  const model = keys.gemini?.length ? "gemini-3.5-flash" : "qwen/qwen3.6-27b";
  mark("read", "run", `${pages.length} page${pages.length > 1 ? "s" : ""}`);
  const shrunk = await Promise.all(pages.map((p) => forgeShrinkImage(p, 1400, 0.82).catch(() => p)));
  const scans = await forgeMapWithLimit(shrunk, 2, async (img, i) => {
    try {
      const r = await forgeAsk({
        provider, keys: keys[provider], model, signal,
        system: FORGE_P_SCRIBE, user: `Transcribe page ${i + 1}. Miss nothing.`,
        images: [img], json: true, temperature: 0.1, maxTokens: 6000,
      });
      return forgeExtractJSON(r.text);
    } catch { return null; }
  });
  const good = scans.filter(Boolean);
  mark("read", good.length ? "done" : "warn", good.length ? `${good.length} read` : "unreadable");
  return good.length ? JSON.stringify(good.length === 1 ? good[0] : { pages: good }) : "";
}

/**
 * Build one poster for a day.
 * @param topic      the day's topic (required — this is the spine)
 * @param subTopics  newline/comma list; each should surface somewhere
 * @param images     optional photos of the board or notes
 * @param keys       { groq:[...], gemini:[...] }
 * @param onStage    ({id,state,note}) for a progress strip
 */
export async function runStudioNotes({
  topic = "", subTopics = "", images = [], series = "",
  keys = {}, models = {}, signal, onStage = () => {},
}) {
  if (!String(topic).trim() && !images.length) {
    throw new Error("Add a topic for the day, or a photo of the notes.");
  }
  const mark = (id, state, note) => onStage({ id, state, note });
  const groq = keys.groq || [];
  if (!groq.length) throw new Error("Add a Groq key in Settings › AI keys — Groq writes the sheet.");
  const tModel = models.text || "openai/gpt-oss-120b";
  const askT = (o) => forgeAsk({ provider: "groq", keys: groq, model: tModel, signal, ...o });

  const transcript = await readPages(images, keys, signal, mark);

  /* 1 — the sheet itself */
  mark("design", "run", "laying out the page");
  const subs = String(subTopics || "").split(/[\n,;•]+/).map((x) => x.trim()).filter(Boolean);
  const brief = [
    `TOPIC: ${topic}`,
    series ? `SERIES: ${series}` : "",
    subs.length ? "SUB-TOPICS — each must be visible somewhere on the page:\n" +
      subs.map((s, i) => `  ${i + 1}. ${s}`).join("\n") : "",
    transcript
      ? "\nThe class also produced these notes. Treat them as the source of truth for what was\n" +
        "actually taught, and fill the gaps around them:\n" + transcript.slice(0, 14000)
      : "",
  ].filter(Boolean).join("\n");

  const r = await askT({
    system: P_STUDIO, user: brief, json: true, temperature: 0.4, maxTokens: 9000,
  });
  let spec = completeStudioSpec(forgeExtractJSON(r.text), topic, series);
  if (!spec.panels.length) throw new Error("The model returned no panels — try again.");
  mark("design", "done", `${spec.triad.length + spec.panels.length} cards`);

  /* 2 — figures */
  const figs = spec.panels.map((p) => p.figure).filter((f) => f && f.spec);
  const svgMap = {};
  if (figs.length) {
    mark("draw", "run", `0/${figs.length}`);
    let n = 0;
    await forgeMapWithLimit(figs, 2, async (f) => {
      try {
        const g = await askT({
          system: P_STUDIO_FIG,
          user: [`fig_id: ${f.fig_id}`, `kind: ${f.kind}`, `title: ${f.title}`, "Draw this:", f.spec].join("\n"),
          json: true, temperature: 0.25, maxTokens: 5000,
        });
        const svg = forgeCleanSVG(forgeExtractJSON(g.text).svg, f.fig_id);
        if (svg) svgMap[f.fig_id] = svg;
      } catch { /* a missing figure must not cost the sheet */ }
      finally { mark("draw", "run", `${++n}/${figs.length}`); }
    });
    mark("draw", "done", `${Object.keys(svgMap).length}/${figs.length} drawn`);
  }

  return { spec, svgMap, topic, subTopics, builtAt: Date.now(), v: 1 };
}

/* ══════════════════════════════════════════════════════════════════════
   BOARD BRIDGE
   The chalkboard is a stroke-animation engine, not an HTML renderer, so
   the poster cannot simply be pasted onto it. What CAN be shared is the
   thing that matters — the structure. The same spec becomes a sequence
   of board segments, so a student watching the lesson and a student
   reading the sheet are taught the same material in the same order.
   ══════════════════════════════════════════════════════════════════════ */

/* Poster hue → chalk stick. The board's palette is warm and limited; these
   are the nearest legible match for each, not a literal colour conversion. */
const CHALK_FOR = {
  violet: "violet", sky: "blue", emerald: "green",
  amber: "yellow", rose: "pink", teal: "blue", slate: "grey",
};
const chalkOfHue = (c) => CHALK_FOR[c] || "white";

/* LaTeX subset → the board's own inline maths dialect, which reads a
   flat expression with ^ and _ rather than \frac. A fraction becomes a
   parenthesised division, which is what a teacher says out loud anyway. */
function texToBoard(expr) {
  let s = String(expr || "");
  for (const [k, v] of Object.entries(MATH_SYM)) s = s.split(k).join(v);

  /* A regex cannot do this: real denominators nest ({10000^{2i/d_{model}}}),
     and [^{}]* stops at the first inner brace, leaving a literal "frac" on
     the chalkboard. Walk the braces instead. */
  const group = (str, i) => {
    if (str[i] !== "{") return [str[i] ?? "", i + 1];
    let d = 0;
    for (let j = i; j < str.length; j++) {
      if (str[j] === "{") d++;
      else if (str[j] === "}") { d--; if (!d) return [str.slice(i + 1, j), j + 1]; }
    }
    return [str.slice(i + 1), str.length];
  };
  const flatten = (str) => {
    let out = "";
    for (let i = 0; i < str.length;) {
      if (str.startsWith("\\frac", i)) {
        const [n, a] = group(str, i + 5);
        const [dn, b] = group(str, a);
        out += "(" + flatten(n) + ")/(" + flatten(dn) + ")";
        i = b;
      } else { out += str[i]; i++; }
    }
    return out;
  };

  return flatten(s)
    .replace(/\\left|\\right/g, "")
    .replace(/\\([a-zA-Z]+)/g, "$1")
    .replace(/\s+/g, " ").trim();
}

/**
 * Turn a poster spec into board segments the existing engine can play.
 * Returns { segments } — the shape LMS_Board.sanitizeSegments expects.
 */
export function studioToBoardSegments(spec) {
  const S = completeStudioSpec(spec);
  const segs = [];
  const push = (say, blocks) => segs.push({ say, blocks: blocks.filter(Boolean) });

  push(
    `Today we're looking at ${S.title}. ${stripMarks(S.definition)}`,
    [{ kind: "title", text: S.title, color: "yellow" },
     { kind: "text", text: clip(stripMarks(S.definition), 150) }]
  );

  for (const t of S.triad) {
    const col = chalkOfHue(t.color);
    if (t.style === "chain" && t.chain?.length) {
      push(
        `${stripMarks(t.heading)} ${t.chain.map((n) => n.label).join(", then ")}. ${stripMarks(t.note || "")}`,
        [{ kind: "heading", text: t.heading, color: col },
         { kind: "diagram", nodes: t.chain.map((n) => clip(n.label, 24)),
           edges: t.chain.slice(1).map((n, i) => ({ from: i, to: i + 1, label: n.op || "" })) }]
      );
    } else if (t.style === "numbered" && t.groups?.length) {
      push(
        `${stripMarks(t.heading)} ${t.groups.map((g) => g.label).join(", and ")}.`,
        [{ kind: "heading", text: t.heading, color: col },
         { kind: "bullets", items: t.groups.flatMap((g) =>
             [g.label, ...(g.items || []).slice(0, 2).map((x) => "  " + stripMarks(x))]).slice(0, 8) }]
      );
    } else {
      push(
        `${stripMarks(t.heading)} ${(t.items || []).map(stripMarks).join(" ")}`,
        [{ kind: "heading", text: t.heading, color: col },
         { kind: "bullets", items: (t.items || []).map((x) => clip(stripMarks(x), 90)).slice(0, 5) }]
      );
    }
  }

  for (const p of S.panels) {
    const col = chalkOfHue(p.color);
    push(`${stripMarks(p.heading)}. ${stripMarks(p.intro || "")}`,
      [{ kind: "heading", text: p.heading, color: col },
       p.intro ? { kind: "text", text: clip(stripMarks(p.intro), 140) } : null]);

    for (const f of (p.formulas || []).slice(0, 3)) {
      push(
        `Here's the expression. ${stripMarks(f.note || "Read it carefully.")}`,
        [{ kind: "formula", lines: [texToBoard(f.expr)], color: "green" },
         (p.keyvals || []).length
           ? { kind: "bullets", items: p.keyvals.slice(0, 4).map((k) => `${k.k} = ${clip(stripMarks(k.v), 44)}`) }
           : null]
      );
    }
    if (p.table?.headers?.length) {
      push(`Look at the numbers. ${stripMarks(p.table.caption || "")}`,
        [{ kind: "table", headers: p.table.headers.slice(0, 5),
           rows: (p.table.rows || []).slice(0, 4).map((r) => r.slice(0, 5)) }]);
    }
    if (p.star) push(stripMarks(p.star), [{ kind: "boxed", text: clip(stripMarks(p.star), 105), color: "violet" }]);
  }

  for (const b of S.bands) {
    push(
      `${stripMarks(b.label)}: ${b.chain.map((n) => n.label).join(" then ")}.`,
      [{ kind: "heading", text: b.label, color: chalkOfHue(b.color) },
       { kind: "diagram", nodes: b.chain.map((n) => clip(n.label, 22)),
         edges: b.chain.slice(1).map((n, i) => ({ from: i, to: i + 1, label: n.op || "" })) }]
    );
  }

  push(
    `${stripMarks(S.takeaway.line1 || "")} ${stripMarks(S.takeaway.line2 || "")}`,
    [{ kind: "boxed", text: clip(stripMarks(S.takeaway.line2 || S.takeaway.line1), 105), color: "yellow" }]
  );

  return { segments: segs };
}

const clip = (s, n) => { const t = String(s || "").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
/* The board writes chalk, not markup — emphasis syntax must not reach it. */
const stripMarks = (s) => String(s || "")
  .replace(/\[\[(.+?)\|\w+\]\]/g, "$1")
  .replace(/\*\*(.+?)\*\*/g, "$1")
  .replace(/__(.+?)__/g, "$1")
  .trim();

/* ══════════════════════════════════════════════════════════════════════
   UI
   ══════════════════════════════════════════════════════════════════════ */
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

/** The finished poster, in an iframe so its handwriting stylesheet cannot
 *  leak into the LMS shell (and the LMS's cannot leak into it). */
export function StudioSheetView({ sheet, darkMode, canDownload, dayNum, notify }) {
  const ref = useRef(null);
  const html = useMemo(
    () => (sheet?.spec ? studioHTML(sheet, sheet.spec?.title) : ""),
    [sheet?.builtAt, sheet?.spec, sheet?.svgMap]
  );

  useEffect(() => {
    const f = ref.current;
    if (!f || !html) return;
    f.srcdoc = html;
    // Grow the frame to its content so the page scrolls, not the frame.
    const fit = () => {
      try {
        const d = f.contentDocument;
        if (d?.body) f.style.height = Math.max(420, d.body.scrollHeight + 32) + "px";
      } catch {}
    };
    f.addEventListener("load", fit);
    const t = setInterval(fit, 700);
    return () => { f.removeEventListener("load", fit); clearInterval(t); };
  }, [html]);

  if (!sheet?.spec) return null;
  const nFig = Object.keys(sheet.svgMap || {}).length;

  const download = () => {
    if (canDownload && !canDownload()) return;
    const blob = new Blob([html], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Day${dayNum || 1}_${(sheet.spec.title || "notes").replace(/\W+/g, "_")}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
    notify?.(`Saved — ${Math.max(1, Math.round(blob.size / 1024))} KB, opens without internet`);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "#94a3b8", ...mono }}>
          Visual notes
        </span>
        <span style={{ fontSize: 11.5, color: "#94a3b8", ...mono }}>
          {sheet.spec.panels?.length || 0} panels · {nFig} figure{nFig === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        <button className="lms-btn lms-btn-blue" onClick={download}>Download (HTML)</button>
      </div>
      <iframe ref={ref} title="Visual notes" style={{
        width: "100%", border: `1px solid ${darkMode ? "#1e293b" : "#e2e8f0"}`,
        borderRadius: 12, background: "#fff", minHeight: 420, display: "block",
      }} />
    </div>
  );
}

const STAGES = [
  { id: "read",   label: "Read the photos" },
  { id: "design", label: "Lay out the page" },
  { id: "draw",   label: "Draw the figures" },
];

/**
 * The generate panel. Drop this into a day's tab.
 *
 * @param topic/subTopics  the day's fields — the sheet is built from these
 * @param images           optional data URLs already uploaded for the day
 * @param keys             { groq:[...], gemini:[...] }
 * @param onSave           (sheet) => persist it on the day
 * @param onSendToBoard    (segments) => hand the same structure to the board
 */
export function StudioPanel({
  topic, subTopics, series = "", images = [], keys = {}, models = {},
  sheet, onSave, onSendToBoard, darkMode, notify, dayNum, canDownload,
}) {
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState({});
  const [err, setErr] = useState("");
  const abort = useRef(null);

  const hasGroq = (keys.groq || []).length > 0;
  const run = async () => {
    setBusy(true); setErr(""); setStages({});
    abort.current = new AbortController();
    try {
      const out = await runStudioNotes({
        topic, subTopics, series, images, keys, models,
        signal: abort.current.signal,
        onStage: ({ id, state, note }) => setStages((s) => ({ ...s, [id]: { state, note } })),
      });
      onSave?.(out);
      notify?.("Visual notes ready");
    } catch (e) {
      if (e?.name !== "AbortError") { setErr(e.message || String(e)); notify?.(e.message, "err"); }
    } finally { setBusy(false); }
  };

  const sendBoard = () => {
    if (!sheet?.spec) return;
    const { segments } = studioToBoardSegments(sheet.spec);
    onSendToBoard?.(segments);
    notify?.(`Board lesson built — ${segments.length} segments from the same notes`);
  };

  const dot = (st) => st === "done" ? "#22c55e" : st === "run" ? "#3b82f6" : st === "warn" ? "#f59e0b" : "#cbd5e1";

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <button className="lms-btn lms-btn-blue" onClick={run} disabled={busy || !hasGroq}>
          {busy ? "Building…" : sheet?.spec ? "Rebuild notes" : "Generate visual notes"}
        </button>
        {busy && (
          <button className="lms-btn" onClick={() => abort.current?.abort()}>Stop</button>
        )}
        {sheet?.spec && !busy && onSendToBoard && (
          <button className="lms-btn" onClick={sendBoard}>Send to board</button>
        )}
        {images.length > 0 && (
          <span style={{ fontSize: 11.5, color: "#94a3b8", ...mono }}>
            {images.length} photo{images.length === 1 ? "" : "s"} will be read first
          </span>
        )}
      </div>

      {!hasGroq && (
        <div style={{ fontSize: 12.5, color: "#f59e0b", marginBottom: 10 }}>
          Add a Groq key in Settings › AI keys — Groq writes the sheet. A Gemini key is only
          needed if you want photographed notes read as well.
        </div>
      )}

      {(busy || Object.keys(stages).length > 0) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
          {STAGES.filter((s) => s.id !== "read" || images.length > 0).map((s) => {
            const st = stages[s.id];
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: dot(st?.state), flex: "none" }} />
                <span style={{ color: darkMode ? "#cbd5e1" : "#475569" }}>{s.label}</span>
                {st?.note && <span style={{ color: "#94a3b8", ...mono, fontSize: 11.5 }}>{st.note}</span>}
              </div>
            );
          })}
        </div>
      )}

      {err && (
        <div style={{ fontSize: 12.5, color: "#f43f5e", marginBottom: 10 }}>{err}</div>
      )}

      {sheet?.spec && (
        <StudioSheetView sheet={sheet} darkMode={darkMode} canDownload={canDownload}
          dayNum={dayNum} notify={notify} />
      )}
    </div>
  );
}
