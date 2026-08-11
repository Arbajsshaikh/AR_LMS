/* ═══════════════════════════════════════════════════════════════════
   LMS_Forge.jsx — premium study sheets from a photo of notes
   ───────────────────────────────────────────────────────────────────
   Adapted from Notes Forge Studio for the LMS. Five agents read a page
   of handwriting and rebuild it as a typeset sheet with real SVG
   figures — a different, much higher-fidelity path than the chalk
   engine, which stays for the animated board.

   Changes from the original:
     · no Vercel proxy — the LMS already holds provider keys in the
       browser, so requests go direct and nothing extra is deployed
     · no tesseract OCR path, which pulled a large external dependency
     · the day's topic and sub-topics steer the Architect, so a sheet
       matches the lesson it belongs to and not only the photo
     · keys arrive as a rotating pool, mirroring the Groq key handling
   ═══════════════════════════════════════════════════════════════════ */
import { useState, useEffect, useMemo, useRef } from "react";


const PALETTE = {
  violet: "#6d28d9",
  rose: "#e11d48",
  emerald: "#059669",
  amber: "#c2740b",
  sky: "#0369a1",
  slate: "#475569",
};
const PALETTE_TINT = {
  violet: "#f3efff",
  rose: "#fff1f4",
  emerald: "#ecfdf5",
  amber: "#fff8e8",
  sky: "#eff8ff",
  slate: "#f4f6f9",
};
const COLOR_KEYS = Object.keys(PALETTE);

const AGENTS = [
  { id: "scribe", name: "Scribe", role: "Reads every mark on the page" },
  { id: "architect", name: "Architect", role: "Rebuilds the learning flow" },
  { id: "auditor", name: "Auditor", role: "Checks nothing was dropped" },
  { id: "draftsman", name: "Draftsman", role: "Draws the diagrams as SVG" },
  { id: "composer", name: "Composer", role: "Typesets the final sheet" },
];

const P_SCRIBE = [
  "You are Scribe, a forensic transcription agent for handwritten study notes and whiteboard photos.",
  "Your only job: record EVERYTHING visible. You are not allowed to summarise, judge, or skip.",
  "",
  "Record, in reading order:",
  "- every word, abbreviation, heading, margin note, arrow label and stray symbol",
  "- every formula, exactly as written, using unicode math (∂ Σ η ŷ × ÷ ≈ → ⇒ √ ² ₃)",
  "- every table, with its real headers and every row",
  "- every diagram: what kind it is, each node and its label, each connection and its",
  "  direction, axis names, axis tick values, plotted points, shaded regions, callouts",
  "- every arrow that links two things on the page, as a from → to relation",
  "- colour coding the author used, and what each colour seems to mean",
  "- checklists, numbered items, and any 'to cover later' lists",
  "",
  "Return ONLY JSON with this shape:",
  '{"page_title":string,"subject":string,"text_blocks":[string],"formulas":[{"expr":string,"context":string}],',
  '"tables":[{"caption":string,"headers":[string],"rows":[[string]]}],',
  '"diagrams":[{"name":string,"kind":string,"description":string,"nodes":[string],"edges":[string],"axes":string,"annotations":[string]}],',
  '"relations":[string],"colour_legend":[{"colour":string,"meaning":string}],"margin_notes":[string],"open_items":[string]}',
  "Prefer too much detail over too little. No prose outside the JSON.",
].join("\n");

const P_ARCHITECT = [
  "You are Architect, a textbook editor. You receive a raw transcription of messy notes and",
  "rebuild it as a premium study sheet: same information, far better order and clarity.",
  "",
  "Rules:",
  "1. Teach in a logical order — what it is, the moving parts, the maths, the loop, the summary.",
  "   Do NOT copy the physical layout of the original page.",
  "2. Every single item from the transcription must land somewhere. Nothing is dropped.",
  "3. Each section gets a short plain-English intro (2-4 sentences) BEFORE any bullets.",
  "   Explain the idea to someone meeting it for the first time.",
  "4. Give every concept that is spatial, sequential, comparative or numeric a figure.",
  "   Aim for one figure per major section. Figure specs must be concrete enough to draw",
  "   without seeing the original: name the nodes, the edges, the axis ranges, the labels.",
  "5. Formulas use unicode math only, never LaTeX, never backslashes.",
  "6. Emphasis markers inside any text: **bold** and __highlight__. No other markup.",
  "7. Colours must be one of: violet, rose, emerald, amber, sky, slate. Vary them across sections.",
  "8. figure.kind is one of: network, flowchart, pipeline, graph, cycle, comparison, hierarchy,",
  "   anatomy, matrix, timeline.",
  "",
  "Return ONLY JSON:",
  '{"doc_title":string,"subtitle":string,',
  '"legend":[{"symbol":string,"meaning":string,"color":string}],',
  '"sections":[{"id":string,"number":number,"title":string,"color":string,"intro":string,',
  '  "bullets":[string],',
  '  "figures":[{"fig_id":string,"kind":string,"title":string,"caption":string,"spec":string}],',
  '  "table":{"caption":string,"headers":[string],"rows":[[string]]}|null,',
  '  "formulas":[{"expr":string,"note":string}],',
  '  "callout":{"style":"info"|"tip"|"warn","title":string,"items":[string]}|null}],',
  '"summary_cards":[{"n":number,"title":string,"body":string,"color":string}],',
  '"workflow":{"title":string,"steps":[{"label":string,"detail":string}],"loop_note":string},',
  '"remember":string,',
  '"coverage":[{"source_item":string,"mapped_to":string}]}',
  "",
  "THE SHEET HAS A FIXED ANATOMY. Every one of these must be present and non-empty —",
  "a sheet missing any of them is incomplete, and empty fields are the most common failure:",
  "  · doc_title  — the topic, then a dash, then \"Complete Notes\"",
  "  · subtitle   — one line saying what the reader will be able to do afterwards",
  "  · legend     — 3 to 5 chips for the shorthand used on the page (\"epoch → FP + BP\",",
  "                 \"f → Theory\", \"m → Math\"). If the page has no shorthand, make chips from",
  "                 the key symbols instead. Never return an empty legend.",
  "  · sections   — 6 to 9, each NUMBERED from 1, each with its own colour, each with an intro",
  "                 AND at least one of: a figure, a table, or formulas. A section that is only",
  "                 bullets is a wasted section.",
  "  · the FIRST section must carry a callout of style \"info\" titled like \"What happens here?\"",
  "                 with 3 to 5 numbered items walking through the process end to end.",
  "  · summary_cards — exactly 6, numbered 1 to 6, one per key component, each a different colour.",
  "                 Title is the component, body is two short sentences: what it does, then an example.",
  "  · workflow   — 4 to 6 steps that chain the whole topic together, plus a loop_note describing",
  "                 what repeats (\"repeat for many epochs until loss is minimum\").",
  "  · remember   — one sentence a student could recite before an exam.",
  "",
  "Figures carry the sheet. Give the FIRST or SECOND section a figure of kind \"network\",",
  "\"anatomy\" or \"pipeline\" showing the structure being taught, and the workflow section a",
  "\"flowchart\". Where the notes plot anything against anything, that is a \"graph\" figure with",
  "real axis ranges and the key point marked.",
  "",
  "6 to 9 sections. 4 to 6 workflow steps. No prose outside the JSON.",
].join("\n");

