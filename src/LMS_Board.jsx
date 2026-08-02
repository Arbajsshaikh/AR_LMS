/* ═══════════════════════════════════════════════════════════════════
   LMS_Board.jsx — Animated chalkboard lesson for a day's topic
   ───────────────────────────────────────────────────────────────────
   Drop-in sibling module for LMSApp.jsx. Nothing here reads a key or
   calls an endpoint directly for text: the host passes in `callAI`,
   so this uses the exact same Groq key rotation, model fallback and
   rate-limit handling as every other generator in the LMS.

   Inputs come from the day, like every other generator:
     topic     -> day.topic
     subtopics -> dayData[dayKey].subTopics

   Exports
     runBoardLessonAgents({ topic, subTopics, level, beats, callAI, onProgress })
     BoardLessonPanel   — the tab UI (playback, doubts, export)
   ═══════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useRef } from "react";

/* ---------------------------------------------------------------- constants */
const BW = 1600, BH = 900;
const CHALK_STEP = 2.4;      // px of path per grain pass — keeps density even
/* Named chalks. The agent picks by name; anything unknown falls back to white. */
const CHALK = {
  white: "#f4f1e6", grey: "#d8d3c2", yellow: "#ffd782", blue: "#9fd8e8",
  green: "#b7e6b0", pink: "#ffb2a3", violet: "#d4bcf5", orange: "#ffc48a"
};
const chalkOf = (name, fallback) => CHALK[String(name || "").toLowerCase()] || fallback;              // board internal resolution
const ML = 66, MR = 66, MT = 58, MB = 54;
const COL = {
  chalk: "#f4f1e6", dim: "#d8d3c2", sky: "#9fd8e8", rose: "#ffb2a3",
  mint: "#b7e6b0", amber: "#ffd782", violet: "#d4bcf5"
};

const GROQ_TEXT_MODELS = [
  "llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b",
  "moonshotai/kimi-k2-instruct", "qwen/qwen3-32b",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.1-8b-instant"
];
const GROQ_VOICES = [
  "Fritz-PlayAI", "Arista-PlayAI", "Celeste-PlayAI", "Basil-PlayAI", "Briggs-PlayAI",
  "Calum-PlayAI", "Cheyenne-PlayAI", "Gail-PlayAI", "Mason-PlayAI", "Mikail-PlayAI",
  "Quinn-PlayAI", "Thunder-PlayAI", "Indigo-PlayAI", "Deedee-PlayAI"
];

/* ------------------------------------------------------------------- random */
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let SEED = 1;
const nextRnd = () => mulberry((SEED = (SEED * 1103515245 + 12345) & 0x7fffffff));

/* ==========================================================================
   1. SINGLE-STROKE CHALK FONT
   Encoding  "width|x,y x,y ...|x,y x,y ..."
   Units: cap-top y=0, baseline y=100, x-height top y=42, descender y=130
   ========================================================================== */
const FONT_SRC = {
  A: "86|3,100 43,2 83,100|17,66 69,66",
  B: "82|10,2 10,100|10,2 50,0 68,12 62,30 44,47 10,48|10,48 56,50 76,66 68,88 46,100 10,99",
  C: "84|78,18 62,3 36,0 15,20 10,55 20,87 44,100 72,92 80,78",
  D: "84|10,1 10,100|10,1 46,3 72,20 76,55 62,88 38,100 10,100",
  E: "74|14,2 11,100|14,2 70,0|12,50 54,49|11,100 72,97",
  F: "72|14,2 11,100|14,2 70,0|12,50 54,49",
  G: "88|78,18 62,3 36,0 15,20 10,55 20,87 44,100 70,94 78,72 78,56|78,56 52,56",
  H: "84|12,0 10,100|76,0 74,100|11,52 75,50",
  I: "50|12,2 46,0|29,1 27,99|10,100 46,98",
  J: "66|60,0 58,78 48,97 26,100 12,86 10,72",
  K: "80|12,0 10,100|74,2 12,56|30,42 78,100",
  L: "70|14,0 11,98|11,98 68,95",
  M: "98|6,100 12,0 46,72 80,0 88,100",
  N: "86|12,100 10,0 76,98 78,0",
  O: "90|46,0 22,10 10,38 12,72 30,95 54,100 76,86 84,56 78,22 60,4 46,0",
  P: "78|12,1 10,100|10,1 50,0 70,12 68,34 46,50 10,50",
  Q: "90|46,0 22,10 10,38 12,72 30,95 54,100 76,86 84,56 78,22 60,4 46,0|56,72 86,110",
  R: "80|12,1 10,100|10,1 50,0 70,12 68,34 46,50 10,50|42,50 78,100",
  S: "76|70,18 52,3 26,4 16,20 24,38 50,50 66,62 66,84 46,99 20,96 10,84",
  T: "80|6,3 76,0|42,1 40,100",
  U: "84|10,0 12,72 28,96 52,100 72,90 78,68 78,0",
  V: "84|6,0 42,100 80,0",
  W: "108|4,0 24,100 52,34 78,100 100,0",
  X: "80|8,2 74,100|74,2 8,100",
  Y: "80|6,0 40,52 76,0|40,52 38,100",
  Z: "78|10,3 72,0 10,98 74,95",

  a: "74|62,52 40,42 18,50 12,72 20,95 42,101 62,88|63,44 62,100",
  b: "74|14,0 12,100|12,62 30,45 54,46 66,68 60,92 38,101 14,92",
  c: "70|64,56 46,43 22,50 14,72 22,95 44,101 64,90",
  d: "74|66,0 64,100|64,55 44,43 20,50 12,73 22,96 46,101 64,88",
  e: "72|14,74 62,70 60,50 38,43 18,55 14,78 28,97 52,101 66,90",
  f: "48|56,8 40,2 30,16 28,100|10,50 54,47",
  g: "74|62,52 40,42 18,50 12,72 20,95 42,101 62,88|63,44 61,104 50,126 28,129 12,118",
  h: "72|14,0 12,100|12,62 30,45 52,44 62,60 62,100",
  i: "34|16,22 17,25|16,44 15,100",
  j: "40|22,22 23,25|24,44 22,108 14,127 2,128",
  k: "68|14,0 12,100|60,45 14,78|28,68 62,100",
  l: "36|14,0 12,90 26,100",
  m: "108|10,45 10,100|10,60 26,45 44,48 48,64 48,100|48,62 64,45 82,48 88,64 88,100",
  n: "72|14,45 12,100|12,60 28,45 50,46 60,62 60,100",
  o: "74|38,42 18,50 12,72 20,94 42,101 62,90 66,68 58,48 38,42",
  p: "74|14,45 12,130|12,62 30,45 54,46 66,68 60,92 38,101 14,92",
  q: "74|62,52 40,42 18,50 12,72 20,95 42,101 62,88|63,44 62,130",
  r: "54|16,45 14,100|14,62 30,46 52,44",
  s: "64|58,52 38,43 18,48 18,62 40,70 56,78 54,94 32,101 12,93",
  t: "48|32,14 30,86 42,100 58,96|10,46 54,44",
  u: "72|14,45 14,84 26,98 46,99 60,86 62,45|62,80 62,100",
  v: "68|8,45 38,100 66,45",
  w: "94|6,45 24,100 42,60 58,100 78,45",
  x: "66|10,46 60,100|60,46 10,100",
  y: "68|8,45 38,100|68,45 32,126 14,128",
  z: "64|10,47 58,45 10,99 60,96",

  0: "72|36,0 16,14 10,50 14,84 34,100 56,92 64,58 58,18 36,0",
  1: "48|12,20 30,2 28,100|12,100 46,98",
  2: "70|12,20 26,3 50,2 62,18 56,40 14,98 64,96",
  3: "70|12,10 34,0 58,6 60,26 38,46 60,54 66,74 58,94 32,100 12,90",
  4: "74|52,2 10,70 66,70|50,2 48,100",
  5: "70|60,3 18,2 14,42 38,36 60,44 66,68 56,92 30,100 10,90",
  6: "70|58,6 34,2 16,22 10,58 18,88 40,100 60,88 62,64 48,50 26,50 12,62",
  7: "68|8,4 62,2 30,100",
  8: "72|38,0 18,10 16,30 38,46 60,32 58,10 38,0|38,46 16,58 12,82 34,100 58,92 62,68 38,46",
  9: "70|60,44 44,52 22,48 12,28 22,8 44,2 60,14 62,48 54,82 34,98 14,96",

  ".": "26|12,96 13,99", ",": "26|14,94 12,100 6,112",
  ":": "26|13,52 14,55|13,96 14,99", ";": "26|13,52 14,55|14,94 12,100 6,112",
  "!": "28|14,2 12,70|13,96 14,99",
  "?": "62|8,18 22,2 44,2 54,16 50,34 30,48 28,68|28,96 29,99",
  "'": "22|11,2 9,24", '"': "36|10,2 8,24|26,2 24,24",
  "(": "36|28,-2 12,26 10,58 14,88 30,110", ")": "36|8,-2 24,26 26,58 22,88 6,110",
  "[": "34|28,-2 10,-2 10,108 28,108", "]": "34|8,-2 26,-2 26,108 8,108",
  "{": "40|32,-2 18,6 18,44 8,54 18,64 18,102 32,108",
  "}": "40|8,-2 22,6 22,44 32,54 22,64 22,102 8,108",
  "+": "72|10,58 62,58|36,32 36,84", "-": "56|8,58 48,58",
  "=": "72|10,44 62,44|10,72 62,72",
  "*": "50|24,18 24,62|8,26 40,54|40,26 8,54",
  "/": "56|8,110 48,-4", "\\": "56|8,-4 48,110",
  "<": "68|58,26 10,58 58,90", ">": "68|10,26 58,58 10,90",
  "%": "88|20,2 8,14 12,30 28,30 34,16 26,2 20,2|76,10 12,96|66,64 54,74 58,90 74,92 80,78 72,64 66,64",
  "&": "88|78,98 30,52 20,30 30,10 50,10 56,26 44,42 18,64 16,84 34,98 56,94 72,76",
  "#": "84|26,4 16,100|60,4 50,100|8,36 74,34|6,68 72,66",
  "@": "96|70,50 56,38 38,42 32,62 42,78 60,74 66,50 66,72 76,80 88,62 86,36 68,12 40,6 18,18 8,44 12,74 32,94 60,98",
  _: "70|4,110 66,110", "|": "24|12,-2 12,108",
  "°": "40|20,6 10,14 12,26 24,30 32,20 28,8 20,6",
  "~": "64|8,58 20,48 32,58 44,68 56,58",
  $: "70|64,18 40,6 18,14 16,32 40,44 62,54 62,80 40,94 14,84|38,-6 38,106",

  "π": "78|8,44 70,42|26,44 22,100|56,44 54,100",
  "θ": "66|32,0 14,20 12,56 20,88 38,100 54,86 58,48 50,14 32,0|14,52 56,50",
  "α": "74|64,46 46,42 22,50 12,70 20,92 40,100 60,80 64,46|40,60 66,100",
  "β": "70|14,130 16,30 26,8 46,4 60,16 58,36 40,50 16,52|40,50 60,62 62,84 48,98 24,96 16,86",
  "γ": "66|8,44 30,80 34,100|58,44 42,90 32,124",
  "Δ": "88|44,2 8,100 80,100 44,2",
  "λ": "72|10,2 24,6 62,100|46,44 12,100",
  "μ": "76|14,44 12,124|12,44 12,84 24,98 44,98 58,86 60,44|60,80 62,100",
  "σ": "78|70,46 40,42 20,52 12,72 22,94 44,100 62,86 64,60 52,46 70,46",
  "φ": "78|40,26 40,124|40,44 20,50 12,70 20,92 40,98 60,90 66,68 58,48 40,44",
  "ω": "88|20,44 10,66 12,88 26,100 38,92 42,72 46,92 58,100 74,90 78,66 68,44",
  "Σ": "82|72,4 10,2 42,50 8,100 74,98",
  "Π": "84|8,44 76,42|22,44 20,100|62,44 60,100",
  "δ": "70|58,14 38,4 20,14 26,30 46,40 60,56 58,80 40,98 20,92 12,72 16,52 30,40",
  "Ω": "84|10,100 30,96 16,70 14,40 30,12 56,10 72,32 70,64 58,94 76,100",
  "∫": "44|32,-16 20,-6 18,50 16,96 4,110",
  "√": "76|4,62 20,70 36,100 60,-4|60,-4 74,-4",
  "∞": "92|30,52 12,62 16,82 34,86 48,70 62,54 80,58 84,78 68,88 50,76 34,58 30,52",
  "±": "72|10,48 62,48|36,24 36,72|10,92 62,92",
  "×": "62|12,32 50,80|50,32 12,80",
  "÷": "72|10,58 62,58|36,30 37,33|36,82 37,85",
  "≈": "72|10,44 22,36 34,44 46,52 58,44|10,72 22,64 34,72 46,80 58,72",
  "≠": "72|10,44 62,44|10,72 62,72|48,24 24,92",
  "≤": "70|58,18 10,50 58,80|10,96 60,94",
  "≥": "70|10,18 58,50 10,80|10,96 60,94",
  "→": "92|6,58 84,58|64,38 84,58 64,78",
  "←": "92|86,58 8,58|28,38 8,58 28,78",
  "↑": "60|30,104 30,10|12,30 30,10 48,30",
  "↓": "60|30,4 30,98|12,78 30,98 48,78",
  "·": "24|11,58 12,61",
  "¹": "26|7,11 17,1 15,55|7,55 25,54",
  "²": "38|7,11 14,2 28,1 34,10 31,22 8,54 35,53",
  "³": "38|7,6 19,0 32,3 33,14 21,25 33,30 36,41 32,52 18,55 7,50",
  "∈": "70|60,20 26,20 12,42 12,70 26,92 60,92|18,56 52,56",
  "∂": "70|54,16 34,6 16,20 12,44 26,58 46,52 54,32|54,32 52,72 38,96 16,98",
  "∇": "84|8,4 76,2 42,100 8,4",
  "∴": "56|26,44 27,47|12,92 13,95|42,92 43,95",
  "∝": "78|16,52 34,42 54,50 62,68 54,90 34,98 16,88 30,70 46,52 62,44"
};

const FONT = (() => {
  const f = {};
  for (const k in FONT_SRC) {
    const parts = FONT_SRC[k].split("|");
    f[k] = {
      w: parseFloat(parts[0]) / 100,
      s: parts.slice(1).map(seg =>
        seg.trim().split(/\s+/).map(p => {
          const [x, y] = p.split(",");
          return [parseFloat(x) / 100, parseFloat(y) / 100];
        })
      )
    };
  }
  f[" "] = { w: 0.30, s: [] };
  return f;
})();

const TRACK = 0.012;   // letter spacing (em) — glyphs carry their own side bearings
const glyphOf = ch => FONT[ch] || FONT[ch.toLowerCase()] || FONT["·"];

/* Models leak TeX into plain-text fields. Render the symbol, not the backslash. */
function deTex(s) {
  let t = String(s ?? "");
  if (t.indexOf("\\") >= 0)
    t = t.replace(/\\[a-zA-Z]+/g, m => (MACROS[m] !== undefined ? MACROS[m] : m.slice(1)));
  return t
    .replace(/\$/g, "")
    .replace(/\^\{?2\}?/g, "²").replace(/\^\{?3\}?/g, "³")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
const chW = (ch, S) => (glyphOf(ch).w + TRACK) * S;
const measure = (str, S) => { let w = 0; for (const c of String(str)) w += chW(c, S); return w; };

/* Catmull-Rom resample for natural, smooth strokes */
function smooth(pts, per = 5) {
  if (pts.length < 3) {
    if (pts.length === 2) {
      const o = [];
      for (let i = 0; i <= per; i++) {
        const t = i / per;
        o.push([pts[0][0] + (pts[1][0] - pts[0][0]) * t, pts[0][1] + (pts[1][1] - pts[0][1]) * t]);
      }
      return o;
    }
    return pts.slice();
  }
  const p = [pts[0], ...pts, pts[pts.length - 1]], out = [];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    for (let j = 0; j < per; j++) {
      const t = j / per, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
      ]);
    }
  }
  out.push(p[p.length - 2]);
  return out;
}
const strokeLen = p => { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return L; };
const mkStroke = (p, w, c, o = {}) => {
  const sp = smooth(p, o.raw ? 1 : 5);
  return { p: sp, w, c, len: strokeLen(sp), dash: o.dash || false };
};

/* glyph -> absolute strokes, with human wobble */
function glyphStrokes(ch, x, yBase, S, color, rnd, weight, drift = 0) {
  const g = glyphOf(ch), out = [];
  const slant = -0.055;                       // slight forward lean
  const jx = (rnd() - 0.5) * S * 0.03, jy = (rnd() - 0.5) * S * 0.012 + drift;
  const sx = 1 + (rnd() - 0.5) * 0.05, sy = 1 + (rnd() - 0.5) * 0.05;
  for (const seg of g.s) {
    const pts = seg.map(([gx, gy]) => {
      const ux = gx * sx, uy = gy * sy;
      return [
        x + jx + (ux + slant * (1 - uy)) * S + (rnd() - 0.5) * S * 0.022,
        yBase + jy - S + uy * S + (rnd() - 0.5) * S * 0.022
      ];
    });
    out.push(mkStroke(pts, weight, color));
  }
  return out;
}

function textStrokes(str, x, yBase, S, color, rnd, opts = {}) {
  const out = []; let cx = x;
  const weight = opts.weight || Math.max(1.6, S * 0.075);
  // a hand wanders off the ruled line slowly, it does not vibrate
  const ph = rnd() * 6.283, wl = S * (7 + rnd() * 5), amp = S * 0.026;
  for (const ch of String(str)) {
    const drift = Math.sin(ph + (cx - x) / wl) * amp;
    if (ch !== " ") out.push(...glyphStrokes(ch, cx, yBase, S, color, rnd, weight, drift));
    cx += chW(ch, S);
  }
  if (opts.underline) {
    out.push(mkStroke(
      [[x, yBase + S * 0.20], [cx - S * 0.05, yBase + S * 0.20 + (rnd() - 0.5) * S * 0.05]],
      weight * 0.85, color
    ));
  }
  return out;
}

/* ==========================================================================
   2. MATH TYPESETTER  (mini-TeX -> strokes)
   ========================================================================== */
const MACROS = {
  "\\pi": "π", "\\theta": "θ", "\\alpha": "α", "\\beta": "β", "\\gamma": "γ",
  "\\Delta": "Δ", "\\delta": "δ", "\\lambda": "λ", "\\mu": "μ", "\\sigma": "σ",
  "\\phi": "φ", "\\omega": "ω", "\\Omega": "Ω", "\\Sigma": "Σ", "\\infty": "∞",
  "\\pm": "±", "\\times": "×", "\\cdot": "·", "\\div": "÷", "\\approx": "≈",
  "\\neq": "≠", "\\ne": "≠", "\\leq": "≤", "\\le": "≤", "\\geq": "≥", "\\ge": "≥",
  "\\to": "→", "\\rightarrow": "→", "\\leftarrow": "←", "\\Rightarrow": "→",
  "\\in": "∈", "\\partial": "∂", "\\nabla": "∇", "\\therefore": "∴",
  "\\propto": "∝", "\\degree": "°", "\\circ": "°", "\\%": "%", "\\ ": " ",
  "\\left": "", "\\right": "", "\\,": " ", "\\;": " ", "\\!": ""
};

function tokenizeTex(s) {
  const t = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      let j = i + 1, name = "\\";
      if (/[a-zA-Z]/.test(s[j])) { while (j < s.length && /[a-zA-Z]/.test(s[j])) name += s[j++]; }
      else name += s[j++];
      t.push({ t: "cmd", v: name }); i = j;
    } else if ("{}^_".includes(c)) { t.push({ t: c }); i++; }
    else { t.push({ t: "ch", v: c }); i++; }
  }
  return t;
}

