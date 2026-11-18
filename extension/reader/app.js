"use strict";

const $ = (id) => document.getElementById(id);
const IN_EXT = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const BLOCKS = "p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, figcaption";
const ABBR = /(?:\b(?:et al|e\.g|i\.e|cf|vs|Fig|Figs|Eq|Eqs|Sec|Ref|Refs|No|Dr|Mr|Mrs|Ms|Prof|approx|resp)\.|\b[A-Z]\.)\s*$/;
const WPM = 200;
const HAS_TTS = "speechSynthesis" in window;

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const settings = Object.assign({ rate: 1, voice: "", size: 20 }, store.get("fr-settings", {}));
const saveSettings = () => store.set("fr-settings", settings);

let sents = [];
let wordsAfter = [];
let idx = 0;
let docId = "";
let speaking = false;
let speakToken = 0;
let voices = [];

// ====================== parsing ======================

function splitSentences(text) {
  let seg;
  try {
    seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
  } catch {
    return [text];
  }
  const out = [];
  let pending = null;
  for (const s of seg.segment(text)) {
    const start = pending ?? s.index;
    const end = s.index + s.segment.length;
    if (ABBR.test(text.slice(start, end))) {
      pending = start;
      continue;
    }
    pending = null;
    out.push(text.slice(start, end).trim());
  }
  if (pending !== null) out.push(text.slice(pending).trim());
  return out.filter(Boolean);
}

const clean = (t) => t.replace(/\s+/g, " ").trim();

function htmlToBlocks(doc) {
  doc.querySelectorAll("script, style, noscript, nav, footer, aside, form, svg").forEach((n) => n.remove());
  let root = doc.body || doc.documentElement;
  let best = 0;
  for (const c of doc.querySelectorAll("article, main, [role='main']")) {
    if (c.textContent.length > best) {
      best = c.textContent.length;
      if (best > 500) root = c;
    }
  }
  const blocks = [];
  for (const el of root.querySelectorAll(BLOCKS)) {
    if (el.querySelector(BLOCKS)) continue;
    const text = clean(el.textContent);
    if (text) blocks.push({ h: /^H\d$/.test(el.tagName), text });
  }
  if (!blocks.length) return textToBlocks(root.textContent, false);
  return blocks;
}

function textToBlocks(raw, md) {
  const text = raw.replace(/\r/g, "");
  let chunks = text.split(/\n\s*\n/);
  if (chunks.length < 3 && text.split("\n").length > 5) chunks = text.split("\n");
  const blocks = [];
  for (const chunk of chunks) {
    const parts = md && /^\s*(?:[-*+]|\d+\.)\s/m.test(chunk) ? chunk.split("\n") : [chunk];
    for (let p of parts) {
      p = p.trim();
      if (!p) continue;
      let h = false;
      if (md) {
        if (/^(```|---+$|===+$)/.test(p)) continue;
        const m = /^#{1,6}\s+(.*)$/.exec(p);
        if (m) {
          h = true;
          p = m[1];
        }
        p = p
          .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/^\s*(?:[-*+]|\d+\.|>)\s+/gm, "")
          .replace(/(\*\*|__|`)/g, "");
      }
      p = clean(p);
      if (p) blocks.push({ h, text: p });
    }
  }
  return blocks;
}