const P_AUDITOR_TAIL = [
  "",
  "Also check the sheet's anatomy and repair it in the same pass:",
  "- legend must have 3 to 5 chips; summary_cards must have exactly 6; workflow must have 4 to 6",
  "  steps and a loop_note; remember must be one sentence. Fill anything empty from the content",
  "  you already have — do not invent facts, but do write the connective tissue.",
  "- every section must be numbered and have at least one figure, table or formula.",
  "- the first section must have an \"info\" callout walking through the process.",
].join("\n");

const P_AUDITOR = [
  "You are Auditor. You are given (A) the raw transcription of the original notes and",
  "(B) the study-sheet outline built from it. Find everything in A that is missing,",
  "wrong, or reduced to a stub in B — a formula, a table row, an arrow, a margin note,",
  "a diagram detail, a numbered item. Then return a corrected outline.",
  "",
  "Repair rules: add missing content into the most relevant existing section, or add a new",
  "section if it truly does not fit. Keep every id, fig_id and the existing schema intact.",
  "Do not delete anything that is already correct. Do not rewrite good prose for style.",
  "",
  'Return ONLY JSON: {"missing_items":[string],"notes":string,"patched_outline":{...full outline, same schema...}}',
].join("\n");

const P_DRAFTSMAN = [
  "You are Draftsman, a technical illustrator. You output ONE clean, self-contained SVG",
  "for the figure spec you are given. Textbook quality, not decorative.",
  "",
  "Hard rules:",
  '- Root must be <svg viewBox="0 0 W H" xmlns="http://www.w3.org/2000/svg" width="100%"> with no height attribute.',
  "  Pick W between 760 and 1000 and a height that fits the content without crowding.",
  "- No external images, no <script>, no <foreignObject>, no CSS classes, no web fonts.",
  '- Style with attributes only. font-family="Kalam, Comic Sans MS, cursive".',
  "- Colours ONLY from: " + Object.entries(PALETTE).map(([k, v]) => k + " " + v).join(", ") + ".",
  "  Neutrals allowed: #ffffff, #fbfaf6, #e6e2d8, #2b2b3a, #6b7280.",
  "- Arrows: define a <marker> in <defs> and give its id the prefix you are handed, so ids",
  "  never collide with other figures on the page. Reference it with marker-end.",
  "- Do NOT draw the figure's title inside the SVG — the page prints it above the figure.",
  "- Label every node, every axis, and every edge that carries meaning. Font size 13-16 for labels,",
  "  14-15 for group headings inside the drawing, 11-12 for tick marks.",
  "- Keep 24px of padding inside the viewBox. Text must never overlap a shape or another label.",
  "- Estimate text width as roughly 0.55 × font-size per character and size boxes to fit.",
  "- Use text-anchor=\"middle\" for centred labels and dominant-baseline=\"middle\" for vertical centring.",
  "",
  'Return ONLY JSON: {"svg":"<svg ...>...</svg>"}. Nothing else.',
].join("\n");

const P_EDITOR = [
  "You are Editor. You receive a study-sheet outline JSON and one revision request from the",
  "reader. Apply the request faithfully, change nothing else, and keep the schema and all ids.",
  "If the request needs a new figure, add it with a fresh fig_id and a full spec.",
  'Return ONLY JSON: {"patched_outline":{...},"changelog":[string]}',
].join("\n");

/* ------------------------------- helpers --------------------------------- */

function shrinkImage(dataUrl, maxEdge = 1500, quality = 0.85) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      res(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
}

function extractJSON(text) {
  if (!text) throw new Error("Empty model response");
  let s = String(text).trim();
  const F = "\u0060\u0060\u0060"; // fenced block, if the model added one
  const fence = s.indexOf(F);
  if (fence !== -1) {
    const end = s.indexOf(F, fence + 3);
    if (end !== -1) s = s.slice(fence + 3, end).replace(/^json\s*/i, "");
  }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("No JSON object in response");
  const body = s.slice(a, b + 1);
  try {
    return JSON.parse(body);
  } catch (e) {
    return JSON.parse(body.replace(/,\s*([}\]])/g, "$1").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ----------------------------- providers --------------------------------- */
/*  Model IDs rot fast — Groq killed Llama-4 Scout/Maverick and the 3.x Llama
    text models inside six months. So nothing here is load-bearing: `seed` is
    only a first guess, the app lists live models on connect, and a decommission
    error triggers an automatic re-pick. Add a provider by adding a row.        */

const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    dialect: "gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    keyUrl: "https://aistudio.google.com/apikey",
    envVar: "GEMINI_API_KEY",
    vision: true,
    note: "Free tier, no card. Strongest on messy handwriting.",
    seed: { vision: "gemini-3.5-flash", text: "gemini-3.5-flash" },
    prefer: [/flash(?!.*lite)/i, /flash/i, /pro/i],
  },
  openrouter: {
    label: "OpenRouter",
    dialect: "openai",
    base: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    envVar: "OPENROUTER_API_KEY",
    vision: true,
    note: "Dozens of :free models behind one key. 50 req/day free.",
    seed: { vision: "google/gemma-4-31b-it:free", text: "openrouter/free" },
    prefer: [/:free$/i],
    freeOnly: true,
  },
  groq: {
    label: "Groq",
    dialect: "openai",
    base: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    envVar: "GROQ_API_KEY",
    vision: true,
    note: "Fastest text inference. Vision lineup changes often.",
    seed: { vision: "qwen/qwen3.6-27b", text: "openai/gpt-oss-120b" },
    prefer: [/gpt-oss-120b/i, /qwen/i],
  },
  mistral: {
    label: "Mistral",
    dialect: "openai",
    base: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    envVar: "MISTRAL_API_KEY",
    vision: true,
    note: "Free experiment tier. Pixtral reads documents well.",
    seed: { vision: "pixtral-12b-latest", text: "mistral-small-latest" },
    prefer: [/pixtral/i, /small/i],
  },
  ocr: {
    label: "On-device OCR (no key)",
    dialect: "ocr",
    vision: true,
    textCapable: false,
    note: "Runs in your browser, costs nothing. Reads text only — it cannot describe diagrams.",
    seed: { vision: "tesseract", text: "" },
  },
  custom: {
    label: "Custom OpenAI-compatible",
    dialect: "openai",
    base: "",
    keyUrl: "",
    envVar: "CUSTOM_API_KEY",
    vision: true,
    note: "Ollama, LM Studio, Together, Cerebras, DeepInfra — any /v1 endpoint.",
    seed: { vision: "", text: "" },
    prefer: [],
  },
};