function parseTex(tokens) {
  let i = 0;
  function group() {
    if (tokens[i] && tokens[i].t === "{") {
      i++; const n = list("}"); if (tokens[i] && tokens[i].t === "}") i++; return n;
    }
    return atom() || { k: "row", c: [] };
  }
  function atom() {
    const tk = tokens[i];
    if (!tk) return null;
    if (tk.t === "ch") { i++; return { k: "ch", v: tk.v }; }
    if (tk.t === "cmd") {
      const v = tk.v; i++;
      if (v === "\\frac" || v === "\\dfrac") return { k: "frac", n: group(), d: group() };
      if (v === "\\sqrt") return { k: "sqrt", c: group() };
      if (v === "\\vec") return { k: "acc", a: "→", c: group() };
      if (v === "\\bar" || v === "\\overline") return { k: "acc", a: "-", c: group() };
      if (v === "\\hat") return { k: "acc", a: "^", c: group() };
      if (v === "\\text" || v === "\\mathrm" || v === "\\operatorname") return { k: "text", c: group() };
      if (v === "\\sum") return { k: "big", v: "Σ" };
      if (v === "\\int") return { k: "big", v: "∫" };
      if (v === "\\prod") return { k: "big", v: "Π" };
      if (v === "\\lim") return { k: "big", v: "lim" };
      const m = MACROS[v];
      if (m === "") return { k: "row", c: [] };
      return { k: "ch", v: m !== undefined ? m : v.slice(1) };
    }
    if (tk.t === "{") return group();
    return null;
  }
  function list(stop) {
    const c = [];
    while (i < tokens.length) {
      if (stop && tokens[i].t === stop) break;
      if (tokens[i].t === "^" || tokens[i].t === "_") {
        const kind = tokens[i].t; i++;
        const arg = group(); const prev = c[c.length - 1];
        if (prev && (prev.k === "sup" || prev.k === "sub") === false && prev.k !== "script") {
          c[c.length - 1] = { k: "script", base: prev, sup: kind === "^" ? arg : null, sub: kind === "_" ? arg : null };
        } else if (prev && prev.k === "script") {
          if (kind === "^") prev.sup = arg; else prev.sub = arg;
        } else c.push({ k: "script", base: { k: "row", c: [] }, sup: kind === "^" ? arg : null, sub: kind === "_" ? arg : null });
        continue;
      }
      const a = atom(); if (!a) { i++; continue; } c.push(a);
    }
    return { k: "row", c };
  }
  return list(null);
}

function mMeasure(n, S) {
  switch (n.k) {
    case "ch": return { w: chW(n.v, S), a: S, d: S * 0.32 };
    case "row": {
      let w = 0, a = S * 0.8, d = S * 0.2;
      for (const c of n.c) { const m = mMeasure(c, S); w += m.w; a = Math.max(a, m.a); d = Math.max(d, m.d); }
      return { w, a, d };
    }
    case "text": { const m = mMeasure(n.c, S * 0.95); return m; }
    case "frac": {
      const a = mMeasure(n.n, S * 0.86), b = mMeasure(n.d, S * 0.86);
      return { w: Math.max(a.w, b.w) + S * 0.22, a: a.a + a.d + S * 0.30, d: b.a + b.d + S * 0.10 };
    }
    case "sqrt": { const m = mMeasure(n.c, S); return { w: m.w + S * 0.62, a: m.a + S * 0.20, d: m.d }; }
    case "acc": { const m = mMeasure(n.c, S); return { w: m.w, a: m.a + S * 0.22, d: m.d }; }
    case "big": { const s = S * 1.5; return { w: (n.v === "lim" ? measure("lim", S) : chW(n.v, s)), a: s * 0.95, d: s * 0.35 }; }
    case "script": {
      const b = mMeasure(n.base, S);
      const su = n.sup ? mMeasure(n.sup, S * 0.62) : { w: 0, a: 0, d: 0 };
      const sb = n.sub ? mMeasure(n.sub, S * 0.62) : { w: 0, a: 0, d: 0 };
      const isBig = n.base.k === "big";
      if (isBig) return { w: Math.max(b.w, su.w, sb.w), a: b.a + su.a + S * 0.1, d: b.d + sb.a + S * 0.1 };
      return { w: b.w + Math.max(su.w, sb.w) + S * 0.04, a: b.a + (n.sup ? S * 0.34 : 0), d: b.d + (n.sub ? S * 0.28 : 0) };
    }
    default: return { w: 0, a: 0, d: 0 };
  }
}

function mDraw(n, x, y, S, color, rnd, out) {
  const W = Math.max(1.7, S * 0.078);
  switch (n.k) {
    case "ch": out.push(...textStrokes(n.v, x, y, S, color, rnd, { weight: W })); return chW(n.v, S);
    case "text": return mDraw(n.c, x, y, S * 0.95, color, rnd, out);
    case "row": { let cx = x; for (const c of n.c) cx += mDraw(c, cx, y, S, color, rnd, out); return cx - x; }
    case "frac": {
      const s2 = S * 0.86, a = mMeasure(n.n, s2), b = mMeasure(n.d, s2);
      const w = Math.max(a.w, b.w), tot = w + S * 0.22, bar = y - S * 0.30;
      mDraw(n.n, x + S * 0.11 + (w - a.w) / 2, bar - S * 0.16, s2, color, rnd, out);
      out.push(mkStroke([[x + S * 0.04, bar], [x + tot - S * 0.04, bar + (rnd() - 0.5) * S * 0.04]], W, color));
      mDraw(n.d, x + S * 0.11 + (w - b.w) / 2, bar + b.a + S * 0.16, s2, color, rnd, out);
      return tot;
    }
    case "sqrt": {
      const m = mMeasure(n.c, S), top = y - m.a - S * 0.16;
      out.push(mkStroke([[x, y - m.a * 0.45], [x + S * 0.16, y - m.a * 0.3], [x + S * 0.34, y + m.d * 0.7], [x + S * 0.5, top]], W, color));
      out.push(mkStroke([[x + S * 0.5, top], [x + S * 0.58 + m.w, top + (rnd() - 0.5) * S * 0.04]], W * 0.9, color));
      mDraw(n.c, x + S * 0.58, y, S, color, rnd, out);
      return m.w + S * 0.62;
    }
    case "acc": {
      const m = mMeasure(n.c, S);
      mDraw(n.c, x, y, S, color, rnd, out);
      const ay = y - m.a - S * 0.1;
      if (n.a === "→") { out.push(mkStroke([[x, ay], [x + m.w, ay]], W * 0.8, color)); out.push(mkStroke([[x + m.w - S * 0.13, ay - S * 0.09], [x + m.w, ay], [x + m.w - S * 0.13, ay + S * 0.09]], W * 0.8, color)); }
      else if (n.a === "-") out.push(mkStroke([[x, ay], [x + m.w, ay]], W * 0.8, color));
      else out.push(mkStroke([[x + m.w * 0.2, ay], [x + m.w * 0.5, ay - S * 0.14], [x + m.w * 0.8, ay]], W * 0.8, color));
      return m.w;
    }
    case "big": {
      if (n.v === "lim") { out.push(...textStrokes("lim", x, y, S, color, rnd, { weight: W })); return measure("lim", S); }
      const s = S * 1.5;
      out.push(...textStrokes(n.v, x, y + s * 0.16, s, color, rnd, { weight: W * 1.15 }));
      return chW(n.v, s);
    }
    case "script": {
      const isBig = n.base.k === "big";
      const bw = mDraw(n.base, x, y, S, color, rnd, out);
      const ss = S * 0.62;
      if (isBig) {
        const bm = mMeasure(n.base, S);
        if (n.sup) { const m = mMeasure(n.sup, ss); mDraw(n.sup, x + (bw - m.w) / 2, y - bm.a - S * 0.18, ss, color, rnd, out); }
        if (n.sub) { const m = mMeasure(n.sub, ss); mDraw(n.sub, x + (bw - m.w) / 2, y + bm.d + m.a + S * 0.1, ss, color, rnd, out); }
        return Math.max(bw, n.sup ? mMeasure(n.sup, ss).w : 0, n.sub ? mMeasure(n.sub, ss).w : 0);
      }
      let ex = 0;
      if (n.sup) { mDraw(n.sup, x + bw + S * 0.03, y - S * 0.52, ss, color, rnd, out); ex = Math.max(ex, mMeasure(n.sup, ss).w); }
      if (n.sub) { mDraw(n.sub, x + bw + S * 0.03, y + S * 0.22, ss, color, rnd, out); ex = Math.max(ex, mMeasure(n.sub, ss).w); }
      return bw + ex + S * 0.04;
    }
    default: return 0;
  }
}
const texMeasure = (tex, S) => mMeasure(parseTex(tokenizeTex(tex)), S);
function texStrokes(tex, x, y, S, color, rnd) { const o = []; mDraw(parseTex(tokenizeTex(tex)), x, y, S, color, rnd, o); return o; }

/* ==========================================================================
   3. SAFE EXPRESSION EVALUATOR (for graphs)
   ========================================================================== */
function compileExpr(src) {
  const s = String(src).replace(/\s+/g, "").replace(/\)\(/g, ")*(");
  let i = 0;
  const peek = () => s[i];
  function parseE() { let v = parseT(); while (peek() === "+" || peek() === "-") { const o = s[i++]; const r = parseT(); const a = v; v = o === "+" ? x => a(x) + r(x) : x => a(x) - r(x); } return v; }
  function parseT() {
    let v = parseU();
    while (peek() === "*" || peek() === "/") {
      const o = s[i++]; const r = parseU(); const a = v;
      v = o === "*" ? x => a(x) * r(x) : x => a(x) / r(x);
    }
    return v;
  }
  // -x^2 must mean -(x^2), and 2^-1 must still parse, so unary binds
  // looser than ^ on the left and tighter on the right.
  function parseU() { if (peek() === "-") { i++; const v = parseU(); return x => -v(x); } if (peek() === "+") { i++; return parseU(); } return parseF(); }
  function parseF() { const b = parseP(); if (peek() === "^") { i++; const e = parseU(); return x => Math.pow(b(x), e(x)); } return b; }
  function parseP() {
    if (peek() === "(") { i++; const v = parseE(); if (peek() === ")") i++; return v; }
    if (/[0-9.]/.test(peek() || "")) { let n = ""; while (i < s.length && /[0-9.]/.test(s[i])) n += s[i++]; const val = parseFloat(n); return () => val; }
    let id = ""; while (i < s.length && /[a-zA-Z]/.test(s[i])) id += s[i++];
    id = id.toLowerCase();
    if (peek() === "(") {
      i++; const arg = parseE(); if (peek() === ")") i++;
      const F = { sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10, sqrt: Math.sqrt, abs: Math.abs, sign: Math.sign, floor: Math.floor, ceil: Math.ceil, round: Math.round }[id];
      return F ? x => F(arg(x)) : () => NaN;
    }
    if (id === "pi") return () => Math.PI;
    if (id === "e") return () => Math.E;
    if (id === "x" || id === "t" || id === "n") return x => x;
    return () => NaN;
  }
  try { const f = parseE(); f(0); return f; } catch { return () => NaN; }
}

/* ==========================================================================
   4. BOARD COMPOSER — turns agent blocks into positioned chalk strokes
   ========================================================================== */
/* A word longer than the column cannot wrap on spaces. Hard-break it so
   nothing ever runs off the right edge of the board. */
function fitWords(text, S, maxW) {
  const out = [];
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (measure(w, S) <= maxW) { out.push(w); continue; }
    let cur = "";
    for (const ch of w) {
      if (cur && measure(cur + ch, S) > maxW) { out.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) out.push(cur);
  }
  return out;
}

class Composer {
  constructor() {
    this.out = [];
    this.colX = { full: ML, left: ML, right: ML + 940 };
    this.colW = { full: BW - ML - MR, left: 880, right: BW - MR - (ML + 940) };
    this.y = { full: MT + 40, left: MT + 40, right: MT + 40 };
    this.page = 0;
    this.rnd = nextRnd();
  }
  push(s) { this.out.push(...s); }
  cursorY(col) { return col === "full" ? Math.max(this.y.full, this.y.left, this.y.right) : this.y[col]; }
  advance(col, dy) {
    if (col === "full") { const t = Math.max(this.y.full, this.y.left, this.y.right) + dy; this.y.full = this.y.left = this.y.right = t; }
    else this.y[col] += dy;
  }
  ensure(col, h) {
    if (this.cursorY(col) + h > BH - MB) {
      if (col === "right" && this.y.left + h <= BH - MB) return "left";
      if (col === "left" && this.y.right + h <= BH - MB && this.colW.right > 300) return "right";
      this.break();
    }
    return col;
  }
  break() {
    this.out.push({ brk: true });
    this.page++;
    this.y = { full: MT + 40, left: MT + 40, right: MT + 40 };
  }

