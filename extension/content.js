(() => {
  if (window.__focusReader) {
    window.__focusReader.toggle();
    return;
  }

  const BLOCKS = "p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, figcaption";
  const SKIP = "nav, footer, aside, [aria-hidden='true'], #focus-reader-hud";
  // Sentence breaks we should NOT trust: "et al.", "Fig.", initials, etc.
  const ABBR = /(?:\b(?:et al|e\.g|i\.e|cf|vs|Fig|Figs|Eq|Eqs|Sec|Ref|Refs|No|Dr|Mr|Mrs|Ms|Prof|approx|resp)\.|\b[A-Z]\.)\s*$/;
  const WPM = 200;
  const POS_KEY = "focus-reader-pos";

  let sentences = [];
  let wordsAfter = [];
  let idx = 0;
  let on = false;
  let speakToken = 0;
  let speaking = false;
  let hud = null;
  let info = null;
  let voices = [];
  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const settings = { rate: 1, voice: "" };
  const saveSettings = () => {
    try {
      chrome.storage.local.set({ frSettings: settings });
    } catch {}
  };

  // ---------- sentence splitting ----------

  function splitSentences(text) {
    const lang = document.documentElement.lang || "en";
    let seg;
    try {
      seg = new Intl.Segmenter(lang, { granularity: "sentence" });
    } catch {
      seg = new Intl.Segmenter("en", { granularity: "sentence" });
    }
    const out = [];
    let pending = null;
    for (const s of seg.segment(text)) {
      const start = pending ?? s.index;
      const end = s.index + s.segment.length;
      if (ABBR.test(text.slice(start, end))) {
        pending = start; // glue onto the next segment
        continue;
      }
      pending = null;
      out.push([start, end]);
    }
    if (pending !== null) out.push([pending, text.length]);

    // trim whitespace off both ends, drop empties
    return out
      .map(([s, e]) => {
        while (s < e && /\s/.test(text[s])) s++;
        while (e > s && /\s/.test(text[e - 1])) e--;
        return [s, e];
      })
      .filter(([s, e]) => e > s);
  }

  function pickRoot() {
    const candidates = [...document.querySelectorAll("article, main, [role='main']")];
    let best = null;
    let bestLen = 0;
    for (const c of candidates) {
      const len = c.textContent.length;
      if (len > bestLen) {
        best = c;
        bestLen = len;
      }
    }
    return bestLen > 500 ? best : document.body;
  }

  function collect() {
    sentences = [];
    const root = pickRoot();
    for (const el of root.querySelectorAll(BLOCKS)) {
      if (el.querySelector(BLOCKS)) continue; // only leaf blocks
      if (el.closest(SKIP)) continue;
      if (!el.getClientRects().length) continue; // hidden
      const text = el.textContent;
      if (text.trim().length < 2) continue;

      // map character offsets in textContent back to text nodes
      const nodes = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let pos = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n, start: pos });
        pos += n.data.length;
      }
      if (!nodes.length) continue;

      const locate = (offset, isEnd) => {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const { node, start } = nodes[i];
          if (offset > start || (!isEnd && offset === start)) {
            return [node, Math.min(offset - start, node.data.length)];
          }
        }
        return [nodes[0].node, 0];
      };

      for (const [s, e] of splitSentences(text)) {
        const range = document.createRange();
        range.setStart(...locate(s, false));
        range.setEnd(...locate(e, true));
        sentences.push({ range, text: text.slice(s, e) });
      }
    }

    // words remaining after each sentence, for the time estimate
    wordsAfter = new Array(sentences.length).fill(0);
    let total = 0;
    for (let i = sentences.length - 1; i >= 0; i--) {
      wordsAfter[i] = total;
      total += sentences[i].text.split(/\s+/).length;
    }
  }

  // ---------- display ----------

  function injectStyle() {
    if (document.getElementById("focus-reader-style")) return;
    const style = document.createElement("style");
    style.id = "focus-reader-style";
    style.textContent = `
      html.focus-reader-on :is(${BLOCKS}),
      html.focus-reader-on :is(${BLOCKS}) * {
        color: rgba(127, 127, 127, 0.45) !important;
      }
      ::highlight(focus-reader) {
        color: #111;
        background-color: #ffe9a8;
      }
      #focus-reader-hud {
        position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
        z-index: 2147483647;
        font: 13px/1.4 system-ui, sans-serif;
        color: #fff !important; background: rgba(20, 20, 20, 0.88);
        padding: 6px 14px; border-radius: 999px;
        display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px 12px;
        max-width: calc(100vw - 20px); width: max-content;
      }
      #focus-reader-hud b { color: #fff !important; font-weight: 600; white-space: nowrap; }
      #focus-reader-hud span, #focus-reader-hud label { color: #bbb !important; white-space: nowrap; }
      #focus-reader-hud select {
        font: inherit; color: #fff !important; background: #333; border: 1px solid #666;
        border-radius: 6px; padding: 1px 4px; max-width: 170px; margin: 0;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function show(i, { scroll = true } = {}) {
    if (!sentences.length) return;
    idx = Math.max(0, Math.min(sentences.length - 1, i));
    const { range } = sentences[idx];
    CSS.highlights.set("focus-reader", new Highlight(range));

    if (scroll) {
      const r = range.getBoundingClientRect();
      const h = window.innerHeight;
      // only move the page when the sentence drifts out of the comfortable band
      if (r.top < h * 0.2 || r.bottom > h * 0.7) {
        const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollBy({
          top: r.top + r.height / 2 - h * 0.4,
          behavior: calm ? "auto" : "smooth",
        });
      }
    }

    const mins = Math.ceil(wordsAfter[idx] / WPM);
    info.textContent =
      `${idx + 1} / ${sentences.length} · ` +
      (mins ? `~${mins} min left` : "last bit") +
      (speaking ? " · 🔊" : "");

    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ path: location.pathname, idx }));
    } catch {}
  }

  // ---------- read aloud ----------

  function speak() {
    const token = ++speakToken;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(sentences[idx].text);
    u.lang = document.documentElement.lang || "en";
    const v = voices.find((x) => x.voiceURI === settings.voice);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = settings.rate;
    u.onend = () => {
      if (token !== speakToken || !speaking) return;
      if (idx < sentences.length - 1) {
        show(idx + 1);
        speak();
      } else {
        stopSpeaking();
      }
    };
    speechSynthesis.speak(u);
  }

  function stopSpeaking() {
    speaking = false;
    speakToken++;
    speechSynthesis.cancel();
    if (on) show(idx, { scroll: false });
  }

  function go(i) {
    show(i);
    if (speaking) speak();
  }

  // ---------- input ----------

  function onKey(e) {
    if (!on || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof Element && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

    const k = e.key;
    if (k === "ArrowRight" || k === "ArrowDown" || k === " " || k === "j") go(idx + 1);
    else if (k === "ArrowLeft" || k === "ArrowUp" || k === "k") go(idx - 1);
    else if (k === "s" || k === "S") {
      if (speaking) stopSpeaking();
      else {
        speaking = true;
        show(idx, { scroll: false });
        speak();
      }
    } else if (k === "Escape") turnOff();
    else return;

    e.preventDefault();
    e.stopPropagation();
  }

  function onClick(e) {
    if (!on || e.target.closest?.("#focus-reader-hud")) return;
    const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!caret) return;
    const hit = sentences.findIndex(({ range }) => {
      try {
        return range.comparePoint(caret.startContainer, caret.startOffset) === 0;
      } catch {
        return false;
      }
    });
    if (hit >= 0) go(hit);
  }

  // ---------- speed and voice controls ----------

  function buildVoices(sel) {
    voices = speechSynthesis.getVoices();
    sel.replaceChildren(new Option(voices.length ? "Default voice" : "Loading voices…", ""));
    let names;
    try {
      names = new Intl.DisplayNames([navigator.language || "en"], { type: "language" });
    } catch {}
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
    const groups = new Map();
    for (const v of voices) {
      const lang = (v.lang || "").replace("_", "-");
      if (!groups.has(lang)) groups.set(lang, []);
      groups.get(lang).push(v);
    }
    const langs = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
    for (const lang of langs) {
      const og = document.createElement("optgroup");
      og.label = label(lang);
      for (const v of groups.get(lang)) og.append(new Option(v.name, v.voiceURI));
      sel.append(og);
    }
    sel.value = voices.some((v) => v.voiceURI === settings.voice) ? settings.voice : "";
  }

  function buildHud() {
    hud = document.createElement("div");
    hud.id = "focus-reader-hud";
    info = document.createElement("b");

    const rate = document.createElement("select");
    for (const r of RATES) rate.append(new Option(r + "×", r));
    rate.value = RATES.includes(settings.rate) ? settings.rate : 1;
    rate.onchange = () => {
      settings.rate = Number(rate.value);
      saveSettings();
      rate.blur();
      if (speaking) speak();
    };

    const voice = document.createElement("select");
    buildVoices(voice);
    speechSynthesis.onvoiceschanged = () => hud && buildVoices(voice);
    voice.onchange = () => {
      settings.voice = voice.value;
      saveSettings();
      voice.blur();
      if (speaking) speak();
    };

    const labelled = (text, el) => {
      const l = document.createElement("label");
      l.append(text + " ", el);
      return l;
    };
    const hint = document.createElement("span");
    hint.textContent = "→ next · ← back · S read aloud · Esc exit";
    hud.append(info, labelled("Speed", rate), labelled("Voice", voice), hint);
    document.documentElement.appendChild(hud);
  }

  // ---------- on / off ----------

  function turnOn() {
    if (!("highlights" in CSS) || !("Segmenter" in Intl)) {
      alert("Focus Reader needs a newer version of Chrome (105+).");
      return;
    }
    injectStyle();
    collect();
    if (!sentences.length) {
      alert("Focus Reader couldn't find readable text on this page.");
      return;
    }
    buildHud();
    document.documentElement.classList.add("focus-reader-on");
    on = true;

    // resume where you left off; otherwise start at the first sentence on screen
    let start = -1;
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (saved && saved.path === location.pathname && saved.idx < sentences.length) start = saved.idx;
    } catch {}
    if (start < 0) {
      start = sentences.findIndex(({ range }) => range.getBoundingClientRect().bottom > 0);
    }
    show(Math.max(0, start));
  }

  function turnOff() {
    on = false;
    stopSpeaking();
    CSS.highlights.delete("focus-reader");
    document.documentElement.classList.remove("focus-reader-on");
    hud?.remove();
    hud = null;
  }

  window.addEventListener("keydown", onKey, true);
  document.addEventListener("click", onClick, true);

  window.__focusReader = { toggle: () => (on ? turnOff() : turnOn()) };
  (async () => {
    try {
      const saved = await chrome.storage.local.get("frSettings");
      Object.assign(settings, saved.frSettings || {});
    } catch {}
    turnOn();
  })();
})();