async function parsePdf(buf, progress) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;

  // 1. rebuild visual lines from positioned text fragments
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    progress(`Reading page ${p} of ${pdf.numPages}…`);
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    let cur = null;
    const flush = () => {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = null;
    };
    for (const it of tc.items) {
      if (typeof it.str !== "string") continue;
      const x = it.transform[4];
      const y = it.transform[5];
      const h = it.height || Math.abs(it.transform[3]) || 10;
      if (cur && Math.abs(y - cur.y) > Math.max(h, cur.h || h) * 0.9) flush();
      if (!cur) cur = { text: "", x, y, h: 0, page: p, xEnd: x };
      if (cur.text && x - cur.xEnd > h * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += " ";
      cur.text += it.str;
      if (it.str.trim()) cur.h = Math.max(cur.h, h);
      cur.xEnd = x + (it.width || 0);
      if (it.hasEOL) flush();
    }
    flush();
    page.cleanup();
  }
  if (lines.reduce((n, l) => n + l.text.length, 0) < 20) {
    throw new Error("This PDF has no selectable text. It may be a scan, which isn't supported yet.");
  }

  // 2. find the body font size and the usual line spacing
  const sizes = new Map();
  for (const l of lines) {
    const k = Math.round(l.h * 2) / 2;
    sizes.set(k, (sizes.get(k) || 0) + l.text.length);
  }
  const bodyH = [...sizes].sort((a, b) => b[1] - a[1])[0][0];
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (lines[i].page === lines[i - 1].page && g > 0 && g < bodyH * 4) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const lineGap = gaps.length ? gaps[gaps.length >> 1] : bodyH * 1.2;

  // 3. merge lines into paragraphs and headings
  const endsSentence = (t) => /[.!?:;]["”’)\]]?\s*$/.test(t);
  const blocks = [];
  let para = null;
  let prev = null;
  const push = () => {
    if (para) blocks.push({ h: para.h, text: clean(para.text) });
    para = null;
  };
  for (const l of lines) {
    const t = l.text.trim();
    if (/^\d{1,4}$/.test(t)) continue; // page numbers
    const isH = l.h > bodyH * 1.15 && t.length < 150;
    let brk = !para || isH !== para.h;
    if (!brk) {
      const gap = prev.y - l.y;
      if (l.page !== prev.page || gap < 0) brk = endsSentence(prev.text);
      else if (gap > lineGap * 1.4) brk = true;
      else if (l.x - prev.x > bodyH * 0.8 && endsSentence(prev.text)) brk = true;
    }
    if (brk) {
      push();
      para = { h: isH, text: t };
    } else if (/[A-Za-z]-$/.test(para.text) && /^[a-z]/.test(t)) {
      para.text = para.text.slice(0, -1) + t; // re-join hyphenated words
    } else {
      para.text += " " + t;
    }
    prev = l;
  }
  push();
  return blocks;
}

async function parseDocx(buf) {
  const { value } = await mammoth.convertToHtml({ arrayBuffer: buf });
  return htmlToBlocks(new DOMParser().parseFromString(value, "text/html"));
}

async function parseEpub(buf, progress) {
  const zip = await JSZip.loadAsync(buf);
  const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
  const container = xml(await zip.file("META-INF/container.xml").async("string"));
  const opfPath = container.querySelector("rootfile").getAttribute("full-path");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opf = xml(await zip.file(opfPath).async("string"));
  const hrefs = {};
  for (const item of opf.querySelectorAll("manifest > item")) hrefs[item.getAttribute("id")] = item.getAttribute("href");
  const spine = [...opf.querySelectorAll("spine > itemref")].map((r) => hrefs[r.getAttribute("idref")]).filter(Boolean);
  const blocks = [];
  for (let i = 0; i < spine.length; i++) {
    progress(`Reading chapter ${i + 1} of ${spine.length}…`);
    const f = zip.file(decodeURIComponent(base + spine[i].split("#")[0]));
    if (!f) continue;
    blocks.push(...htmlToBlocks(new DOMParser().parseFromString(await f.async("string"), "text/html")));
  }
  return blocks;
}

async function parsePptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .map((n) => [n, /^ppt\/slides\/slide(\d+)\.xml$/.exec(n)])
    .filter(([, m]) => m)
    .sort((a, b) => a[1][1] - b[1][1]);
  const blocks = [];
  for (const [name, m] of slides) {
    const doc = new DOMParser().parseFromString(await zip.file(name).async("string"), "application/xml");
    blocks.push({ h: true, text: `Slide ${m[1]}` });
    for (const p of doc.getElementsByTagName("a:p")) {
      const text = clean([...p.getElementsByTagName("a:t")].map((t) => t.textContent).join(""));
      if (text) blocks.push({ h: false, text });
    }
  }
  return blocks;
}

const isPdfBytes = (buf) => new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(5, buf.byteLength))) === "%PDF-";

async function parse(buf, ext, progress) {
  const text = () => new TextDecoder().decode(buf);
  if (ext === "pdf" || isPdfBytes(buf)) return parsePdf(buf, progress);
  if (ext === "docx") return parseDocx(buf);
  if (ext === "epub") return parseEpub(buf, progress);
  if (ext === "pptx") return parsePptx(buf);
  if (ext === "html" || ext === "htm") return htmlToBlocks(new DOMParser().parseFromString(text(), "text/html"));
  if (ext === "md" || ext === "markdown") return textToBlocks(text(), true);
  if (["doc", "ppt", "rtf", "pages", "odt"].includes(ext)) {
    throw new Error(`.${ext} files aren't supported yet. Save it as PDF or .docx and drop that in.`);
  }
  const t = text();
  if (/\u0000/.test(t.slice(0, 2000))) throw new Error("That file type isn't supported yet.");
  return textToBlocks(t, false);
}