  title(text) {
    const S = 50, col = "full"; text = deTex(text);
    const w = measure(text, S), x = ML + Math.max(0, (this.colW.full - w) / 2);
    this.ensure(col, S * 2.1);
    const y = this.cursorY(col) + S;
    this.push(textStrokes(text, x, y, S, COL.amber, this.rnd, { weight: S * 0.088 }));
    this.push([mkStroke([[x - 14, y + 24], [x + w + 10, y + 22 + (this.rnd() - 0.5) * 6]], 3.4, COL.amber)]);
    this.advance(col, S * 1.9);
  }
  heading(text, col = "full", color) {
    const S = 36; text = deTex(text); col = this.ensure(col, S * 2.0);
    const y = this.cursorY(col) + S;
    const x = this.colX[col];
    this.push(textStrokes(text, x, y, S, color || COL.sky, this.rnd, { weight: S * 0.085, underline: true }));
    this.advance(col, S * 1.85);
  }
  para(text, col = "full", color = COL.chalk, size = 27) {
    const S = size, maxW = this.colW[col], lh = S * 1.66;
    const words = fitWords(deTex(text), S, maxW);
    let line = "";
    const flush = () => {
      if (!line) return;
      col = this.ensure(col, lh);
      const y = this.cursorY(col) + S;
      this.push(textStrokes(line, this.colX[col], y, S, color, this.rnd));
      this.advance(col, lh); line = "";
    };
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (measure(t, S) > maxW && line) flush(); else line = t;
      if (measure(line, S) > maxW) flush();
    }
    flush();
    this.advance(col, S * 0.24);
    return col;
  }
  bullets(items, col = "full", numbered = false, color) {
    const S = 26, lh = S * 1.62, ind = S * 1.5;
    items.forEach((it, idx) => {
      const marker = numbered ? `${idx + 1}.` : "";
      col = this.ensure(col, lh);
      const y0 = this.cursorY(col) + S;
      const x0 = this.colX[col];
      if (numbered) this.push(textStrokes(marker, x0, y0, S, COL.amber, this.rnd));
      else {
        this.push([mkStroke([[x0 + 4, y0 - S * 0.30], [x0 + 15, y0 - S * 0.34], [x0 + 16, y0 - S * 0.22], [x0 + 4, y0 - S * 0.18], [x0 + 4, y0 - S * 0.30]], 3, COL.amber)]);
      }
      const maxW = this.colW[col] - ind;
      const words = fitWords(deTex(it), S, maxW);
      let line = "", first = true;
      const flush = () => {
        if (!line) return;
        if (!first) col = this.ensure(col, lh);
        const y = first ? y0 : this.cursorY(col) + S;
        this.push(textStrokes(line, this.colX[col] + ind, y, S, color || COL.chalk, this.rnd));
        this.advance(col, lh); line = ""; first = false;
      };
      for (const w of words) {
        const t = line ? line + " " + w : w;
        if (measure(t, S) > maxW && line) flush(); else line = t;
      }
      flush();
      this.advance(col, 5);
    });
    this.advance(col, 8);
  }
  formula(tex, label, col = "full", color = COL.mint) {
    const S = 38;
    const m = texMeasure(tex, S);
    const h = m.a + m.d + 34;
    col = this.ensure(col, h + (label ? 30 : 0));
    const x = this.colX[col] + Math.max(0, (this.colW[col] - m.w) / 2);
    const y = this.cursorY(col) + m.a + 14;
    this.push(texStrokes(tex, x, y, S, color, this.rnd));
    if (label) {
      label = deTex(label);
      const ls = 20, lw = measure(label, ls);
      this.push(textStrokes(label, this.colX[col] + Math.max(0, (this.colW[col] - lw) / 2), y + m.d + 26, ls, COL.dim, this.rnd));
    }
    this.advance(col, h + (label ? 30 : 0) + 10);
  }
  boxed(text, col = "full") {
    const S = 28, pad = 20, maxW = this.colW[col] - pad * 2 - 12;
    const words = fitWords(deTex(text), S, maxW), lines = []; let line = "";
    for (const w of words) { const t = line ? line + " " + w : w; if (measure(t, S) > maxW && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line);
    const h = lines.length * S * 1.6 + pad * 2;
    col = this.ensure(col, h + 22);
    const x = this.colX[col], y = this.cursorY(col), w = this.colW[col] - 8;
    const r = this.rnd, j = () => (r() - 0.5) * 7;
    this.push([
      mkStroke([[x + j(), y + j()], [x + w + j(), y + j()]], 3, COL.amber),
      mkStroke([[x + w + j(), y + j()], [x + w + j(), y + h + j()]], 3, COL.amber),
      mkStroke([[x + w + j(), y + h + j()], [x + j(), y + h + j()]], 3, COL.amber),
      mkStroke([[x + j(), y + h + j()], [x + j(), y + j()]], 3, COL.amber)
    ]);
    lines.forEach((L, i) => this.push(textStrokes(L, x + pad + 8, y + pad + S + i * S * 1.6, S, COL.amber, r, { weight: S * 0.085 })));
    this.advance(col, h + 26);
  }
  divider(col = "full") {
    col = this.ensure(col, 26);
    const y = this.cursorY(col) + 12, x = this.colX[col], w = this.colW[col];
    const pts = []; for (let i = 0; i <= 8; i++) pts.push([x + (w * i) / 8, y + (this.rnd() - 0.5) * 5]);
    this.push([mkStroke(pts, 2, COL.dim)]);
    this.advance(col, 30);
  }
  table(headers, rows, col = "full") {
    const S = 22, padX = 14, rowH = S * 2.05;
    const nCol = Math.max(1, headers.length);
    const totalW = Math.min(this.colW[col] - 6, 120 + nCol * 200);
    const cw = totalW / nCol;
    const h = (rows.length + 1) * rowH + 12;
    col = this.ensure(col, h + 20);
    const x = this.colX[col], y = this.cursorY(col) + 8;
    const r = this.rnd, jj = () => (r() - 0.5) * 4;
    // header text
    headers.forEach((hd, i) => {
      const t = deTex(hd), ts = measure(t, S) > cw - padX * 2 ? S * (cw - padX * 2) / measure(t, S) : S;
      this.push(textStrokes(t, x + i * cw + padX, y + rowH * 0.66, ts, COL.amber, r, { weight: ts * 0.09 }));
    });
    // header rule
    this.push([mkStroke([[x + jj(), y + rowH], [x + totalW + jj(), y + rowH + jj()]], 3, COL.amber)]);
    rows.forEach((row, ri) => {
      row.slice(0, nCol).forEach((cell, ci) => {
        const t = deTex(cell), ts = measure(t, S) > cw - padX * 2 ? S * (cw - padX * 2) / measure(t, S) : S;
        this.push(textStrokes(t, x + ci * cw + padX, y + rowH * (ri + 1) + rowH * 0.66, ts, COL.chalk, r));
      });
      if (ri < rows.length - 1)
        this.push([mkStroke([[x + jj(), y + rowH * (ri + 2)], [x + totalW + jj(), y + rowH * (ri + 2) + jj()]], 1.4, COL.dim)]);
    });
    // verticals + frame
    for (let i = 1; i < nCol; i++)
      this.push([mkStroke([[x + i * cw + jj(), y + jj()], [x + i * cw + jj(), y + rowH * (rows.length + 1) + jj()]], 1.4, COL.dim)]);
    this.push([
      mkStroke([[x + jj(), y + jj()], [x + totalW + jj(), y + jj()]], 2, COL.dim),
      mkStroke([[x + jj(), y + rowH * (rows.length + 1) + jj()], [x + totalW + jj(), y + rowH * (rows.length + 1) + jj()]], 2, COL.dim),
      mkStroke([[x + jj(), y + jj()], [x + jj(), y + rowH * (rows.length + 1) + jj()]], 2, COL.dim),
      mkStroke([[x + totalW + jj(), y + jj()], [x + totalW + jj(), y + rowH * (rows.length + 1) + jj()]], 2, COL.dim)
    ]);
    this.advance(col, h + 22);
  }
  graph(g, col = "full") {
    const W = Math.min(this.colW[col] - 10, 620), H = 400;
    col = this.ensure(col, H + 66);
    const ox = this.colX[col] + Math.max(0, (this.colW[col] - W) / 2), oy = this.cursorY(col) + 20;
    const r = this.rnd;
    let [x0, x1] = g.domain || [-6, 6];
    let [y0, y1] = g.range || [-6, 6];
    const curves = (g.curves || []).map(c => ({ ...c, f: compileExpr(c.expr) }));
    if (!g.range && curves.length) {
      let lo = Infinity, hi = -Infinity;
      for (const c of curves) for (let i = 0; i <= 200; i++) {
        const v = c.f(x0 + (x1 - x0) * i / 200);
        if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      if (isFinite(lo) && isFinite(hi)) { const p = (hi - lo) * 0.18 + 0.5; y0 = lo - p; y1 = hi + p; }
    }
    const px = v => ox + ((v - x0) / (x1 - x0)) * W;
    const py = v => oy + H - ((v - y0) / (y1 - y0)) * H;
    const ax = Math.max(oy, Math.min(oy + H, py(0))), ay = Math.max(ox, Math.min(ox + W, px(0)));
    if (g.title) { const s = 24; g = { ...g, title: deTex(g.title) }; this.push(textStrokes(g.title, ox + Math.max(0, (W - measure(g.title, s)) / 2), oy - 4, s, COL.dim, r)); }
    // axes
    this.push([mkStroke([[ox - 8, ax], [ox + W + 8, ax + (r() - 0.5) * 4]], 2.6, COL.dim)]);
    this.push([mkStroke([[ay, oy - 8], [ay + (r() - 0.5) * 4, oy + H + 8]], 2.6, COL.dim)]);
    this.push([mkStroke([[ox + W - 12, ax - 7], [ox + W + 8, ax], [ox + W - 12, ax + 7]], 2.2, COL.dim)]);
    this.push([mkStroke([[ay - 7, oy + 4], [ay, oy - 8], [ay + 7, oy + 4]], 2.2, COL.dim)]);
    // ticks
    const step = v => { const raw = v / 6, m = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1))); const n = raw / m; return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * m; };
    const sx = step(x1 - x0), sy = step(y1 - y0);
    for (let v = Math.ceil(x0 / sx) * sx; v <= x1; v += sx) {
      if (Math.abs(v) < 1e-9) continue;
      this.push([mkStroke([[px(v), ax - 6], [px(v), ax + 6]], 1.6, COL.dim)]);
      const lb = (Math.round(v * 100) / 100).toString();
      this.push(textStrokes(lb, px(v) - measure(lb, 16) / 2, ax + 26, 16, COL.dim, r));
    }
    for (let v = Math.ceil(y0 / sy) * sy; v <= y1; v += sy) {
      if (Math.abs(v) < 1e-9) continue;
      this.push([mkStroke([[ay - 6, py(v)], [ay + 6, py(v)]], 1.6, COL.dim)]);
      const lb = (Math.round(v * 100) / 100).toString();
      this.push(textStrokes(lb, ay - measure(lb, 16) - 12, py(v) + 6, 16, COL.dim, r));
    }
    if (g.xLabel) this.push(textStrokes(g.xLabel, ox + W - measure(g.xLabel, 19) - 4, ax - 12, 19, COL.dim, r));
    if (g.yLabel) this.push(textStrokes(g.yLabel, ay + 12, oy + 6, 19, COL.dim, r));
    // curves
    const palette = [COL.mint, COL.rose, COL.sky, COL.violet, COL.amber];
    curves.forEach((c, ci) => {
      const color = palette[ci % palette.length];
      let seg = [];
      const flush = () => { if (seg.length > 1) this.push([mkStroke(seg, 3, color, { raw: true, dash: c.dashed })]); seg = []; };
      for (let i = 0; i <= 260; i++) {
        const xv = x0 + (x1 - x0) * i / 260, yv = c.f(xv);
        if (!isFinite(yv) || yv < y0 - (y1 - y0) * 1.2 || yv > y1 + (y1 - y0) * 1.2) { flush(); continue; }
        seg.push([px(xv), py(yv) + (r() - 0.5) * 1.6]);
      }
      flush();
      if (c.label) {
        const ly = oy + 16 + ci * 26;
        this.push([mkStroke([[ox + W - 150, ly], [ox + W - 118, ly]], 3, color, { dash: c.dashed })]);
        this.push(textStrokes(deTex(c.label), ox + W - 110, ly + 6, 18, color, r));
      }
    });
    (g.points || []).forEach(p => {
      const X = px(p.x), Y = py(p.y);
      this.push([mkStroke([[X - 7, Y - 7], [X + 7, Y + 7]], 2.6, COL.rose), mkStroke([[X + 7, Y - 7], [X - 7, Y + 7]], 2.6, COL.rose)]);
      if (p.label) this.push(textStrokes(deTex(p.label), X + 12, Y - 8, 17, COL.rose, r));
    });
    this.advance(col, H + 56);
  }
  bars(g, col = "full") {
    const W = Math.min(this.colW[col] - 10, 620), H = 330;
    col = this.ensure(col, H + 70);
    const ox = this.colX[col] + Math.max(0, (this.colW[col] - W) / 2), oy = this.cursorY(col) + 22, r = this.rnd;
    const vals = g.values || [], cats = g.categories || [];
    const max = Math.max(...vals, 1) * 1.15;
    if (g.title) this.push(textStrokes(deTex(g.title), ox + Math.max(0, (W - measure(deTex(g.title), 24)) / 2), oy - 2, 24, COL.dim, r));
    this.push([mkStroke([[ox, oy + H], [ox + W, oy + H + (r() - 0.5) * 4]], 2.6, COL.dim)]);
    this.push([mkStroke([[ox, oy], [ox + (r() - 0.5) * 4, oy + H]], 2.6, COL.dim)]);
    const bw = (W - 40) / Math.max(1, vals.length), palette = [COL.mint, COL.sky, COL.rose, COL.amber, COL.violet];
    vals.forEach((v, i) => {
      const h = (v / max) * H, x = ox + 26 + i * bw, w = bw * 0.58, c = palette[i % palette.length];
      const j = () => (r() - 0.5) * 4;
      this.push([mkStroke([[x + j(), oy + H], [x + j(), oy + H - h]], 2.6, c),
      mkStroke([[x + j(), oy + H - h], [x + w + j(), oy + H - h + j()]], 2.6, c),
      mkStroke([[x + w + j(), oy + H - h], [x + w + j(), oy + H]], 2.6, c)]);
      for (let k = 1; k < 5; k++) { const yy = oy + H - h * (k / 5); this.push([mkStroke([[x + 3, yy], [x + w - 3, yy + 6]], 1.1, c)]); }
      const lb = deTex(cats[i] ?? ""), ls = Math.min(18, 18 * (bw * 0.9) / Math.max(1, measure(lb, 18)));
      this.push(textStrokes(lb, x + w / 2 - measure(lb, ls) / 2, oy + H + 26, ls, COL.chalk, r));
      const vs = String(v);
      this.push(textStrokes(vs, x + w / 2 - measure(vs, 17) / 2, oy + H - h - 10, 17, c, r));
    });
    this.advance(col, H + 62);
  }
  diagram(d, col = "full") {
    const W = Math.min(this.colW[col] - 10, 900), H = d.height || 380;
    col = this.ensure(col, H + 50);
    const ox = this.colX[col] + Math.max(0, (this.colW[col] - W) / 2), oy = this.cursorY(col) + 16, r = this.rnd;
    if (d.title) this.push(textStrokes(deTex(d.title), ox + Math.max(0, (W - measure(d.title, 24)) / 2), oy + 4, 24, COL.dim, r));
    const off = d.title ? 30 : 0;
    const N = {};
    (d.nodes || []).forEach(n => {
      const cx = ox + (n.x ?? 0.5) * W, cy = oy + off + (n.y ?? 0.5) * (H - off);
      const S = 21, label = deTex(n.label ?? "");
      const words = label.split(/\s+/), lines = []; let ln = "";
      for (const w of words) { const t = ln ? ln + " " + w : w; if (measure(t, S) > 190 && ln) { lines.push(ln); ln = w; } else ln = t; }
      if (ln) lines.push(ln);
      const tw = Math.max(...lines.map(l => measure(l, S)), 40);
      const w = Math.max(n.w ? n.w * W : tw + 40, 70), h = Math.max(lines.length * S * 1.45 + 26, 54);
      N[n.id] = { cx, cy, w, h, shape: n.shape || "rect" };
      const c = n.color === "accent" ? COL.amber : n.color === "alt" ? COL.sky : COL.chalk;
      const j = () => (r() - 0.5) * 6;
      if (N[n.id].shape === "ellipse" || N[n.id].shape === "circle") {
        const pts = []; const rx = w / 2, ry = h / 2;
        for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; pts.push([cx + Math.cos(a) * rx + (r() - 0.5) * 4, cy + Math.sin(a) * ry + (r() - 0.5) * 4]); }
        this.push([mkStroke(pts, 2.6, c)]);
      } else if (N[n.id].shape === "diamond") {
        this.push([mkStroke([[cx, cy - h / 2 + j()], [cx + w / 2 + j(), cy], [cx, cy + h / 2 + j()], [cx - w / 2 + j(), cy], [cx, cy - h / 2]], 2.6, c)]);
      } else {
        const L = cx - w / 2, R = cx + w / 2, T = cy - h / 2, B = cy + h / 2;
        this.push([mkStroke([[L + j(), T + j()], [R + j(), T + j()]], 2.6, c),
        mkStroke([[R + j(), T + j()], [R + j(), B + j()]], 2.6, c),
        mkStroke([[R + j(), B + j()], [L + j(), B + j()]], 2.6, c),
        mkStroke([[L + j(), B + j()], [L + j(), T + j()]], 2.6, c)]);
      }
      lines.forEach((L, i) =>
        this.push(textStrokes(L, cx - measure(L, S) / 2, cy - (lines.length - 1) * S * 0.72 + i * S * 1.45 + S * 0.36, S, c, r)));
    });
    (d.edges || []).forEach(e => {
      const a = N[e.from], b = N[e.to]; if (!a || !b) return;
      const dx = b.cx - a.cx, dy = b.cy - a.cy, L = Math.hypot(dx, dy) || 1;
      const clip = (n, sx, sy) => {
        const t = Math.min(Math.abs((n.w / 2 + 6) / (sx || 1e-6)), Math.abs((n.h / 2 + 6) / (sy || 1e-6)));
        return [n.cx + sx * t, n.cy + sy * t];
      };
      const p1 = clip(a, dx / L, dy / L), p2 = clip(b, -dx / L, -dy / L);
      const mx = (p1[0] + p2[0]) / 2 + (e.bend ? -dy / L * 46 * e.bend : (r() - 0.5) * 6);
      const my = (p1[1] + p2[1]) / 2 + (e.bend ? dx / L * 46 * e.bend : (r() - 0.5) * 6);
      this.push([mkStroke([p1, [mx, my], p2], 2.3, COL.sky, { dash: e.dashed })]);
      const ang = Math.atan2(p2[1] - my, p2[0] - mx), hl = 14;
      if (e.arrow !== false)
        this.push([mkStroke([[p2[0] - Math.cos(ang - 0.4) * hl, p2[1] - Math.sin(ang - 0.4) * hl], p2,
        [p2[0] - Math.cos(ang + 0.4) * hl, p2[1] - Math.sin(ang + 0.4) * hl]], 2.3, COL.sky)]);
      if (e.label) {
        const s = 17, el = deTex(e.label), w = measure(el, s);
        this.push(textStrokes(el, mx - w / 2, my - 8, s, COL.dim, r));
      }
    });
    this.advance(col, H + 40);
  }

  block(b) {
    const col = b.col === "right" ? "right" : b.col === "left" ? "left" : "full";
    const C = b.color ? chalkOf(b.color, null) : null;
    switch (b.kind) {
      case "title": this.title(b.text || ""); break;
      case "heading": this.heading(b.text || "", col, C); break;
      case "text": this.para(b.text || "", col, C || COL.chalk); break;
      case "note": this.para(b.text || "", col, C || COL.dim, 23); break;
      case "bullets": this.bullets(b.items || [], col, false, C); break;
      case "steps": this.bullets(b.items || [], col, true, C); break;
      case "formula": this.formula(b.tex || "", b.label, col, C || COL.mint); break;
      case "boxed": this.boxed(b.text || "", col); break;
      case "table": this.table(b.headers || [], b.rows || [], col); break;
      case "graph": this.graph(b, col); break;
      case "bars": this.bars(b, col); break;
      case "diagram": this.diagram(b, col); break;
      case "divider": this.divider(col); break;
      case "newpage": this.break(); break;
      default: if (b.text) this.para(b.text, col);
    }
  }
}

function buildTimeline(segments, startPage = 0) {
  const c = new Composer(); c.page = startPage;
  const tl = [];
  for (const s of segments) {
    const before = c.out.length;
    (s.blocks || []).forEach(b => { try { c.block(b); } catch (e) { /* skip malformed block */ } });
    tl.push({ say: s.say || "", strokes: c.out.slice(before) });
  }
  return { timeline: tl, pages: c.page + 1 };
}

/* ==========================================================================
   5. CHALKBOARD RENDERER
   ========================================================================== */
function makeBoardTexture(w = BW, h = BH) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const BW = w, BH = h;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, BW, BH);
  g.addColorStop(0, "#2b4038"); g.addColorStop(0.45, "#22352d"); g.addColorStop(1, "#1a2a24");
  x.fillStyle = g; x.fillRect(0, 0, BW, BH);
  const rg = x.createRadialGradient(BW * 0.42, BH * 0.34, 60, BW * 0.5, BH * 0.5, BW * 0.78);
  rg.addColorStop(0, "rgba(255,255,255,0.07)"); rg.addColorStop(1, "rgba(0,0,0,0.34)");
  x.fillStyle = rg; x.fillRect(0, 0, BW, BH);
  const r = mulberry(7);
  for (let i = 0; i < 26000; i++) {
    x.fillStyle = `rgba(255,255,255,${r() * 0.028})`;
    x.fillRect(r() * BW, r() * BH, r() * 1.7, r() * 1.7);
  }
  for (let i = 0; i < 46; i++) {            // ghosts of erased lessons
    x.strokeStyle = `rgba(232,240,232,${0.012 + r() * 0.026})`;
    x.lineWidth = 8 + r() * 26; x.lineCap = "round";
    x.beginPath();
    const sy = r() * BH, sx = r() * BW;
    x.moveTo(sx, sy);
    x.bezierCurveTo(sx + 120, sy - 40 + r() * 60, sx + 260, sy + 50 - r() * 70, sx + 380 + r() * 220, sy + (r() - 0.5) * 40);
    x.stroke();
  }
  return c;
}

function chalkSegment(ctx, x0, y0, x1, y1, w, color, rnd) {
  ctx.strokeStyle = color; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.globalAlpha = 0.30; ctx.lineWidth = w * 1.85;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.globalAlpha = 0.92; ctx.lineWidth = w * (0.82 + rnd() * 0.34);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.globalAlpha = 0.5; ctx.fillStyle = color;
  for (let i = 0; i < 3; i++) {
    const t = rnd();
    ctx.fillRect(x0 + (x1 - x0) * t + (rnd() - 0.5) * w * 2.1,
      y0 + (y1 - y0) * t + (rnd() - 0.5) * w * 2.1, rnd() * 1.3 + 0.3, rnd() * 1.3 + 0.3);
  }
  ctx.globalAlpha = 1;
}

/* ==========================================================================
   6. AVATAR — presets, a custom look, or the user's own photo.
   Lip sync is driven by real audio amplitude in both modes. For a photo we
   warp the jaw downwards rather than pasting a mouth on top, which reads far
   better than a drawn shape over a real face.
   ========================================================================== */
export const AVATAR_PRESETS = [
  { id: "ravi",   name: "Ravi",   skin: "#e2ab7c", hair: "#241d1a", style: "short", shirt: "#4a6b7c", glasses: true,  beard: false },
  { id: "meera",  name: "Meera",  skin: "#d9a06a", hair: "#1c1512", style: "long",  shirt: "#8b5a6b", glasses: false, beard: false },
  { id: "amara",  name: "Amara",  skin: "#8d5a3c", hair: "#2a1c18", style: "curls", shirt: "#3f7a6a", glasses: false, beard: false },
  { id: "chen",   name: "Chen",   skin: "#f0c9a0", hair: "#16161a", style: "short", shirt: "#5b6b8c", glasses: true,  beard: false },
  { id: "sofia",  name: "Sofia",  skin: "#f2d3b0", hair: "#5c3a1e", style: "bun",   shirt: "#7a5c8c", glasses: false, beard: false },
  { id: "omar",   name: "Omar",   skin: "#c98a5a", hair: "#221a15", style: "short", shirt: "#6b7a4a", glasses: false, beard: true  },
];
export const DEFAULT_AVATAR = AVATAR_PRESETS[0];

/* Read the dominant colours out of a head-and-shoulders photo and return a
   drawn avatar wearing them. The result is a real rig — it blinks, looks at
   the chalk and lip syncs — instead of a photo with a mouth pasted over it. */
export function deriveAvatarFromPhoto(img) {
  const W = 160, H = Math.max(1, Math.round(W * img.naturalHeight / img.naturalWidth));
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0, W, H);
  const px = x.getImageData(0, 0, W, H).data;

  // Median-ish colour of a rectangle, ignoring very dark and very bright pixels
  // so shadow and blown highlights do not drag the result.
  const sample = (x0, y0, x1, y1, keepDark) => {
    const R = [], G = [], B = [];
    for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) {
      for (let xx = Math.floor(x0 * W); xx < Math.floor(x1 * W); xx++) {
        const i = (y * W + xx) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2], lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (!keepDark && (lum < 28 || lum > 244)) continue;
        if (keepDark && lum > 210) continue;
        R.push(r); G.push(g); B.push(b);
      }
    }
    if (!R.length) return null;
    const mid = a => { a.sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
    const h = v => v.toString(16).padStart(2, "0");
    return `#${h(mid(R))}${h(mid(G))}${h(mid(B))}`;
  };

  const skin  = sample(0.36, 0.42, 0.64, 0.60, false) || DEFAULT_AVATAR.skin;
  const hair  = sample(0.32, 0.03, 0.68, 0.17, true)  || DEFAULT_AVATAR.hair;
  const shirt = sample(0.18, 0.88, 0.82, 0.99, false) || DEFAULT_AVATAR.shirt;

  // Hair that reaches the sides of the frame low down reads as long hair.
  const sideLow = sample(0.02, 0.55, 0.14, 0.78, true);
  const near = (a, b) => {
    if (!a || !b) return false;
    const p = h2 => [1, 3, 5].map(i => parseInt(h2.slice(i, i + 2), 16));
    const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
    return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) < 110;
  };
  const style = near(sideLow, hair) ? "long" : "short";

  return { id: "you", name: "You", skin, hair, shirt, style, glasses: false, beard: false };
}

const shade = (hex, amt) => {
  const n = parseInt(String(hex).replace("#", ""), 16);
  const cl = v => Math.max(0, Math.min(255, v));
  return `rgb(${cl((n >> 16) + amt)},${cl(((n >> 8) & 255) + amt)},${cl((n & 255) + amt)})`;
};