const VISION_PROVIDERS = Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].vision);
const TEXT_PROVIDERS = Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].textCapable !== false);

const DEAD_MODEL = /decommission|deprecat|not_found|does not exist|no longer|invalid.*model|model_not/i;

/* ------------------------------ transport -------------------------------- */


function buildRequest(p, base, key, { model, system, user, images = [], json, temperature, maxTokens }) {
  if (p.dialect === "gemini") {
    const parts = [];
    if (user) parts.push({ text: user });
    for (const img of images) {
      const comma = img.indexOf(",");
      parts.push({
        inline_data: {
          mime_type: (img.slice(0, comma).match(/data:([^;]+)/) || [])[1] || "image/jpeg",
          data: img.slice(comma + 1),
        },
      });
    }
    return {
      url: base + "/models/" + model + ":generateContent",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(json ? { responseMimeType: "application/json" } : {}),
        },
      },
    };
  }

  const content = [];
  if (user) content.push({ type: "text", text: user });
  for (const url of images) content.push({ type: "image_url", image_url: { url } });
  return {
    url: base + "/chat/completions",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: images.length ? content : user },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    },
  };
}

function parseResponse(p, data) {
  if (p.dialect === "gemini") {
    const cand = data.candidates?.[0];
    if (!cand && data.promptFeedback?.blockReason) throw new Error("Blocked: " + data.promptFeedback.blockReason);
    return {
      text: (cand?.content?.parts || []).map((x) => x.text || "").join(""),
      usage: { total_tokens: data.usageMetadata?.totalTokenCount || 0 },
    };
  }
  return { text: data.choices?.[0]?.message?.content ?? "", usage: data.usage || {} };
}

/**
 * One call, three transport modes:
 *   proxy  → POST /api/llm, key never leaves the server (Vercel deploy)
 *   direct → browser talks to the provider with a pasted key (local dev)
 * Retries 429/5xx with backoff. Throws a tagged error on a dead model so the
 * caller can re-pick and try again.
 */
async function callLLM({ provider, base, key, proxy, signal, ...opts }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error("Unknown provider " + provider);

  const endpoint = (base || p.base || "").replace(/\/+$/, "");
  if (!proxy && !endpoint) throw new Error(p.label + " needs a base URL");
  if (!proxy && !key) throw new Error(p.label + " needs an API key");

  const req = proxy
    ? {
        url: "/api/llm",
        headers: { "Content-Type": "application/json" },
        body: { provider, base: endpoint, ...opts },
      }
    : buildRequest(p, endpoint, key, opts);

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(req.url, {
        method: "POST",
        signal,
        headers: req.headers,
        body: JSON.stringify(req.body),
      });

      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 1500 * Math.pow(2, attempt);
        lastErr = new Error(p.label + " is rate limited (" + res.status + ")");
        if (attempt === 3) break;
        await sleep(Math.min(wait, 25000));
        continue;
      }

      const raw = await res.text();
      if (!res.ok) {
        const err = new Error(p.label + " " + res.status + ": " + raw.slice(0, 300));
        if (DEAD_MODEL.test(raw)) err.deadModel = true;
        throw err;
      }

      const data = JSON.parse(raw);
      if (proxy && data.error) throw new Error(data.error);
      return parseResponse(p, proxy ? data.raw : data);
    } catch (err) {
      if (err.name === "AbortError" || err.deadModel) throw err;
      lastErr = err;
      if (attempt === 3) break;
      await sleep(1200 * Math.pow(2, attempt));
    }
  }
  throw lastErr || new Error(p.label + " request failed");
}

/** Ask the provider what it actually serves today. */
async function listModels({ provider, base, key, proxy }) {
  const p = PROVIDERS[provider];
  if (!p || p.dialect === "ocr") return [];
  const endpoint = (base || p.base || "").replace(/\/+$/, "");

  if (proxy) {
    const r = await fetch("/api/llm?list=1&provider=" + provider + "&base=" + encodeURIComponent(endpoint));
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d.models || [];
  }

  if (p.dialect === "gemini") {
    const r = await fetch(endpoint + "/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ""), vision: true, free: true }));
  }

  const r = await fetch(endpoint + "/models", { headers: key ? { Authorization: "Bearer " + key } : {} });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error).slice(0, 200));
  return (d.data || []).map((m) => ({
    id: m.id,
    // OpenRouter exposes modalities and pricing; other providers don't, so assume capable.
    vision: m.architecture ? (m.architecture.input_modalities || []).includes("image") : true,
    free: m.pricing ? Number(m.pricing.prompt) === 0 : true,
  }));
}

/** Choose the best available model for a slot, honouring the provider's prefs. */
function pickModel(provider, models, slot, current) {
  const p = PROVIDERS[provider] || {};
  let pool = models;
  if (slot === "vision") pool = pool.filter((m) => m.vision);
  if (p.freeOnly) {
    const free = pool.filter((m) => m.free);
    if (free.length) pool = free;
  }
  if (!pool.length) return current || p.seed?.[slot] || "";
  if (current && pool.some((m) => m.id === current)) return current;
  for (const rx of p.prefer || []) {
    const hit = pool.find((m) => rx.test(m.id));
    if (hit) return hit.id;
  }
  return pool[0].id;
}

/* ------------------------- on-device OCR fallback ------------------------- */
/*  No key, no network, no cost. It reads block text and whiteboard printing
    well and cursive poorly, and it cannot see diagrams — the Architect gets
    text only. Loaded from a CDN so it never enters your bundle unless used.  */


const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** **bold** and __highlight__ only. Everything else is escaped. */
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, '<mark class="nb-hl">$1</mark>');
}