// ====================== loading ======================

function status(msg, isError) {
  $("status").textContent = msg || "";
  $("status").classList.toggle("error", !!isError);
}

async function load(title, getBlocks) {
  stopSpeaking();
  showLanding();
  status("Opening…");
  try {
    const blocks = await getBlocks();
    if (!blocks.length) throw new Error("Couldn't find any readable text in that.");
    render(title, blocks);
    status("");
  } catch (err) {
    console.error(err);
    status(err.message || "Something went wrong opening that.", true);
  }
}

function openFile(file) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  const title = dot > 0 ? file.name.slice(0, dot) : file.name;
  return load(title, async () => parse(await file.arrayBuffer(), ext, status));
}

function openUrl(url) {
  let title = url;
  return load(url, async () => {
    status("Fetching…");
    let res;
    try {
      res = await fetch(url);
    } catch {
      throw new Error("Couldn't fetch that link. If it's a file on your computer, drop it here instead.");
    }
    if (!res.ok) throw new Error(`That link returned an error (${res.status}).`);
    const buf = await res.arrayBuffer();
    const type = res.headers.get("content-type") || "";
    if (type.includes("pdf") || isPdfBytes(buf)) return parsePdf(buf, status);
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(buf), "text/html");
    title = doc.title || url;
    return htmlToBlocks(doc);
  }).then(() => {
    if (!$("reader").hidden) {
      $("doc-title").textContent = title;
      $("doc").querySelector("h1").textContent = title;
    }
  });
}

// ====================== reader ======================

function render(title, blocks) {
  const frag = document.createDocumentFragment();
  const h1 = document.createElement("h1");
  h1.textContent = title;
  frag.appendChild(h1);
  sents = [];
  for (const b of blocks) {
    const el = document.createElement(b.h ? "h2" : "p");
    for (const s of b.h ? [b.text] : splitSentences(b.text)) {
      const span = document.createElement("span");
      span.className = "s";
      span.textContent = s;
      span.dataset.i = sents.length;
      sents.push(span);
      el.append(span, " ");
    }
    frag.appendChild(el);
  }
  $("doc").replaceChildren(frag);

  wordsAfter = new Array(sents.length).fill(0);
  let total = 0;
  for (let i = sents.length - 1; i >= 0; i--) {
    wordsAfter[i] = total;
    total += sents[i].textContent.split(/\s+/).length;
  }

  docId = `${title}:${sents.length}`;
  $("doc-title").textContent = title;
  $("landing").hidden = true;
  $("reader").hidden = false;
  $("bar").hidden = false;
  $("new").hidden = false;
  window.scrollTo(0, 0);
  show(Math.min(store.get("fr-pos:" + docId, 0), sents.length - 1));
}

function showLanding() {
  $("landing").hidden = false;
  $("reader").hidden = true;
  $("bar").hidden = true;
  $("new").hidden = true;
  $("doc-title").textContent = "";
  sents = [];
}

function show(i) {
  if (!sents.length) return;
  sents[idx]?.classList.remove("cur");
  idx = Math.max(0, Math.min(sents.length - 1, i));
  const el = sents[idx];
  el.classList.add("cur");

  const r = el.getBoundingClientRect();
  const h = window.innerHeight;
  if (r.top < h * 0.2 || r.bottom > h * 0.65) {
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollBy({ top: r.top + r.height / 2 - h * 0.4, behavior: calm ? "auto" : "smooth" });
  }

  const mins = Math.ceil(wordsAfter[idx] / WPM);
  $("progress").textContent = `${idx + 1} / ${sents.length} · ` + (mins ? `~${mins} min left` : "last bit");
  store.set("fr-pos:" + docId, idx);
}

function go(i) {
  show(i);
  if (speaking) speak();
}

// ====================== voice ======================