/* ---- photo mode: draw the face, then drop the jaw by the amplitude ---- */
function drawPhotoAvatar(ctx, W, H, st, img) {
  const { mouth, blink, look, t } = st;
  ctx.clearRect(0, 0, W, H);
  const s = Math.min(W / 300, H / 360);
  const bob = Math.sin(t / 900) * 2 * s + (st.talking ? Math.sin(t / 150) * 0.8 * s : 0);
  const cx = W / 2, cy = H * 0.46 + bob;
  const rw = Math.min(W * 0.40, H * 0.34), rh = rw * 1.22;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.3)";
  ctx.beginPath(); ctx.ellipse(cx, H * 0.95, rw * 1.05, 10 * s, 0, 0, 7); ctx.fill();

  // shoulders behind the head
  const sh = ctx.createLinearGradient(0, cy + rh * 0.6, 0, H);
  sh.addColorStop(0, "#3d5b6b"); sh.addColorStop(1, "#25384a");
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.moveTo(cx - rw * 1.5, H);
  ctx.quadraticCurveTo(cx - rw * 1.1, cy + rh * 0.72, cx, cy + rh * 0.66);
  ctx.quadraticCurveTo(cx + rw * 1.1, cy + rh * 0.72, cx + rw * 1.5, H);
  ctx.closePath(); ctx.fill();

  // head, clipped to an oval, with a slight yaw parallax
  const yaw = look.x * 4 * s;
  ctx.save();
  ctx.beginPath(); ctx.ellipse(cx, cy, rw, rh, 0, 0, 7); ctx.clip();
  const ir = img.naturalWidth / img.naturalHeight;
  let dw = rw * 2.35, dh = dw / ir;
  if (dh < rh * 2.2) { dh = rh * 2.2; dw = dh * ir; }
  const ix = cx - dw / 2 + yaw, iy = cy - dh * 0.52;
  ctx.drawImage(img, ix, iy, dw, dh);

  // jaw drop: redraw the lower face lower down, leaving a dark gap
  const jawY = cy + rh * (st.mouthY ?? 0.26);
  const drop = mouth * rh * 0.20;
  if (drop > 0.4) {
    ctx.save();
    ctx.beginPath(); ctx.rect(cx - rw, jawY - rh * 0.02, rw * 2, rh * 2); ctx.clip();
    ctx.drawImage(img, ix, iy + drop, dw, dh);
    ctx.restore();
    const mw = rw * (0.30 + mouth * 0.06);
    const g = ctx.createLinearGradient(0, jawY - drop * 0.4, 0, jawY + drop);
    g.addColorStop(0, "rgba(60,20,18,.95)"); g.addColorStop(1, "rgba(120,55,48,.85)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(cx + yaw * 0.6, jawY + drop * 0.30, mw, drop * 0.62, 0, 0, 7); ctx.fill();
    if (mouth > 0.42) {
      ctx.fillStyle = "rgba(246,240,230,.82)";
      ctx.beginPath(); ctx.ellipse(cx + yaw * 0.6, jawY + drop * 0.02, mw * 0.74, drop * 0.16, 0, 0, 7); ctx.fill();
    }
  }
  // blink: a lid sweeping down over the eye band
  if (blink) {
    const ey = cy - rh * (st.eyeY ?? 0.14);
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, cy, rw, rh, 0, 0, 7); ctx.clip();
    ctx.drawImage(img, ix, iy - rh * 0.10, dw, dh);
    ctx.fillStyle = "rgba(0,0,0,.05)";
    ctx.fillRect(cx - rw, ey - rh * 0.06, rw * 2, rh * 0.12);
    ctx.restore();
  }
  ctx.restore();

  // rim light so the cut-out does not look pasted on
  ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.lineWidth = 2.5 * s;
  ctx.beginPath(); ctx.ellipse(cx, cy, rw, rh, 0, 0, 7); ctx.stroke();
  ctx.restore();
}

function drawTeacher(ctx, W, H, st) {
  if (st.photo && st.photo.complete && st.photo.naturalWidth) {
    try { return drawPhotoAvatar(ctx, W, H, st, st.photo); } catch { /* fall back to drawn */ }
  }
  const A = st.av || DEFAULT_AVATAR;
  const { t, mouth, blink, look, talking, point } = st;
  ctx.clearRect(0, 0, W, H);
  const cx = W * 0.5, s = Math.min(W / 300, H / 360);
  const bob = Math.sin(t / 900) * 2.2 * s + (talking ? Math.sin(t / 150) * 0.9 * s : 0);
  const lean = point ? Math.max(-1, Math.min(1, (point.x - 0.5))) * 5 * s : 0;

  ctx.save(); ctx.translate(cx + lean, H * 0.02 + bob);

  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath(); ctx.ellipse(0, 344 * s, 92 * s, 12 * s, 0, 0, 7); ctx.fill();

  const shirt = ctx.createLinearGradient(-70 * s, 190 * s, 70 * s, 350 * s);
  shirt.addColorStop(0, shade(A.shirt, 18)); shirt.addColorStop(1, shade(A.shirt, -28));
  ctx.fillStyle = shirt;
  ctx.beginPath();
  ctx.moveTo(-58 * s, 214 * s); ctx.quadraticCurveTo(-86 * s, 250 * s, -84 * s, 348 * s);
  ctx.lineTo(84 * s, 348 * s); ctx.quadraticCurveTo(86 * s, 250 * s, 58 * s, 214 * s);
  ctx.quadraticCurveTo(0, 238 * s, -58 * s, 214 * s); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.20)"; ctx.lineWidth = 2 * s;
  ctx.beginPath(); ctx.moveTo(-22 * s, 220 * s); ctx.lineTo(0, 248 * s); ctx.lineTo(22 * s, 220 * s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 250 * s); ctx.lineTo(0, 344 * s); ctx.stroke();

  const tx = point ? (point.x - 0.5) : 0.5, ty = point ? point.y : 0.4;
  const shd = [56 * s, 232 * s];
  const hand = [shd[0] + (60 + tx * 46) * s, shd[1] + (-58 + ty * 116) * s];
  const el = [(shd[0] + hand[0]) / 2 + 22 * s, (shd[1] + hand[1]) / 2 + 20 * s];
  ctx.strokeStyle = shade(A.shirt, -10); ctx.lineWidth = 20 * s; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(shd[0], shd[1]); ctx.quadraticCurveTo(el[0], el[1], hand[0], hand[1]); ctx.stroke();
  ctx.strokeStyle = shade(A.skin, -14); ctx.lineWidth = 13 * s;
  ctx.beginPath(); ctx.moveTo(el[0], el[1]); ctx.lineTo(hand[0], hand[1]); ctx.stroke();
  ctx.fillStyle = shade(A.skin, 6); ctx.beginPath(); ctx.arc(hand[0], hand[1], 9 * s, 0, 7); ctx.fill();
  if (point) { ctx.fillStyle = "#f6f3e8"; ctx.save(); ctx.translate(hand[0], hand[1]); ctx.rotate(-0.5); ctx.fillRect(2 * s, -3 * s, 15 * s, 6 * s); ctx.restore(); }
  ctx.strokeStyle = shade(A.shirt, -10); ctx.lineWidth = 20 * s;
  ctx.beginPath(); ctx.moveTo(-56 * s, 232 * s); ctx.quadraticCurveTo(-80 * s, 280 * s, -62 * s, 322 * s); ctx.stroke();
  ctx.fillStyle = shade(A.skin, 6); ctx.beginPath(); ctx.arc(-62 * s, 326 * s, 9 * s, 0, 7); ctx.fill();

  ctx.fillStyle = shade(A.skin, -22); ctx.fillRect(-14 * s, 186 * s, 28 * s, 34 * s);
  const skin = ctx.createLinearGradient(-52 * s, 60 * s, 52 * s, 200 * s);
  skin.addColorStop(0, shade(A.skin, 20)); skin.addColorStop(1, shade(A.skin, -18));
  const hx = look.x * 4 * s;
  ctx.save(); ctx.translate(hx, 0);
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.ellipse(0, 132 * s, 58 * s, 68 * s, 0, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-57 * s, 136 * s, 9 * s, 14 * s, 0, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(57 * s, 136 * s, 9 * s, 14 * s, 0, 0, 7); ctx.fill();

  const hair = ctx.createLinearGradient(0, 60 * s, 0, 140 * s);
  hair.addColorStop(0, shade(A.hair, 22)); hair.addColorStop(1, A.hair);
  ctx.fillStyle = hair;
  if (A.style === "long") {
    ctx.beginPath();
    ctx.moveTo(-62 * s, 200 * s); ctx.quadraticCurveTo(-74 * s, 90 * s, 0, 60 * s);
    ctx.quadraticCurveTo(74 * s, 90 * s, 62 * s, 200 * s);
    ctx.quadraticCurveTo(50 * s, 150 * s, 52 * s, 112 * s);
    ctx.quadraticCurveTo(0, 96 * s, -52 * s, 112 * s);
    ctx.quadraticCurveTo(-50 * s, 150 * s, -62 * s, 200 * s); ctx.fill();
  } else if (A.style === "curls") {
    for (let i = 0; i <= 14; i++) {
      const a = Math.PI + (i / 14) * Math.PI;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 56 * s, 128 * s + Math.sin(a) * 66 * s, 15 * s, 0, 7); ctx.fill();
    }
    ctx.beginPath(); ctx.ellipse(0, 92 * s, 56 * s, 36 * s, 0, 0, 7); ctx.fill();
  } else if (A.style === "bun") {
    ctx.beginPath(); ctx.arc(0, 52 * s, 22 * s, 0, 7); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-59 * s, 128 * s); ctx.quadraticCurveTo(-64 * s, 58 * s, 0, 62 * s);
    ctx.quadraticCurveTo(64 * s, 58 * s, 59 * s, 128 * s);
    ctx.quadraticCurveTo(46 * s, 100 * s, 0, 100 * s);
    ctx.quadraticCurveTo(-46 * s, 100 * s, -59 * s, 128 * s); ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(-59 * s, 128 * s); ctx.quadraticCurveTo(-64 * s, 58 * s, 0, 62 * s);
    ctx.quadraticCurveTo(64 * s, 58 * s, 59 * s, 128 * s);
    ctx.quadraticCurveTo(46 * s, 96 * s, 18 * s, 100 * s);
    ctx.quadraticCurveTo(-26 * s, 104 * s, -59 * s, 128 * s); ctx.fill();
  }

  ctx.strokeStyle = shade(A.hair, 10); ctx.lineWidth = 4.4 * s; ctx.lineCap = "round";
  const br = talking ? Math.sin(t / 420) * 2.2 * s : 0;
  ctx.beginPath(); ctx.moveTo(-36 * s, 118 * s - br); ctx.quadraticCurveTo(-22 * s, 111 * s - br, -9 * s, 116 * s - br); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(36 * s, 118 * s - br); ctx.quadraticCurveTo(22 * s, 111 * s - br, 9 * s, 116 * s - br); ctx.stroke();

  const eo = blink ? 1.2 : 9;
  [-23, 23].forEach(ex => {
    ctx.fillStyle = "#fbf7f0";
    ctx.beginPath(); ctx.ellipse(ex * s, 134 * s, 13 * s, eo * s, 0, 0, 7); ctx.fill();
    if (!blink) {
      ctx.fillStyle = "#3d2b1c";
      ctx.beginPath(); ctx.arc(ex * s + look.x * 3.4 * s, 134 * s + look.y * 2.6 * s, 5.6 * s, 0, 7); ctx.fill();
      ctx.fillStyle = "#0e0a07";
      ctx.beginPath(); ctx.arc(ex * s + look.x * 3.4 * s, 134 * s + look.y * 2.6 * s, 2.5 * s, 0, 7); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath(); ctx.arc(ex * s + look.x * 3.4 * s + 2.4 * s, 131 * s, 1.8 * s, 0, 7); ctx.fill();
    }
    ctx.strokeStyle = shade(A.skin, -60); ctx.lineWidth = 1.6 * s;
    ctx.beginPath(); ctx.ellipse(ex * s, 134 * s, 13 * s, eo * s, 0, 0, 7); ctx.stroke();
  });

  if (A.glasses) {
    ctx.strokeStyle = "rgba(226,214,196,0.75)"; ctx.lineWidth = 2.4 * s;
    ctx.beginPath(); ctx.roundRect(-39 * s, 122 * s, 32 * s, 26 * s, 7 * s); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(7 * s, 122 * s, 32 * s, 26 * s, 7 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-7 * s, 133 * s); ctx.lineTo(7 * s, 133 * s); ctx.stroke();
  }
  ctx.strokeStyle = shade(A.skin, -45); ctx.lineWidth = 3 * s;
  ctx.beginPath(); ctx.moveTo(0, 138 * s); ctx.quadraticCurveTo(6 * s, 155 * s, -2 * s, 158 * s); ctx.stroke();

  if (A.beard) {
    ctx.fillStyle = shade(A.hair, 8);
    ctx.beginPath();
    ctx.moveTo(-42 * s, 150 * s);
    ctx.quadraticCurveTo(-40 * s, 196 * s, 0, 200 * s);
    ctx.quadraticCurveTo(40 * s, 196 * s, 42 * s, 150 * s);
    ctx.quadraticCurveTo(20 * s, 172 * s, 0, 170 * s);
    ctx.quadraticCurveTo(-20 * s, 172 * s, -42 * s, 150 * s); ctx.fill();
  }

  const mo = 3 * s + mouth * 17 * s, mw = (17 + mouth * 9) * s;
  ctx.fillStyle = "#6d3630";
  ctx.beginPath(); ctx.ellipse(0, 174 * s, mw, mo, 0, 0, 7); ctx.fill();
  if (mouth > 0.28) { ctx.fillStyle = "#f6f0e6"; ctx.beginPath(); ctx.ellipse(0, 174 * s - mo * 0.55, mw * 0.72, mo * 0.24, 0, 0, 7); ctx.fill(); }
  ctx.strokeStyle = "#8a4a40"; ctx.lineWidth = 2 * s;
  ctx.beginPath(); ctx.ellipse(0, 174 * s, mw, mo, 0, 0, 7); ctx.stroke();
  ctx.restore();
  ctx.restore();
}

/* ==========================================================================
   7. AGENTS — every call goes through the host's callAI, so the LMS's
      Groq key rotation / model fallback / 429 handling applies unchanged.
   ========================================================================== */
const DSL_SPEC = `Board block types (JSON). Pick the visual that carries the meaning:
{"kind":"title","text":"..."}
{"kind":"heading","text":"...","col":"full|left|right"}
{"kind":"text","text":"one short board sentence"}
{"kind":"note","text":"small aside"}
{"kind":"bullets","items":["...","..."]}
{"kind":"steps","items":["...","..."]}          numbered procedure
{"kind":"formula","tex":"a^2+b^2=c^2","label":"optional caption"}
{"kind":"boxed","text":"the one thing to remember"}
{"kind":"table","headers":["A","B"],"rows":[["1","2"]]}
{"kind":"graph","title":"","xLabel":"x","yLabel":"y","domain":[-6,6],"range":[-4,10],
 "curves":[{"expr":"x^2-2*x-3","label":"y=x^2-2x-3","dashed":false}],
 "points":[{"x":1,"y":-4,"label":"vertex"}]}
{"kind":"bars","title":"","categories":["A","B"],"values":[3,7]}
{"kind":"diagram","title":"","height":380,
 "nodes":[{"id":"a","label":"Input","x":0.15,"y":0.3,"shape":"rect|ellipse|diamond","color":"accent|alt"}],
 "edges":[{"from":"a","to":"b","label":"then","dashed":false,"bend":0}]}
{"kind":"divider"}   {"kind":"newpage"}

Rules that matter:
- tex supports: ^ _ \\frac{}{} \\sqrt{} \\sum \\int \\vec{} \\bar{} \\pi \\theta \\alpha \\beta \\Delta \\lambda \\mu \\sigma \\omega \\infty \\pm \\times \\cdot \\div \\approx \\neq \\leq \\geq \\to \\in \\partial \\nabla \\therefore. No \\begin/\\end, no matrices.
- graph "expr" is plain math in x: + - * / ^ ( ) and sin cos tan exp ln log sqrt abs pi e. Write 2*x, never 2x.
- diagram x,y are 0..1 inside the diagram area. Space nodes at least 0.22 apart in x or 0.28 in y so nothing overlaps.
- Board text is NOT the narration. Board = short labels, keywords, formulas, structure. Narration = the full spoken explanation.
- Keep every board line under 60 characters. Never write a paragraph on the board.
- Any block may carry "color": one of white, yellow, blue, green, pink, violet, orange.
  Use it with intent, the way a teacher swaps chalk: yellow for the thing to remember,
  green for results and formulas, blue for structure and headings, pink for warnings and
  common mistakes, violet for real-world asides, white for ordinary working. A board with
  no colour at all is a wasted board; a board where everything is coloured is noise.
- For programming topics, write real code on the board as {"kind":"steps"} or {"kind":"text"} lines, one statement per line.`;

const BOARD_SYS = {
  architect:
    `You are a senior curriculum designer sequencing one teaching session. Your one job is ordering: nothing may be used before it has been explained.

Return JSON only:
{"lessonTitle":"...","objectives":["..."],"prerequisites":["..."],
 "beats":[{"id":1,"role":"hook|intuition|definition|worked-example|edge-case|recap","title":"...",
           "goal":"what the student can do after this beat, stated as an action",
           "covers":["3 to 6 specific sub-points this beat must teach"],
           "realWorld":"a concrete everyday example this beat should mention by name",
           "visualPlan":"exactly what to draw here, and why that form",
           "uses":["concepts this beat assumes — every one must appear in an EARLIER beat or in prerequisites"],
           "introduces":["concepts this beat defines for the first time"],
           "visual":"formula|graph|diagram|table|bars|worked-example|code|text",
           "detail":"the exact content this beat must cover — write out the actual equations, the actual numbers, the actual worked values. Not a description of them."}],
 "misconceptions":["the wrong idea students usually hold here"],
 "facts":["each checkable claim the lesson will make, one per line, stated precisely enough to be verified"]}

Depth is the point. This is a full lecture, not a summary. Each beat is 2-3 minutes of teaching.
- Give every beat a "covers" list of 3 to 6 specific sub-points it must teach. These become the
  visible contents of the lecture, so be concrete: name the cases, the terms, the steps.
- Give every beat a "realWorld" field: a concrete everyday situation, measurement or piece of
  engineering where this exact idea shows up. Not "used in many fields" — name the thing.
- Give every beat a "visualPlan": what should be drawn, specifically. If a relationship between
  two quantities exists, that is a graph. If there is a process or a flow, that is a diagram.
  If two or more cases differ, that is a table. Say which.

Hard rules:
- The beat roles must run in this order: hook, intuition, definition, worked-example, then any edge-case, then recap.
- Exactly one beat has role "worked-example" and its "detail" must contain a complete problem WITH its numeric answer computed.
- For every beat, everything in "uses" must appear in an earlier beat's "introduces", or in "prerequisites". If that fails, reorder the beats until it holds.
- "detail" carries the real content. A beat whose detail says "explain the formula" is a failed beat; write the formula.
- Do not include a concept in "introduces" twice across beats.`,

  director:
    `You are the teacher at the chalkboard. For one beat you write what is SAID out loud, cut it into spoken segments, and decide exactly what gets written during each segment.
Return JSON only: {"segments":[{"say":"the exact sentences spoken","blocks":[ ...board blocks... ]}]}

Delivery:
- 6 to 9 segments. 260 to 420 spoken words for the whole beat. This is a real lecture: teach the
  idea, then show it, then work an example with it, then say where it shows up in life.
- Every sub-point in the beat's "covers" list must get its own segment and its own board content.
  If a sub-point never reaches the board, you have not taught it.
- Spoken register: contractions, short sentences, second person, one idea per sentence. No stage directions, no markdown, no emoji, no "in this video", no "let's dive in".
- Say numbers and symbols the way a person says them: "x squared", "the square root of two", "delta y over delta x".
- Almost every segment should put something on the board. A segment with no blocks is rare and
  should only happen when the teacher is genuinely just linking two ideas.
- Include AT LEAST TWO large visuals per beat, and they must be different kinds. A graph AND a
  diagram, or a table AND a graph. Choose by what the content is:
    a relationship between two quantities  -> graph, with the axes labelled and the key point marked
    a process, a flow, a hierarchy, parts  -> diagram, with real labels on the arrows
    two or more cases compared             -> table
    magnitudes side by side                -> bars
    a rule, a definition, a derivation     -> formula, one line per algebraic step
- Work the example on the board line by line as {"kind":"steps"}, one algebraic move per step.
- Give the real-world example its own segment near the end of the beat, and put it on the board
  as a small diagram or a boxed line in violet. Name the actual object, machine or situation.
- Use colour deliberately (see the colour rule below).

Correctness — these are not style notes, they are the job:
- Use ONLY the numbers, equations and values given to you in the beat detail. Never invent a figure, a date, a constant or a citation to fill a gap. If something is missing, teach around it instead.
- In a worked example, show the arithmetic on the board line by line — substitution first, then each simplification, then the answer. Never jump from the setup straight to the result.
- Re-read every number you write: the value on the board and the value in the narration must be the same value.
- If a claim is true only under a condition, say the condition in the same sentence. Do not state a special case as a general rule.
- If the topic has a widely-believed wrong version, name it as wrong rather than quietly avoiding it.
- Define a symbol on the board the first time it appears.
` + DSL_SPEC,

  reviewer:
    `You are a subject-matter reviewer with the authority to correct. You are shown a numbered list of lesson segments. Each has what the teacher SAYS and what is WRITTEN on the board.

Check for: factual errors, wrong formulas, wrong signs, arithmetic that does not compute, wrong units, mislabeled axes, a board value disagreeing with the spoken value, a symbol used before it is defined, and general claims that are only true in a special case.

Return JSON only:
{"verdict":"pass|fix",
 "issues":[{"segment":3,"what":"what is wrong","fix":"what it should be"}],
 "corrections":[{"segment":3,"say":"the FULL corrected spoken text for that segment","blocks":[ the FULL corrected block list for that segment ]}]}

Rules:
- Only report errors that are actually wrong. Style, tone and preference are not errors. If it is all correct, return {"verdict":"pass","issues":[],"corrections":[]}.
- "segment" is the 1-based number shown in the listing.
- Every issue you raise must have a matching correction. Do not raise an issue you cannot fix.
- A correction REPLACES that segment, so repeat the parts that were already fine. Keep the same block kinds unless a kind was itself the error.
- Recompute any arithmetic yourself before deciding it is wrong.`,

  doubtBrief:
    `A student asked a question during a lesson. Answer it on the board.
Return JSON only, and keep it SHORT enough that the JSON definitely closes:
{"segments":[{"say":"spoken sentences","blocks":[{"kind":"heading","text":"Question: <gist>","color":"yellow"},{"kind":"text","text":"short board line"}]}]}
- Exactly 3 segments, about 40 words each.
- Answer directly in the first segment.
- Allowed block kinds here: heading, text, bullets, formula, boxed. Keep board lines under 60 characters.
- If a formula helps, include one: {"kind":"formula","tex":"a^2+b^2=c^2","color":"green"}.`,

  doubt:
    `A student has interrupted the lesson with a question. Teach the answer properly on the board — this is a mini-lecture, not a one-liner.
Return JSON only: {"segments":[{"say":"...","blocks":[...]}]}
- 4 to 7 segments, 180 to 320 spoken words total.
- Restate their question in one clause, then answer it directly in the very next sentence. Do not
  build up to the answer — give it, then justify it.
- Start the board with {"kind":"heading","text":"Question: <4-6 word gist>","color":"yellow"}.
- Take it end to end: the direct answer, then WHY it is so, then a formula or worked line if the
  question touches anything quantitative, then AT LEAST ONE visual — a diagram of the mechanism or
  a graph of the relationship — then where it connects back to the topic being taught.
- If the question reveals a likely misunderstanding, name that misunderstanding in pink and correct it.
- If it is quantitative, show the numbers on the board, not just in speech.
- End with one sentence that hands back to the lesson.
` + DSL_SPEC
};

