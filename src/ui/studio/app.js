/* ai-qa studio — the page. Vanilla JS, no build, no dependency: it has to run
   on a client's laptop with nothing installed, and it has to keep running when
   that laptop is offline.

   The shape is Orca's. One sidebar lists PROJECTS and, under each, its FLOWS
   as cards. The main area is one of three screens:

     home      no project yet → add a folder from this machine, or clone a URL
     project   the project's flows; "+ New flow" asks which AI agent does it
     flow      the work: Agent (chat) · Steps (canvas) · Run · Evidence · Spec

   A flow carries its own agent and its own worktree, so opening one is what
   decides which AI answers and which checkout everything runs in.            */
(() => {
  "use strict";
  const BOOT = window.STUDIO;
  const TOKEN = BOOT.token;
  const API = (p) => `/${TOKEN}/api${p}`;
  const SCHEMA = BOOT.schema;
  let STATE = BOOT.state;
  let ENGINES = BOOT.engines;

  const $ = (id) => document.getElementById(id);

  // ---- theme: follow the machine by default, remember an explicit choice -------
  const THEMES = ["system", "light", "dark"];
  const themeIcon = { system: "◐", light: "☀", dark: "☾" };
  function applyTheme(mode) {
    const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = mode === "dark" || (mode === "system" && sysDark);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const b = $("themeBtn");
    if (b) { b.textContent = themeIcon[mode]; b.title = `Theme: ${mode} — click to change`; }
    try { localStorage.setItem("aiqa.theme", mode); } catch { /* private window */ }
  }
  let themeMode = (() => { try { return localStorage.getItem("aiqa.theme") || "system"; } catch { return "system"; } })();
  applyTheme(themeMode);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (themeMode === "system") applyTheme("system"); });
  $("themeBtn").addEventListener("click", () => { themeMode = THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length]; applyTheme(themeMode); if (TERM) TERM.options.theme = termTheme(); });

  // ---- small helpers --------------------------------------------------------------
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
  const short = (p) => String(p || "").replace(STATE.home || /^\/Users\/[^/]+/, "~");
  const ago = (iso) => {
    if (!iso) return "";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!isFinite(s)) return "";
    if (s < 60) return "just now"; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
  };
  const agentById = (id) => (STATE.agents || []).find((a) => a.id === id) || null;
  const agentLabel = (id) => agentById(id)?.label || id || "no agent";

  // ---- a small markdown renderer: enough for REPORT.md, manifests and chat ------
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
  // app state
  // ---------------------------------------------------------------------------
  let FLOWS = [];                 // summaries of the active project's flows
  let flow = blankFlow();         // the open flow document
  let AGENT = null;               // the resolved agent for the open flow
  let openName = null;            // the open flow's name (null on home/project screens)
  let runningFlow = null;         // a flow whose run is streaming right now
  let specLoadedFor = null;
  const ticketInput = $("ticket");

  function blankFlow() { return { version: 1, name: "", title: "", ticket: "", kind: "acceptance", case: 1, agent: null, worktree: null, nodes: [], edges: [] }; }
  const activeProject = () => STATE.projects?.active || null;

  // ---- screens -----------------------------------------------------------------
  function showScreen(name) {
    for (const s of ["home", "project", "flow"]) $(`scr-${s}`).hidden = s !== name;
    if (name !== "flow") { openName = null; detachTerminal(); }
    renderTree();
  }

  async function refreshState() {
    const r = await getJSON("/state");
    STATE = r.state; ENGINES = r.engines;
    renderTree(); renderBars();
    return STATE;
  }
  async function loadFlows() {
    const r = await getJSON("/flows").catch(() => ({ flows: [] }));
    FLOWS = r.flows || [];
    renderTree(); renderProjectScreen();
    return FLOWS;
  }

  // ---------------------------------------------------------------------------
  // sidebar: projects, and under each its flows as cards
  // ---------------------------------------------------------------------------
  function flowCard(f, { big = false } = {}) {
    const shellOnly = f.agent === "shell";
    const a = shellOnly ? null : agentById(f.agent || activeProject()?.agent);
    const agentId = shellOnly ? null : (f.agent || activeProject()?.agent || STATE.projects?.active?.agentResolved?.id);
    const mainBranch = (STATE.worktrees?.list || []).find((w) => w.isMain)?.branch || "";
    const live = runningFlow === f.name || !!f.terminal?.running;
    const runBtn = el("button", { class: "btn-card-run", title: "Run this test immediately", onclick: async (e) => {
      e.stopPropagation();
      await openFlow(f.name, { autoRun: true });
    } }, "▶ Run");
    const card = el("div", { class: `card${f.name === openName ? " on" : ""}`, title: f.title || f.name, onclick: () => openFlow(f.name) },
      el("div", { class: "l1" },
        el("span", { class: `dot ${live ? "live" : (f.result || "")}` }),
        el("span", { class: "name" }, f.name),
        runBtn,
        big ? el("button", { class: "ghost del", title: "Delete this flow (evidence already in evd/ stays)", onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete flow "${f.name}"?\n\nCompiled evidence in evd/ stays.`)) return;
          await sendJSON(`/flows/${f.name}`, {}, "DELETE"); await loadFlows();
        } }, "✕") : null),
      el("div", { class: "l2" },
        f.ticket ? el("span", { class: "chip ticket" }, f.ticket) : el("span", { class: "chip" }, "no ticket"),
        el("span", { class: "branch" }, f.worktree ? `worktree ${f.worktree}${f.worktreeExists ? "" : " (missing)"}` : (mainBranch || "the project checkout"))),
      el("div", { class: "l3" },
        el("span", { class: `agent ${agentId || ""}${a && !a.installed ? " missing" : ""}` }, shellOnly ? "shell only" : a ? a.label : (agentId || "agent: project default")),
        el("span", { class: "when" }, runningFlow === f.name ? "running…" : f.terminal?.running ? "agent running" : f.result ? `${f.result}${f.ranAt ? ` · ${ago(f.ranAt)}` : ""}` : f.steps ? `${f.steps} steps · not run` : "empty")));
    return card;
  }

  function renderTree() {
    const tree = $("projectTree"); tree.replaceChildren();
    const P = STATE.projects || { list: [], activeId: null };
    for (const p of P.list) {
      const on = p.id === P.activeId;
      const group = el("div", { class: `pj-group${on ? " on open" : ""}` });
      const row = el("div", { class: "pj-row", title: p.path, onclick: () => selectProject(p.id) },
        el("span", { class: "caret" }, on ? "▾" : "▸"),
        el("span", { class: "name" }, p.name),
        el("span", { class: "badge", title: "this project's default AI" }, p.agent ? agentLabel(p.agent) : "AI: auto"),
        el("button", { class: "ghost gear", title: "Project settings", onclick: (e) => { e.stopPropagation(); selectProject(p.id).then(openSettings); } }, "⚙"));
      group.append(row);
      if (on) {
        const flows = el("div", { class: "flows" });
        for (const f of FLOWS) flows.append(flowCard(f));
        flows.append(el("button", { class: "ghost add-flow", onclick: openNewFlow }, "+ New flow"));
        group.append(flows);
      }
      tree.append(group);
    }
    if (!P.list.length) tree.append(el("div", { class: "none" }, "No projects yet. Press + Add, or use the two buttons on the right."));
    const installed = (STATE.agents || []).filter((a) => a.installed);
    $("agentsLine").textContent = installed.length ? `Agents on this machine: ${installed.map((a) => a.label).join(" · ")}` : "No agent CLI found on PATH — install Claude Code, or set ANTHROPIC_API_KEY.";
  }

  async function selectProject(id) {
    if (id !== STATE.projects?.activeId) await sendJSON("/projects/active", { id });
    await refreshState(); await loadFlows(); specLoadedFor = null; $("specDoc").dataset.loaded = "";
    showScreen("project");
  }

  // ---------------------------------------------------------------------------
  // bars: things both the project and the flow screen show
  // ---------------------------------------------------------------------------
  function renderBars() {
    $("ticketList").replaceChildren(...(STATE.tickets || []).map((t) => el("option", { value: t })));
    const envSel = $("envSel");
    envSel.replaceChildren(...(STATE.environments.names.length ? STATE.environments.names : [""]).map((n) => el("option", { value: n, selected: n === STATE.environments.active }, n || "(app.url)")));
    $("writesBadge").hidden = STATE.environments.writes !== "forbidden";
    $("laneChip").hidden = STATE.hasLane !== false;
    renderProjectScreen(); renderFlowBar();
  }
  $("envSel").addEventListener("change", async (e) => { const r = await sendJSON("/env", { name: e.target.value }); STATE = r.state; renderBars(); });

  /** "What this project has" — the answers the Steps tab will ask you for.
   *
   *  Five questions, each with an honest state. A curated list (someone wrote
   *  it down), a file listing read out of the repository (useful, and NOT the
   *  same thing), or missing — which is a real answer, and comes with the
   *  command that fixes it. Nothing here is inferred. */
  const INV_CARDS = [
    { key: "roles",   title: "Who you can be",            q: "Sign in as the role that owns the task — half of all interface defects only appear for one role.",
      line: (x) => [x.role, x.can].filter(Boolean).join(" — ") },
    { key: "screens", title: "What a user can reach",     q: "The places a person can be. A step needs the click path that gets there.",
      line: (x) => [x.name, x.purpose].filter(Boolean).join(" — ") },
    { key: "api",     title: "The API",                   q: "What can be called, and what was promised back.",
      line: (x) => `${x.method} ${x.path}${x.summary ? ` — ${x.summary}` : ""}` },
    { key: "data",    title: "The data",                  q: "A write is verified by reading the row back, and that needs a table.",
      line: (x) => `${x.name}${x.fields?.length ? ` (${x.fields.slice(0, 6).join(", ")}${x.fields.length > 6 ? ", …" : ""})` : ""}` },
    { key: "oracle",  title: "Where 'correct' is written", q: "Without this, a verdict is an opinion — and the report has to say so.",
      line: (x) => `${x.path}${x.exists ? "" : "  ← not on disk"}` },
  ];

  const INV_STATE_WORD = { curated: "written down", config: "from the config", "from-code": "read from the code",
    partial: "incomplete", empty: "declares none", missing: "nobody has said" };

  async function renderInventory() {
    const host = $("inventory");
    if (!host) return;
    let inv = null;
    try { inv = (await getJSON("/inventory")).inventory; } catch { /* offline, or no lane in this checkout */ }
    if (!inv) { host.replaceChildren(); $("invSub").textContent = ""; return; }

    const known = INV_CARDS.filter((c) => inv[c.key]?.items?.length).length;
    $("invSub").textContent = `${known} of ${INV_CARDS.length} answered`;

    host.replaceChildren(...INV_CARDS.map((c) => {
      const sec = inv[c.key] || { state: "missing", items: [], source: "", next: "" };
      const shown = sec.items.slice(0, 12);
      return el("div", { class: "inv" },
        el("h5", {}, c.title),
        el("p", { class: "q" }, c.q),
        el("span", { class: `tag ${sec.state}` }, INV_STATE_WORD[sec.state] || sec.state),
        shown.length ? el("div", { class: "items" }, ...shown.map((x) => el("span", { title: c.line(x) }, c.line(x)))) : null,
        sec.items.length > shown.length ? el("div", { class: "more" }, `… and ${sec.items.length - shown.length} more`) : null,
        sec.source ? el("div", { class: "src" }, sec.source) : null,
        sec.next ? el("div", { class: "next" }, sec.next) : null);
    }));
  }

  function renderProjectScreen() {
    renderInventory();
    const p = activeProject(); if (!p) return;
    const main = (STATE.worktrees?.list || []).find((w) => w.isMain);
    $("pjTitle").textContent = p.name;
    $("pjSub").textContent = `${short(p.path)}${main?.branch ? ` · ${main.branch}` : ""}`;
    const r = p.agentResolved || {};
    $("pjAgentChip").textContent = r.id ? `default AI: ${agentLabel(r.id)}${r.chosen ? "" : " (auto)"}` : "no AI available";
    $("pjAgentChip").className = `chip${r.id && !r.installed ? " warnchip" : ""}`;
    $("laneNotice").hidden = STATE.hasLane !== false || !!STATE.worktrees?.activePath;
    $("flowCount").textContent = FLOWS.length ? `(${FLOWS.length})` : "";
    const cards = $("flowCards"); cards.replaceChildren();
    for (const f of FLOWS) cards.append(flowCard(f, { big: true }));
    $("flowsEmpty").hidden = FLOWS.length > 0;
    $("homeLead").textContent = STATE.projects?.list?.length ? "Select a project from the sidebar to begin." : "Add a project to get started.";
  }

  function renderFlowBar() {
    const p = activeProject(); if (!p || !openName) return;
    $("crumbProject").textContent = p.name;
    $("flowCrumb").textContent = flow.name || "(unnamed)";
    $("flowTicketChip").textContent = flow.ticket || ""; $("flowTicketChip").hidden = !flow.ticket;
    const a = AGENT || {};
    $("flowAgentChip").textContent = a.id ? `${agentLabel(a.id)}${a.chosen ? "" : " (project default)"}` : a.shellOnly ? "shell only" : "no agent";
    $("flowAgentChip").className = `chip${a.id && !a.installed ? " warnchip" : ""}`;
    $("flowAgentChip").title = a.reason || (a.id ? `the terminal types ${agentLabel(a.id)}'s command` : "the terminal opens with nothing typed");
    const W = STATE.worktrees || {};
    $("flowWtChip").textContent = W.activeName ? `worktree ${W.activeName}` : `${(W.list || []).find((w) => w.isMain)?.branch || "checkout"} · ${short(STATE.cwd)}`;
    const sum = FLOWS.find((f) => f.name === openName);
    $("flowResult").textContent = sum?.result ? `RESULT: ${sum.result}` : "";
    $("flowResult").className = `result ${sum?.result || ""}`;
  }
  $("crumbProject").addEventListener("click", (e) => { e.preventDefault(); showScreen("project"); loadFlows(); });
  $("flowQuickRunBtn")?.addEventListener("click", () => {
    showTab("run");
    if (!runningFlow) $("runBtn").click();
  });

  let isRunningAll = false;
  $("runAllBtn")?.addEventListener("click", async () => {
    if (isRunningAll) return;
    if (!FLOWS.length) { alert("No flows yet to run. Click '+ New flow' first."); return; }
    if (!confirm(`Run all ${FLOWS.length} test flow(s) sequentially?`)) return;
    isRunningAll = true;
    $("runAllBtn").textContent = "Running all…";
    $("runAllBtn").disabled = true;
    for (const f of FLOWS) {
      await openFlow(f.name, { autoRun: true });
      while (runningFlow) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    $("runAllBtn").textContent = "▶ Run all flows";
    $("runAllBtn").disabled = false;
    isRunningAll = false;
    await loadFlows();
    showScreen("project");
  });

  // ---------------------------------------------------------------------------
  // dialogs
  // ---------------------------------------------------------------------------
  const dialogs = ["dlgProject", "dlgFlow", "dlgSettings"];
  function openDialog(id) { for (const d of dialogs) $(d).hidden = d !== id; $("scrim").hidden = false; }
  function closeDialogs() { for (const d of dialogs) $(d).hidden = true; $("scrim").hidden = true; }
  $("scrim").addEventListener("click", closeDialogs);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeDialogs));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDialogs(); });

  // -- add a project: a folder here, or a URL to clone -----------------------------
  let pjMode = "folder";
  function setPjMode(mode) {
    pjMode = mode;
    $("pjSource").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.src === mode));
    $("pjFolder").hidden = mode !== "folder"; $("pjUrl").hidden = mode !== "url";
    $("pjAdd").textContent = mode === "folder" ? "Add project" : "Clone and add";
  }
  $("pjSource").addEventListener("click", (e) => { const m = e.target.closest("button")?.dataset.src; if (m) setPjMode(m); });
  function openAddProject(mode = "folder", { url = "" } = {}) {
    setPjMode(mode);
    $("pjProbe").replaceChildren(); $("cloneProbe").replaceChildren(); $("cloneLog").hidden = true; $("cloneLog").textContent = "";
    $("pjCloneUrl").value = url; suggestCloneInto();
    openDialog("dlgProject");
    if (mode === "folder") loadFs($("pjPath").value || STATE.home || "~"); else $("pjCloneUrl").focus();
  }
  $("addProject").addEventListener("click", () => openAddProject("folder"));
  $("homeBrowse").addEventListener("click", () => openAddProject("folder"));
  $("homeCloneForm").addEventListener("submit", (e) => { e.preventDefault(); const u = $("homeCloneUrl").value.trim(); openAddProject("url", { url: u }); if (u) startClone(); });

  async function loadFs(p) {
    const r = await getJSON(`/fs?path=${encodeURIComponent(p)}`);
    $("pjPath").value = r.path;
    const ul = $("fsList"); ul.replaceChildren();
    if (r.error) ul.append(el("li", { class: "muted" }, r.error));
    for (const e of r.entries) {
      ul.append(el("li", { class: e.isRepo ? "repo" : "", title: e.path, onclick: () => loadFs(e.path) },
        el("span", { class: "ico" }, e.isRepo ? "◆" : "▸"), el("span", {}, e.name),
        e.isRepo ? el("span", { class: "badge" }, e.hasLane ? "repo · lane installed" : "git repository") : null));
    }
    if (!r.entries.length && !r.error) ul.append(el("li", { class: "muted" }, "no folders inside"));
    $("fsUp").disabled = !r.parent;
    const box = $("pjProbe");
    if (r.isRepo) { box.className = r.hasLane ? "probe ok" : "probe warn"; box.textContent = r.hasLane ? "This folder is a git repository with the lane installed — press Add project." : "This folder is a git repository, but it has no aiqa.config.yaml. Add it anyway, then run `ai-qa init` in that folder; the studio will not install it for you."; }
    else { box.className = "probe"; box.textContent = "Open the repository you want to test — repositories are marked ◆ — then press Add project."; }
  }
  $("fsUp").addEventListener("click", async () => { const r = await getJSON(`/fs?path=${encodeURIComponent($("pjPath").value)}`); if (r.parent) loadFs(r.parent); });
  $("fsHome").addEventListener("click", () => loadFs(STATE.home || "~"));
  $("pjPath").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); loadFs($("pjPath").value.trim() || "~"); } });
  $("pjPath").addEventListener("change", () => loadFs($("pjPath").value.trim() || "~"));

  function suggestCloneInto() {
    const u = $("pjCloneUrl").value.trim();
    const name = (u.replace(/[\/:]+$/, "").split(/[\/:]/).pop() || "repo").replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
    if (!$("pjCloneInto").dataset.edited) $("pjCloneInto").value = u ? `${short(STATE.clonesDir || "~/.ai-qa/projects")}/${name}` : "";
    $("pjCloneInto").placeholder = `${short(STATE.clonesDir || "~/.ai-qa/projects")}/${name}`;
  }
  $("pjCloneUrl").addEventListener("input", suggestCloneInto);
  $("pjCloneInto").addEventListener("input", () => { $("pjCloneInto").dataset.edited = $("pjCloneInto").value ? "1" : ""; });

  async function startClone() {
    const url = $("pjCloneUrl").value.trim(); const into = $("pjCloneInto").value.trim();
    const log = $("cloneLog"); const box = $("cloneProbe");
    if (!url) { box.className = "probe bad"; box.textContent = "Paste the repository's URL first."; return; }
    log.hidden = false; log.textContent = ""; box.className = "probe"; box.textContent = "cloning…"; $("pjAdd").disabled = true;
    try {
      await stream("/clone", { url, into: into || null }, (ev) => {
        if (ev.type === "progress") { log.textContent += ev.text + "\n"; log.scrollTop = log.scrollHeight; }
        else if (ev.type === "done") {
          if (!ev.ok) { box.className = "probe bad"; box.textContent = ev.error; return; }
          box.className = "probe ok"; box.textContent = `Cloned into ${short(ev.dest)}${ev.info?.hasLane ? " — the lane is installed." : " — no aiqa.config.yaml yet: run `ai-qa init` there."}`;
          STATE = ev.state;
          setTimeout(async () => { closeDialogs(); await refreshState(); await loadFlows(); showScreen("project"); }, 900);
        }
      });
    } catch (e) { box.className = "probe bad"; box.textContent = e.message; }
    $("pjAdd").disabled = false;
  }
  $("pjAdd").addEventListener("click", async () => {
    if (pjMode === "url") return startClone();
    const box = $("pjProbe");
    try {
      await sendJSON("/projects", { path: $("pjPath").value.trim() });
      closeDialogs(); await refreshState(); await loadFlows(); specLoadedFor = null; showScreen("project");
    } catch (e) { box.className = "probe bad"; box.textContent = e.message; }
  });

  // -- new flow: ticket, name, the AI agent, where it runs ---------------------------
  /** What the terminal will type for this agent — said before the flow exists. */
  function agentNote(a, project) {
    if (!a) return { cls: "probe", text: "" };
    if (!a.installed) return { cls: "probe bad", text: `\`${a.cmd}\` is not on PATH — install it, or pick another agent.` };
    const typed = project?.customCommand && project?.agent === a.id ? project.customCommand.replace(/\s*\{prompt\}\s*/g, " ").trim() : a.cmd;
    return { cls: "probe", text: `The terminal opens your shell in the flow's checkout and types \`${typed}\` — nothing added.` };
  }
  function renderAgentRadios(container, name, chosenId, { project = null, note = null } = {}) {
    container.replaceChildren();
    const agents = STATE.agents || [];
    const usable = (a) => a.installed;
    const first = agents.filter(usable); const rest = agents.filter((a) => !usable(a));
    const pick = chosenId && agents.some((a) => a.id === chosenId) ? chosenId : (first[0]?.id || agents[0]?.id);
    const row = (a) => el("label", { class: `radio${usable(a) ? "" : " dim"}` },
      el("input", { type: "radio", name, value: a.id, checked: a.id === pick, onchange: () => { if (note) { const n = agentNote(a, project); note.className = n.cls; note.textContent = n.text; } } }),
      el("span", {}, el("b", {}, a.label, el("span", { class: "badge" }, a.installed ? "installed" : "not installed")),
        el("small", {}, a.note || `typed as \`${a.cmd}\``)));
    for (const a of first) container.append(row(a));
    if (rest.length) {
      const more = el("div", { class: "radios", hidden: true }); for (const a of rest) more.append(row(a));
      const tog = el("button", { class: "ghost mini", style: "align-self:flex-start", onclick: (e) => { e.preventDefault(); more.hidden = !more.hidden; tog.textContent = more.hidden ? `Show ${rest.length} more (not installed on this machine)` : "Show fewer"; } }, `Show ${rest.length} more (not installed on this machine)`);
      container.append(tog, more);
    }
    if (note) { const n = agentNote(agents.find((a) => a.id === pick), project); note.className = n.cls; note.textContent = n.text; }
    return pick;
  }
  const flowNameFor = (ticket, kind) => `${String(ticket || "flow").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "flow"}_${kind}`;
  let knownBranches = [];

  async function openNewFlow() {
    const p = activeProject(); if (!p) { openAddProject("folder"); return; }
    $("nfProject").textContent = `in ${p.name}`;
    $("nfTicket").value = ""; $("nfName").value = ""; $("nfName").dataset.edited = "";
    const k = $("nfKind"); if (!k.options.length) k.replaceChildren(...SCHEMA.kinds.map((x) => el("option", { value: x }, x)));
    k.value = "acceptance";
    if ($("nfAdvDetails")) $("nfAdvDetails").open = false;
    renderAgentRadios($("nfAgents"), "nfAgent", p.agentResolved?.id || p.agent, { project: p, note: $("nfAgentNote") });
    document.querySelector('input[name="nfWhere"][value="project"]').checked = true; $("nfWtFields").hidden = true;
    const main = (STATE.worktrees?.list || []).find((w) => w.isMain);
    $("nfMainBranch").textContent = `${main?.branch || "the current branch"} · ${short(p.path)}. Fine when the change under test is already merged there.`;
    $("nfWtName").value = ""; $("nfWtNewBranch").checked = false;
    const box = $("nfProbe"); box.className = "probe";
    box.textContent = "acceptance — verify core user journey against specification";
    if (STATE.hasLane === false) { box.className = "probe warn"; box.textContent = "This project has no aiqa.config.yaml. The flow can be created, but nothing will run until `ai-qa init` has been run in that folder."; }
    openDialog("dlgFlow"); $("nfTicket").focus();
    const sel = $("nfWtBase"); sel.replaceChildren(el("option", { value: "" }, "loading branches…"));
    knownBranches = [];
    try {
      const w = await getJSON("/worktrees"); sel.replaceChildren();
      knownBranches = w.branches.local || [];
      if (w.branches.current) sel.append(el("option", { value: "HEAD", selected: true }, `HEAD · ${w.branches.current} (this checkout)`));
      for (const b of w.branches.local) sel.append(el("option", { value: b }, b));
      for (const b of w.branches.remoteOnly) sel.append(el("option", { value: `origin/${b}` }, `origin/${b} — not checked out here yet`));
    } catch (e) { sel.replaceChildren(el("option", { value: "" }, e.message)); }
  }
  $("newFlowBtn").addEventListener("click", openNewFlow);
  $("newFlowBtn2").addEventListener("click", openNewFlow);
  const KIND_HINTS = {
    acceptance: "acceptance — verify core user journey against specification",
    boundary: "boundary — test edge values (threshold, empty field, maximums)",
    "whole-screen": "whole-screen — full screen audit, all fields and buttons",
    "write-readback": "write-readback — verify a write is actually persisted in database",
    exploratory: "exploratory — free-form investigation without strict oracle"
  };
  $("nfKind").addEventListener("change", () => {
    if (!$("nfName").dataset.edited) $("nfName").value = flowNameFor($("nfTicket").value.trim(), $("nfKind").value);
    const box = $("nfProbe");
    if (box && (!box.classList.contains("bad") || !box.textContent)) {
      box.className = "probe";
      box.textContent = KIND_HINTS[$("nfKind").value] || "";
    }
  });
  $("nfName").addEventListener("input", () => { $("nfName").dataset.edited = $("nfName").value ? "1" : ""; });
  $("nfWtName").addEventListener("input", () => { $("nfWtName").dataset.edited = $("nfWtName").value ? "1" : ""; });
  document.querySelectorAll('input[name="nfWhere"]').forEach((r) => r.addEventListener("change", () => { $("nfWtFields").hidden = document.querySelector('input[name="nfWhere"]:checked').value !== "worktree"; }));

  $("nfCreate").addEventListener("click", async () => {
    const box = $("nfProbe");
    const name = $("nfName").value.trim() || flowNameFor($("nfTicket").value.trim(), $("nfKind").value);
    if (!/^[a-z0-9][a-z0-9_-]{0,59}$/.test(name)) { box.className = "probe bad"; box.textContent = "Name: lower-case letters, digits, _ and -, up to 60 characters."; return; }
    if (FLOWS.some((f) => f.name === name)) { box.className = "probe bad"; box.textContent = `A flow named ${name} already exists in this project.`; return; }
    const agent = document.querySelector('input[name="nfAgent"]:checked')?.value || null;
    const where = document.querySelector('input[name="nfWhere"]:checked').value;
    let worktree = null;
    box.className = "probe"; box.textContent = "creating…"; $("nfCreate").disabled = true;
    try {
      if (where === "worktree") {
        const wtName = $("nfWtName").value.trim();
        if (!wtName) throw new Error("Give the worktree a name.");
        // "new branch" with a name that already exists is git's most common
        // refusal here; the dialog knows the branches, so check the branch out
        // instead and say so, rather than bouncing the person off a fatal.
        const exists = knownBranches.includes(wtName);
        const r = await sendJSON("/worktrees", { name: wtName, base: exists ? wtName : $("nfWtBase").value, newBranch: $("nfWtNewBranch").checked && !exists, activate: false });
        worktree = r.worktree.name || wtName;
        if (exists && $("nfWtNewBranch").checked) box.textContent = `branch ${wtName} already existed — the worktree checks it out`;
      }
      const f = { ...blankFlow(), name, ticket: $("nfTicket").value.trim(), kind: $("nfKind").value, agent, worktree, created: new Date().toISOString() };
      await sendJSON(`/flows/${name}`, f, "PUT");
      closeDialogs(); await loadFlows(); await openFlow(name);
    } catch (e) { box.className = "probe bad"; box.textContent = e.body?.error || e.message; }
    $("nfCreate").disabled = false;
  });

  // -- project settings: default AI, model, worktrees -------------------------------
  function openSettings() {
    const p = activeProject(); if (!p) return;
    $("stPath").textContent = `${p.name} — ${p.path}`;
    const sel = $("stAgent"); sel.replaceChildren();
    sel.append(el("option", { value: "" }, "— not chosen: use the first one the studio can drive —"));
    for (const a of STATE.agents || []) {
      const bits = [a.installed ? "installed" : "not installed", a.drive === "stream" ? "ready" : "needs a command"];
      sel.append(el("option", { value: a.id, selected: p.agent === a.id }, `${a.label} · ${bits.join(" · ")}`));
    }
    $("stCustom").value = p.customCommand || "";
    describeAgent();
    const ul = $("stWorktrees"); ul.replaceChildren();
    for (const w of STATE.worktrees?.list || []) {
      ul.append(el("li", { title: w.path },
        el("div", { class: "col" }, el("span", {}, w.isMain ? "the project checkout" : w.name), el("span", { class: "sub" }, `${w.branch || w.head || "detached"}${w.hasLane ? "" : " · no lane"}`)),
        w.isMain ? el("span", { class: "badge" }, "main") : el("button", { class: "ghost mini", title: "Remove this worktree", onclick: async () => {
          try { await sendJSON(`/worktrees/${encodeURIComponent(w.name)}`, {}, "DELETE"); }
          catch (err) { if (!confirm(`${err.message}\n\nRemove it anyway?`)) return; await fetch(API(`/worktrees/${encodeURIComponent(w.name)}?force=1`), { method: "DELETE" }); }
          await refreshState(); await loadFlows(); openSettings();
        } }, "✕")));
    }
    openDialog("dlgSettings");
  }
  function describeAgent() {
    const id = $("stAgent").value; const a = agentById(id); const box = $("stAgentNote");
    $("stCustomWrap").hidden = !a;
    if (!id) { box.className = "probe"; box.textContent = "The studio will use the first installed agent it knows how to drive, and say which."; return; }
    if (!a) { box.className = "probe bad"; box.textContent = "unknown agent"; return; }
    const n = agentNote(a, { customCommand: $("stCustom").value.trim() }); box.className = n.cls; box.textContent = n.text;
  }
  $("stAgent").addEventListener("change", describeAgent);
  $("stCustom").addEventListener("input", describeAgent);
  $("settingsBtn").addEventListener("click", openSettings);
  $("stSave").addEventListener("click", async () => {
    const p = activeProject(); if (!p) return;
    await sendJSON(`/projects/${p.id}`, { agent: $("stAgent").value, customCommand: $("stCustom").value.trim() });
    closeDialogs(); await refreshState(); await loadFlows();
  });
  $("stForget").addEventListener("click", async () => {
    const p = activeProject(); if (!p) return;
    if (!confirm(`Forget "${p.name}"?\n\nIt is removed from the studio only — nothing on disk is touched.`)) return;
    await sendJSON(`/projects/${p.id}`, {}, "DELETE");
    closeDialogs(); await refreshState();
    if (STATE.projects.list.length) { await loadFlows(); showScreen("project"); } else { FLOWS = []; showScreen("home"); }
  });

  // ---------------------------------------------------------------------------
  // the flow screen
  // ---------------------------------------------------------------------------
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  function showTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === `tab-${name}`));
    if (name === "canvas") { drawEdges(); requestAnimationFrame(() => fitView({ min: 0.6 })); }
    if (name === "spec") loadSpecTab();
    if (name === "evidence") loadEvd();
    if (name === "agent" && openName) requestAnimationFrame(() => attachTerminal());
  }

  // ---------------------------------------------------------------------------
  // the flow's terminal — the machine's own shell in the flow's checkout, drawn
  // by xterm.js. The chosen agent's command is typed into it. Nothing added.
  // ---------------------------------------------------------------------------
  let TERM = null, termFit = null, termWs = null, termFor = null, termRO = null;
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function termTheme() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    const base = { background: cssVar("--background"), foreground: cssVar("--foreground"), cursor: cssVar("--foreground"), cursorAccent: cssVar("--background") };
    return dark
      ? { ...base, selectionBackground: "#ffffff33", black: "#0a0a0a", red: "#ff6568", green: "#00c758", yellow: "#fcbb00", blue: "#54a2ff", magenta: "#a685ff", cyan: "#5ad1e6", white: "#e5e5e5",
          brightBlack: "#737373", brightRed: "#ff8a8c", brightGreen: "#4fe08a", brightYellow: "#ffd54f", brightBlue: "#8ec0ff", brightMagenta: "#c2a9ff", brightCyan: "#8fe3f0", brightWhite: "#fafafa" }
      : { ...base, selectionBackground: "#0000001f", black: "#0a0a0a", red: "#e40014", green: "#00a544", yellow: "#b75000", blue: "#155dfc", magenta: "#7f22fe", cyan: "#0e7490", white: "#737373",
          brightBlack: "#525252", brightRed: "#f0424f", brightGreen: "#22b85e", brightYellow: "#dd7400", brightBlue: "#3b7cff", brightMagenta: "#9c5cff", brightCyan: "#1a9bb5", brightWhite: "#0a0a0a" };
  }
  function setTermStatus(text, cls) { const s = $("termStatus"); s.textContent = text; s.className = `term-status ${cls || ""}`; }
  function detachTerminal() {
    if (termWs) { try { termWs.onclose = null; termWs.close(); } catch { /* gone */ } termWs = null; }
    if (termRO) { termRO.disconnect(); termRO = null; }
    if (TERM) { TERM.dispose(); TERM = null; termFit = null; }
    $("term").replaceChildren(); termFor = null;
  }
  /** Attach the page to this flow's terminal. The session lives in the studio
   *  process: leaving the flow detaches the page, the shell (and whatever runs
   *  in it) keeps going, and coming back replays what it printed meanwhile. */
  function attachTerminal({ restart = false } = {}) {
    if (!openName) return;
    if (typeof Terminal === "undefined") { setTermStatus("xterm.js did not load", "unavailable"); return; }
    if (TERM && termFor === openName && !restart) { try { termFit.fit(); } catch { /* not laid out yet */ } TERM.focus(); return; }
    detachTerminal();
    termFor = openName;
    $("termNote").hidden = true;
    TERM = new Terminal({ fontFamily: cssVar("--mono") || "monospace", fontSize: 12, lineHeight: 1.25, cursorBlink: true, scrollback: 5000, theme: termTheme(), allowTransparency: true });
    termFit = new FitAddon.FitAddon(); TERM.loadAddon(termFit);
    TERM.open($("term")); try { termFit.fit(); } catch { /* zero-size until laid out */ }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/${TOKEN}/api/term?flow=${encodeURIComponent(openName)}&cols=${TERM.cols}&rows=${TERM.rows}${restart ? "&restart=1" : ""}`);
    ws.binaryType = "arraybuffer"; termWs = ws;
    const enc = new TextEncoder();
    setTermStatus("opening a terminal…");
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") { TERM.write(new Uint8Array(e.data)); return; }
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type !== "status") return;
      if (m.state === "unavailable") {
        setTermStatus("terminal unavailable", "unavailable");
        const n = $("termNote"); n.hidden = false;
        n.replaceChildren(el("b", {}, "No terminal on this machine."), el("div", {}, m.reason || ""));
        return;
      }
      const where = m.worktree ? `worktree ${m.worktree}${m.worktreeMissing ? " (missing → project checkout)" : ""}` : short(m.cwd);
      if (m.state === "running") setTermStatus(`${m.shell} in ${where}${m.typed ? ` · typed ${m.typed}` : ""}${m.note ? ` · ${m.note}` : ""}`, m.note ? "exited" : "running");
      else setTermStatus(`terminal closed${m.exitCode != null ? ` (${m.exitCode})` : ""} — restart opens a fresh one`, "exited");
      loadFlows();
    };
    ws.onclose = () => { if (termWs === ws && !$("termStatus").classList.contains("exited")) setTermStatus("disconnected — reopen the flow to reconnect", "exited"); };
    TERM.onData((d) => { if (ws.readyState === 1) ws.send(enc.encode(d)); });
    TERM.onBinary((d) => { if (ws.readyState === 1) ws.send(Uint8Array.from(d, (ch) => ch.charCodeAt(0))); });
    TERM.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols, rows })); });
    const refit = debounce(() => { try { termFit?.fit(); } catch { /* hidden */ } }, 60);
    termRO = new ResizeObserver(refit); termRO.observe($("termWrap"));
    TERM.focus();
  }
  /** Type into the terminal as a person would: the text, then Enter. */
  function termType(text) {
    if (!termWs || termWs.readyState !== 1) return false;
    const enc = new TextEncoder();
    termWs.send(enc.encode(text));
    setTimeout(() => { if (termWs?.readyState === 1) termWs.send(enc.encode("\r")); }, 250);
    TERM?.focus();
    return true;
  }
  /** The agent picker in the bar: what this machine has, the flow's own selected. */
  function fillTermAgents() {
    const sel = $("termAgent"); sel.replaceChildren();
    // what is in effect: the flow's own choice, else the project's default (AGENT); "shell" is the explicit none
    const effective = flow.agent === "shell" ? "shell" : (flow.agent || AGENT?.id || "shell");
    sel.append(el("option", { value: "shell", selected: effective === "shell" }, "— shell only, nothing typed —"));
    for (const a of (STATE.agents || []).filter((a) => a.installed)) sel.append(el("option", { value: a.id, selected: effective === a.id }, `${a.label}${!flow.agent && AGENT?.id === a.id ? " (project default)" : ""}`));
    for (const a of (STATE.agents || []).filter((a) => !a.installed)) sel.append(el("option", { value: a.id, disabled: true }, `${a.label} — not installed`));
  }
  // Choosing another agent: the flow remembers it, and a fresh terminal opens
  // with that agent's command typed — the same as closing a terminal window and
  // opening a new one for the other tool. "shell only" opens one with nothing typed.
  $("termAgent").addEventListener("change", async () => {
    flow.agent = $("termAgent").value || "shell";
    AGENT = flow.agent === "shell" ? { id: null, chosen: true, shellOnly: true } : { ...(agentById(flow.agent) || { id: flow.agent }), chosen: true };
    if (/^[a-z0-9][a-z0-9_-]{0,59}$/.test(flow.name || "")) await sendJSON(`/flows/${flow.name}`, flow, "PUT").catch(() => {});
    renderFlowBar(); loadFlows();
    attachTerminal({ restart: true });
  });
  $("termRestart").addEventListener("click", () => attachTerminal({ restart: true }));

  async function openFlow(name, { autoRun = false } = {}) {
    const r = await sendJSON(`/flows/${name}/open`, {});
    flow = r.flow; STATE = r.state; AGENT = r.agent; openName = name;
    selected = { node: null, edge: null };
    nextId = 1 + Math.max(0, ...(flow.nodes || []).map((n) => Number(String(n.id).replace(/\D/g, "")) || 0));
    ticketInput.value = flow.ticket || "";
    showScreen("flow"); renderBars(); renderNodes(); renderInspector(); scheduleValidate();
    fillTermAgents();
    if (autoRun) {
      showTab("run");
      setTimeout(() => { if (!runningFlow) $("runBtn")?.click(); }, 120);
    } else if ((flow.nodes || []).length > 0) {
      showTab("run");
    } else {
      showTab("canvas");
    }
  }

  // ---------------------------------------------------------------------------
  // canvas model
  // ---------------------------------------------------------------------------
  let selected = { node: null, edge: null };
  let nextId = 1;
  const newId = () => { let id; do { id = `n${nextId++}`; } while (flow.nodes.some((n) => n.id === id)); return id; };
  const stage = $("stage"); const canvas = $("canvas"); const svg = $("edges");
  const TYPES = SCHEMA.nodeTypes;

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
  function fitView({ min = 0.35 } = {}) {
    const b = bbox(); if (!b) { setZoom(1); return; }
    const pad = 40;
    if (!canvas.clientWidth) return;
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
    // The reason a step exists is printed UNDER its name, not hidden in a
    // tooltip. Someone meeting this screen for the first time should not have
    // to hover over twelve things to work out which four they need.
    const pal = $("palette"); pal.replaceChildren();
    for (const g of (SCHEMA.groups || [])) {
      const types = Object.entries(TYPES).filter(([, spec]) => spec.group === g.id);
      if (!types.length) continue;
      pal.append(el("h4", {}, g.title));
      for (const [type, spec] of types) {
        const item = el("div", { class: "pal-item", "data-type": type },
          el("span", { class: "sw", style: `background:${spec.color}` }),
          el("span", { class: "txt" },
            el("b", {}, spec.label),
            spec.hint ? el("em", {}, spec.hint) : null));
        item.addEventListener("pointerdown", (e) => startPaletteDrag(e, type));
        pal.append(item);
      }
    }
  }

  /** An empty canvas offers a shape to start from.
   *
   *  A blank canvas plus twelve step types asks you to already know what a
   *  test case looks like — the exact knowledge someone new does not have.
   *  Each shape arrives wired and already carrying the parts the gate insists
   *  on; the words stay yours, because a starter that invented an expected
   *  value would be the one thing this tool must never do. */
  function renderStarters() {
    const host = $("canvasHint");
    if (!host) return;
    host.replaceChildren(
      el("h3", {}, "Start from a shape"),
      el("p", {}, "Each one is already wired and already has the parts a case needs. You fill in the words — nothing here guesses a value for you."),
      el("div", { class: "starters" }, ...(SCHEMA.starters || []).map((st) =>
        el("button", { class: "starter", type: "button", onclick: () => applyStarter(st.id) },
          el("b", {}, st.label),
          el("em", {}, st.why)))),
      el("p", { class: "or" }, "Or drag a step in from the left. Wire two steps by dragging from the right-hand dot of one to the other, and click a step to fill it in."));
  }

  function applyStarter(id) {
    const st = (SCHEMA.starters || []).find((x) => x.id === id);
    if (!st) return;
    // The server built the shape once; the page only gives it fresh ids.
    const ids = new Map(st.nodes.map((n) => [n.id, newId()]));
    // Only ever ADDS — someone who has already drawn something keeps it.
    for (const n of st.nodes) flow.nodes.push({ ...n, id: ids.get(n.id), data: { ...n.data } });
    for (const e of st.edges) flow.edges.push({ from: ids.get(e.from), to: ids.get(e.to) });
    if (st.kind && !flow.kind) flow.kind = st.kind;
    select(ids.get(st.nodes[0]?.id) || null, null);   // select() redraws
    scheduleValidate(); scheduleSave();
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
    if (!flow.nodes.length) renderStarters();
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
    if (!openName || !$("tab-canvas").classList.contains("on")) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selected.node) removeNode(selected.node);
      else if (selected.edge) { flow.edges = flow.edges.filter((x) => !(x.from === selected.edge.from && x.to === selected.edge.to)); selected.edge = null; drawEdges(); scheduleValidate(); scheduleSave(); }
    }
  });

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
    const ghost = el("div", { class: "pal-item", style: `position:fixed;left:${e.clientX + 6}px;top:${e.clientY + 6}px;pointer-events:none;opacity:.85;z-index:50;width:180px;background:var(--popover);border:1px solid var(--border)` }, el("span", { class: "sw", style: `background:${TYPES[type].color}` }), TYPES[type].label);
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
  ticketInput.addEventListener("change", () => { flow.ticket = ticketInput.value.trim(); renderFlowBar(); scheduleValidate(); scheduleSave(); specLoadedFor = null; });

  const scheduleValidate = debounce(async () => {
    if (!openName) return;
    const v = await sendJSON("/validate", flow).catch((e) => ({ errors: [e.message], warnings: [] }));
    const box = $("validation"); box.replaceChildren();
    if (!v.errors.length && !v.warnings.length && flow.nodes.length) box.append(el("div", { class: "ok" }, "Compiles. Every check that has a citation can become a defect; the rest report differences."));
    for (const e of v.errors) box.append(el("div", { class: "err" }, e));
    for (const w of v.warnings) box.append(el("div", { class: "warn" }, w));
  }, 250);
  const scheduleSave = debounce(async () => {
    if (!openName || !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(flow.name || "")) return;
    try {
      await sendJSON(`/flows/${flow.name}`, flow, "PUT");
      if (flow.name !== openName) { await sendJSON(`/flows/${openName}`, {}, "DELETE"); openName = flow.name; }
      await loadFlows(); renderFlowBar();
    } catch { /* shown on next validate */ }
  }, 600);
  $("saveFlow").addEventListener("click", () => { flow.name = $("flowName").value.trim(); scheduleSave(); scheduleValidate(); });

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
      loadFlows(); loadEvd();
    } catch (e) {
      setRunStatus("does not compile", "fail");
      for (const m of (e.body?.errors || [e.message])) logLine(`x ${m}\n`, "bad");
    }
  });

  function showRunBanner(result, caseDir, extra = "") {
    const banner = $("runBanner");
    if (!banner) return;
    banner.replaceChildren();
    const r = String(result || "").toUpperCase();
    banner.className = `run-banner ${r.toLowerCase()}`;
    if (r === "PASS") {
      banner.append(
        el("div", { class: "banner-msg" },
          el("b", {}, "✓ Test Passed"),
          el("span", {}, `All verifications succeeded against specification. Evidence saved in ${caseDir || "evd/"}.`)),
        el("div", { class: "banner-act" },
          el("button", { class: "primary mini", onclick: () => showTab("evidence") }, "View evidence & report →"))
      );
      banner.hidden = false;
    } else if (r === "FAIL") {
      banner.append(
        el("div", { class: "banner-msg" },
          el("b", {}, "✗ Test Failed"),
          el("span", {}, extra || "One or more checks did not match expected values or spec requirements.")),
        el("div", { class: "banner-act" },
          el("button", { class: "primary mini", onclick: () => showTab("evidence") }, "Inspect failure evidence →"))
      );
      banner.hidden = false;
    } else if (r === "BLOCKED") {
      banner.append(
        el("div", { class: "banner-msg" },
          el("b", {}, "⚠ Test Blocked"),
          el("span", {}, extra || "Preflight check failed. Ensure the app is running (e.g. npm run dev) and environment allows writes.")),
        el("div", { class: "banner-act" },
          el("button", { class: "bd mini", onclick: () => $("runBtn").click() }, "↻ Retry run"),
          el("button", { class: "ghost mini", onclick: () => showTab("evidence") }, "View details"))
      );
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  $("runBtn").addEventListener("click", async () => {
    showTab("run"); $("runLog").replaceChildren(); $("runFiles").replaceChildren();
    if ($("runBanner")) { $("runBanner").hidden = true; $("runBanner").replaceChildren(); }
    const statuses = {}; let steps = [];
    runAbort = new AbortController(); $("stopBtn").disabled = false; $("runBtn").disabled = true;
    runningFlow = openName; renderTree(); setRunStatus("running…");
    try {
      await stream("/run", { flow, caseNo: flow.case }, (ev) => {
        if (ev.type === "compiled") { steps = ev.steps; renderSteps(steps); logLine(`compiled → ${ev.caseDir}\n`, "head"); for (const w of ev.warnings || []) logLine(`! ${w}\n`, "amber"); }
        else if (ev.type === "step") { statuses[ev.id] = ev.status; renderSteps(steps, statuses); if (ev.status === "start") logLine(`\n▶ ${ev.label}\n`, "head"); }
        else if (ev.type === "out") { for (const l of String(ev.text).split(/(?<=\n)/)) logLine(l, classify(l)); }
        else if (ev.type === "gate") { logLine(`\n${ev.text}\n`, ev.ok ? "ok" : ""); }
        else if (ev.type === "error") { logLine(`x ${ev.message}\n`, "bad"); }
        else if (ev.type === "done") {
          setRunStatus(`RESULT: ${ev.result}${ev.caseDir ? ` · ${ev.caseDir}` : ""}`, ev.result === "PASS" ? "pass" : ev.result === "FAIL" ? "fail" : "blocked");
          showRunBanner(ev.result, ev.caseDir);
        }
      }, runAbort.signal);
    } catch (e) {
      if (e.name !== "AbortError") {
        logLine(`x ${e.message}\n`, "bad"); setRunStatus("run failed to start", "fail");
        showRunBanner("FAIL", null, e.message);
      } else {
        setRunStatus("stopped", "blocked");
        showRunBanner("BLOCKED", null, "Run was stopped by user");
      }
    }
    $("stopBtn").disabled = true; $("runBtn").disabled = false; runAbort = null; runningFlow = null;
    await loadFlows(); renderFlowBar(); loadEvd();
  });
  $("stopBtn").addEventListener("click", () => runAbort?.abort());

  // ---------------------------------------------------------------------------
  // evidence
  // ---------------------------------------------------------------------------
  function renderEvdSummary() {
    const box = $("evdSummary");
    if (!box) return;
    const sum = FLOWS.find((f) => f.name === openName);
    if (!sum || !sum.result) { box.hidden = true; return; }
    box.hidden = false;
    box.replaceChildren(
      el("div", { class: "sum-title" },
        el("div", { class: "row nowrap" },
          el("span", { class: `sum-badge ${sum.result}` }, sum.result),
          el("b", {}, flow.name || openName),
          flow.ticket ? el("span", { class: "chip ticket" }, flow.ticket) : null),
        el("span", { class: "muted small" }, sum.ranAt ? `Last run: ${ago(sum.ranAt)}` : "Recorded run")),
      el("div", { class: "sum-acts" },
        el("button", { class: "primary mini", onclick: () => $("exportBtn").click() }, "📥 Export Excel"),
        el("button", { class: "bd mini", onclick: () => $("gateBtn").click() }, "Run verification gate"))
    );
  }

  async function loadEvd() {
    const { tree } = await getJSON("/evd").catch(() => ({ tree: [] }));
    const ul = $("evdTree"); ul.replaceChildren();
    const walk = (items, depth) => {
      for (const it of items) {
        if (it.dir) { ul.append(el("li", { class: "dir", style: `padding-left:${8 + depth * 12}px` }, it.name)); walk(it.children, depth + 1); }
        else ul.append(el("li", { style: `padding-left:${8 + depth * 12}px`, onclick: () => openEvidence(it.path) }, el("span", {}, it.name), el("span", { class: "size" }, it.size > 1024 ? `${Math.round(it.size / 1024)}k` : `${it.size}`)));
      }
    };
    walk(tree, 0);
    if (!tree.length) ul.append(el("li", { class: "muted" }, "no evidence yet — compile or run a flow, or ask the agent to /qa"));
    renderEvdSummary();
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
    const ticket = (flow.ticket || ticketInput.value).trim(); if (!ticket) return alert("Give the flow a ticket first (Steps → Ticket).");
    $("evdStatus").textContent = "running evd_check…";
    const g = await sendJSON("/gate", { ticket }).catch((e) => ({ ok: false, text: e.message }));
    $("evdStatus").textContent = g.ok ? "EVIDENCE: GREEN" : "EVIDENCE: RED"; $("evdStatus").className = `run-status ${g.ok ? "pass" : "fail"}`;
    $("evdView").replaceChildren(el("h3", {}, `evd_check — evd/${ticket}`), el("pre", { class: "log" }, g.text));
  });
  $("exportBtn").addEventListener("click", async () => {
    const ticket = (flow.ticket || ticketInput.value).trim(); if (!ticket) return alert("Give the flow a ticket first (Steps → Ticket).");
    $("evdStatus").textContent = "exporting…";
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
  async function loadSpecTab() {
    const key = (flow.ticket || ticketInput.value).trim();
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
  // quick commands: typed into the terminal as a person would
  // ---------------------------------------------------------------------------
  $("quick").addEventListener("click", (e) => {
    const q = e.target.closest("button")?.dataset.q; if (!q) return;
    const t = (flow.ticket || ticketInput.value).trim();
    const text = q.replace("{ticket}", t || "<ticket>");
    if (q.includes("{ticket}") && !t) { showTab("canvas"); ticketInput.focus(); return; }
    if (!termWs || termWs.readyState !== 1) { attachTerminal(); return; }
    if (q.endsWith(" ")) { termWs.send(new TextEncoder().encode(text)); TERM?.focus(); return; }   // wants an argument: left for the person to finish
    termType(text);
  });

  // ---------------------------------------------------------------------------
  // Draft from ticket — a one-off, non-interactive call (Claude Code --print or
  // the Anthropic API), separate from the terminal, reported in the inspector.
  // ---------------------------------------------------------------------------
  $("draftFlow").addEventListener("click", async () => {
    const ticket = (flow.ticket || ticketInput.value).trim(); if (!ticket) { ticketInput.focus(); return alert("Give the flow a ticket first — the draft is built from the ticket and the spec."); }
    const name = flow.name || flowNameFor(ticket, flow.kind);
    const surface = [].concat(STATE.project.surfaces).includes("web") ? "web" : "api";
    const box = $("validation"); box.replaceChildren(el("div", { class: "warn" }, `drafting ${flow.kind} steps for ${ticket} from the ticket and the spec…`));
    const log = el("div", { class: "hint", style: "white-space:pre-wrap;max-height:180px;overflow:auto;font-family:var(--mono);font-size:10.5px" }); box.append(log);
    let drafted = null, text = "";
    $("draftFlow").disabled = true;
    try {
      await stream("/draft", { ticket, kind: flow.kind, name, surface }, (ev) => {
        if (ev.type === "text") { text += ev.text; log.textContent = text.slice(-1500); log.scrollTop = log.scrollHeight; }
        else if (ev.type === "tool") { log.textContent += `\n▸ ${ev.name}`; }
        else if (ev.type === "status") { log.textContent += `\n${ev.text}`; }
        else if (ev.type === "error") box.append(el("div", { class: "err" }, ev.message));
        else if (ev.type === "flow") drafted = ev;
      });
    } catch (e) { box.append(el("div", { class: "err" }, e.message)); }
    $("draftFlow").disabled = false;
    if (drafted && drafted.flow) {
      const f = drafted.flow;
      f.nodes = (f.nodes || []).map((n, i) => ({ id: n.id || `n${i + 1}`, type: n.type, x: Number(n.x) || 40, y: Number(n.y) || 40 + i * 130, data: n.data || {} })).filter((n) => TYPES[n.type]);
      f.edges = (f.edges || []).filter((e) => f.nodes.some((n) => n.id === e.from) && f.nodes.some((n) => n.id === e.to));
      flow = { ...flow, ...f, name: flow.name, agent: flow.agent, worktree: flow.worktree, case: flow.case }; selected = { node: null, edge: null };
      nextId = 1 + f.nodes.length; showTab("canvas"); autoLayout(); renderInspector(); scheduleValidate(); scheduleSave();
      if (f.notes) setTimeout(() => $("validation").append(el("div", { class: "warn" }, `Notes from the draft: ${f.notes}`)), 500);
    } else {
      box.append(el("div", { class: "err" }, "No flow came back that the canvas could read — try again, or build it by hand."));
    }
  });

  // ---------------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------------
  (async () => {
    renderPalette(); renderInspector(); renderNodes(); setZoom(1); renderBars(); renderTree();
    if (!STATE.projects?.list?.length) { showScreen("home"); return; }
    await loadFlows();
    showScreen("project");
  })();
})();