function cleanSVG(svg, prefix) {
  if (!svg || typeof svg !== "string") return "";
  let s = svg.trim();
  const a = s.indexOf("<svg");
  const b = s.lastIndexOf("</svg>");
  if (a === -1 || b === -1) return "";
  s = s.slice(a, b + 6);
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");

  // namespace ids so several figures can share one page without collisions
  s = s.replace(/\bid="([^"]+)"/g, (m, id) => 'id="' + prefix + "-" + id + '"');
  s = s.replace(/url\(#([^)]+)\)/g, (m, id) => "url(#" + prefix + "-" + id + ")");
  s = s.replace(/(xlink:href|href)="#([^"]+)"/g, (m, at, id) => at + '="#' + prefix + "-" + id + '"');

  // rewrite ONLY the opening <svg …> tag so the figure scales to its container
  const close = s.indexOf(">");
  let open = s.slice(0, close + 1);
  const rest = s.slice(close + 1);
  open = open.replace(/\s(width|height)\s*=\s*"[^"]*"/gi, "");
  if (!/viewBox=/i.test(open)) return ""; // unusable without a viewBox
  if (!/xmlns=/.test(open)) open = open.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  open = open.replace("<svg", '<svg width="100%"');
  return open + rest;
}

const safeColor = (c) => (COLOR_KEYS.includes(c) ? c : "slate");

/* --------------------------- the sheet stylesheet ------------------------- */

// @import must be the first rule in a stylesheet, so it is kept separate and
// always concatenated ahead of everything else.

const FONT_IMPORT =
  "@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&family=Kalam:wght@300;400;700&display=swap');\n";

const SHEET_CSS = `
.nb-sheet{
  --ink:#2b2b3a; --muted:#6b7280; --paper:#fffdf7; --rule:#e6e2d8;
  --violet:${PALETTE.violet}; --rose:${PALETTE.rose}; --emerald:${PALETTE.emerald};
  --amber:${PALETTE.amber}; --sky:${PALETTE.sky}; --slate:${PALETTE.slate};
  background:var(--paper); color:var(--ink);
  font-family:'Kalam','Comic Sans MS',cursive; font-size:16px; line-height:1.6;
  padding:38px 34px 44px; max-width:1080px; margin:0 auto;
  background-image:linear-gradient(#f0ece0 1px,transparent 1px);
  background-size:100% 30px; background-position:0 -1px;
}
.nb-sheet *{box-sizing:border-box}
.nb-sheet h1,.nb-sheet h2,.nb-sheet h3{font-family:'Caveat','Kalam',cursive; margin:0; font-weight:700; letter-spacing:.2px}

.nb-head{border-bottom:3px solid var(--violet); padding-bottom:12px; margin-bottom:8px}
.nb-title{font-size:42px; color:var(--violet); line-height:1.05}
.nb-sub{font-size:16px; color:var(--muted); margin-top:4px; font-style:italic}
.nb-legend{display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 22px}
.nb-chip{border:1.5px solid currentColor; border-radius:8px; padding:3px 11px; font-size:14px; background:#fff}
.nb-chip b{font-weight:700}

.nb-card{border:1.5px solid var(--rule); border-radius:14px; background:#fff;
  padding:20px 22px 22px; margin:0 0 20px; box-shadow:0 1px 0 rgba(43,43,58,.05)}
.nb-card-h{display:flex; align-items:center; gap:10px; margin-bottom:10px}
.nb-num{flex:none; width:28px; height:28px; border-radius:9px; display:grid; place-items:center;
  font-family:'Caveat',cursive; font-size:19px; font-weight:700; color:#fff}
.nb-card-t{font-size:26px}
.nb-intro{margin:0 0 12px; color:#3a3a4a}
.nb-ul{margin:8px 0 0; padding-left:20px}
.nb-ul li{margin:4px 0}
.nb-ul li::marker{color:var(--muted)}

.nb-hl{background:linear-gradient(transparent 58%, #ffe9a8 58%); color:inherit; padding:0 1px}
.nb-sheet strong{font-weight:700}

.nb-fig{margin:16px 0 6px; border:1.5px dashed var(--rule); border-radius:12px;
  background:#fdfcf8; padding:14px 12px 8px}
.nb-fig-t{font-family:'Caveat',cursive; font-size:20px; text-align:center; margin-bottom:6px}
.nb-fig svg{display:block; width:100%; height:auto; max-width:100%}
.nb-cap{font-size:13.5px; color:var(--muted); text-align:center; margin:8px 4px 2px; font-style:italic}
.nb-fig-missing{padding:26px; text-align:center; color:var(--muted); font-size:14px}

.nb-formula{border:1.5px dashed var(--emerald); background:#ecfdf5; border-radius:10px;
  padding:12px 16px; margin:12px 0}
.nb-formula .fx{font-family:'Kalam',cursive; font-size:20px; color:#065f46; text-align:center}
.nb-formula .fn{font-size:14px; color:#3f6b5c; text-align:center; margin-top:6px}

.nb-callout{border:1.5px dashed var(--sky); background:#f3f9ff; border-radius:12px; padding:14px 18px; margin:14px 0}
.nb-callout.tip{border-color:var(--emerald); background:#f0fdf7}
.nb-callout.warn{border-color:var(--rose); background:#fff5f7}
.nb-callout h4{margin:0 0 6px; font-family:'Caveat',cursive; font-size:20px; color:var(--sky)}
.nb-callout.tip h4{color:var(--emerald)} .nb-callout.warn h4{color:var(--rose)}
.nb-callout ol{margin:0; padding-left:20px} .nb-callout li{margin:3px 0}

.nb-table-wrap{overflow-x:auto; margin:14px 0}
.nb-table{border-collapse:collapse; width:100%; font-size:15px; background:#fff}
.nb-table th,.nb-table td{border:1px solid var(--rule); padding:7px 12px; text-align:left}
.nb-table th{background:#faf7ef; font-weight:700}
.nb-table caption{caption-side:bottom; font-size:13px; color:var(--muted); padding-top:6px; font-style:italic}

.nb-grid{display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); margin-top:6px}
.nb-mini{border:1.5px solid currentColor; border-radius:12px; padding:13px 15px; background:#fff}
.nb-mini .t{font-family:'Caveat',cursive; font-size:19px; display:flex; align-items:center; gap:7px}
.nb-mini .t i{font-style:normal; border:1.5px solid currentColor; border-radius:50%; width:22px; height:22px;
  display:grid; place-items:center; font-size:13px; font-family:'Kalam',cursive}
.nb-mini p{margin:6px 0 0; color:#3a3a4a; font-size:14.5px}

.nb-flow{display:grid; grid-template-columns:repeat(auto-fit,minmax(178px,1fr)); gap:12px; margin:14px 0 4px}
.nb-step{border:1.5px solid var(--rule); border-radius:12px; padding:12px 14px 13px; background:#fff;
  position:relative; border-top:3px solid var(--violet)}
.nb-step .n{font-family:'Kalam',cursive; font-size:11px; letter-spacing:1.2px; color:var(--muted)}
.nb-step .s{font-family:'Caveat',cursive; font-size:19px; color:var(--violet); line-height:1.2; margin-top:1px}
.nb-step p{margin:5px 0 0; font-size:14px; color:#4a4a58; line-height:1.5}
.nb-loop{margin-top:14px; text-align:center; font-size:14.5px; color:var(--violet)}

.nb-remember{margin-top:22px; border:1.5px solid var(--amber); border-left:6px solid var(--amber);
  background:#fffaeb; border-radius:12px; padding:14px 18px; font-size:16px}
.nb-remember b{font-family:'Caveat',cursive; font-size:20px; color:var(--amber); margin-right:8px}
.nb-foot{margin-top:16px; font-size:12px; color:#9aa0ab; text-align:right}

@media print{
  .nb-sheet{padding:0; background:#fff; background-image:none; max-width:none}
  .nb-card{break-inside:avoid; page-break-inside:avoid}
  .nb-fig{break-inside:avoid}
}
@media (max-width:640px){
  .nb-sheet{padding:20px 14px; font-size:15px}
  .nb-title{font-size:32px} .nb-card-t{font-size:22px}
  .nb-arrow{flex-basis:100%; height:22px; transform:rotate(90deg)}
}
`;