/* ── Deterministic repair pass ────────────────────────────────────────
   Models get the JSON shape right and the details wrong. This runs with
   no AI call and fixes what can be checked by arithmetic: unplottable
   curves, ragged tables, edges pointing at nodes that do not exist,
   formulas that typeset to nothing, board lines too long to read.
   Anything unfixable is dropped rather than drawn broken.            */
const BOARD_KINDS = new Set(["title", "heading", "text", "note", "bullets", "steps", "formula",
  "boxed", "table", "graph", "bars", "diagram", "divider", "newpage"]);

function sanitizeBlock(b, report) {
  if (!b || typeof b !== "object" || !BOARD_KINDS.has(b.kind)) { report.dropped++; return null; }
  const clip = (t, n) => {
    const v = String(t ?? "").replace(/\s+/g, " ").trim();
    if (v.length > n) { report.trimmed++; return v.slice(0, n - 1).trimEnd() + "…"; }
    return v;
  };
  if (b.color && !CHALK[String(b.color).toLowerCase()]) { b = { ...b, color: undefined }; report.repaired++; }

  switch (b.kind) {
    case "title": case "heading": {
      const text = clip(b.text, 58);
      return text ? { ...b, text } : (report.dropped++, null);
    }
    case "text": case "note": case "boxed": {
      const text = clip(b.text, b.kind === "boxed" ? 110 : 150);
      return text ? { ...b, text } : (report.dropped++, null);
    }
    case "bullets": case "steps": {
      const items = (Array.isArray(b.items) ? b.items : []).map(i => clip(i, 100)).filter(Boolean).slice(0, 8);
      return items.length ? { ...b, items } : (report.dropped++, null);
    }
    case "formula": {
      const tex = String(b.tex ?? "").trim();
      if (!tex) { report.dropped++; return null; }
      try {
        const m = texMeasure(tex, 38);
        if (!isFinite(m.w) || m.w <= 0) { report.dropped++; return null; }
      } catch { report.dropped++; return null; }
      return { ...b, tex, label: b.label ? clip(b.label, 60) : undefined };
    }
    case "table": {
      let headers = (Array.isArray(b.headers) ? b.headers : []).map(h => clip(h, 26)).filter(Boolean);
      let rows = Array.isArray(b.rows) ? b.rows : [];
      if (!headers.length || !rows.length) { report.dropped++; return null; }
      if (headers.length > 4) { headers = headers.slice(0, 4); report.trimmed++; }
      rows = rows
        .filter(r => Array.isArray(r))
        .map(r => {                                   // ragged rows are common
          const out = r.slice(0, headers.length).map(c => clip(c, 26));
          while (out.length < headers.length) { out.push(""); report.repaired++; }
          return out;
        })
        .filter(r => r.some(c => c !== ""))
        .slice(0, 8);
      return rows.length ? { ...b, headers, rows } : (report.dropped++, null);
    }
    case "graph": {
      let dom = Array.isArray(b.domain) && b.domain.length === 2 ? b.domain.map(Number) : [-6, 6];
      if (!isFinite(dom[0]) || !isFinite(dom[1]) || dom[0] >= dom[1]) { dom = [-6, 6]; report.repaired++; }
      const curves = (Array.isArray(b.curves) ? b.curves : []).map(c => {
        const expr = String(c?.expr ?? "").trim();
        if (!expr) return null;
        const f = compileExpr(expr);
        let good = 0;
        for (let i = 0; i <= 60; i++) {              // must actually plot something
          const v = f(dom[0] + (dom[1] - dom[0]) * i / 60);
          if (isFinite(v)) good++;
        }
        if (good < 12) { report.dropped++; return null; }
        return { ...c, expr, label: c.label ? clip(c.label, 26) : undefined };
      }).filter(Boolean).slice(0, 4);
      const points = (Array.isArray(b.points) ? b.points : [])
        .filter(pt => pt && isFinite(Number(pt.x)) && isFinite(Number(pt.y)))
        .map(pt => ({ x: Number(pt.x), y: Number(pt.y), label: pt.label ? clip(pt.label, 20) : undefined }))
        .slice(0, 6);
      if (!curves.length && !points.length) { report.dropped++; return null; }
      let range = Array.isArray(b.range) && b.range.length === 2 ? b.range.map(Number) : undefined;
      if (range && (!isFinite(range[0]) || !isFinite(range[1]) || range[0] >= range[1])) { range = undefined; report.repaired++; }
      return { ...b, domain: dom, range, curves, points, title: b.title ? clip(b.title, 40) : undefined };
    }
    case "bars": {
      const cats = (Array.isArray(b.categories) ? b.categories : []).map(c => clip(c, 14));
      const vals = (Array.isArray(b.values) ? b.values : []).map(Number).filter(v => isFinite(v));
      const n = Math.min(cats.length, vals.length, 7);
      if (n < 2) { report.dropped++; return null; }
      if (cats.length !== vals.length) report.repaired++;
      return { ...b, categories: cats.slice(0, n), values: vals.slice(0, n), title: b.title ? clip(b.title, 40) : undefined };
    }
    case "diagram": {
      const seen = new Set();
      const nodes = (Array.isArray(b.nodes) ? b.nodes : []).map(n => {
        const id = String(n?.id ?? "").trim();
        if (!id || seen.has(id)) { report.dropped++; return null; }
        seen.add(id);
        const cl = (v, d) => { const x = Number(v); return isFinite(x) ? Math.min(0.94, Math.max(0.06, x)) : d; };
        return { ...n, id, label: clip(n.label, 42), x: cl(n.x, 0.5), y: cl(n.y, 0.5) };
      }).filter(Boolean).slice(0, 8);
      if (nodes.length < 2) { report.dropped++; return null; }
      // pull apart any two nodes the model stacked on the same spot
      for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++)
          if (Math.abs(nodes[i].x - nodes[j].x) < 0.12 && Math.abs(nodes[i].y - nodes[j].y) < 0.16) {
            nodes[j].y = Math.min(0.94, nodes[j].y + 0.18); report.repaired++;
          }
      const ids = new Set(nodes.map(n => n.id));
      const edges = (Array.isArray(b.edges) ? b.edges : [])
        .filter(e => e && ids.has(String(e.from)) && ids.has(String(e.to)) && e.from !== e.to)
        .map(e => ({ ...e, from: String(e.from), to: String(e.to), label: e.label ? clip(e.label, 22) : undefined }))
        .slice(0, 12);
      if (edges.length !== (b.edges || []).length) report.repaired++;
      return { ...b, nodes, edges, title: b.title ? clip(b.title, 40) : undefined };
    }
    default:
      return { kind: b.kind };
  }
}

export function sanitizeSegments(segments) {
  const report = { dropped: 0, trimmed: 0, repaired: 0, bigVisualsSplit: 0 };
  const out = [];
  for (const seg of (Array.isArray(segments) ? segments : [])) {
    if (!seg || typeof seg.say !== "string") { report.dropped++; continue; }
    const say = seg.say.replace(/\s+/g, " ").trim();
    let blocks = (Array.isArray(seg.blocks) ? seg.blocks : [])
      .map(b => sanitizeBlock(b, report)).filter(Boolean);
    // more than one heavy visual in a single segment reads as clutter
    const heavy = ["graph", "bars", "diagram", "table"];
    let seenHeavy = false;
    blocks = blocks.filter(b => {
      if (!heavy.includes(b.kind)) return true;
      if (seenHeavy) { report.bigVisualsSplit++; return false; }
      seenHeavy = true; return true;
    });
    if (!say && !blocks.length) { report.dropped++; continue; }
    out.push(seg.b != null ? { say, blocks, b: seg.b } : { say, blocks });
  }
  return { segments: out, report };
}

/* Strip a lesson down to what a student actually needs before it is
   stored. Everything here is text; nothing large travels.            */
export function compactLesson(lesson) {
  return {
    lessonTitle: String(lesson.lessonTitle || "").slice(0, 120),
    topic: lesson.topic,
    subTopics: String(lesson.subTopics || "").slice(0, 1200),
    objectives: (lesson.objectives || []).slice(0, 6).map(o => String(o).slice(0, 160)),
    prerequisites: (lesson.prerequisites || []).slice(0, 6).map(o => String(o).slice(0, 160)),
    misconceptions: (lesson.misconceptions || []).slice(0, 4).map(o => String(o).slice(0, 200)),
    beatTitles: (lesson.beatTitles || []).slice(0, 10).map(o => String(o).slice(0, 90)),
    segments: lesson.segments,
    reviewIssues: (lesson.review?.issues || []).slice(0, 5)
      .map(i => ({ what: String(i.what || "").slice(0, 160), fix: String(i.fix || "").slice(0, 160) })),
    corrected: lesson.corrected || 0,
    builtAt: lesson.builtAt || Date.now(),
    v: 1,
  };
}

/* Render the finished boards offscreen and return small JPEGs.
   480px wide at q0.5 is roughly 15-25 KB a page — a preview, not the
   artefact. Students re-render the real board from the script, so these
   are only for showing the day at a glance without loading a lesson. */
export function renderBoardThumbs(segments, { width = 480, quality = 0.5, maxPages = 6 } = {}) {
  const pages = [];
  try {
    SEED = 1;
    const { timeline } = buildTimeline(segments);
    const layer = document.createElement("canvas"); layer.width = BW; layer.height = BH;
    const lc = layer.getContext("2d");
    const bg = makeBoardTexture();
    const shot = () => {
      if (pages.length >= maxPages) return;
      const c = document.createElement("canvas");
      c.width = width; c.height = Math.round(width * BH / BW);
      const x = c.getContext("2d");
      x.drawImage(bg, 0, 0, c.width, c.height);
      x.drawImage(layer, 0, 0, c.width, c.height);
      pages.push(c.toDataURL("image/jpeg", quality));
    };
    let i = 0, ink = false;
    for (const t of timeline) for (const st of (t.strokes || [])) {
      if (st.brk) { if (ink) shot(); lc.clearRect(0, 0, BW, BH); ink = false; continue; }
      const r = mulberry(++i * 7919);
      for (let j = 1; j < st.p.length; j++)
        chalkSegment(lc, st.p[j - 1][0], st.p[j - 1][1], st.p[j][0], st.p[j][1], st.w, st.c, r);
      ink = true;
    }
    if (ink) shot();
  } catch { /* a thumbnail is never worth failing a save over */ }
  return pages;
}

/* ONE giant blackboard. Every page of the lecture, plus every board drawn
   while answering a question, tiled into a single continuous slate — no
   frames, no gaps, no seams. Three rows by default; the grid grows sideways
   as the lecture gets longer, which is how a real wall of boards fills up. */
export function renderBoardWall(segments, doubtSegments = [], { rows = 3, minCols = 4, panelWidth = 900, hardMax = 16000 } = {}) {
  // Ink only. The background is drawn once, underneath everything.
  const inkPages = list => {
    if (!list || !list.length) return [];
    SEED = 1;
    const { timeline } = buildTimeline(list);
    const layer = document.createElement("canvas"); layer.width = BW; layer.height = BH;
    const lc = layer.getContext("2d");
    const out = [];
    const shot = () => {
      const c = document.createElement("canvas"); c.width = BW; c.height = BH;
      c.getContext("2d").drawImage(layer, 0, 0);
      out.push(c);
    };
    let n = 0, ink = false;
    for (const t of timeline) for (const st of (t.strokes || [])) {
      if (st.brk) { if (ink) shot(); lc.clearRect(0, 0, BW, BH); ink = false; continue; }
      const r = mulberry(++n * 131);
      for (let j = 1; j < st.p.length; j++)
        chalkSegment(lc, st.p[j - 1][0], st.p[j - 1][1], st.p[j][0], st.p[j][1], st.w, st.c, r);
      ink = true;
    }
    if (ink) shot();
    return out;
  };

  const pages = [...inkPages(segments), ...inkPages(doubtSegments)];
  if (!pages.length) return null;

  const cols = Math.max(minCols, Math.ceil(pages.length / rows));
  const usedRows = Math.min(rows, Math.ceil(pages.length / cols)) || 1;
  const fullW = cols * BW, fullH = usedRows * BH;
  // Keep each panel legible rather than fitting a fixed overall width — a long
  // lecture is a wider wall, not a smaller one. Capped so the canvas stays
  // within what browsers will allocate.
  const target = Math.min(hardMax, cols * panelWidth);
  const scale = Math.min(1, target / fullW);

  const wall = document.createElement("canvas");
  wall.width = Math.round(fullW * scale);
  wall.height = Math.round(fullH * scale);
  const x = wall.getContext("2d");

  // One slate for the whole wall, generated at final size so there is no
  // repeating vignette and no tile boundary anywhere.
  x.drawImage(makeBoardTexture(wall.width, wall.height), 0, 0);

  pages.forEach((pg, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    x.drawImage(pg, Math.round(c * BW * scale), Math.round(r * BH * scale),
      Math.round(BW * scale), Math.round(BH * scale));
  });

  return { canvas: wall, pages: pages.length, cols, rows: usedRows, scale };
}

export const lessonBytes = obj => {
  try { return new Blob([JSON.stringify(obj)]).size; } catch { return JSON.stringify(obj).length; }
};

/* Pull every complete {"say":…,"blocks":[…]} object out of a string, even
   when the surrounding JSON was cut off mid-array by the token limit.
   Walks braces while respecting strings and escapes. */
