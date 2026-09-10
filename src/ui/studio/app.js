/* ai-qa studio — the page. Vanilla JS, no build, no dependency: it has to run
   on a client's laptop with nothing installed, and it has to keep running when
   that laptop is offline. Three parts share one small state object:
     canvas   — nodes + edges drawn on a scrollable stage, edited in an inspector
     run      — compile a flow into evd/ and execute it, streaming the log
     chat     — talk to the engine; the server relays engine events over SSE      */
(() => {
  "use strict";
  const BOOT = window.STUDIO;
  const TOKEN = BOOT.token;
  const API = (p) => `/${TOKEN}/api${p}`;
  const SCHEMA = BOOT.schema;
  let STATE = BOOT.state;
  let ENGINES = BOOT.engines;

  const $ = (id) => document.getElementById(id);

  // Theme: follow the machine by default, and remember an explicit choice.
  // Orca is a desktop app that switches with the OS; a browser page sitting
  // beside it that stays white at midnight looks like a different product.
  const THEMES = ["system", "light", "dark"];
  const themeIcon = { system: "◐", light: "☀", dark: "☾" };
  function applyTheme(mode) {
    const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = mode === "dark" || (mode === "system" && sysDark);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const b = document.getElementById("themeBtn");
    if (b) { b.textContent = themeIcon[mode]; b.title = `Theme: ${mode} — click to change`; }
    try { localStorage.setItem("aiqa.theme", mode); } catch { /* private window */ }
  }
  let themeMode = (() => { try { return localStorage.getItem("aiqa.theme") || "system"; } catch { return "system"; } })();
  applyTheme(themeMode);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (themeMode === "system") applyTheme("system"); });
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids) if (kid !== null && kid !== undefined) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const getJSON = async (p) => { const r = await fetch(API(p)); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
  const sendJSON = async (p, body, method = "POST") => {
    const r = await fetch(API(p), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || r.statusText); e.body = j; throw e; } return j;
  };
  /** POST that answers with server-sent events — EventSource cannot POST, so read the stream by hand. */
  async function stream(p, body, onEvent, signal) {
    const r = await fetch(API(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText); }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data) continue;
        try { onEvent(JSON.parse(data)); } catch { /* keep-alive */ }
      }
    }
  }

  // ---- a small markdown renderer: enough for REPORT.md, manifests and chat -----
  function md(src) {
    const lines = String(src || "").replace(/\r/g, "").split("\n");
    const out = []; let i = 0; let para = [];
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) { flush(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre>${esc(buf.join("\n"))}</pre>`); continue; }
      const h = l.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flush(); let t = inline(h[2]); t = t.replace(/\b(PASS|FAIL|PARTIAL|NEW-BUG|BLOCKED|UNCLEAR)\b/, (m) => `<span class="verdict-${m}">${m}</span>`); out.push(`<h${h[1].length}>${t}</h${h[1].length}>`); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(l)) {
        flush(); const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
        const [head, ...rest] = body;
        out.push("<table><thead><tr>" + cells(head).map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
          rest.map((r) => "<tr>" + cells(r).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>");
        continue;
      }
      if (/^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l)) {
        flush(); const ordered = /^\s*\d+\./.test(l); const items = [];
        while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) items.push(lines[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`); continue;
      }
      if (/^\s*<!--/.test(l)) { i++; continue; }
      if (!l.trim()) { flush(); i++; continue; }
      const kv = l.match(/^([A-Z][A-Z_-]{1,20}):\s*(.*)$/);
      if (kv) { flush(); out.push(`<p><b>${esc(kv[1])}:</b> ${inline(kv[2])}</p>`); i++; continue; }
      para.push(l); i++;
    }
    flush();
    return `<div class="md">${out.join("\n")}</div>`;
  }

  // ---------------------------------------------------------------------------
  // top bar
  // ---------------------------------------------------------------------------
  const ticketInput = $("ticket");
  function fillTop() {
    $("projName").textContent = `${STATE.project.name} · ${STATE.project.key}-nnn`;
    $("ticketList").replaceChildren(...STATE.tickets.map((t) => el("option", { value: t })));
    const envSel = $("envSel");
    envSel.replaceChildren(...(STATE.environments.names.length ? STATE.environments.names : [""]).map((n) => el("option", { value: n, selected: n === STATE.environments.active }, n || "(app.url)")));
    $("writesBadge").hidden = STATE.environments.writes !== "forbidden";
    const engSel = $("engineSel");
    engSel.replaceChildren(...ENGINES.map((e) => el("option", { value: e.id, disabled: !e.available, title: e.reason }, `${e.available ? "" : "· "}${e.label}`)));
    const firstOk = ENGINES.find((e) => e.available);
    if (firstOk && !ENGINES.find((e) => e.id === engSel.value && e.available)) engSel.value = firstOk.id;
  }
  $("envSel").addEventListener("change", async (e) => { const r = await sendJSON("/env", { name: e.target.value }); STATE = r.state; fillTop(); });
  ticketInput.addEventListener("change", () => { flow.ticket = ticketInput.value.trim(); scheduleValidate(); scheduleSave(); loadSpecTab(); });

  // ---------------------------------------------------------------------------
  // tabs
  // ---------------------------------------------------------------------------
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  function showTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === `tab-${name}`));
    if (name === "canvas") drawEdges();
    if (name === "spec") loadSpecTab();
  }

  // ---------------------------------------------------------------------------
  // canvas model
  // ---------------------------------------------------------------------------
  let flow = blankFlow();
  let selected = { node: null, edge: null };
  let nextId = 1;
  function blankFlow() { return { version: 1, name: "", title: "", ticket: ticketInput?.value?.trim() || "", kind: "acceptance", case: 1, nodes: [], edges: [] }; }
  const newId = () => { let id; do { id = `n${nextId++}`; } while (flow.nodes.some((n) => n.id === id)); return id; };

  const stage = $("stage"); const canvas = $("canvas"); const svg = $("edges");
  const TYPES = SCHEMA.nodeTypes;

  // A five-step flow is wider than the viewport between the palette and the
  // inspector, and a canvas you can only see two steps of hides the rest —
  // the opposite of why it exists. So the stage scales, and opening a flow
  // fits it. Every pointer coordinate is divided by this, or dragging drifts.
  let zoom = 1;
  function setZoom(z) {
    zoom = Math.min(1, Math.max(0.35, z));
    stage.style.transformOrigin = "0 0";
    stage.style.transform = `scale(${zoom})`;
    $("zoomLabel").textContent = `${Math.round(zoom * 100)}%`;
  }
  function bbox() {
    if (!flow.nodes.length) return null;
    const xs = flow.nodes.map((n) => n.x), ys = flow.nodes.map((n) => n.y);
    return { x: Math.min(...xs), y: Math.min(...ys), r: Math.max(...xs) + 230, b: Math.max(...ys) + 120 };
  }
  /** `min` is the floor the zoom will not go below. Opening a flow uses a
   *  legible floor and lets the canvas scroll; the Fit button asks to see the
   *  whole graph and accepts whatever size that takes. */
  function fitView({ min = 0.35 } = {}) {
    const b = bbox(); if (!b) { setZoom(1); return; }
    const pad = 40;
    const ideal = Math.min(1, (canvas.clientWidth - pad) / (b.r + pad), (canvas.clientHeight - pad) / (b.b + pad));
    setZoom(Math.max(min, ideal));
    canvas.scrollTo({ left: Math.max(0, b.x * zoom - 12), top: Math.max(0, b.y * zoom - 12) });
  }

  function summarize(n) {
    const x = n.data || {};
    switch (n.type) {
      case "actor": return `${x.role || ""}${x.account ? ` (${x.account})` : ""}`;
      case "precondition": return x.text || "";
      case "open": return String(x.path || "").split("\n").filter(Boolean).join(" → ");
      case "click": return x.why || x.selector || "";
      case "type": return `${JSON.stringify(x.value || "")} into ${x.selector || ""}`;
      case "expect": return `${x.what || ""} reads ${JSON.stringify(x.value || "")}${x.cite ? ` — ${x.cite}` : " — NO CITATION"}`;
      case "screenshot": return x.what || "";
      case "api": return `${x.method || "GET"} ${x.path || ""}${x.status ? ` → ${x.status}` : ""}`;
      case "db": return x.name || "";
      case "reload": return x.what || "";
      case "back": return x.what || "";
      case "cleanup": return `${x.how || ""}${x.method && x.path ? ` (${x.method} ${x.path})` : ""}`;
      default: return "";
    }
  }

  function renderPalette() {
    const groups = { who: "Who & where", web: "On the screen", api: "Calls", check: "Checks" };
    const pal = $("palette"); pal.replaceChildren();
    for (const [g, title] of Object.entries(groups)) {
      pal.append(el("h4", {}, title));
      for (const [type, spec] of Object.entries(TYPES)) {
        if (spec.group !== g) continue;
        const item = el("div", { class: "pal-item", title: spec.hint || "", "data-type": type }, el("span", { class: "sw", style: `background:${spec.color}` }), spec.label);
        item.addEventListener("pointerdown", (e) => startPaletteDrag(e, type));
        pal.append(item);
      }
    }
  }

  function renderNodes() {
    stage.querySelectorAll(".node").forEach((n) => n.remove());
    for (const n of flow.nodes) {
      const spec = TYPES[n.type] || { label: n.type, group: "" };
      const body = summarize(n);
      const warn = n.type === "expect" && !(n.data && n.data.cite);
      const div = el("div", { class: `node ${spec.group}${selected.node === n.id ? " on" : ""}`, "data-id": n.id, style: `left:${n.x}px;top:${n.y}px` },
        el("div", { class: "head" }, el("span", {}, spec.label), el("span", { class: "del", title: "Remove step", onclick: (e) => { e.stopPropagation(); removeNode(n.id); } }, "✕")),
        el("div", { class: `body${warn ? " warn" : ""}` }, body || el("span", { class: "muted" }, "click to fill in")),
        el("div", { class: "port in", "data-port": "in" }),
        el("div", { class: "port out", "data-port": "out", title: "Drag to the next step" }));
      div.querySelector(".head").addEventListener("pointerdown", (e) => startNodeDrag(e, n));
      div.querySelector(".body").addEventListener("pointerdown", (e) => startNodeDrag(e, n));
      div.querySelector(".port.out").addEventListener("pointerdown", (e) => startConnect(e, n));
      div.addEventListener("click", (e) => { if (e.target.closest(".port") || e.target.closest(".del")) return; select(n.id, null); });
      stage.append(div);
    }
    drawEdges();
    $("canvasHint").hidden = flow.nodes.length > 0;
  }

  function nodeRect(id) {
    const d = stage.querySelector(`.node[data-id="${id}"]`); if (!d) return null;
    const n = flow.nodes.find((x) => x.id === id);
    return { x: n.x, y: n.y, w: d.offsetWidth, h: d.offsetHeight };
  }
  function edgePath(a, b) {
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  function drawEdges() {
    svg.replaceChildren();
    for (const e of flow.edges) {
      const a = nodeRect(e.from), b = nodeRect(e.to); if (!a || !b) continue;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", edgePath(a, b));
      if (selected.edge && selected.edge.from === e.from && selected.edge.to === e.to) p.classList.add("on");
      p.addEventListener("click", (ev) => { ev.stopPropagation(); select(null, e); });
      svg.append(p);
    }
  }
  function select(nodeId, edge) { selected = { node: nodeId, edge }; renderNodes(); renderInspector(); }
  canvas.addEventListener("click", (e) => { if (e.target === stage || e.target === canvas || e.target === svg) select(null, null); });

  function removeNode(id) {
    flow.nodes = flow.nodes.filter((n) => n.id !== id);
    flow.edges = flow.edges.filter((e) => e.from !== id && e.to !== id);
    if (selected.node === id) selected.node = null;
    renderNodes(); renderInspector(); scheduleValidate(); scheduleSave();
  }
  function addNode(type, x, y) {
    const spec = TYPES[type]; const data = {};
    for (const f of spec.fields) if (f.default !== undefined) data[f.key] = f.default;
    const n = { id: newId(), type, x: Math.max(0, Math.round(x / 10) * 10), y: Math.max(0, Math.round(y / 10) * 10), data };
    flow.nodes.push(n); select(n.id, null); scheduleValidate(); scheduleSave(); return n;
  }
  document.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selected.node) removeNode(selected.node);
      else if (selected.edge) { flow.edges = flow.edges.filter((x) => !(x.from === selected.edge.from && x.to === selected.edge.to)); selected.edge = null; drawEdges(); scheduleValidate(); scheduleSave(); }
    }
  });

  // -- pointer interactions ------------------------------------------------------
  const stagePoint = (e) => { const r = stage.getBoundingClientRect(); return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }; };
  function startNodeDrag(e, n) {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = stagePoint(e); const ox = start.x - n.x, oy = start.y - n.y; let moved = false;
    const div = stage.querySelector(`.node[data-id="${n.id}"]`);
    const move = (ev) => { const p = stagePoint(ev); n.x = Math.max(0, p.x - ox); n.y = Math.max(0, p.y - oy); moved = true; div.style.left = `${n.x}px`; div.style.top = `${n.y}px`; drawEdges(); };
    const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); if (moved) { n.x = Math.round(n.x / 10) * 10; n.y = Math.round(n.y / 10) * 10; renderNodes(); scheduleSave(); } };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }
  function startPaletteDrag(e, type) {
    if (e.button !== 0) return;
    e.preventDefault();
    const ghost = el("div", { class: "pal-item", style: `position:fixed;left:${e.clientX + 6}px;top:${e.clientY + 6}px;pointer-events:none;opacity:.85;z-index:50;width:180px` }, el("span", { class: "sw", style: `background:${TYPES[type].color}` }), TYPES[type].label);
    document.body.append(ghost); let moved = false;
    const move = (ev) => { moved = true; ghost.style.left = `${ev.clientX + 6}px`; ghost.style.top = `${ev.clientY + 6}px`; };
    const up = (ev) => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); ghost.remove();
      const r = canvas.getBoundingClientRect();
      if (moved && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) { const p = stagePoint(ev); addNode(type, p.x - 20, p.y - 16); }
      else if (!moved) addNode(type, canvas.scrollLeft / zoom + 40 + (flow.nodes.length % 3) * 260, canvas.scrollTop / zoom + 40 + Math.floor(flow.nodes.length / 3) * 130);
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }
  function startConnect(e, from) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const a = nodeRect(from.id);
    const temp = document.createElementNS("http://www.w3.org/2000/svg", "path"); temp.classList.add("temp"); svg.append(temp);
    const move = (ev) => { const p = stagePoint(ev); temp.setAttribute("d", edgePath(a, { x: p.x, y: p.y, w: 0, h: 0 })); };
    const up = (ev) => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); temp.remove();
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".node");
      const to = target?.dataset.id;
      if (to && to !== from.id && !flow.edges.some((x) => x.from === from.id && x.to === to)) { flow.edges.push({ from: from.id, to }); drawEdges(); scheduleValidate(); scheduleSave(); }
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }

  // -- layout -------------------------------------------------------------------
  function autoLayout() {
    const ids = flow.nodes.map((n) => n.id); const depth = new Map(ids.map((i) => [i, 0]));
    const kids = new Map(ids.map((i) => [i, []])); const indeg = new Map(ids.map((i) => [i, 0]));
    for (const e of flow.edges) if (kids.has(e.from) && kids.has(e.to)) { kids.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
    const q = ids.filter((i) => indeg.get(i) === 0); const seen = new Set();
    while (q.length) { const i = q.shift(); if (seen.has(i)) continue; seen.add(i); for (const k of kids.get(i)) { depth.set(k, Math.max(depth.get(k), depth.get(i) + 1)); indeg.set(k, indeg.get(k) - 1); if (indeg.get(k) === 0) q.push(k); } }
    const cols = new Map();
    for (const n of flow.nodes) { const d = depth.get(n.id); if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n); }
    for (const [d, list] of cols) { list.sort((a, b) => a.y - b.y); list.forEach((n, i) => { n.x = 40 + d * 280; n.y = 40 + i * 130; }); }
    renderNodes(); fitView({ min: 0.6 }); scheduleSave();
  }
  $("autoLayout").addEventListener("click", autoLayout);
  $("fitView").addEventListener("click", () => fitView({ min: 0.35 }));
  $("zoomIn").addEventListener("click", () => setZoom(zoom + 0.15));
  $("zoomOut").addEventListener("click", () => setZoom(zoom - 0.15));

  // -- inspector ------------------------------------------------------------------
  function renderInspector() {
    const form = $("nodeForm"); form.replaceChildren();
    $("flowName").value = flow.name || ""; $("flowTitle").value = flow.title || ""; $("flowCase").value = flow.case || 1;
    const kindSel = $("flowKind"); if (!kindSel.options.length) kindSel.replaceChildren(...SCHEMA.kinds.map((k) => el("option", { value: k }, k)));
    kindSel.value = flow.kind || "acceptance";
    if (selected.edge) { form.append(el("h4", {}, "Connection"), el("div", { class: "hint" }, `${selected.edge.from} → ${selected.edge.to}. Press Delete to remove it.`)); return; }
    const n = flow.nodes.find((x) => x.id === selected.node);
    if (!n) { form.append(el("div", { class: "muted" }, "Select a step to edit it.")); return; }
    const spec = TYPES[n.type];
    form.append(el("h4", {}, spec.label), spec.hint ? el("div", { class: "hint" }, spec.hint) : null);
    const build = () => {
      form.querySelectorAll("label").forEach((l) => l.remove());
      for (const f of spec.fields) {
        if (f.when && Object.entries(f.when).some(([k, v]) => (n.data[k] ?? "") !== v)) continue;
        let input;
        if (f.kind === "select") input = el("select", {}, ...f.options.map((o) => el("option", { value: o, selected: (n.data[f.key] ?? f.default ?? "") === o }, o || "—")));
        else if (f.kind === "textarea") input = el("textarea", { rows: 3, placeholder: f.placeholder || "" });
        else input = el("input", { placeholder: f.placeholder || "", spellcheck: "false" });
        if (f.kind !== "select") input.value = n.data[f.key] ?? "";
        input.addEventListener("input", () => { n.data[f.key] = input.value; const d = stage.querySelector(`.node[data-id="${n.id}"] .body`); if (d) { d.textContent = summarize(n) || "click to fill in"; d.classList.toggle("warn", n.type === "expect" && !n.data.cite); } scheduleValidate(); scheduleSave(); });
        if (f.kind === "select") input.addEventListener("change", build);
        form.append(el("label", {}, `${f.label}${f.required ? " *" : ""}`, input));
      }
    };
    build();
  }
  for (const [id, key] of [["flowName", "name"], ["flowTitle", "title"], ["flowKind", "kind"], ["flowCase", "case"]]) {
    $(id).addEventListener("input", (e) => { flow[key] = key === "case" ? Number(e.target.value) || 1 : e.target.value.trim(); scheduleValidate(); if (key !== "name") scheduleSave(); });
    if (key === "name") $(id).addEventListener("change", () => scheduleSave());
  }

  // -- validation + save -----------------------------------------------------------
  const scheduleValidate = debounce(async () => {
    const v = await sendJSON("/validate", flow).catch((e) => ({ errors: [e.message], warnings: [] }));
    const box = $("validation"); box.replaceChildren();
    if (!v.errors.length && !v.warnings.length && flow.nodes.length) box.append(el("div", { class: "ok" }, "Compiles. Every check that has a citation can become a defect; the rest report differences."));
    for (const e of v.errors) box.append(el("div", { class: "err" }, e));
    for (const w of v.warnings) box.append(el("div", { class: "warn" }, w));
  }, 250);
  const scheduleSave = debounce(async () => {
    if (!/^[a-z0-9][a-z0-9_-]{0,59}$/.test(flow.name || "")) return;
    try { await sendJSON(`/flows/${flow.name}`, flow, "PUT"); await loadFlows(flow.name); } catch { /* shown on next validate */ }
  }, 600);
  $("saveFlow").addEventListener("click", () => { flow.name = $("flowName").value.trim(); scheduleSave(); scheduleValidate(); });

  async function loadFlows(activeName) {
    const { flows } = await getJSON("/flows");
    const ul = $("flowList"); ul.replaceChildren();
    for (const name of flows) {
      ul.append(el("li", { class: name === activeName ? "on" : "", onclick: () => openFlow(name) }, el("span", {}, name),
        el("span", { class: "del muted", title: "Delete flow", onclick: async (e) => { e.stopPropagation(); if (confirm(`Delete flow "${name}"? Compiled evidence in evd/ stays.`)) { await sendJSON(`/flows/${name}`, {}, "DELETE"); loadFlows(flow.name); } } }, "✕")));
    }
    if (!flows.length) ul.append(el("li", { class: "muted" }, "no flows yet — press + new"));
  }
  async function openFlow(name) {
    const { flow: f } = await getJSON(`/flows/${name}`);
    flow = f; selected = { node: null, edge: null };
    nextId = 1 + Math.max(0, ...flow.nodes.map((n) => Number(String(n.id).replace(/\D/g, "")) || 0));
    if (flow.ticket) ticketInput.value = flow.ticket;
    renderNodes(); renderInspector(); scheduleValidate(); loadFlows(name); showTab("canvas"); fitView({ min: 0.6 });
  }
  $("newFlow").addEventListener("click", () => { flow = blankFlow(); selected = { node: null, edge: null }; renderNodes(); renderInspector(); $("validation").replaceChildren(); loadFlows(null); $("flowName").focus(); });

  // ---------------------------------------------------------------------------
  // compile & run
  // ---------------------------------------------------------------------------
  let runAbort = null;
  function renderSteps(steps, statuses = {}) {
    const box = $("runSteps"); box.replaceChildren();
    for (const s of steps) {
      const st = statuses[s.id] || "";
      const mark = st === "ok" ? "✓" : st === "fail" ? "✗" : st === "blocked" ? "~" : st === "start" ? "▶" : st === "skipped" ? "·" : "○";
      box.append(el("div", { class: `step ${st}`, "data-id": s.id }, el("span", { class: "st" }, mark), el("span", {}, `${s.kind}: ${s.label}`)));
    }
  }
  function renderFiles(files) {
    const box = $("runFiles"); box.replaceChildren();
    for (const [rel, text] of Object.entries(files || {})) box.append(el("details", {}, el("summary", {}, rel), el("pre", {}, text)));
  }
  const logLine = (text, cls) => { const pre = $("runLog"); pre.append(el("span", { class: cls || "" }, text)); pre.scrollTop = pre.scrollHeight; };
  const classify = (l) => /EVIDENCE: GREEN|API: OK|DB: OK|APP: UP|EXPECT: ok|^\s*✓/.test(l) ? "ok" : /EVIDENCE: RED|API: FAIL|EXPECT: FAIL|^\s*x |^\s*✗/.test(l) ? "bad" : /BLOCKED|DOWN|refused|REFUSED/.test(l) ? "amber" : "";
  function setRunStatus(text, cls) { const s = $("runStatus"); s.textContent = text; s.className = `run-status ${cls || ""}`; }

  $("compileBtn").addEventListener("click", async () => {
    showTab("run"); $("runLog").replaceChildren(); setRunStatus("compiling…");
    try {
      const r = await sendJSON("/compile", { flow, caseNo: flow.case });
      renderSteps(r.steps); renderFiles(r.files);
      logLine(`compiled → ${r.caseDir}\n`, "head");
      for (const w of r.warnings || []) logLine(`! ${w}\n`, "amber");
      logLine(`\n${r.gate.text}\n`, r.gate.ok ? "ok" : "");
      setRunStatus(`compiled into ${r.caseDir} — RESULT: BLOCKED until it runs`, "blocked");
      loadEvd();
    } catch (e) {
      setRunStatus("does not compile", "fail");
      for (const m of (e.body?.errors || [e.message])) logLine(`x ${m}\n`, "bad");
    }
  });

  $("runBtn").addEventListener("click", async () => {
    showTab("run"); $("runLog").replaceChildren(); $("runFiles").replaceChildren();
    const statuses = {}; let steps = [];
    runAbort = new AbortController(); $("stopBtn").disabled = false; $("runBtn").disabled = true;
    setRunStatus("running…");
    try {
      await stream("/run", { flow, caseNo: flow.case }, (ev) => {
        if (ev.type === "compiled") { steps = ev.steps; renderSteps(steps); logLine(`compiled → ${ev.caseDir}\n`, "head"); for (const w of ev.warnings || []) logLine(`! ${w}\n`, "amber"); }
        else if (ev.type === "step") { statuses[ev.id] = ev.status; renderSteps(steps, statuses); if (ev.status === "start") logLine(`\n▶ ${ev.label}\n`, "head"); }
        else if (ev.type === "out") { for (const l of String(ev.text).split(/(?<=\n)/)) logLine(l, classify(l)); }
        else if (ev.type === "gate") { logLine(`\n${ev.text}\n`, ev.ok ? "ok" : ""); }
        else if (ev.type === "error") { logLine(`x ${ev.message}\n`, "bad"); }
        else if (ev.type === "done") { setRunStatus(`RESULT: ${ev.result}${ev.caseDir ? ` · ${ev.caseDir}` : ""}`, ev.result === "PASS" ? "pass" : ev.result === "FAIL" ? "fail" : "blocked"); }
      }, runAbort.signal);
    } catch (e) { if (e.name !== "AbortError") { logLine(`x ${e.message}\n`, "bad"); setRunStatus("run failed to start", "fail"); } else setRunStatus("stopped", "blocked"); }
    $("stopBtn").disabled = true; $("runBtn").disabled = false; runAbort = null; loadEvd();
  });
  $("stopBtn").addEventListener("click", () => runAbort?.abort());

  // ---------------------------------------------------------------------------
  // evidence
  // ---------------------------------------------------------------------------
  async function loadEvd() {
    const { tree } = await getJSON("/evd").catch(() => ({ tree: [] }));
    const ul = $("evdTree"); ul.replaceChildren();
    const walk = (items, depth) => {
      for (const it of items) {
        if (it.dir) { ul.append(el("li", { class: `dir${depth ? " indent" : ""}`, style: `padding-left:${8 + depth * 12}px` }, it.name)); walk(it.children, depth + 1); }
        else ul.append(el("li", { style: `padding-left:${8 + depth * 12}px`, onclick: () => openEvidence(it.path) }, el("span", {}, it.name), el("span", { class: "size" }, it.size > 1024 ? `${Math.round(it.size / 1024)}k` : `${it.size}`)));
      }
    };
    walk(tree, 0);
    if (!tree.length) ul.append(el("li", { class: "muted" }, "no evidence yet"));
  }
  async function openEvidence(rel) {
    showTab("evidence");
    const view = $("evdView"); view.replaceChildren(el("div", { class: "muted" }, `loading ${rel}…`));
    const ext = rel.split(".").pop().toLowerCase();
    if (["png", "jpg", "jpeg", "svg"].includes(ext)) { view.replaceChildren(el("h3", {}, rel), el("img", { src: API(`/evd/file?path=${encodeURIComponent(rel)}`), alt: rel })); return; }
    if (ext === "xlsx") { view.replaceChildren(el("h3", {}, rel), el("a", { href: API(`/evd/file?path=${encodeURIComponent(rel)}`) }, "Download the spreadsheet")); return; }
    const r = await fetch(API(`/evd/file?path=${encodeURIComponent(rel)}`)); const text = await r.text();
    view.replaceChildren(el("h3", {}, rel));
    if (ext === "md") view.insertAdjacentHTML("beforeend", md(text)); else view.append(el("pre", {}, text));
  }
  $("refreshEvd").addEventListener("click", loadEvd);
  $("gateBtn").addEventListener("click", async () => {
    const ticket = ticketInput.value.trim(); if (!ticket) return alert("Type a ticket key first.");
    showTab("evidence"); $("evdStatus").textContent = "running evd_check…";
    const g = await sendJSON("/gate", { ticket }).catch((e) => ({ ok: false, text: e.message }));
    $("evdStatus").textContent = g.ok ? "EVIDENCE: GREEN" : "EVIDENCE: RED"; $("evdStatus").className = `run-status ${g.ok ? "pass" : "fail"}`;
    $("evdView").replaceChildren(el("h3", {}, `evd_check — evd/${ticket}`), el("pre", { class: "log" }, g.text));
  });
  $("exportBtn").addEventListener("click", async () => {
    const ticket = ticketInput.value.trim(); if (!ticket) return alert("Type a ticket key first.");
    showTab("evidence"); $("evdStatus").textContent = "exporting…";
    try {
      const r = await sendJSON("/export", { ticket });
      $("evdStatus").textContent = r.file ? "spreadsheet written" : "export finished"; $("evdStatus").className = "run-status";
      $("evdView").replaceChildren(el("h3", {}, "xlsx_export"), el("pre", { class: "log" }, r.text), r.file ? el("p", {}, el("a", { href: API(`/evd/file?path=${encodeURIComponent(r.file)}`) }, `Download ${r.file}`)) : null);
      loadEvd();
    } catch (e) { $("evdStatus").textContent = "BLOCKED"; $("evdStatus").className = "run-status blocked"; $("evdView").replaceChildren(el("pre", { class: "log" }, e.body?.text || e.message)); }
  });

  // ---------------------------------------------------------------------------
  // ticket & spec tab
  // ---------------------------------------------------------------------------
  let specLoadedFor = null;
  async function loadSpecTab() {
    const key = ticketInput.value.trim();
    $("ticketKeyLabel").textContent = key;
    if (key && key !== specLoadedFor) {
      $("ticketDoc").textContent = "fetching from the tracker…";
      try {
        const r = await getJSON(`/ticket?key=${encodeURIComponent(key)}`);
        const t = r.ticket;
        $("ticketDoc").textContent = t ? `${t.title}\nStatus: ${t.status || "?"} · Assignee: ${t.assignee || "—"}\n\n${t.description || ""}` : r.raw;
      } catch (e) { $("ticketDoc").textContent = e.message; }
      specLoadedFor = key;
    }
    if (!$("specDoc").dataset.loaded) {
      const { specs } = await getJSON("/spec").catch(() => ({ specs: [] }));
      const box = $("specDoc"); box.replaceChildren();
      if (!specs.length) box.append(el("div", { class: "muted" }, "oracle.specs is empty in aiqa.config.yaml — without a written spec, every check reports a difference, not a defect."));
      for (const s of specs) { box.append(el("h4", {}, s.path)); box.insertAdjacentHTML("beforeend", s.text === null ? '<p class="muted">file not found</p>' : md(s.text)); }
      box.dataset.loaded = "1";
    }
  }

  // ---------------------------------------------------------------------------
  // chat
  // ---------------------------------------------------------------------------
  const sessions = {};
  let chatAbort = null;
  const messages = $("messages");
  function addMsg(who, cls) { const m = el("div", { class: `msg ${cls}` }, el("div", { class: "who" }, who), el("div", { class: "bubble" })); messages.append(m); messages.scrollTop = messages.scrollHeight; return m.querySelector(".bubble"); }
  async function sendChat(text, opts = {}) {
    const engine = $("engineSel").value;
    if (!ENGINES.find((e) => e.id === engine && e.available)) { addMsg("studio", "assistant").textContent = "No engine is available on this machine — install Claude Code, or set ANTHROPIC_API_KEY, then restart the studio."; return; }
    if (!opts.silentUser) addMsg("you", "user").textContent = text;
    const bubble = addMsg(opts.label || ENGINES.find((e) => e.id === engine).label.split(" (")[0], "assistant");
    let acc = ""; const live = el("div", { style: "white-space:pre-wrap" }); bubble.append(live);
    chatAbort = new AbortController(); $("abortBtn").hidden = false; $("sendBtn").disabled = true;
    let drafted = null;
    try {
      await stream(opts.route || "/chat", { engine, message: text, sessionId: sessions[engine] || null, ...(opts.body || {}) }, (ev) => {
        if (ev.type === "text") { acc += ev.text; live.textContent = acc; messages.scrollTop = messages.scrollHeight; }
        else if (ev.type === "tool") bubble.append(el("div", { class: "tool" }, `▸ ${ev.name}  ${ev.input || ""}`));
        else if (ev.type === "tool_result") bubble.append(el("div", { class: `tool res${ev.error ? " err" : ""}` }, ev.text));
        else if (ev.type === "status") bubble.append(el("div", { class: "status" }, ev.text));
        else if (ev.type === "error") bubble.append(el("div", { class: "tool err" }, ev.message));
        else if (ev.type === "flow") drafted = ev;
        else if (ev.type === "done") {
          if (ev.sessionId && !opts.route) sessions[engine] = ev.sessionId;
          const cost = ev.cost != null ? ` · $${Number(ev.cost).toFixed(3)}` : ev.usage ? ` · ${ev.usage.input}+${ev.usage.output} tokens` : "";
          $("chatMeta").textContent = `${engine}${sessions[engine] ? ` · session ${String(sessions[engine]).slice(0, 8)}` : ""}${cost}`;
        }
      }, chatAbort.signal);
      if (acc) { live.remove(); bubble.insertAdjacentHTML("afterbegin", md(acc)); }
    } catch (e) { bubble.append(el("div", { class: "tool err" }, e.name === "AbortError" ? "stopped" : e.message)); }
    $("abortBtn").hidden = true; $("sendBtn").disabled = false; chatAbort = null;
    loadEvd();
    return drafted;
  }
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); const t = $("chatInput").value.trim(); if (!t) return; $("chatInput").value = ""; sendChat(t); });
  $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("composer").requestSubmit(); } });
  $("abortBtn").addEventListener("click", () => chatAbort?.abort());
  $("newChat").addEventListener("click", () => { delete sessions[$("engineSel").value]; messages.replaceChildren(); $("chatMeta").textContent = "new session"; });
  $("quick").addEventListener("click", (e) => {
    const q = e.target.closest("button")?.dataset.q; if (!q) return;
    const t = ticketInput.value.trim();
    const text = q.replace("{ticket}", t || "<ticket>");
    if (q.includes("{ticket}") && !t) { $("chatInput").value = text; ticketInput.focus(); return; }
    if (q.endsWith(" ")) { $("chatInput").value = text; $("chatInput").focus(); return; }
    sendChat(text);
  });

  $("draftFlow").addEventListener("click", async () => {
    const ticket = ticketInput.value.trim(); if (!ticket) { ticketInput.focus(); return alert("Type a ticket key first — the draft is built from the ticket and the spec."); }
    const name = $("flowName").value.trim() || `${ticket.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${flow.kind}`;
    const surface = [].concat(STATE.project.surfaces).includes("web") ? "web" : "api";
    const drafted = await sendChat(`Draft a ${flow.kind} flow for ${ticket} from the ticket and the specification.`, {
      route: "/draft", body: { ticket, kind: flow.kind, name, surface }, label: "drafting" });
    if (drafted && drafted.flow) {
      const f = drafted.flow; f.nodes = (f.nodes || []).map((n, i) => ({ id: n.id || `n${i + 1}`, type: n.type, x: Number(n.x) || 40, y: Number(n.y) || 40 + i * 130, data: n.data || {} })).filter((n) => TYPES[n.type]);
      f.edges = (f.edges || []).filter((e) => f.nodes.some((n) => n.id === e.from) && f.nodes.some((n) => n.id === e.to));
      f.case = flow.case; flow = f; selected = { node: null, edge: null };
      nextId = 1 + f.nodes.length; autoLayout(); renderInspector(); scheduleValidate(); scheduleSave(); showTab("canvas");
      if (f.notes) addMsg("drafting", "assistant").textContent = `Notes from the draft: ${f.notes}`;
    } else if (drafted) addMsg("studio", "assistant").textContent = "The engine did not return a flow I could read — try again, or build it by hand.";
  });

  // ---------------------------------------------------------------------------
  $("themeBtn").addEventListener("click", () => { themeMode = THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length]; applyTheme(themeMode); });
  fillTop(); renderPalette(); renderInspector(); renderNodes(); setZoom(1); loadFlows(null); loadEvd();
  $("chatMeta").textContent = ENGINES.find((e) => e.available) ? "ready" : "no engine available";
})();