/* --------------------------- deterministic composer ----------------------- */

function renderSheet(outline, svgMap) {
  if (!outline) return "";
  const O = outline;
  const out = [];

  out.push('<article class="nb-sheet">');

  out.push('<header class="nb-head">');
  out.push('<h1 class="nb-title">' + esc(O.doc_title || "Study Sheet") + "</h1>");
  if (O.subtitle) out.push('<div class="nb-sub">' + esc(O.subtitle) + "</div>");
  out.push("</header>");

  if (Array.isArray(O.legend) && O.legend.length) {
    out.push('<div class="nb-legend">');
    for (const l of O.legend) {
      const c = PALETTE[safeColor(l.color)];
      out.push(
        '<span class="nb-chip" style="color:' + c + '"><b>' + esc(l.symbol) + "</b> — " + esc(l.meaning) + "</span>"
      );
    }
    out.push("</div>");
  }

  (O.sections || []).forEach((s, si) => {
    const key = safeColor(s.color);
    const c = PALETTE[key];
    out.push('<section class="nb-card" style="border-top:4px solid ' + c + '">');
    out.push('<div class="nb-card-h">');
    out.push('<span class="nb-num" style="background:' + c + '">' + (s.number || si + 1) + "</span>");
    out.push('<h2 class="nb-card-t" style="color:' + c + '">' + esc(s.title) + "</h2>");
    out.push("</div>");

    if (s.intro) out.push('<p class="nb-intro">' + inline(s.intro) + "</p>");

    if (Array.isArray(s.bullets) && s.bullets.length) {
      out.push('<ul class="nb-ul">' + s.bullets.map((b) => "<li>" + inline(b) + "</li>").join("") + "</ul>");
    }

    (s.figures || []).forEach((f) => {
      const svg = svgMap[f.fig_id];
      out.push('<figure class="nb-fig">');
      if (f.title) out.push('<div class="nb-fig-t" style="color:' + c + '">' + esc(f.title) + "</div>");
      out.push(svg ? svg : '<div class="nb-fig-missing">Figure not drawn — rerun the Draftsman for ' + esc(f.fig_id) + "</div>");
      if (f.caption) out.push('<figcaption class="nb-cap">' + inline(f.caption) + "</figcaption>");
      out.push("</figure>");
    });

    if (s.table && Array.isArray(s.table.headers) && s.table.headers.length) {
      out.push('<div class="nb-table-wrap"><table class="nb-table">');
      if (s.table.caption) out.push("<caption>" + esc(s.table.caption) + "</caption>");
      out.push("<thead><tr>" + s.table.headers.map((h) => "<th>" + esc(h) + "</th>").join("") + "</tr></thead><tbody>");
      (s.table.rows || []).forEach((r) => {
        out.push("<tr>" + (r || []).map((d) => "<td>" + inline(d) + "</td>").join("") + "</tr>");
      });
      out.push("</tbody></table></div>");
    }

    (s.formulas || []).forEach((f) => {
      out.push('<div class="nb-formula"><div class="fx">' + esc(f.expr) + "</div>");
      if (f.note) out.push('<div class="fn">' + inline(f.note) + "</div>");
      out.push("</div>");
    });

    if (s.callout && Array.isArray(s.callout.items) && s.callout.items.length) {
      const st = ["info", "tip", "warn"].includes(s.callout.style) ? s.callout.style : "info";
      out.push('<div class="nb-callout ' + st + '">');
      if (s.callout.title) out.push("<h4>" + esc(s.callout.title) + "</h4>");
      out.push("<ol>" + s.callout.items.map((i) => "<li>" + inline(i) + "</li>").join("") + "</ol>");
      out.push("</div>");
    }

    out.push("</section>");
  });

  if (Array.isArray(O.summary_cards) && O.summary_cards.length) {
    out.push('<section class="nb-card" style="border-top:4px solid ' + PALETTE.slate + '">');
    out.push(
      '<div class="nb-card-h"><span class="nb-num" style="background:' +
        PALETTE.slate +
        '">∑</span><h2 class="nb-card-t" style="color:' +
        PALETTE.slate +
        '">Key components at a glance</h2></div>'
    );
    out.push('<div class="nb-grid">');
    O.summary_cards.forEach((k, i) => {
      const c = PALETTE[safeColor(k.color)];
      const t = PALETTE_TINT[safeColor(k.color)];
      out.push(
        '<div class="nb-mini" style="color:' +
          c +
          ";background:" +
          t +
          '"><div class="t"><i>' +
          (k.n || i + 1) +
          "</i>" +
          esc(k.title) +
          '</div><p style="color:#3a3a4a">' +
          inline(k.body) +
          "</p></div>"
      );
    });
    out.push("</div></section>");
  }

  if (O.workflow && Array.isArray(O.workflow.steps) && O.workflow.steps.length) {
    out.push('<section class="nb-card" style="border-top:4px solid ' + PALETTE.violet + '">');
    out.push(
      '<div class="nb-card-h"><span class="nb-num" style="background:' +
        PALETTE.violet +
        '">→</span><h2 class="nb-card-t" style="color:' +
        PALETTE.violet +
        '">' +
        esc(O.workflow.title || "End-to-end workflow") +
        "</h2></div>"
    );
    out.push('<div class="nb-flow">');
    O.workflow.steps.forEach((st, i) => {
      out.push(
        '<div class="nb-step"><div class="n">STEP ' +
          String(i + 1).padStart(2, "0") +
          '</div><div class="s">' +
          esc(st.label) +
          "</div><p>" +
          inline(st.detail || "") +
          "</p></div>"
      );
    });
    out.push("</div>");
    if (O.workflow.loop_note) out.push('<div class="nb-loop">↻ ' + inline(O.workflow.loop_note) + "</div>");
    out.push("</section>");
  }

  if (O.remember) {
    out.push('<div class="nb-remember"><b>Remember</b>' + inline(O.remember) + "</div>");
  }

  out.push('<div class="nb-foot">Redesigned from handwritten notes · Notes Forge</div>');
  out.push("</article>");
  return out.join("\n");
}