function salvageSegments(text) {
  const s2 = String(text ?? "");
  const out = [];
  for (let i = 0; i < s2.length; i++) {
    if (s2[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s2.length; j++) {
      const ch = s2[j];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    // The OUTER object is the one left unclosed by truncation, so bailing
    // out here would discard the complete segments nested inside it.
    if (end < 0) continue;
    const chunk = s2.slice(i, end + 1);
    if (chunk.indexOf('"say"') >= 0) {
      try {
        const o = JSON.parse(chunk);
        if (o && typeof o.say === "string") { out.push(o); i = end; continue; }
      } catch { /* not a segment object, keep scanning */ }
    }
  }
  return out;
}

/* Last resort: the model answered in prose. Put the prose on the board
   rather than telling the student nothing came back. */
function proseToSegments(question, prose) {
  const clean = String(prose).replace(/```[a-z]*|```/g, "").replace(/[{}\[\]"]/g, " ")
    .replace(/\s+/g, " ").trim();
  if (clean.length < 40) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
  const per = Math.max(2, Math.ceil(sentences.length / 3));
  const gist = String(question).split(/\s+/).slice(0, 6).join(" ");
  const segs = [];
  for (let i = 0; i < sentences.length; i += per) {
    const say = sentences.slice(i, i + per).join(" ").trim();
    if (!say) continue;
    const blocks = i === 0
      ? [{ kind: "heading", text: `Question: ${gist}`, color: "yellow" }]
      : [];
    // Give each chunk one short board line so something is always written.
    const key = say.split(/[,;:]/)[0].trim();
    if (key && key.length > 8) blocks.push({ kind: "text", text: key.slice(0, 90) });
    segs.push({ say, blocks });
  }
  return segs;
}

function boardJson(raw, fallback) {
  const s = String(raw ?? "");
  const tryParse = t => { try { return JSON.parse(t); } catch { return null; } };
  let out = tryParse(s);
  if (out) return out;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { out = tryParse(fenced[1]); if (out) return out; }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    out = tryParse(s.slice(a, b + 1)) || tryParse(s.slice(a, b + 1).replace(/,\s*([}\]])/g, "$1"));
    if (out) return out;
  }
  return fallback;
}

/**
 * Full multi-agent build. `callAI` is the host's — keys, model choice and
 * rate-limit resilience all come from the LMS.
 * Calls are sequential on purpose, matching genAllForDay's rate-limit-safe style.
 */
export async function runBoardLessonAgents({ topic, subTopics = "", level = "", beats = 5, callAI, onProgress = () => { } }) {
  const subject = topic;
  const subLine = subTopics.trim()
    ? `\nSub-topics that MUST each be taught explicitly on the board:\n${subTopics.trim()}\n`
    : "";
  // Groq rejects a request outright when max_tokens alone exceeds the
  // per-minute budget, so every agent asks for only what it needs.
  // JSON mode keeps the model from wrapping the answer in prose, which was
  // the main reason a reply came back unparseable. Not every model supports
  // it, so fall back to a plain call if the request is rejected for it.
  const ask = async (system, user, maxTokens = 2600) => {
    const msgs = [{ role: "system", content: system }, { role: "user", content: user }];
    try {
      return String(await callAI(msgs, { maxTokens, temperature: 0.3, responseFormat: { type: "json_object" } }) || "");
    } catch (e) {
      if (!/response_format|json_object|json mode/i.test(String(e?.message || ""))) throw e;
      return String(await callAI(msgs, { maxTokens, temperature: 0.3 }) || "");
    }
  };

  /* 1 — Curriculum Architect */
  onProgress({ step: 1, of: beats + 2, label: "Curriculum Architect — sequencing the lesson" });
  const plan = boardJson(await ask(
    BOARD_SYS.architect,
    `Topic: ${subject}${subLine}${level ? `\nAudience level: ${level}` : ""}\nProduce exactly ${beats} beats.\nReturn JSON only.`, 3200
  ), null);
  if (!plan || !Array.isArray(plan.beats) || !plan.beats.length)
    throw new Error("The architect returned no beats — try a different model in Settings.");
  plan.beats = plan.beats.slice(0, beats);

  /* 2 — Board Director, one beat at a time */
  const allSegments = [];
  const repairs = { dropped: 0, trimmed: 0, repaired: 0, bigVisualsSplit: 0 };
  for (let i = 0; i < plan.beats.length; i++) {
    const b = plan.beats[i];
    onProgress({ step: 2 + i, of: beats + 2, label: `Board Director — beat ${i + 1} of ${plan.beats.length}` });
    const raw = await ask(
      BOARD_SYS.director,
      `Lesson: ${subject}${subLine}${level ? `\nLevel: ${level}` : ""}
Beat ${i + 1} of ${plan.beats.length}: ${b.title}
Goal: ${b.goal || ""}
Must cover, each as its own segment with its own board content:
${(b.covers || []).map((c, n2) => `  ${n2 + 1}. ${c}`).join("\n") || "  (derive the sub-points yourself from the detail below)"}
Exact content, values and equations: ${b.detail || ""}
Real-world example to teach near the end of this beat: ${b.realWorld || "choose a concrete one and name it"}
What to draw: ${b.visualPlan || b.visual || "your choice, but at least two different visual kinds"}
${i === 0
        ? 'Open with a hook in the first sentence. Start the board with {"kind":"title"} for the lesson.'
        : `Open with one clause linking back to "${plan.beats[i - 1]?.title || "the previous beat"}". Start the board with {"kind":"newpage"} then a heading.`}
${i === plan.beats.length - 1 ? "End with a two-sentence recap." : ""}
Return JSON only.`, 6000
    );
    const d = boardJson(raw, { segments: [] });
    let got = Array.isArray(d.segments) && d.segments.length ? d.segments : salvageSegments(raw);
    if (!got.length) got = [{ say: b.detail || b.title, blocks: [{ kind: "heading", text: b.title }] }];
    const raw2 = got;
    const { segments: clean, report } = sanitizeSegments(raw2);
    repairs.dropped += report.dropped; repairs.trimmed += report.trimmed;
    repairs.repaired += report.repaired; repairs.bigVisualsSplit += report.bigVisualsSplit;
    const withBeat = (clean.length ? clean : [{ say: b.detail || b.title, blocks: [{ kind: "heading", text: b.title }] }])
      .map(sg => ({ ...sg, b: i }));            // which beat this segment belongs to
    allSegments.push(...withBeat);
  }

  /* 3 — Accuracy Reviewer (advisory; never blocks the lesson) */
  onProgress({ step: beats + 2, of: beats + 2, label: "Accuracy Reviewer — checking facts and formulas" });
  let review = { verdict: "pass", issues: [] };
  let corrected = 0;
  try {
    review = boardJson(await ask(
      BOARD_SYS.reviewer,
      `Lesson: ${subject}${level ? ` (${level})` : ""}.\n\n` +
      allSegments.map((s, i) => `SEGMENT ${i + 1}\nSaid: ${s.say}\nBoard: ${JSON.stringify(s.blocks || [])}`).join("\n\n") +
      `\n\nReturn JSON only.`, 3000
    ), { verdict: "pass", issues: [] });

    // Apply the corrections rather than only reporting them. A correction
    // that fails to sanitize is discarded — a flagged segment is better
    // than a broken replacement.
    for (const c of (Array.isArray(review.corrections) ? review.corrections : [])) {
      const idx = parseInt(c?.segment, 10) - 1;
      if (!(idx >= 0 && idx < allSegments.length)) continue;
      const { segments: fixed } = sanitizeSegments([{
        say: typeof c.say === "string" && c.say.trim() ? c.say : allSegments[idx].say,
        blocks: Array.isArray(c.blocks) ? c.blocks : allSegments[idx].blocks,
      }]);
      if (fixed.length) { allSegments[idx] = fixed[0]; corrected++; }
    }
  } catch { /* a failed review must not lose a good lesson */ }

  return {
    corrected,
    repairs,
    lessonTitle: plan.lessonTitle || topic,
    objectives: plan.objectives || [],
    prerequisites: plan.prerequisites || [],
    misconceptions: plan.misconceptions || [],
    beatTitles: plan.beats.map(b => b.title),
    segments: allSegments,
    review,
    topic,
    subTopics,
    builtAt: Date.now()
  };
}

/** Runtime doubt answering — same callAI, so same keys.
 *  A student's question must never come back empty. In order: JSON mode,
 *  then salvage whatever complete segments survived truncation, then a
 *  shorter retry, then finally teach the prose the model did return. */
export async function answerBoardDoubt({ question, topic, subTopics = "", currentlySaying = "", callAI }) {
  const userMsg = (brief) => `Lesson: ${topic}${subTopics.trim() ? `\nSub-topics: ${subTopics.trim().slice(0, 400)}` : ""}
We are right here in the lesson: "${String(currentlySaying).slice(0, 400)}"

Student's question: "${String(question).slice(0, 500)}"
${brief ? "Keep it to 3 segments and at most one visual. Stay well inside the token budget so the JSON closes properly." : ""}
Return JSON only.`;

  const call = async (brief, maxTokens) => {
    const msgs = [{ role: "system", content: brief ? BOARD_SYS.doubtBrief : BOARD_SYS.doubt },
                  { role: "user", content: userMsg(brief) }];
    try {
      return String(await callAI(msgs, { maxTokens, temperature: 0.3, responseFormat: { type: "json_object" } }) || "");
    } catch (e) {
      if (!/response_format|json_object|json mode/i.test(String(e?.message || ""))) throw e;
      return String(await callAI(msgs, { maxTokens, temperature: 0.3 }) || "");
    }
  };

  const harvest = (raw) => {
    const d = boardJson(raw, { segments: [] });
    let segs = Array.isArray(d.segments) && d.segments.length ? d.segments : salvageSegments(raw);
    return sanitizeSegments(segs).segments;
  };

  let raw = await call(false, 3500);
  let segments = harvest(raw);

  if (!segments.length) {
    // Smaller ask — a shorter answer is far likelier to close its own JSON.
    const raw2 = await call(true, 1800);
    segments = harvest(raw2);
    if (!segments.length) raw = raw2 || raw;
  }

  if (!segments.length) {
    // The model answered, just not in JSON. Teach that answer rather than
    // telling the student nothing came back.
    segments = sanitizeSegments(proseToSegments(question, raw)).segments;
  }

  if (!segments.length) throw new Error("The model returned nothing at all — check the key and try again.");
  return segments;
}

/* ==========================================================================
   8. PANEL — the day tab. Styled with the LMS's own lms-btn classes.
   ========================================================================== */
const BIc = ({ d, s = 14, c = "currentColor" }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d={d} /></svg>
);
const P_PLAY = "M5 3l14 9-14 9V3z", P_PAUSE = "M6 4h4v16H6zM14 4h4v16h-4z", P_NEXT = "M5 4l10 8-10 8V4zM19 5v14";
const P_WIPE = "M20 20H7L3 16a2 2 0 010-3l8-8a2 2 0 013 0l6 6a2 2 0 010 3l-6 6", P_MIC = "M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3zM19 10a7 7 0 01-14 0M12 17v5";
const P_SEND = "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z", P_DL = "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3";
const P_VID = "M23 7l-7 5 7 5V7zM14 5H3a2 2 0 00-2 2v10a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2z";
const P_STOP = "M5 5h14v14H5z", P_RESET = "M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5";
const P_PREV = "M19 20L9 12l10-8v16zM5 19V5";
const P_EXPAND = "M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3";
const P_SHRINK = "M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3";
const BSpin = ({ s = 14 }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" style={{ flexShrink: 0 }}>
    <path d="M21 12a9 9 0 11-6.2-8.6" />
    <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12"
      dur="0.85s" repeatCount="indefinite" />
  </svg>
);

export function BoardLessonPanel({
  day, dayKey, dayData, updateDay, notify, studentMode, darkMode,
  busy, onGenerate, callAI, groqKey, trackActivity, studentId
}) {
  const lesson = dayData?.boardLesson || null;
  const subTopics = (dayData?.subTopics || "").trim();
  const busyKey = `board-${dayKey}`;
  const isBuilding = !!busy?.[busyKey];

  const [status, setStatus] = useState("idle");        // idle|ready|playing|paused|doubt|done
  const [caption, setCaption] = useState("");
  const [segIdx, setSegIdx] = useState(0);
  const [pages, setPages] = useState([]);
  const [transcript, setTranscript] = useState([]);
  const [doubtText, setDoubtText] = useState("");
  const [doubtBusy, setDoubtBusy] = useState(false);
  const [doubtLog, setDoubtLog] = useState([]);
  const [doubtBoards, setDoubtBoards] = useState([]);
  const DOUBT_LS = `lms_board_qa_${dayKey}_${studentId || "trainer"}`;
  useEffect(() => {
    try { const v = JSON.parse(localStorage.getItem(DOUBT_LS) || "[]"); if (Array.isArray(v)) setDoubtLog(v); } catch { }
    // eslint-disable-next-line
  }, [DOUBT_LS]);
  useEffect(() => {
    try { localStorage.setItem(DOUBT_LS, JSON.stringify(doubtLog.slice(-20))); } catch { }
  }, [doubtLog, DOUBT_LS]);
  const [listening, setListening] = useState(false);
  const [recording, setRecording] = useState(false);
  const [videoURL, setVideoURL] = useState("");
  const [voice, setVoice] = useState("Fritz-PlayAI");
  const [expanded, setExpanded] = useState(false);
  const [rate, setRate] = useState(1);
  const rateRef = useRef(1);
  useEffect(() => {
    rateRef.current = rate;
    // Retune anything already in flight so the slider takes effect immediately.
    const S = R.current;
    if (S.srcNode) { try { S.srcNode.playbackRate.value = rate; } catch { } }
    if (S.baseSpeed) S.speed = S.baseSpeed * rate;
  }, [rate]);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const photoRef = useRef(null);
  const fileRef = useRef(null);

  // Appearance lives on the day so the trainer's choice reaches students.
  const av = dayData?.boardAvatar || DEFAULT_AVATAR;
  const photoData = dayData?.boardAvatarPhoto || "";
  useEffect(() => {
    if (!photoData) { photoRef.current = null; return; }
    const img = new Image();
    img.onload = () => { photoRef.current = img; };
    img.src = photoData;
  }, [photoData]);
  const setAv = patch => updateDay(dayKey, { boardAvatar: { ...av, ...patch } });

  const viewRef = useRef(null), avatarRef = useRef(null), exportRef = useRef(null);
  const layerRef = useRef(null), bgRef = useRef(null), rafRef = useRef(0), lastT = useRef(0);
  const recogRef = useRef(null), recRef = useRef({ mr: null, chunks: [] });
  const R = useRef({
    strokes: [], si: 0, sp: 0, speed: 900, drawing: false, erase: -1, pen: null, dust: [],
    mouth: 0, blink: false, look: { x: 0, y: 0 }, talking: false, nextBlink: 1400,
    audioCtx: null, analyser: null, srcNode: null, dest: null, data: null,
    tlRef: [], idxRef: 0, origIdx: 0, gen: 0, cancelled: false, currentDuration: 0, recording: false
  });

  /* Trainer only: once a lesson exists, store a handful of small preview
     images alongside it. Guarded so it runs once per build, never for a
     student, and never if the trainer turned previews off.            */
  useEffect(() => {
    if (studentMode || !lesson?.segments?.length) return;
    if (dayData?.boardPreviewsOff) return;
    if (dayData?.boardThumbsAt === lesson.builtAt) return;
    const id = setTimeout(() => {
      const thumbs = renderBoardThumbs(lesson.segments, { width: 480, quality: 0.5, maxPages: 6 });
      if (thumbs.length) updateDay(dayKey, { boardThumbs: thumbs, boardThumbsAt: lesson.builtAt });
    }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line
  }, [lesson?.builtAt, studentMode, dayData?.boardPreviewsOff]);

  /* timeline is rebuilt whenever the stored lesson changes */
  const [timeline, setTimeline] = useState([]);
  useEffect(() => {
    if (!lesson?.segments?.length) { setTimeline([]); setStatus("idle"); return; }
    SEED = 1;
    try {
      const { timeline: tl } = buildTimeline(lesson.segments);
      setTimeline(tl); setStatus("ready"); setSegIdx(0);
    } catch (e) { setTimeline([]); }
    if (layerRef.current) layerRef.current.getContext("2d").clearRect(0, 0, BW, BH);
    setPages([]); setTranscript([]); setCaption("");
  }, [lesson?.builtAt, lesson?.segments?.length]);

  /* ---- canvas bootstrap + render loop ---- */
  const stepRef = useRef(() => { });
  useEffect(() => { stepRef.current = step; });
  useEffect(() => {
    bgRef.current = makeBoardTexture();
    const l = document.createElement("canvas"); l.width = BW; l.height = BH; layerRef.current = l;
    lastT.current = performance.now();
    paint();
    const loop = t => { stepRef.current(t); rafRef.current = requestAnimationFrame(loop); };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      halt();
      try { R.current.audioCtx?.close(); } catch { }
      try { recRef.current.mr?.stop(); } catch { }
    };
    // eslint-disable-next-line
  }, []);

  function step(t) {
    const dt = Math.min(64, t - lastT.current); lastT.current = t;
    const S = R.current;

    if (S.analyser && S.data) {
      S.analyser.getByteTimeDomainData(S.data);
      let sum = 0;
      for (let i = 0; i < S.data.length; i += 4) { const v = (S.data[i] - 128) / 128; sum += v * v; }
      S.mouth += (Math.min(1, Math.sqrt(sum / (S.data.length / 4)) * 5.2) - S.mouth) * 0.35;
    } else if (S.talking) {
      S.mouth = 0.32 + 0.30 * Math.abs(Math.sin(t / 92)) + 0.16 * Math.abs(Math.sin(t / 47));
    } else S.mouth += (0 - S.mouth) * 0.2;

    S.nextBlink -= dt;
    if (S.nextBlink < 0) { S.blink = true; setTimeout(() => { S.blink = false; }, 115); S.nextBlink = 1900 + Math.random() * 3600; }
    const tg = S.pen ? { x: S.pen[0] / BW, y: S.pen[1] / BH } : { x: 0.5, y: 0.45 };
    S.look.x += ((tg.x - 0.5) * 1.7 - S.look.x) * 0.06;
    S.look.y += ((tg.y - 0.5) * 1.4 - S.look.y) * 0.06;

    if (S.erase >= 0) {
      const ctx = layerRef.current.getContext("2d");
      const p1 = Math.min(1, S.erase + dt / 900), x1 = p1 * BW;
      ctx.save();
      ctx.globalAlpha = 0.05; ctx.fillStyle = "#dfe8df";
      for (let i = 0; i < 30; i++) ctx.fillRect(x1 - Math.random() * 60, Math.random() * BH, Math.random() * 26, Math.random() * 2.4);
      ctx.restore();
      S.pen = [x1, BH * 0.5];
      S.erase = p1 >= 1 ? -1 : p1;
      if (S.erase < 0) S.pen = null;
      paint(); drawAv(t); if (S.recording) compose(); return;
    }

    if (S.drawing && S.si < S.strokes.length) {
      let budget = (S.speed * dt) / 1000, guard = 0;
      const ctx = layerRef.current.getContext("2d");
      while (budget > 0 && S.si < S.strokes.length && guard++ < 4000) {
        const st = S.strokes[S.si];
        if (st.brk) { snapshot(); wipeLayer(); S.erase = 0; S.si++; S.sp = 0; break; }
        const r = mulberry((S.si * 7919 + Math.floor(S.sp)) | 0);
        let acc = 0, drew = false;
        for (let i = 1; i < st.p.length; i++) {
          const a = st.p[i - 1], b = st.p[i], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (acc + seg <= S.sp) { acc += seg; continue; }
          const startT = Math.max(0, (S.sp - acc) / (seg || 1));
          const take = Math.min(seg - (S.sp - acc), budget);
          const endT = startT + take / (seg || 1);
          // Grain is laid down in fixed-length steps, not one blob per frame.
          // Drawing a long piece in a single call left the chalk visibly
          // thinner wherever the writing sped up.
          if (!st.dash || (Math.floor(acc / 13) % 2 === 0)) {
            const steps = Math.max(1, Math.ceil(take / CHALK_STEP));
            for (let k = 0; k < steps; k++) {
              const t0 = startT + (endT - startT) * (k / steps);
              const t1 = startT + (endT - startT) * ((k + 1) / steps);
              chalkSegment(ctx, a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0,
                a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, st.w, st.c, r);
            }
          }
          S.pen = [a[0] + (b[0] - a[0]) * endT, a[1] + (b[1] - a[1]) * endT];
          if (Math.random() < 0.16) S.dust.push({ x: S.pen[0], y: S.pen[1], vy: 12 + Math.random() * 26, life: 1, s: Math.random() * 1.7 + 0.4 });
          // Float drift can leave `take` vanishingly small. Step past THIS
          // vertex only — jumping to st.len abandoned the rest of the stroke
          // and letters came out with pieces missing.
          if (take < 1e-4) { S.sp = Math.min(st.len, acc + seg + 1e-3); }
          else { S.sp += take; budget -= take; }
          drew = true; break;
        }
        if (!drew || S.sp >= st.len - 0.01) { S.si++; S.sp = 0; }
      }
      // If a frame burned its whole guard, finish that stroke outright rather
      // than skip it — skipping is what dropped parts of letters.
      if (guard >= 4000 && S.si < S.strokes.length) {
        const st = S.strokes[S.si];
        if (st && st.p) {
          const r = mulberry(S.si * 131);
          for (let j = 1; j < st.p.length; j++)
            chalkSegment(ctx, st.p[j - 1][0], st.p[j - 1][1], st.p[j][0], st.p[j][1], st.w, st.c, r);
        }
        S.si++; S.sp = 0;
      }
    }
    // Outside the block on purpose. A segment with no blocks at all — the
    // teacher just talking — never enters it, and leaving `drawing` true
    // stalled playback for the full catch-up timeout.
    if (S.drawing && S.si >= S.strokes.length) { S.drawing = false; S.pen = null; }
    S.dust = S.dust.filter(d => { d.y += d.vy * dt / 1000; d.vy += 46 * dt / 1000; d.life -= dt / 900; return d.life > 0; });
    paint(); drawAv(t); if (S.recording) compose();
  }

  function wipeLayer() {
    layerRef.current?.getContext("2d").clearRect(0, 0, BW, BH);
  }

  /* Land the rest of the current stroke list instantly, HONOURING page
     breaks. Skipping a break was what let a new page draw over the old
     one. Used by Next, Previous and any early exit from a segment. */
  function flushStrokes(from = R.current.si) {
    const S = R.current;
    if (!layerRef.current) return;
    const ctx = layerRef.current.getContext("2d");
    for (let i = from; i < S.strokes.length; i++) {
      const st = S.strokes[i];
      if (st.brk) { snapshot(); wipeLayer(); continue; }
      const r = mulberry(i * 131);
      for (let j = 1; j < st.p.length; j++)
        chalkSegment(ctx, st.p[j - 1][0], st.p[j - 1][1], st.p[j][0], st.p[j][1], st.w, st.c, r);
    }
    S.si = S.strokes.length; S.sp = 0; S.drawing = false; S.erase = -1; S.pen = null;
  }

  /* Rebuild the board silently up to (not including) segment `idx`, so
     jumping backwards or into a chapter shows the right board state. */
  function rebuildTo(list, idx) {
    const S = R.current;
    wipeLayer(); setPages([]);
    const ctx = layerRef.current.getContext("2d");
    let n = 0;
    for (let k = 0; k < idx && k < list.length; k++) {
      for (const st of (list[k].strokes || [])) {
        if (st.brk) { wipeLayer(); continue; }
        const r = mulberry(++n * 131);
        for (let j = 1; j < st.p.length; j++)
          chalkSegment(ctx, st.p[j - 1][0], st.p[j - 1][1], st.p[j][0], st.p[j][1], st.w, st.c, r);
      }
    }
    S.strokes = []; S.si = 0; S.sp = 0; S.drawing = false; S.erase = -1; S.pen = null;
  }

  function paint() {
    const c = viewRef.current; if (!c || !bgRef.current || !layerRef.current) return;
    const x = c.getContext("2d"); const S = R.current;
    x.drawImage(bgRef.current, 0, 0); x.drawImage(layerRef.current, 0, 0);
    for (const d of S.dust) { x.globalAlpha = d.life * 0.5; x.fillStyle = "#e9e4d4"; x.fillRect(d.x, d.y, d.s, d.s); }
    x.globalAlpha = 1;
    if (S.pen && (S.drawing || S.erase >= 0)) {
      if (S.erase >= 0) {
        x.fillStyle = "#7c5a3a"; x.fillRect(S.pen[0] - 28, S.pen[1] - 26, 56, 52);
        x.fillStyle = "#d9d2bf"; x.fillRect(S.pen[0] - 28, S.pen[1] + 16, 56, 12);
      } else {
        x.save(); x.translate(S.pen[0], S.pen[1]); x.rotate(-0.62);
        x.fillStyle = "rgba(0,0,0,0.32)"; x.fillRect(-2, -1, 24, 11);
        x.fillStyle = "#f7f3e7"; x.fillRect(-3, -3, 23, 10);
        x.fillStyle = "#ded7c4"; x.fillRect(-3, 4, 23, 3);
        x.restore();
      }
    }
  }
  function drawAv(t) {
    const c = avatarRef.current; if (!c) return; const S = R.current;
    drawTeacher(c.getContext("2d"), c.width, c.height, {
      t, mouth: S.mouth, blink: S.blink, look: S.look, talking: S.talking,
      av, photo: photoRef.current,
      point: S.pen && S.drawing ? { x: S.pen[0] / BW, y: S.pen[1] / BH } : null
    });
  }
  function compose() {
    const c = exportRef.current; if (!c || !viewRef.current) return;
    const x = c.getContext("2d"), W = c.width, H = c.height;
    x.fillStyle = "#0d0f12"; x.fillRect(0, 0, W, H);
    const pad = W * 0.018, bw = W - pad * 2 - W * 0.19, bh = bw * (BH / BW), by = (H - bh) / 2 - H * 0.035;
    const fr = x.createLinearGradient(0, by, bw, by + bh);
    fr.addColorStop(0, "#5f4227"); fr.addColorStop(0.55, "#3f2b18"); fr.addColorStop(1, "#57391f");
    x.fillStyle = fr; x.fillRect(pad - 12, by - 12, bw + 24, bh + 24);
    x.drawImage(viewRef.current, pad, by, bw, bh);
    if (avatarRef.current) {
      const aw = W * 0.175, ah = aw * (avatarRef.current.height / avatarRef.current.width);
      x.drawImage(avatarRef.current, W - pad - aw, by + bh - ah, aw, ah);
    }
    x.fillStyle = "rgba(0,0,0,0.62)"; x.fillRect(0, H - H * 0.13, W, H * 0.13);
    x.fillStyle = "#f0ece0"; x.font = `${Math.round(H * 0.031)}px system-ui, sans-serif`; x.textAlign = "center";
    const words = String(caption || "").split(/\s+/), lines = []; let ln = "";
    for (const w of words) { const t2 = ln ? ln + " " + w : w; if (x.measureText(t2).width > W * 0.86 && ln) { lines.push(ln); ln = w; } else ln = t2; }
    if (ln) lines.push(ln);
    lines.slice(-2).forEach((L, i) => x.fillText(L, W / 2, H - H * 0.13 + H * 0.048 + i * H * 0.038));
    x.textAlign = "left"; x.fillStyle = "#c9a227"; x.font = `600 ${Math.round(H * 0.026)}px Georgia, serif`;
    x.fillText(lesson?.lessonTitle || day?.topic || "Lesson", pad, by - 22);
  }
  function snapshot() {
    const t = document.createElement("canvas"); t.width = BW; t.height = BH;
    const x = t.getContext("2d"); x.drawImage(bgRef.current, 0, 0); x.drawImage(layerRef.current, 0, 0);
    setPages(p => [...p, t.toDataURL("image/png")]);
  }

  /* ---- audio ---- */
  function ensureAudio() {
    const S = R.current;
    if (!S.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      S.audioCtx = new AC();
      S.analyser = S.audioCtx.createAnalyser(); S.analyser.fftSize = 1024;
      S.data = new Uint8Array(S.analyser.fftSize);
      S.dest = S.audioCtx.createMediaStreamDestination();
      S.analyser.connect(S.audioCtx.destination); S.analyser.connect(S.dest);
    }
    if (S.audioCtx.state === "suspended") S.audioCtx.resume();
    return S.audioCtx;
  }
  async function speak(text) {
    const S = R.current; S.talking = true;
    if (groqKey) {
      try {
        const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
          body: JSON.stringify({ model: "playai-tts", voice, input: text, response_format: "wav" })
        });
        if (res.ok) {
          const ctx = ensureAudio(), audio = await ctx.decodeAudioData(await res.arrayBuffer());
          return await new Promise(resolve => {
            const src = ctx.createBufferSource();
            src.buffer = audio; src.connect(S.analyser); S.srcNode = src;
            src.playbackRate.value = rateRef.current;
            src.onended = () => { S.talking = false; S.srcNode = null; resolve(audio.duration * 1000); };
            src.start(); S.currentDuration = (audio.duration * 1000) / rateRef.current;
          });
        }
      } catch { /* fall through to the browser voice */ }
    }
    return await new Promise(resolve => {
      if (!window.speechSynthesis) { setTimeout(() => { S.talking = false; resolve(0); }, 1800); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.rate = Math.max(0.1, Math.min(10, 0.98 * rateRef.current));
      const vs = window.speechSynthesis.getVoices();
      const pick = vs.find(v => /en-(GB|US)/.test(v.lang) && /Google|Daniel|Samantha|Natural/i.test(v.name)) || vs.find(v => v.lang.startsWith("en"));
      if (pick) u.voice = pick;
      u.onend = () => { S.talking = false; resolve(0); };
      u.onerror = () => { S.talking = false; resolve(0); };
      window.speechSynthesis.speak(u);
    });
  }
  function stopSpeech() {
    const S = R.current;
    try { S.srcNode && S.srcNode.stop(); } catch { }
    S.srcNode = null; S.talking = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  /* ---- playback ---- */
  const estMs = t => Math.max(2200, String(t).split(/\s+/).length * 372) / (rateRef.current || 1);
  const tagged = list => list.map((s, i) => ({ ...s, orig: i }));
  function halt() {
    const S = R.current; S.cancelled = true; S.gen++; S.drawing = false; stopSpeech();
  }
  async function playFrom(list, i) {
    const S = R.current; S.tlRef = list; S.cancelled = false;
    const gen = ++S.gen, alive = () => !S.cancelled && S.gen === gen;
    for (let k = i; k < list.length; k++) {
      if (!alive()) return;
      S.idxRef = k;
      const seg = list[k];
      if (seg.orig != null) { S.origIdx = seg.orig; setSegIdx(seg.orig); }
      setCaption(seg.say);
      if (seg.say) setTranscript(t => (t[t.length - 1] === seg.say ? t : [...t, seg.say]));
      S.strokes = seg.strokes || []; S.si = 0; S.sp = 0; S.drawing = true;
      const total = S.strokes.reduce((a, s) => a + (s.len || 0), 0);
      S.baseSpeed = Math.max(220, total / Math.max(1.6, estMs(seg.say) / 1000 * 0.86));
      S.speed = S.baseSpeed * rateRef.current;
      const spoken = speak(seg.say);
      setTimeout(() => {
        if (S.currentDuration && total > 0) {
          S.baseSpeed = Math.max(220, total / Math.max(1.4, (S.currentDuration / 1000) * 0.84));
          S.speed = S.baseSpeed * rateRef.current;
        }
        S.currentDuration = 0;
      }, 260);
      await spoken;
      if (!alive()) return;
      // Give lagging chalk a bounded window to land, speeding it up gently.
      // 240 frames is ~8s; beyond that something is wrong, so finish the
      // strokes instantly (page breaks included) and move on.
      let guard = 0;
      while (S.drawing && alive() && guard++ < 240) { S.speed = Math.min(S.speed * 1.05, 60000); await new Promise(r => setTimeout(r, 33)); }
      if (S.drawing && alive()) flushStrokes();
    }
    if (!alive()) return;
    S.drawing = false; S.pen = null;
    setStatus("done"); snapshot();
    if (S.recording) stopRecording();
    if (trackActivity && dayKey) trackActivity("notebookView", dayKey, true);
  }
  const start = () => { setStatus("playing"); ensureAudio(); playFrom(tagged(timeline), 0); };
  const pause = () => { halt(); setStatus("paused"); };
  const resume = () => {
    const S = R.current, list = S.tlRef?.length ? S.tlRef : tagged(timeline);
    setStatus("playing"); ensureAudio(); playFrom(list, Math.min(S.idxRef, list.length - 1));
  };
  const skip = () => {
    const S = R.current, list = S.tlRef?.length ? S.tlRef : tagged(timeline);
    const next = Math.min(S.idxRef + 1, list.length - 1);
    halt();
    flushStrokes();                       // includes page breaks — no overdraw
    setTimeout(() => { setStatus("playing"); ensureAudio(); playFrom(list, next); }, 60);
  };

  /* Jump to any segment: used by Previous and by the chapter list. */
  const jumpTo = (target, autoplay = true) => {
    const list = tagged(timeline);
    const idx = Math.max(0, Math.min(target, list.length - 1));
    halt();
    rebuildTo(list, idx);
    setSegIdx(idx); R.current.origIdx = idx; R.current.idxRef = idx;
    setCaption(list[idx]?.say || "");
    if (autoplay) setTimeout(() => { setStatus("playing"); ensureAudio(); playFrom(list, idx); }, 60);
    else setStatus("paused");
  };
  const prev = () => jumpTo((R.current.origIdx || 0) - 1);
  const wipe = () => {
    const S = R.current; halt();
    layerRef.current.getContext("2d").clearRect(0, 0, BW, BH);
    S.si = 0; S.sp = 0; S.idxRef = 0; S.origIdx = 0; S.strokes = []; S.pen = null; S.tlRef = [];
    setPages([]); setTranscript([]); setSegIdx(0); setCaption(""); setStatus(timeline.length ? "ready" : "idle");
  };

  /* ---- doubts ---- */
  async function ask(question) {
    if (!question.trim()) return;
    if (!callAI) { notify?.("Questions need an AI key — add one in Settings › AI keys", "err"); return; }
    const S = R.current, here = S.origIdx || 0, wasPlaying = status === "playing";
    halt(); setStatus("doubt"); setDoubtBusy(true); setDoubtText("");
    setDoubtLog(l => [...l, { q: question, a: "…" }]);
    try {
      const segs = await answerBoardDoubt({
        question, topic: day?.topic || "", subTopics,
        currentlySaying: timeline[here]?.say || "", callAI
      });
      setDoubtLog(l => l.map((d, i) => i === l.length - 1 ? { ...d, a: segs.map(s => s.say).join(" ") } : d));
      // Kept so the exported wall includes what was drawn while answering.
      setDoubtBoards(prev => [...prev, { say: "", blocks: [{ kind: "newpage" }] }, ...segs]);
      snapshot();
      const answer = buildTimeline([{ say: "", blocks: [{ kind: "newpage" }] }, ...segs]).timeline;
      const rest = timeline.slice(here + 1).map((s, i) => ({ ...s, orig: here + 1 + i }));
      const bridge = rest.length
        ? buildTimeline([{ say: "Right — back to where we were.", blocks: [{ kind: "newpage" }, { kind: "heading", text: "Back to the lesson" }] }]).timeline
        : [];
      // Release the input BEFORE playing. Awaiting playback held doubtBusy
      // true for the entire remaining lecture, so a second question was
      // impossible until the lesson ended.
      setDoubtBusy(false);
      setStatus("playing"); ensureAudio();
      playFrom([...answer, ...bridge, ...rest], 0);
      return;
    } catch (e) {
      // Say what actually went wrong. "No answer came back" told the student
      // nothing they could act on.
      const m = String(e?.message || "");
      const friendly =
        /rate|429|per-minute|too large/i.test(m) ? "Groq is rate-limiting that key. Wait a few seconds and ask again."
        : /401|403|invalid.*key|unauthor/i.test(m) ? "That API key was rejected. Check it in Settings › AI."
        : /timed out|unreachable|network|fetch/i.test(m) ? "Couldn't reach the model. Check your connection and ask again."
        : m || "That didn't come back — ask again.";
      setDoubtLog(l => l.map((d, i) => i === l.length - 1 ? { ...d, a: friendly } : d));
      setStatus(wasPlaying ? "paused" : (timeline.length ? "ready" : "idle"));
    } finally { setDoubtBusy(false); }
  }
  function toggleMic() {
    if (listening) { try { recogRef.current?.stop(); } catch { } setListening(false); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      const r = new SR(); r.lang = "en-US"; r.interimResults = true; r.continuous = false;
      r.onresult = e => {
        const txt = Array.from(e.results).map(x => x[0].transcript).join("");
        setDoubtText(txt);
        if (e.results[e.results.length - 1].isFinal) { setListening(false); ask(txt); }
      };
      r.onerror = () => setListening(false); r.onend = () => setListening(false);
      recogRef.current = r; r.start(); setListening(true); return;
    }
    micWhisper();
  }
  async function micWhisper() {
    if (!groqKey) { notify?.("Voice questions need a Groq key in Settings › AI keys", "err"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream), chunks = [];
      mr.ondataavailable = e => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop()); setListening(false);
        const fd = new FormData();
        fd.append("file", new File([new Blob(chunks, { type: "audio/webm" })], "q.webm"));
        fd.append("model", "whisper-large-v3-turbo");
        const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions",
          { method: "POST", headers: { Authorization: `Bearer ${groqKey}` }, body: fd });
        const d = await res.json();
        if (d.text) { setDoubtText(d.text); ask(d.text); }
      };
      mr.start(); setListening(true);
      setTimeout(() => { if (mr.state === "recording") mr.stop(); }, 7000);
    } catch { setListening(false); notify?.("Microphone access was blocked", "err"); }
  }

  /* ---- export ---- */
  function startRecording() {
    const c = exportRef.current; c.width = 1280; c.height = 720;
    ensureAudio();
    const S = R.current;
    const tracks = [...c.captureStream(30).getVideoTracks()];
    if (S.dest) tracks.push(...S.dest.stream.getAudioTracks());
    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(m => MediaRecorder.isTypeSupported(m));
    const mr = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: 5000000 });
    recRef.current = { mr, chunks: [] };
    mr.ondataavailable = e => e.data.size && recRef.current.chunks.push(e.data);
    mr.onstop = () => {
      setVideoURL(URL.createObjectURL(new Blob(recRef.current.chunks, { type: "video/webm" })));
      setRecording(false); R.current.recording = false;
    };
    mr.start(1000); setRecording(true); R.current.recording = true;
    wipe();
    setTimeout(() => { setStatus("playing"); ensureAudio(); playFrom(tagged(timeline), 0); }, 500);
  }
  function stopRecording() { try { recRef.current.mr?.stop(); } catch { } }
  function savePages() {
    const list = pages.length ? pages : (() => {
      const t = document.createElement("canvas"); t.width = BW; t.height = BH;
      const x = t.getContext("2d"); x.drawImage(bgRef.current, 0, 0); x.drawImage(layerRef.current, 0, 0);
      return [t.toDataURL("image/png")];
    })();
    list.forEach((p, i) => {
      const a = document.createElement("a");
      a.href = p; a.download = `Day${day?.dayNum || 1}_board_${String(i + 1).padStart(2, "0")}.png`; a.click();
    });
  }
  function saveTranscript() {
    const L = lesson || {};
    const txt = [
      `Day ${day?.dayNum || ""}: ${L.lessonTitle || day?.topic || ""}`,
      subTopics ? `Sub-topics: ${subTopics.replace(/\n/g, ", ")}` : "",
      "=".repeat(52), "",
      L.objectives?.length ? "Objectives\n" + L.objectives.map(o => "  - " + o).join("\n") + "\n" : "",
      transcript.join("\n\n"),
      doubtLog.length ? "\n\nQuestions asked\n" + doubtLog.map(d => `Q: ${d.q}\nA: ${d.a}`).join("\n\n") : ""
    ].filter(Boolean).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain" }));
    a.download = `Day${day?.dayNum || 1}_board_transcript.txt`; a.click();
  }

  /* Contents list. One entry per beat, plus every heading written on the
     board inside it — a lecture of 8 beats becomes 30-odd jump points
     rather than 8, which is what makes it navigable. */
  const chapters = (() => {
    const titles = lesson?.beatTitles || [];
    const segs = lesson?.segments || [];
    if (!segs.length) return [];
    const out = [];
    let lastBeat = -1;
    const norm = t => String(t || "").replace(/\s+/g, " ").trim();
    segs.forEach((sg, i) => {
      if (i >= timeline.length) return;
      const b = sg.b;
      if (b != null && b !== lastBeat) {
        lastBeat = b;
        out.push({ title: norm(titles[b]) || `Part ${b + 1}`, index: i, beat: b, top: true });
      }
      for (const bl of (sg.blocks || [])) {
        if (bl?.kind !== "heading" && bl?.kind !== "title") continue;
        const t = norm(bl.text);
        if (!t) continue;
        const prev = out[out.length - 1];
        if (prev && prev.index === i) continue;                 // beat row already covers it
        if (out.some(o => o.title.toLowerCase() === t.toLowerCase())) continue;
        out.push({ title: t, index: i, beat: b ?? lastBeat, top: false });
      }
    });
    return out;
  })();
  const activeIdx = chapters.reduce((acc, c, n) => (segIdx >= c.index ? n : acc), -1);

  const [exporting, setExporting] = useState(false);
  function downloadWall() {
    if (!lesson?.segments?.length) return;
    setExporting(true);
    // Yield a frame so the button can show its spinner before the big render.
    setTimeout(() => {
      try {
        const out = renderBoardWall(lesson.segments, doubtBoards);
        if (!out) { notify?.("Nothing on the board to save yet", "err"); setExporting(false); return; }
        out.canvas.toBlob(blob => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `Day${day?.dayNum || 1}_board_wall_${out.cols}x${out.rows}.png`;
          a.click();
          notify?.(`Whole board saved — ${out.pages} panels in a ${out.cols}×${out.rows} grid${doubtBoards.length ? ", questions included" : ""}`);
          setExporting(false);
        }, "image/png");
      } catch (e) { notify?.("Export failed — " + e.message, "err"); setExporting(false); }
    }, 30);
  }

  function onPickPhoto(e) {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 8 * 1024 * 1024) { notify?.("Pick an image under 8 MB", "err"); return; }
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          // Turn the photo into a drawn character wearing its colours. Nothing
          // from the photo itself is stored or shown — the result is a proper
          // rig that blinks, follows the chalk and lip syncs to the audio.
          const built = deriveAvatarFromPhoto(img);
          updateDay(dayKey, { boardAvatar: built, boardAvatarPhoto: "" });
          notify?.("Made an animated teacher from your photo — tweak it below if you like");
        } catch { notify?.("Couldn't read that image — try a clearer head-and-shoulders shot", "err"); }
      };
      img.onerror = () => notify?.("Couldn't open that image", "err");
      img.src = fr.result;
    };
    fr.readAsDataURL(f);
  }

  /* ---------------------------------------------------------------- UI */
  const chip = {
    display: "flex", alignItems: "center", gap: 6, background: darkMode ? "#1e293b" : "#eff6ff",
    border: `1.5px solid ${darkMode ? "#334155" : "#bfdbfe"}`, borderRadius: 8, padding: "5px 10px", height: 36
  };
  const label = { fontSize: 11.5, color: darkMode ? "#93c5fd" : "#1e40af", fontWeight: 600, whiteSpace: "nowrap" };

  const askBox = (compact = false) => (
    <div style={{
      background: compact ? "rgba(15,23,42,.55)" : (darkMode ? "#0f172a" : "#fff"),
      border: `1px solid ${compact ? "rgba(148,163,184,.25)" : (darkMode ? "#1e293b" : "#e2e8f0")}`,
      borderRadius: 12, padding: 14
    }}>
      <div style={{ fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 8, fontFamily: "ui-monospace, monospace" }}>
        {callAI
          ? "Raise your hand any time — the lesson pauses, answers, then carries on"
          : "Add your own AI key to ask questions"}
      </div>
      {!callAI && studentMode && (
        <div style={{ background: "rgba(251,191,36,.12)", border: "1px solid rgba(251,191,36,.4)", borderRadius: 8, padding: "9px 11px", marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, color: darkMode || compact ? "#fcd34d" : "#92400e", fontWeight: 600, marginBottom: 3 }}>
            Your API key is needed to ask questions
          </div>
          <div style={{ fontSize: 11.5, color: compact ? "#cbd5e1" : (darkMode ? "#94a3b8" : "#78350f"), lineHeight: 1.5 }}>
            The lecture plays without one. To stop it and ask, open <b>Settings › AI</b> and paste your own
            free Groq key — questions are then answered on the board and the lesson picks up where it left off.
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="lms-btn lms-btn-ghost" disabled={doubtBusy || !callAI} onClick={toggleMic}
          style={listening ? { borderColor: "#f43f5e", color: "#f43f5e" } : undefined} title="Ask out loud">
          <BIc d={P_MIC} />{listening ? "Listening…" : ""}
        </button>
        <input value={doubtText} onChange={e => setDoubtText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && ask(doubtText)}
          placeholder={callAI ? "Wait — why does the sign flip there?" : "Add your API key in Settings to ask"}
          disabled={doubtBusy || !callAI}
          style={{ flex: 1, minWidth: 0, border: `1.5px solid ${compact ? "rgba(148,163,184,.3)" : (darkMode ? "#334155" : "#e2e8f0")}`, borderRadius: 8, padding: "8px 12px", fontSize: 13.5, background: compact ? "rgba(2,6,23,.5)" : (darkMode ? "#1e293b" : "#fff"), color: compact || darkMode ? "#e2e8f0" : "#1e293b", outline: "none" }} />
        <button className="lms-btn lms-btn-blue" disabled={doubtBusy || !callAI || !doubtText.trim()} onClick={() => ask(doubtText)}>
          <BIc d={P_SEND} />Ask
        </button>
      </div>
      {doubtLog.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10, maxHeight: compact ? "40vh" : 180, overflowY: "auto" }}>
          {doubtLog.slice().reverse().map((d, i) => (
            <div key={i} style={{ borderLeft: "2.5px solid #3b82f6", paddingLeft: 10 }}>
              <div style={{ fontSize: 13, color: compact || darkMode ? "#93c5fd" : "#1d4ed8", fontWeight: 600 }}>{d.q}</div>
              <div style={{ fontSize: 12.5, color: compact ? "#cbd5e1" : (darkMode ? "#94a3b8" : "#475569"), lineHeight: 1.55 }}>{d.a}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const chapterList = (compact = false) => (
    chapters.length > 0 && (
      <div style={{ marginTop: compact ? 0 : 10 }}>
        <div style={{ fontSize: 9.5, letterSpacing: ".16em", textTransform: "uppercase", color: "#78716c", padding: "0 10px 6px", fontFamily: "ui-monospace, monospace" }}>
          Contents · {chapters.length} jump points
        </div>
        <div style={{ display: "flex", flexDirection: "column", maxHeight: compact ? 300 : 340, overflowY: "auto" }}>
          {chapters.map((c, i) => {
            const on = i === activeIdx;
            return (
              <button key={i} onClick={() => jumpTo(c.index)} title={c.title}
                style={{
                  textAlign: "left", border: "none", cursor: "pointer",
                  background: on ? "rgba(59,130,246,.18)" : "transparent",
                  borderLeft: `2.5px solid ${on ? "#3b82f6" : "transparent"}`,
                  color: on ? "#bfdbfe" : (c.top ? "#d6d3d1" : "#a8a29e"),
                  padding: c.top ? "8px 10px 5px" : "4px 10px 4px 24px",
                  fontSize: c.top ? 12 : 11.5, fontWeight: c.top ? 700 : 400,
                  lineHeight: 1.35, display: "flex", gap: 8, alignItems: "baseline"
                }}>
                {c.top
                  ? <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, opacity: .6 }}>{String(c.beat + 1).padStart(2, "0")}</span>
                  : <span style={{ opacity: .45, fontSize: 10 }}>•</span>}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.title}</span>
              </button>
            );
          })}
        </div>
      </div>
    )
  );

  return (
    <div style={{ animation: "lms-in .2s ease" }}>
      {/* toolbar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        {!studentMode && (
          <>
            <div style={chip}>
              <span style={label}>Beats</span>
              <input type="number" min={3} max={8}
                value={dayData?.boardBeats ?? 5}
                onChange={e => updateDay(dayKey, { boardBeats: Math.max(3, Math.min(8, parseInt(e.target.value) || 5)) })}
                style={{ width: 38, border: "none", background: "transparent", fontSize: 14, fontWeight: 800, color: darkMode ? "#93c5fd" : "#1e40af", outline: "none", padding: 0, textAlign: "center" }} />
            </div>
            <button className="lms-btn lms-btn-blue" disabled={isBuilding} onClick={onGenerate}>
              {isBuilding
                ? <><BSpin />Building lesson…</>
                : <><BIc d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2zM22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />{lesson ? "Rebuild board lesson" : "Generate board lesson"}</>}
            </button>
          </>
        )}
        {!studentMode && lesson && (
          <>
            <label style={{ ...chip, cursor: "pointer" }}>
              <input type="checkbox" checked={!dayData?.boardPreviewsOff}
                onChange={e => updateDay(dayKey, { boardPreviewsOff: !e.target.checked })}
                style={{ margin: 0, width: 14, height: 14, accentColor: "#3b82f6" }} />
              <span style={label}>Save board previews</span>
            </label>
            <span style={{ fontSize: 11.5, color: "#94a3b8", fontFamily: "ui-monospace, monospace" }}>
              {(() => {
                const j = lessonBytes(lesson);
                const t = (dayData?.boardThumbs || []).reduce((a, d) => a + Math.round(d.length * 0.75), 0);
                const kb = v => v < 1024 ? `${v} B` : `${(v / 1024).toFixed(0)} KB`;
                return `stored: ${kb(j)} script${t ? ` + ${kb(t)} previews` : ""}`;
              })()}
            </span>
          </>
        )}
        {studentMode && lesson && (
          <span style={{ fontSize: 12, color: "#64748b" }}>
            Your trainer published this lesson. Play it, and stop it any time to ask a question.
          </span>
        )}
        {groqKey && (
          <div style={chip}>
            <span style={label}>Voice</span>
            <select value={voice} onChange={e => setVoice(e.target.value)}
              style={{ border: "none", background: "transparent", fontSize: 12.5, fontWeight: 700, color: darkMode ? "#93c5fd" : "#1e40af", outline: "none" }}>
              {["Fritz-PlayAI", "Arista-PlayAI", "Celeste-PlayAI", "Basil-PlayAI", "Briggs-PlayAI", "Calum-PlayAI", "Mason-PlayAI", "Quinn-PlayAI", "Thunder-PlayAI"]
                .map(v => <option key={v} value={v}>{v.replace("-PlayAI", "")}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* who is teaching */}
      {avatarOpen && !studentMode && (
        <div style={{ background: darkMode ? "#0f172a" : "#f8fafc", border: `1px solid ${darkMode ? "#1e293b" : "#e2e8f0"}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "#94a3b8", fontFamily: "ui-monospace, monospace" }}>Who is teaching</span>
            <div style={{ flex: 1 }} />
            <button className="lms-btn lms-btn-ghost" onClick={() => setAvatarOpen(false)}>Done</button>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {AVATAR_PRESETS.map(pr => {
              const on = !photoData && av.id === pr.id;
              return (
                <button key={pr.id}
                  onClick={() => updateDay(dayKey, { boardAvatar: pr, boardAvatarPhoto: "" })}
                  style={{
                    display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
                    border: `1.5px solid ${on ? "#3b82f6" : (darkMode ? "#334155" : "#e2e8f0")}`,
                    background: on ? "rgba(59,130,246,.12)" : "transparent",
                    borderRadius: 9, padding: "6px 10px"
                  }}>
                  <span style={{ width: 20, height: 20, borderRadius: 99, background: pr.skin, border: `2px solid ${pr.hair}`, flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, color: darkMode ? "#e2e8f0" : "#334155", fontWeight: on ? 700 : 500 }}>{pr.name}</span>
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 6, fontFamily: "ui-monospace, monospace" }}>Build your own</div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                {[["skin", "Skin", ["#f2d3b0", "#e2ab7c", "#c98a5a", "#a86c42", "#8d5a3c", "#5f3a26"]],
                  ["hair", "Hair", ["#16161a", "#241d1a", "#4a3423", "#7b4b28", "#b07a3c", "#9aa0a6"]],
                  ["shirt", "Shirt", ["#4a6b7c", "#8b5a6b", "#3f7a6a", "#5b6b8c", "#7a5c8c", "#6b7a4a"]]].map(([key, lbl, cols]) => (
                    <div key={key}>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>{lbl}</div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {cols.map(c => (
                          <button key={c} onClick={() => { setAv({ [key]: c, id: "custom" }); updateDay(dayKey, { boardAvatarPhoto: "" }); }}
                            title={c}
                            style={{ width: 22, height: 22, borderRadius: 6, background: c, cursor: "pointer", border: av[key] === c ? "2.5px solid #3b82f6" : "1px solid rgba(0,0,0,.25)" }} />
                        ))}
                      </div>
                    </div>
                  ))}
                <div>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Hair style</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {["short", "long", "curls", "bun"].map(st2 => (
                      <button key={st2} onClick={() => { setAv({ style: st2, id: "custom" }); updateDay(dayKey, { boardAvatarPhoto: "" }); }}
                        style={{
                          fontSize: 11, padding: "4px 8px", borderRadius: 6, cursor: "pointer",
                          border: `1.5px solid ${av.style === st2 ? "#3b82f6" : (darkMode ? "#334155" : "#e2e8f0")}`,
                          background: av.style === st2 ? "rgba(59,130,246,.14)" : "transparent",
                          color: darkMode ? "#e2e8f0" : "#334155"
                        }}>{st2}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Extras</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[["glasses", "Glasses"], ["beard", "Beard"]].map(([kk, lbl]) => (
                      <button key={kk} onClick={() => { setAv({ [kk]: !av[kk], id: "custom" }); updateDay(dayKey, { boardAvatarPhoto: "" }); }}
                        style={{
                          fontSize: 11, padding: "4px 8px", borderRadius: 6, cursor: "pointer",
                          border: `1.5px solid ${av[kk] ? "#3b82f6" : (darkMode ? "#334155" : "#e2e8f0")}`,
                          background: av[kk] ? "rgba(59,130,246,.14)" : "transparent",
                          color: darkMode ? "#e2e8f0" : "#334155"
                        }}>{lbl}</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ borderLeft: `1px solid ${darkMode ? "#1e293b" : "#e2e8f0"}`, paddingLeft: 16 }}>
              <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 6, fontFamily: "ui-monospace, monospace" }}>Make one from a photo</div>
              <input ref={fileRef} type="file" accept="image/*" onChange={onPickPhoto} style={{ display: "none" }} />
              <button className="lms-btn lms-btn-ghost" onClick={() => fileRef.current?.click()}>
                Upload a photo
              </button>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 7, maxWidth: 270, lineHeight: 1.55 }}>
                Your photo is read for its colours — skin, hair, hair length, what you are wearing — and an
                animated teacher is drawn from them. The drawing is what gets used, so it blinks, turns towards
                the chalk and lip syncs properly. The photo itself is never stored or shown.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* the board — same markup whether inline or expanded */}
      <div style={expanded
        ? { position: "fixed", inset: 0, zIndex: 9999, background: "#0b0d10", padding: 14, display: "flex", flexDirection: "column", overflow: "auto" }
        : { borderRadius: 16, padding: 14, marginBottom: 14, background: "linear-gradient(160deg,#5f4227,#3f2b18 55%,#57391f)", boxShadow: "0 18px 44px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.12)" }}>
        {expanded && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexShrink: 0 }}>
            <span style={{ color: "#e7e5e4", fontFamily: "Georgia, serif", fontSize: 16 }}>
              {lesson?.lessonTitle || day?.topic}
            </span>
            <span style={{ fontSize: 11, color: "#78716c", fontFamily: "ui-monospace, monospace" }}>
              {timeline.length ? `${Math.min(segIdx + 1, timeline.length)}/${timeline.length}` : ""}
            </span>
            <div style={{ flex: 1 }} />
            <button className="lms-btn lms-btn-ghost" onClick={() => setExpanded(false)}>
              <BIc d={P_SHRINK} />Exit full screen
            </button>
          </div>
        )}
        <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: expanded ? "nowrap" : "wrap", flex: expanded ? 1 : "none", minHeight: 0 }}>
          <div style={{ flex: "1 1 460px", minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ borderRadius: 8, overflow: "hidden", boxShadow: "inset 0 0 60px rgba(0,0,0,.55)", position: "relative" }}>
              <canvas ref={viewRef} width={BW} height={BH} style={{ width: "100%", display: "block" }} />
              {!timeline.length && (
                <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(13,15,18,.72)", padding: 24 }}>
                  <div style={{ textAlign: "center", maxWidth: 380 }}>
                    <p style={{ color: "#f0ece0", fontSize: 17, fontFamily: "Georgia, serif", marginBottom: 6 }}>The board is clean.</p>
                    <p style={{ color: "#a8a29e", fontSize: 13, lineHeight: 1.6 }}>
                      {studentMode
                        ? "Your trainer hasn't built the board lesson for this day yet."
                        : <>Three agents will plan, script and check a lesson on <b style={{ color: "#e7e5e4" }}>{day?.topic || "this topic"}</b>
                          {subTopics ? ", covering every sub-topic you listed above" : ""}, then write it out in chalk.</>}
                    </p>
                  </div>
                </div>
              )}
            </div>
            <div style={{ marginTop: 9, height: 15, borderRadius: "0 0 6px 6px", display: "flex", alignItems: "center", gap: 6, padding: "0 12px", background: "linear-gradient(180deg,#6b4a2b,#3a2716)" }}>
              <span style={{ height: 5, width: 30, borderRadius: 99, background: "rgba(231,229,228,.85)" }} />
              <span style={{ height: 5, width: 18, borderRadius: 99, background: "rgba(253,230,138,.7)" }} />
              <span style={{ height: 5, width: 22, borderRadius: 99, background: "rgba(187,247,208,.55)" }} />
              <span style={{ marginLeft: "auto", height: 8, width: 34, borderRadius: 3, background: "#7c5a3a", borderBottom: "2px solid rgba(231,229,228,.7)" }} />
            </div>
          </div>
          <div style={{ flex: expanded ? "0 0 340px" : "0 0 210px", display: "flex", flexDirection: "column", gap: 10, minHeight: 0, alignSelf: expanded ? "stretch" : "flex-start" }}>
            <div style={{ background: "radial-gradient(120% 90% at 50% 8%, #232a30 0%, #14171b 70%)", borderRadius: 10, overflow: "hidden", flexShrink: 0 }}>
              <canvas ref={avatarRef} width={300} height={360} style={{ width: "100%", display: "block" }} />
              <div style={{ padding: "8px 10px", borderTop: "1px solid #1f2937", display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, color: "#e7e5e4", fontFamily: "Georgia, serif", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {lesson?.lessonTitle || day?.topic || "No lesson yet"}
                  </div>
                  <div style={{ fontSize: 10.5, color: "#78716c", marginTop: 2, fontFamily: "ui-monospace, monospace" }}>
                    {status === "playing" ? "teaching" : status === "doubt" ? "answering" : status === "paused" ? "paused" : status === "done" ? "finished" : "waiting"}
                  </div>
                </div>
                {!studentMode && (
                  <button onClick={() => setAvatarOpen(v => !v)} title="Change the teacher"
                    style={{ border: "1px solid #334155", background: "transparent", color: "#94a3b8", borderRadius: 7, padding: "4px 7px", cursor: "pointer", fontSize: 11, flexShrink: 0 }}>
                    Edit
                  </button>
                )}
              </div>
              {chapterList(true)}
            </div>

            {/* expanded: the question panel lives beside the board */}
            {expanded && <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{askBox(true)}</div>}
          </div>
        </div>
      </div>

      {timeline.length > 0 && (
        <>
          {/* transport */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            {(status === "ready" || status === "idle" || status === "done") && (
              <button className="lms-btn lms-btn-blue" onClick={status === "done" ? wipe : start}>
                {status === "done" ? <><BIc d={P_RESET} />Teach it again</> : <><BIc d={P_PLAY} />Start the lesson</>}
              </button>
            )}
            {status === "playing" && <button className="lms-btn lms-btn-ghost" onClick={pause}><BIc d={P_PAUSE} />Pause</button>}
            {status === "paused" && <button className="lms-btn lms-btn-blue" onClick={resume}><BIc d={P_PLAY} />Resume</button>}
            {status === "doubt" && <span style={{ fontSize: 13, color: "#b45309", fontWeight: 600 }}>Answering the question…</span>}
            <button className="lms-btn lms-btn-ghost" disabled={segIdx <= 0} onClick={prev}><BIc d={P_PREV} />Previous</button>
            <button className="lms-btn lms-btn-ghost" disabled={segIdx >= timeline.length - 1} onClick={skip}><BIc d={P_NEXT} />Next</button>
            <button className="lms-btn lms-btn-ghost" onClick={() => setExpanded(true)}><BIc d={P_EXPAND} />Full screen</button>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 10px", height: 36, borderRadius: 8, border: `1.5px solid ${darkMode ? "#334155" : "#e2e8f0"}` }}>
              <span style={{ fontSize: 11, color: "#94a3b8", fontFamily: "ui-monospace, monospace" }}>Speed</span>
              <input type="range" min={0.5} max={3} step={0.1} value={rate}
                onChange={e => setRate(parseFloat(e.target.value))}
                style={{ width: 96, accentColor: "#3b82f6" }} />
              <button onClick={() => setRate(1)} title="Back to normal speed"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, minWidth: 32,
                         fontSize: 12, fontWeight: 800, color: rate === 1 ? "#94a3b8" : "#3b82f6", fontFamily: "ui-monospace, monospace" }}>
                {rate.toFixed(1)}x
              </button>
            </div>
            <button className="lms-btn lms-btn-ghost" onClick={wipe}><BIc d={P_WIPE} />Wipe board</button>
            <div style={{ flex: 1 }} />
            {!recording
              ? <button className="lms-btn lms-btn-ghost" onClick={startRecording}><BIc d={P_VID} />Record video</button>
              : <button className="lms-btn lms-btn-ghost" onClick={stopRecording}><BIc d={P_STOP} />Stop &amp; save</button>}
            {videoURL && <a className="lms-btn lms-btn-ghost" href={videoURL} download={`Day${day?.dayNum || 1}_board_lesson.webm`}><BIc d={P_DL} />Download video</a>}
            <button className="lms-btn lms-btn-ghost" disabled={exporting} onClick={downloadWall}>
              {exporting ? <BSpin /> : <BIc d={P_DL} />}Whole board (1 PNG)
            </button>
            <button className="lms-btn lms-btn-ghost" disabled={!transcript.length} onClick={saveTranscript}><BIc d={P_DL} />Transcript</button>
          </div>

          <div style={{ height: 4, borderRadius: 99, background: darkMode ? "#1e293b" : "#e2e8f0", overflow: "hidden", marginBottom: 12 }}>
            <div style={{ height: "100%", background: "linear-gradient(90deg,#3b82f6,#6366f1)", width: `${((segIdx + (status === "done" ? 1 : 0)) / timeline.length) * 100}%`, transition: "width .5s" }} />
          </div>

          {/* caption */}
          <div style={{ background: darkMode ? "#0f172a" : "#f8fafc", border: `1px solid ${darkMode ? "#1e293b" : "#e2e8f0"}`, borderRadius: 12, padding: "12px 16px", marginBottom: 12, minHeight: 60 }}>
            <div style={{ fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 4, fontFamily: "ui-monospace, monospace" }}>Saying now</div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: darkMode ? "#e2e8f0" : "#1e293b" }}>{caption || "—"}</div>
          </div>

          {/* doubts */}
          {!expanded && askBox(false)}

          {(lesson?.reviewIssues?.length > 0 || lesson?.review?.issues?.length > 0) && !studentMode && (
            <div style={{ marginTop: 12, background: "#fffbeb", border: "1.5px solid #fde68a", borderRadius: 10, padding: "10px 14px" }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: "#92400e", marginBottom: 4 }}>
                Reviewer corrected {lesson.corrected || 0} segment(s)
              </div>
              {(lesson.reviewIssues || lesson.review?.issues || []).slice(0, 4).map((it, i) => (
                <div key={i} style={{ fontSize: 12, color: "#78350f", lineHeight: 1.5 }}>• {it.fix || it.what}</div>
              ))}
            </div>
          )}
        </>
      )}

      <canvas ref={exportRef} width={1280} height={720} style={{ display: "none" }} />
    </div>
  );
}