function buildVoiceList() {
  const sel = $("voice");
  voices = HAS_TTS ? speechSynthesis.getVoices() : [];
  sel.replaceChildren();
  if (!voices.length) {
    sel.append(new Option(HAS_TTS ? "Loading voices…" : "No voices in this browser", ""));
    return;
  }
  sel.append(new Option("Default voice", ""));

  let names;
  try {
    names = new Intl.DisplayNames([navigator.language || "en"], { type: "language" });
  } catch {}
  const groups = new Map();
  for (const v of voices) {
    const lang = (v.lang || "").replace("_", "-");
    if (!groups.has(lang)) groups.set(lang, []);
    groups.get(lang).push(v);
  }
  const label = (lang) => {
    try {
      return names.of(lang) || lang;
    } catch {
      return lang || "Other";
    }
  };
  const first = ["en-US", "en-GB", "en-IN", "en-AU"];
  const rank = (lang) => {
    const i = first.indexOf(lang);
    return i >= 0 ? i : lang.startsWith("en") ? first.length : first.length + 1;
  };
  const langs = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
  for (const lang of langs) {
    const og = document.createElement("optgroup");
    og.label = label(lang);
    for (const v of groups.get(lang)) og.append(new Option(v.name, v.voiceURI));
    sel.append(og);
  }
  sel.value = voices.some((v) => v.voiceURI === settings.voice) ? settings.voice : "";
}

function speak() {
  if (!HAS_TTS || !sents.length) return;
  const token = ++speakToken;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(sents[idx].textContent);
  const v = voices.find((x) => x.voiceURI === settings.voice);
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  }
  u.rate = settings.rate;
  u.onend = () => {
    if (token !== speakToken || !speaking) return;
    if (idx < sents.length - 1) {
      show(idx + 1);
      speak();
    } else {
      stopSpeaking();
    }
  };
  speechSynthesis.speak(u);
}

function startSpeaking() {
  if (!HAS_TTS) return;
  speaking = true;
  $("play").textContent = "⏸ Pause";
  speak();
}

function stopSpeaking() {
  speaking = false;
  speakToken++;
  if (HAS_TTS) speechSynthesis.cancel();
  $("play").textContent = "▶ Read aloud";
}

const toggleSpeaking = () => (speaking ? stopSpeaking() : startSpeaking());

// ====================== wiring ======================

for (const r of RATES) $("rate").append(new Option(r + "×", r));
$("rate").value = RATES.includes(settings.rate) ? settings.rate : 1;
document.documentElement.style.setProperty("--size", settings.size + "px");
buildVoiceList();
if (HAS_TTS) speechSynthesis.addEventListener("voiceschanged", buildVoiceList);
else $("play").disabled = true;

$("rate").addEventListener("change", (e) => {
  settings.rate = Number(e.target.value);
  saveSettings();
  e.target.blur();
  if (speaking) speak();
});
$("voice").addEventListener("change", (e) => {
  settings.voice = e.target.value;
  saveSettings();
  e.target.blur();
  if (speaking) speak();
});
const resize = (d) => {
  settings.size = Math.max(14, Math.min(34, settings.size + d));
  document.documentElement.style.setProperty("--size", settings.size + "px");
  saveSettings();
};
$("smaller").addEventListener("click", () => resize(-2));
$("bigger").addEventListener("click", () => resize(2));
$("prev").addEventListener("click", () => go(idx - 1));
$("next").addEventListener("click", () => go(idx + 1));
$("play").addEventListener("click", toggleSpeaking);
$("new").addEventListener("click", () => {
  stopSpeaking();
  showLanding();
  status("");
});

$("doc").addEventListener("click", (e) => {
  const s = e.target.closest(".s");
  if (s) go(Number(s.dataset.i));
});

window.addEventListener("keydown", (e) => {
  if ($("reader").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const k = e.key;
  if (k === "ArrowRight" || k === "ArrowDown" || k === "j" || (k === " " && e.target.tagName !== "BUTTON")) go(idx + 1);
  else if (k === "ArrowLeft" || k === "ArrowUp" || k === "k") go(idx - 1);
  else if (k === "s" || k === "S") toggleSpeaking();
  else return;
  e.preventDefault();
});

$("file").addEventListener("change", (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = "";
});
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  $("drop").classList.add("over");
});
window.addEventListener("dragleave", () => $("drop").classList.remove("over"));
window.addEventListener("drop", (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

$("paste-go").addEventListener("click", () => {
  const t = $("paste").value;
  if (t.trim()) load("Pasted text", async () => textToBlocks(t, false));
});

if (IN_EXT) {
  $("url-form").hidden = false;
  $("url-note").textContent = "Files you drop here never leave your device.";
  $("url-form").addEventListener("submit", (e) => {
    e.preventDefault();
    openUrl($("url").value.trim());
  });
  const u = new URLSearchParams(location.search).get("url");
  if (u) openUrl(u);
}

window.addEventListener("pagehide", () => HAS_TTS && speechSynthesis.cancel());