function standaloneHTML(bodyHtml, title) {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + esc(title || "Study Sheet") + "</title>",
    "<style>" + FONT_IMPORT + "body{margin:0;background:#efece3}" + SHEET_CSS + "</style>",
    "</head><body>",
    bodyHtml,
    "</body></html>",
  ].join("\n");
}


function figurePrompt(f) {
  return [
    "Unique id prefix for this figure: " + f.fig_id,
    "Kind: " + f.kind,
    "Title: " + f.title,
    f.sec ? "Section: " + f.sec : "",
    "Draw this:",
    f.spec,
  ]
    .filter(Boolean)
    .join("\n");
}
/* ══════════════════════════════════════════════════════════════════════
   LMS ADAPTER
   ══════════════════════════════════════════════════════════════════════ */

/* Gemini keys live in the same shape as the Groq pool so Settings can
   manage both with one component and rotation works identically. */
export const GEMINI_KEYS_LS = "lms_gemini_keys_v1";

export function forgeLoadKeys() {
  try {
    const arr = JSON.parse(localStorage.getItem(GEMINI_KEYS_LS) || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(k => k && typeof k.key === "string" && k.key.trim())
      .map((k, i) => ({ id: k.id || `g${i}_${k.key.slice(-6)}`, key: k.key.trim(), label: k.label || `Key ${i + 1}` }));
  } catch { return []; }
}
export function forgeSaveKeys(list) {
  try { localStorage.setItem(GEMINI_KEYS_LS, JSON.stringify(list || [])); } catch { }
  try { window.dispatchEvent(new CustomEvent("lms-gemini-keys-changed")); } catch { }
}

/** A key that has hit its quota this minute should not be retried immediately. */
const RESTING = new Map();
const isResting = k => (RESTING.get(k) || 0) > Date.now();
const rest = (k, ms) => RESTING.set(k, Date.now() + ms);

/**
 * One call, tried across every key in the pool. Rotates on rate limits and
 * quota errors the way the Groq engine does, so a class of students sharing
 * a few free keys keeps working.
 */
async function askPooled({ provider, keys, model, signal, ...opts }) {
  const pool = (keys || []).filter(Boolean);
  if (!pool.length) throw new Error(`No ${PROVIDERS[provider]?.label || provider} key — add one in Settings › AI keys.`);
  const live = pool.filter(k => !isResting(k));
  const order = live.length ? live : pool;
  let lastErr = null;
  for (const key of order) {
    try {
      return await callLLM({ provider, key, model, signal, proxy: false, ...opts });
    } catch (e) {
      const m = String(e?.message || "");
      if (e?.name === "AbortError") throw e;
      lastErr = e;
      if (/429|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(m)) { rest(key, 65_000); continue; }
      if (/401|403|API key not valid|PERMISSION_DENIED/i.test(m)) { rest(key, 10 * 60_000); continue; }
      throw e;                       // a real fault, not a key problem
    }
  }
  throw lastErr || new Error("Every key was rate limited — wait a minute and try again.");
}

/* The sheet must teach the day it belongs to, not just echo the photo. */
function lessonContext(topic, subTopics) {
  const t = String(topic || "").trim();
  const s = String(subTopics || "").trim();
  if (!t && !s) return "";
  return [
    "",
    "LESSON CONTEXT — this sheet belongs to a taught session:",
    t ? `Topic: ${t}` : "",
    s ? `Sub-topics that must each appear as their own section, even if the page only hints at them:\n${s}` : "",
    "Use the photo as the source of truth for what was taught. Where it names a method, a scaler,",
    "a loss or a metric without writing the formula, add the formula and define every symbol.",
    "Where a sub-topic above is missing from the page entirely, add a short section for it so the",
    "sheet covers the lesson, and mark that section's `note` field as \"added for completeness\".",
    "",
  ].filter(Boolean).join("\n");
}

/* A prompt can ask for the full anatomy; it cannot guarantee it. This fills
   the structural gaps from content the outline already has, so the sheet is
   never rendered with a missing header strip or an absent summary row. */
const COLORS6 = ["amber", "rose", "sky", "emerald", "violet", "slate"];
function completeOutline(O, topic) {
  const o = { ...(O || {}) };
  const secs = Array.isArray(o.sections) ? o.sections : [];

  o.doc_title = String(o.doc_title || `${topic || "Study"} — Complete Notes`).slice(0, 120);
  if (!o.subtitle) o.subtitle = "Everything from the page, rebuilt in teaching order.";

  o.sections = secs.map((sec, i) => ({
    ...sec,
    number: Number.isFinite(+sec.number) ? +sec.number : i + 1,
    color: COLORS6.includes(sec.color) ? sec.color : COLORS6[i % COLORS6.length],
  }));

  // Chips: fall back to the first formula of each section, which is the
  // shorthand a reader most needs at the top of the page.
  if (!Array.isArray(o.legend) || !o.legend.length) {
    o.legend = o.sections.slice(0, 4)
      .map((sec, i) => {
        const f = (sec.formulas || [])[0];
        const sym = f?.expr || sec.title;
        return sym ? { symbol: String(sym).slice(0, 30), meaning: String(sec.title || "").slice(0, 28), color: COLORS6[i % COLORS6.length] } : null;
      })
      .filter(Boolean);
  }

  // Six summary cards, one per section, so the row is never short.
  if (!Array.isArray(o.summary_cards) || o.summary_cards.length < 3) {
    o.summary_cards = o.sections.slice(0, 6).map((sec, i) => ({
      n: i + 1,
      title: String(sec.title || `Part ${i + 1}`).slice(0, 34),
      body: String(sec.intro || (sec.bullets || [])[0] || "").slice(0, 150),
      color: COLORS6[i % COLORS6.length],
    }));
  }

  if (!o.workflow?.steps?.length) {
    o.workflow = {
      title: "End-to-end workflow",
      steps: o.sections.slice(0, 6).map(sec => ({
        label: String(sec.title || "").slice(0, 28),
        detail: String((sec.bullets || [])[0] || sec.intro || "").slice(0, 90),
      })),
      loop_note: o.workflow?.loop_note || "Repeat until the result stops improving.",
    };
  }

  if (!o.remember) {
    const boxed = o.sections.flatMap(sec => (sec.formulas || []).map(f => f.note)).filter(Boolean)[0];
    o.remember = boxed || String(o.sections[0]?.intro || "").split(/(?<=\.)\s/)[0] || "";
  }
  return o;
}

/**
 * The full five-agent run.
 * @param images     data URLs of the pages
 * @param topic      day.topic
 * @param subTopics  the shared sub-topics field
 * @param keys       { gemini: [...], groq: [...] }
 * @param onStage    ({id, state, note}) for the progress strip
 */
export async function runForge({
  images = [], topic = "", subTopics = "", keys = {}, models = {},
  signal, onStage = () => { },
}) {
  const pages = images.filter(Boolean).slice(0, 6);
  if (!pages.length) throw new Error("Add at least one photo of the notes.");

  // Gemini reads handwriting best and has a real free tier; Groq is the
  // fallback so a course already using it does not need a second key.
  const vision = keys.gemini?.length ? "gemini" : "groq";
  const text = keys.gemini?.length ? "gemini" : "groq";
  const vModel = models.vision || PROVIDERS[vision].seed.vision;
  const tModel = models.text || PROVIDERS[text].seed.text;
  const mark = (id, state, note) => onStage({ id, state, note });

  const askV = (o) => askPooled({ provider: vision, keys: keys[vision], model: vModel, signal, ...o });
  const askT = (o) => askPooled({ provider: text, keys: keys[text], model: tModel, signal, ...o });

  /* 1 — Scribe: read every mark, page by page */
  mark("scribe", "run", `reading ${pages.length} page${pages.length > 1 ? "s" : ""}`);
  const shrunk = await Promise.all(pages.map(p => shrinkImage(p, 1500, 0.85).catch(() => p)));
  const scans = await mapWithLimit(shrunk, 2, async (img, i) => {
    const r = await askV({
      system: P_SCRIBE,
      user: `Transcribe page ${i + 1} of ${shrunk.length}. Miss nothing.`,
      images: [img], json: true, temperature: 0.1, maxTokens: 8000,
    });
    return extractJSON(r.text);
  });
  const transcript = JSON.stringify(scans.length === 1 ? scans[0] : { pages: scans });
  const captured = scans.reduce((n, s) => n +
    (s.text_blocks?.length || 0) + (s.formulas?.length || 0) +
    (s.diagrams?.length || 0) + (s.tables?.length || 0), 0);
  mark("scribe", "done", `${captured} items captured`);

  /* 2 — Architect: rebuild it as a teaching document */
  mark("architect", "run", "rebuilding the flow");
  const ctx = lessonContext(topic, subTopics);
  const arch = await askT({
    system: P_ARCHITECT + ctx,
    user: ctx + "TRANSCRIPTION:\n" + transcript,
    json: true, temperature: 0.35, maxTokens: 12000,
  });
  let plan = extractJSON(arch.text);
  if (!plan?.sections?.length) throw new Error("The architect produced no sections — try again.");
  mark("architect", "done", `${plan.sections.length} sections`);

  /* 3 — Auditor: nothing from the page may be lost. Advisory only. */
  mark("auditor", "run", "checking coverage");
  let missing = [];
  try {
    const aud = await askT({
      system: P_AUDITOR + P_AUDITOR_TAIL,
      user: "TRANSCRIPTION:\n" + transcript + "\n\nOUTLINE:\n" + JSON.stringify(plan),
      json: true, temperature: 0.2, maxTokens: 12000,
    });
    const rep = extractJSON(aud.text);
    if (rep.patched_outline?.sections?.length) plan = rep.patched_outline;
    missing = rep.missing_items || [];
    mark("auditor", "done", `${missing.length} gaps repaired`);
  } catch (e) {
    mark("auditor", "warn", "skipped");
  }

  // Numbering and colours must be settled before figures are drawn, so the
  // figure prompts see the same section titles the sheet will show.
  plan = completeOutline(plan, topic);

  /* 4 — Draftsman: one real SVG per figure */
  const figs = (plan.sections || []).flatMap(s => (s.figures || []).map(f => ({ ...f, sec: s.title })));
  mark("draftsman", "run", `0/${figs.length}`);
  const svgMap = {};
  let done = 0;
  await mapWithLimit(figs, 3, async (f) => {
    try {
      const r = await askT({
        system: P_DRAFTSMAN, user: figurePrompt(f),
        json: true, temperature: 0.25, maxTokens: 7000,
      });
      const svg = cleanSVG(extractJSON(r.text).svg, f.fig_id);
      if (svg) svgMap[f.fig_id] = svg;
    } catch { /* one failed figure must not lose the sheet */ }
    finally { mark("draftsman", "run", `${++done}/${figs.length}`); }
  });
  mark("draftsman", "done", `${Object.keys(svgMap).length}/${figs.length} drawn`);

  plan = completeOutline(plan, topic);
  mark("composer", "done", "sheet typeset");
  return {
    outline: plan, svgMap, missing,
    topic, subTopics,
    figures: Object.keys(svgMap).length,
    builtAt: Date.now(), v: 1,
  };
}

/** Revise an existing sheet from a plain-English request. */
export async function reviseForge({ sheet, request, keys = {}, models = {}, signal }) {
  const provider = keys.gemini?.length ? "gemini" : "groq";
  const r = await askPooled({
    provider, keys: keys[provider], model: models.text || PROVIDERS[provider].seed.text, signal,
    system: P_EDITOR,
    user: "OUTLINE:\n" + JSON.stringify(sheet.outline) + "\n\nREQUEST:\n" + String(request).slice(0, 600),
    json: true, temperature: 0.3, maxTokens: 12000,
  });
  const d = extractJSON(r.text);
  if (!d?.patched_outline?.sections?.length) throw new Error("The editor returned nothing usable.");
  return { ...sheet, outline: d.patched_outline, changelog: d.changelog || [], builtAt: Date.now() };
}

/** The sheet as one self-contained HTML file — opens offline, no egress. */
export function forgeHTML(sheet, title) {
  // Normalise at render time too. A sheet stored before this existed, or one
  // from a run that stopped early, would otherwise render with gaps.
  const O = completeOutline(sheet.outline, title || sheet.topic);
  return standaloneHTML(renderSheet(O, sheet.svgMap || {}), title || O.doc_title || "Study sheet");
}

export { PROVIDERS as FORGE_PROVIDERS, listModels as forgeListModels, renderSheet as forgeRenderSheet, AGENTS as FORGE_AGENTS };

/* Shared with LMS_Studio.jsx so the visual-notes engine reuses ONE transport,
   ONE key pool and ONE rotation policy instead of growing a second copy that
   drifts out of step the first time a provider changes a model id. */
export {
  askPooled as forgeAsk,
  extractJSON as forgeExtractJSON,
  shrinkImage as forgeShrinkImage,
  mapWithLimit as forgeMapWithLimit,
  cleanSVG as forgeCleanSVG,
  P_SCRIBE as FORGE_P_SCRIBE,
};

/* ══════════════════════════════════════════════════════════════════════
   UI — the sheet viewer, and the Gemini key manager for Settings
   ══════════════════════════════════════════════════════════════════════ */
const fmono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

/** Renders a finished sheet in an isolated iframe so its CSS cannot leak
 *  into the LMS, and offers the offline copy. */
export function ForgeSheetView({ sheet, darkMode, canDownload, downloadsLocked, dayNum, notify }) {
  const ref = useRef(null);
  const html = useMemo(
    () => (sheet?.outline ? forgeHTML(sheet, sheet.outline?.title) : ""),
    [sheet?.builtAt, sheet?.outline, sheet?.svgMap]
  );

  useEffect(() => {
    const f = ref.current;
    if (!f || !html) return;
    f.srcdoc = html;
    // Grow the frame to its content so the page scrolls, not the frame.
    const fit = () => {
      try {
        const d = f.contentDocument;
        if (d?.body) f.style.height = Math.max(400, d.body.scrollHeight + 40) + "px";
      } catch { }
    };
    f.addEventListener("load", fit);
    const t = setInterval(fit, 700);
    return () => { f.removeEventListener("load", fit); clearInterval(t); };
  }, [html]);

  function download() {
    if (canDownload && !canDownload()) return;
    const blob = new Blob([html], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Day${dayNum || 1}_study_sheet.html`;
    a.click();
    notify?.(`Sheet saved — ${Math.max(1, Math.round(blob.size / 1024))} KB, opens without internet`);
  }

  if (!sheet?.outline) return null;
  const nFigs = Object.keys(sheet.svgMap || {}).length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "#94a3b8", ...fmono }}>
          Study sheet
        </span>
        <span style={{ fontSize: 11.5, color: "#94a3b8", ...fmono }}>
          {sheet.outline.sections?.length || 0} sections · {nFigs} figure{nFigs === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        {/* Built in the browser from data already loaded, so the lock does
            not apply — it costs nothing to serve. */}
        <button className="lms-btn lms-btn-blue" onClick={download}>Download sheet (HTML)</button>
      </div>
      {sheet.missing?.length > 0 && (
        <div style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 8 }}>
          Auditor recovered {sheet.missing.length} item(s) the first pass had dropped.
        </div>
      )}
      <iframe ref={ref} title="Study sheet" style={{
        width: "100%", border: `1px solid ${darkMode ? "#1e293b" : "#e2e8f0"}`,
        borderRadius: 12, background: "#fff", minHeight: 400, display: "block",
      }} />
    </div>
  );
}

/** Gemini key pool for Settings — same shape and behaviour as the Groq one. */
export function GeminiKeyManager({ darkMode, notify }) {
  const [keys, setKeys] = useState([]);
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState({});

  useEffect(() => {
    const load = () => setKeys(forgeLoadKeys());
    load();
    window.addEventListener("lms-gemini-keys-changed", load);
    return () => window.removeEventListener("lms-gemini-keys-changed", load);
  }, []);

  const commit = list => { forgeSaveKeys(list); setKeys(list); };
  const add = () => {
    const k = draft.trim();
    if (!k) return;
    if (keys.some(x => x.key === k)) { notify?.("That key is already in the pool", "warn"); return; }
    commit([...keys, { id: `g${Date.now()}`, key: k, label: `Key ${keys.length + 1}` }]);
    setDraft("");
    notify?.("Gemini key added");
  };
  const drop = id => commit(keys.filter(k => k.id !== id));
  const mask = k => k.slice(0, 6) + "…" + k.slice(-4);

  const input = {
    flex: 1, minWidth: 0, padding: "8px 11px", borderRadius: 8, fontSize: 13,
    background: darkMode ? "#1e293b" : "#fff", color: darkMode ? "#e2e8f0" : "#1e293b",
    border: `1.5px solid ${darkMode ? "#334155" : "#e2e8f0"}`, outline: "none",
  };

  return (
    <div>
      <div style={{ fontSize: 13, color: darkMode ? "#cbd5e1" : "#475569", lineHeight: 1.6, marginBottom: 10 }}>
        Gemini reads handwriting better than anything else on a free tier, and it is what builds the
        study sheets from uploaded pages. Add several keys and the app rotates through them when one
        hits its per-minute quota. Keys stay in this browser.{" "}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"
          style={{ color: "#3b82f6" }}>Get a free key</a>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          type="password" placeholder="AIza…" style={input} />
        <button className="lms-btn lms-btn-blue" onClick={add} disabled={!draft.trim()}>Add key</button>
      </div>

      {keys.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "#94a3b8" }}>No Gemini keys yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {keys.map((k, i) => (
            <div key={k.id} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 11px", borderRadius: 8,
              border: `1px solid ${darkMode ? "#1e293b" : "#e2e8f0"}`,
              background: darkMode ? "#0f172a" : "#f8fafc",
            }}>
              <span style={{ fontSize: 11, color: "#94a3b8", ...fmono }}>{String(i + 1).padStart(2, "0")}</span>
              <span style={{ fontSize: 12.5, color: darkMode ? "#e2e8f0" : "#1e293b", ...fmono }}>
                {show[k.id] ? k.key : mask(k.key)}
              </span>
              <button onClick={() => setShow(s => ({ ...s, [k.id]: !s[k.id] }))}
                style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 11.5 }}>
                {show[k.id] ? "hide" : "show"}
              </button>
              <div style={{ flex: 1 }} />
              <button onClick={() => drop(k.id)}
                style={{ background: "none", border: "none", color: "#f43f5e", cursor: "pointer", fontSize: 12 }}>
                remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
