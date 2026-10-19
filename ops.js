/* Ops Planning: native port of Metaverve Work (boards, groups, tasks, table + Kanban,
   updates/comments, activity, search/filters, overview dashboard, Done -> group automation).
   No login. All data lives in this browser's IndexedDB; use Export/Import to back up or move it. */
(function () {
  "use strict";
  const STATUSES = ["Not started", "Working on it", "Stuck", "Done"];
  const PRIORITIES = ["Low", "Medium", "High", "Critical"];
  const COLORS = ["#6554c0", "#0c9d8a", "#df8b2d", "#4987d8", "#d85d7a"];
  const ACTIVITY_LIMIT = 300;
  const DB_NAME = "command-deck-ops", STORE = "kv", KEY = "state", FORMAT = "ops-planning-backup";
  const ME = { id: "me", name: "You", initials: "YO", color: "#6554c0" };

  const root = document.getElementById("ops-app");
  if (!root) return;

  // ---------- helpers ----------
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2));
  const nowIso = () => new Date().toISOString();
  const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const clean = (v, field, max, required = true) => {
    if (typeof v !== "string" || v.includes("\u0000")) throw new Error(field + " must be text.");
    const t = v.trim();
    if ((required && !t.length) || t.length > max) throw new Error(field + " must be " + (required ? "1" : "0") + "–" + max + " characters.");
    return t;
  };
  const validDate = (v) => {
    if (v === null || v === "" || v === undefined) return null;
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v.startsWith("0000-")) throw new Error("Due date must be YYYY-MM-DD.");
    const d = new Date(v + "T00:00:00Z");
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new Error("Choose a real calendar date.");
    return v;
  };
  const oneOf = (v, list, field) => { if (!list.includes(v)) throw new Error("Choose a valid " + field + "."); return v; };
  const relative = (iso) => {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago";
  };
  const statusClass = (s) => ({ "Not started": "st-none", "Working on it": "st-working", "Stuck": "st-stuck", "Done": "st-done" }[s] || "st-none");
  const prioClass = (p) => "pr-" + String(p).toLowerCase();
  const emptyState = () => ({ format: FORMAT, version: 1, members: [ME], boards: [], groups: [], tasks: [], comments: [], activity: [], automations: [] });

  // ---------- storage ----------
  let db = null, state = emptyState(), storageError = "";
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbGet() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly"); const r = tx.objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result || null); r.onerror = () => reject(r.error);
    });
  }
  function idbPut(value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("Save was cancelled"));
      tx.objectStore(STORE).put(value, KEY);
    });
  }
  async function commit(mutator) {
    const draft = JSON.parse(JSON.stringify(state));
    try { mutator(draft); } catch (err) { flash(err.message || String(err), "error"); return false; }
    if (draft.activity.length > ACTIVITY_LIMIT) draft.activity = draft.activity.slice(0, ACTIVITY_LIMIT);
    try { if (!db) throw new Error("Storage isn't available in this browser."); await idbPut(draft); }
    catch (err) { flash("Not saved: " + (err && err.message ? err.message : "storage error"), "error"); return false; }
    state = draft; render(); return true;
  }
  function log(s, boardId, taskId, action, detail) {
    s.activity.unshift({ id: uid(), task_id: taskId || null, board_id: boardId, actor_id: ME.id, action, detail: detail || "", created_at: nowIso() });
  }

  // ---------- validation for import ----------
  function validateImport(obj) {
    if (!obj || typeof obj !== "object" || obj.format !== FORMAT) throw new Error("This isn't an Ops Planning backup file.");
    const arr = (k) => { if (!Array.isArray(obj[k])) throw new Error("Backup is missing " + k + "."); return obj[k]; };
    const out = emptyState();
    const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
    const members = arr("members").filter((m) => m && typeof m.id === "string").map((m) => ({ id: str(m.id, 100), name: str(m.name, 80) || "Member", initials: str(m.initials, 3), color: COLORS.concat(["#da8d39", "#4e91b0", "#cf7191"]).includes(m.color) ? m.color : "#6554c0" }));
    out.members = members.some((m) => m.id === ME.id) ? members : [ME].concat(members);
    out.boards = arr("boards").filter((b) => b && typeof b.id === "string").map((b) => ({ id: str(b.id, 100), name: str(b.name, 80) || "Untitled board", description: str(b.description, 2000), color: COLORS.includes(b.color) ? b.color : COLORS[0], created_at: str(b.created_at, 40) || nowIso() }));
    const boardIds = new Set(out.boards.map((b) => b.id));
    out.groups = arr("groups").filter((g) => g && boardIds.has(g.board_id)).map((g) => ({ id: str(g.id, 100), board_id: g.board_id, name: str(g.name, 80) || "Group", color: COLORS.includes(g.color) ? g.color : COLORS[3], position: Number.isFinite(g.position) ? g.position : 0, system_kind: g.system_kind === "done" ? "done" : null }));
    const groupIds = new Set(out.groups.map((g) => g.id)), memberIds = new Set(out.members.map((m) => m.id));
    out.tasks = arr("tasks").filter((t) => t && boardIds.has(t.board_id) && groupIds.has(t.group_id)).map((t) => {
      let due = null; try { due = validDate(t.due_date); } catch (e) { due = null; }
      return { id: str(t.id, 100), board_id: t.board_id, group_id: t.group_id, title: str(t.title, 200) || "Untitled task", description: str(t.description, 10000), status: STATUSES.includes(t.status) ? t.status : "Not started", priority: PRIORITIES.includes(t.priority) ? t.priority : "Medium", assignee_id: memberIds.has(t.assignee_id) ? t.assignee_id : null, due_date: due, archived: !!t.archived, created_at: str(t.created_at, 40) || nowIso(), updated_at: str(t.updated_at, 40) || nowIso() };
    });
    const taskIds = new Set(out.tasks.map((t) => t.id));
    out.comments = arr("comments").filter((c) => c && taskIds.has(c.task_id)).map((c) => ({ id: str(c.id, 100), task_id: c.task_id, user_id: memberIds.has(c.user_id) ? c.user_id : ME.id, body: str(c.body, 5000), created_at: str(c.created_at, 40) || nowIso() }));
    out.activity = arr("activity").filter((a) => a && boardIds.has(a.board_id)).slice(0, ACTIVITY_LIMIT).map((a) => ({ id: str(a.id, 100), task_id: taskIds.has(a.task_id) ? a.task_id : null, board_id: a.board_id, actor_id: memberIds.has(a.actor_id) ? a.actor_id : ME.id, action: str(a.action, 80), detail: str(a.detail, 200), created_at: str(a.created_at, 40) || nowIso() }));
    out.automations = arr("automations").filter((a) => a && boardIds.has(a.board_id)).map((a) => ({ id: str(a.id, 100), board_id: a.board_id, target_group_id: groupIds.has(a.target_group_id) ? a.target_group_id : null, enabled: !!a.enabled && groupIds.has(a.target_group_id) }));
    return out;
  }

  // ---------- domain actions (mirror metaverve-work repository) ----------
  function createBoard(s, name, description, color) {
    const boardId = uid();
    s.boards.push({ id: boardId, name: clean(name, "Board name", 80), description: clean(description || "", "Description", 2000, false), color: oneOf(color || COLORS[0], COLORS, "board color"), created_at: nowIso() });
    const defs = [{ name: "To do", color: "#6554c0", kind: null }, { name: "In progress", color: "#df8b2d", kind: null }, { name: "Completed", color: "#0c9d8a", kind: "done" }];
    const ids = defs.map((g, i) => { const id = uid(); s.groups.push({ id, board_id: boardId, name: g.name, color: g.color, position: i, system_kind: g.kind }); return id; });
    s.automations.push({ id: uid(), board_id: boardId, target_group_id: ids[2], enabled: false });
    log(s, boardId, null, "Board created", s.boards[s.boards.length - 1].name);
    return boardId;
  }
  function automate(s, task, transitioned) {
    if (!transitioned || task.status !== "Done") return;
    const a = s.automations.find((x) => x.board_id === task.board_id && x.enabled);
    if (!a || !a.target_group_id || a.target_group_id === task.group_id) return;
    const g = s.groups.find((x) => x.id === a.target_group_id); if (!g) return;
    task.group_id = g.id; task.updated_at = nowIso();
    log(s, task.board_id, task.id, "Automation ran", "Done → moved to " + g.name);
  }
  function createTask(s, f) {
    const board = s.boards.find((b) => b.id === f.boardId); if (!board) throw new Error("Board not found.");
    const group = s.groups.find((g) => g.id === f.groupId && g.board_id === board.id); if (!group) throw new Error("Group not found.");
    const t = { id: uid(), board_id: board.id, group_id: group.id, title: clean(f.title, "Task title", 200), description: clean(f.description || "", "Description", 10000, false), status: oneOf(f.status || "Not started", STATUSES, "status"), priority: oneOf(f.priority || "Medium", PRIORITIES, "priority"), assignee_id: f.assigneeId && s.members.some((m) => m.id === f.assigneeId) ? f.assigneeId : null, due_date: validDate(f.dueDate), archived: false, created_at: nowIso(), updated_at: nowIso() };
    s.tasks.push(t); log(s, board.id, t.id, "Task created", t.title); automate(s, t, true); return t.id;
  }
  function updateTask(s, taskId, patch) {
    const t = s.tasks.find((x) => x.id === taskId && !x.archived); if (!t) throw new Error("Task not found.");
    const before = Object.assign({}, t), parts = [];
    if ("title" in patch) t.title = clean(patch.title, "Task title", 200);
    if ("description" in patch) t.description = clean(patch.description, "Description", 10000, false);
    if ("status" in patch) t.status = oneOf(patch.status, STATUSES, "status");
    if ("priority" in patch) t.priority = oneOf(patch.priority, PRIORITIES, "priority");
    if ("assigneeId" in patch) t.assignee_id = patch.assigneeId && s.members.some((m) => m.id === patch.assigneeId) ? patch.assigneeId : null;
    if ("dueDate" in patch) t.due_date = validDate(patch.dueDate);
    if ("groupId" in patch) { const g = s.groups.find((x) => x.id === patch.groupId && x.board_id === t.board_id); if (!g) throw new Error("Group not found."); t.group_id = g.id; }
    if (t.title !== before.title) parts.push("Title updated");
    if (t.description !== before.description) parts.push("Description updated");
    if (t.status !== before.status) parts.push(before.status + " → " + t.status);
    if (t.priority !== before.priority) parts.push("Priority updated");
    if (t.assignee_id !== before.assignee_id) parts.push("Assignee updated");
    if (t.due_date !== before.due_date) parts.push("Due date updated");
    if (t.group_id !== before.group_id) parts.push("Group changed");
    if (!parts.length) return false;
    t.updated_at = nowIso(); log(s, t.board_id, t.id, "Task updated", parts.join(" · "));
    automate(s, t, before.status !== t.status); return true;
  }
  function seedDemo(s) {
    if (s.boards.some((b) => b.id === "demo-launch-board")) return;
    [{ id: "demo-riley", name: "[Demo] Riley", initials: "RI", color: "#da8d39" }, { id: "demo-jordan", name: "[Demo] Jordan", initials: "JO", color: "#4e91b0" }, { id: "demo-sam", name: "[Demo] Sam", initials: "SA", color: "#cf7191" }]
      .forEach((p) => { if (!s.members.some((m) => m.id === p.id)) s.members.push(p); });
    const boardId = "demo-launch-board";
    s.boards.push({ id: boardId, name: "[Demo] Product launch", description: "A fictional launch board to explore. All people, tasks, and updates here are synthetic.", color: "#6554c0", created_at: nowIso() });
    [{ id: "demo-plan", name: "Plan & discover", color: "#6554c0", kind: null }, { id: "demo-build", name: "In the making", color: "#df8b2d", kind: null }, { id: "demo-done", name: "Ready to go", color: "#0c9d8a", kind: "done" }]
      .forEach((g, i) => s.groups.push({ id: g.id, board_id: boardId, name: g.name, color: g.color, position: i, system_kind: g.kind }));
    s.automations.push({ id: uid(), board_id: boardId, target_group_id: "demo-done", enabled: false });
    const t0 = today();
    [["Map the customer journey", "demo-plan", "Working on it", "High", "demo-riley", 3, "Bring the touchpoints together into a simple journey map."],
     ["Write the launch story", "demo-plan", "Not started", "Medium", ME.id, 5, "Outline the problem, the promise, and what comes next."],
     ["Explore illustration directions", "demo-plan", "Not started", "Low", "demo-sam", 7, "Try three original visual directions for the fictional launch."],
     ["Build the first onboarding flow", "demo-build", "Working on it", "High", "demo-jordan", 2, "Make the first experience feel clear and welcoming."],
     ["Review accessibility checklist", "demo-build", "Stuck", "Critical", ME.id, -2, "Check focus order, readable contrast, and keyboard interactions."],
     ["Create the release checklist", "demo-build", "Working on it", "Medium", "demo-riley", 4, "List the small things that make a launch feel finished."],
     ["Set the project north star", "demo-done", "Done", "High", "demo-riley", -4, "Define one clear outcome for this synthetic project."],
     ["Gather early feedback", "demo-done", "Done", "Medium", "demo-sam", -1, "Capture the fictional team’s first impressions."]]
      .forEach((x, i) => { const id = "demo-task-" + (i + 1); s.tasks.push({ id, board_id: boardId, group_id: x[1], title: x[0], description: x[6], status: x[2], priority: x[3], assignee_id: x[4], due_date: addDays(t0, x[5]), archived: false, created_at: nowIso(), updated_at: nowIso() }); log(s, boardId, id, "Sample task added", x[0]); });
    s.comments.push({ id: uid(), task_id: "demo-task-1", user_id: "demo-riley", body: "Synthetic update: I’ve mapped the first three touchpoints. The next step is to connect them.", created_at: nowIso() });
    log(s, boardId, null, "Demo loaded", "Fictional launch board. Automation starts disabled.");
  }

  // ---------- selectors ----------
  const live = () => state.tasks.filter((t) => !t.archived && state.boards.some((b) => b.id === t.board_id));
  function filtered(tasks) {
    const q = ui.filters.query.trim().toLocaleLowerCase(), td = today(), wk = addDays(td, 7), f = ui.filters;
    return tasks.filter((t) => {
      const m = state.members.find((p) => p.id === t.assignee_id), b = state.boards.find((x) => x.id === t.board_id);
      return (!q || [t.title, t.description, b && b.name, m && m.name].some((v) => v && v.toLocaleLowerCase().includes(q))) &&
        (!f.status || t.status === f.status) && (!f.priority || t.priority === f.priority) &&
        (!f.assignee || (f.assignee === "unassigned" ? !t.assignee_id : t.assignee_id === f.assignee)) &&
        (!f.due || (f.due === "overdue" ? !!t.due_date && t.due_date < td && t.status !== "Done" : f.due === "today" ? t.due_date === td && t.status !== "Done" : f.due === "week" ? !!t.due_date && t.due_date >= td && t.due_date <= wk && t.status !== "Done" : !t.due_date));
    });
  }
  function metrics(tasks) {
    const td = today(), done = tasks.filter((t) => t.status === "Done").length;
    return { total: tasks.length, done, active: tasks.length - done, stuck: tasks.filter((t) => t.status === "Stuck").length, overdue: tasks.filter((t) => t.due_date && t.due_date < td && t.status !== "Done").length, completion: tasks.length ? Math.round((done / tasks.length) * 100) : 0 };
  }

  // ---------- UI state ----------
  const ui = { page: "overview", boardId: null, view: "table", filters: { query: "", status: "", assignee: "", priority: "", due: "" }, collapsed: [], modal: null, taskId: null, flash: null };
  let flashTimer = null;
  function flash(msg, kind) { ui.flash = { msg, kind: kind || "ok" }; renderFlash(); clearTimeout(flashTimer); flashTimer = setTimeout(() => { ui.flash = null; renderFlash(); }, kind === "error" ? 8000 : 3500); }
  function renderFlash() { const el = root.querySelector("#ops-flash"); if (!el) return; el.className = ui.flash ? "ops-flash " + (ui.flash.kind === "error" ? "err" : "ok") : "ops-flash hidden"; el.textContent = ui.flash ? ui.flash.msg : ""; }

  // ---------- rendering ----------
  const memberName = (id) => { const m = state.members.find((x) => x.id === id); return m ? m.name : "Unassigned"; };
  const avatar = (id) => { const m = state.members.find((x) => x.id === id); return m ? `<span class="ops-av" style="background:${esc(m.color)}" title="${esc(m.name)}">${esc(m.initials)}</span>` : `<span class="ops-av none" title="Unassigned">–</span>`; };
  const opts = (list, sel, labels) => list.map((v, i) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(labels ? labels[i] : v)}</option>`).join("");
  const memberOpts = (sel) => `<option value="">Unassigned</option>` + state.members.map((m) => `<option value="${esc(m.id)}"${m.id === sel ? " selected" : ""}>${esc(m.name)}</option>`).join("");

  function navHtml() {
    const b = state.boards.map((x) => `<button class="ops-nav-btn${ui.page === "board" && ui.boardId === x.id ? " on" : ""}" data-act="nav-board" data-id="${esc(x.id)}"><span class="ops-dot" style="background:${esc(x.color)}"></span>${esc(x.name)}</button>`).join("");
    return `<div class="ops-nav">
      <div class="ops-nav-row">
        <button class="ops-nav-btn${ui.page === "overview" ? " on" : ""}" data-act="nav" data-page="overview"><i class="fa-solid fa-chart-pie"></i>Overview</button>
        <button class="ops-nav-btn${ui.page === "mine" ? " on" : ""}" data-act="nav" data-page="mine"><i class="fa-solid fa-user-check"></i>My work</button>
        <button class="ops-nav-btn${ui.page === "all" ? " on" : ""}" data-act="nav" data-page="all"><i class="fa-solid fa-layer-group"></i>All work</button>
        <span class="ops-sep"></span>${b}
        <button class="ops-nav-btn add" data-act="modal-board"><i class="fa-solid fa-plus"></i>New board</button>
      </div>
      <div class="ops-nav-row right">
        <label class="ops-search"><i class="fa-solid fa-magnifying-glass"></i><input id="ops-search" type="search" aria-label="Search workspace" placeholder="Search this workspace" value="${esc(ui.filters.query)}"></label>
        <button class="ops-btn" data-act="export" title="Download all Ops Planning data as a JSON file"><i class="fa-solid fa-download"></i>Export</button>
        <button class="ops-btn" data-act="import" title="Replace Ops Planning data from a backup file"><i class="fa-solid fa-upload"></i>Import</button>
        <input id="ops-import-file" type="file" accept="application/json,.json" class="hidden">
      </div>
    </div>`;
  }
  function welcomeHtml() {
    return `<div class="ops-welcome glass">
      <div class="ops-eyebrow">A LITTLE CLARITY GOES A LONG WAY</div>
      <h3>Make space for your best work.</h3>
      <p>Bring plans, people, and the next small step together. Start with a blank board or explore a fictional launch.</p>
      <div class="ops-row center"><button class="ops-btn primary" data-act="modal-board"><i class="fa-solid fa-plus"></i>Create your first board</button>
      <button class="ops-btn" data-act="demo"><i class="fa-solid fa-wand-magic-sparkles"></i>Explore demo</button>
      <button class="ops-btn" data-act="import"><i class="fa-solid fa-upload"></i>Import a backup</button></div>
      <small>Demo content is synthetic. Nothing is imported or sent. Data is saved in this browser only.</small>
    </div>`;
  }
  function metric(label, value, note, color, drill) {
    return `<button class="ops-metric glass ${color}" data-act="drill" data-drill='${esc(JSON.stringify(drill))}'><div class="ops-mlabel">${esc(label)}</div><div class="ops-mval">${value}</div><div class="ops-mnote">${esc(note)}</div></button>`;
  }
  function overviewHtml() {
    const tasks = live(), m = metrics(tasks);
    const people = state.members.filter((p) => tasks.some((t) => t.assignee_id === p.id)).map((p) => p.id);
    if (tasks.some((t) => !t.assignee_id)) people.push("unassigned");
    const statusRows = STATUSES.map((st) => `<button class="ops-legend" data-act="drill" data-drill='${esc(JSON.stringify({ status: st }))}'><span class="ops-sdot ${statusClass(st)}"></span><span>${esc(st)}</span><strong>${tasks.filter((t) => t.status === st).length}</strong></button>`).join("");
    const work = people.map((id) => { const c = tasks.filter((t) => (id === "unassigned" ? !t.assignee_id : t.assignee_id === id) && t.status !== "Done").length; const mem = state.members.find((x) => x.id === id); return `<button class="ops-work" data-act="drill" data-drill='${esc(JSON.stringify({ assignee: id }))}'>${avatar(id === "unassigned" ? null : id)}<span>${esc(id === "unassigned" ? "Unassigned" : memberName(id))}</span><div class="ops-bar"><span style="width:${m.active ? (c / m.active) * 100 : 0}%;background:${esc(mem ? mem.color : "#64748b")}"></span></div><strong>${c}</strong></button>`; }).join("") || `<p class="ops-muted">Add a task to see your workload.</p>`;
    const boards = state.boards.map((b) => { const bm = metrics(tasks.filter((t) => t.board_id === b.id)); return `<button class="ops-bsum" data-act="nav-board" data-id="${esc(b.id)}"><span class="ops-dot lg" style="background:${esc(b.color)}"></span><div class="grow"><strong>${esc(b.name)}</strong><small>${bm.total} tasks · ${bm.done} completed</small><div class="ops-bar"><span style="width:${bm.completion}%;background:${esc(b.color)}"></span></div></div><span class="ops-pct">${bm.completion}%</span></button>`; }).join("");
    const acts = state.activity.slice(0, 5).map((a) => `<div class="ops-act"><i class="fa-solid ${a.action.includes("Automation") ? "fa-bolt" : a.action.includes("Update") ? "fa-comment" : "fa-check"}"></i><div class="grow"><strong>${esc(a.action)}</strong><p>${esc(a.detail)}</p></div><small>${esc(relative(a.created_at))}</small></div>`).join("") || `<p class="ops-muted">Your story starts with the first task.</p>`;
    return `<div class="ops-head"><div><div class="ops-eyebrow">THE BIG PICTURE</div><h3>A little clarity. A lot of possibility.</h3><p>Here’s how your work is moving, all in one place.</p></div><button class="ops-btn primary" data-act="modal-board"><i class="fa-solid fa-plus"></i>New board</button></div>
      <div class="ops-metrics">${metric("Total tasks", m.total, state.boards.length + (state.boards.length === 1 ? " board" : " boards") + " in your workspace", "purple", {})}${metric("Completed", m.done, m.completion + "% of work completed", "green", { status: "Done" })}${metric("Overdue", m.overdue, "A little attention goes a long way", "orange", { due: "overdue" })}${metric("Needs a hand", m.stuck, "Tasks currently marked stuck", "pink", { status: "Stuck" })}</div>
      <div class="ops-grid2"><section class="glass ops-panel"><div class="ops-ph"><h4>Work, in motion</h4><span>${m.total} tasks</span></div><div class="ops-status"><div class="ops-donut" role="img" aria-label="${m.completion}% complete, ${m.done} of ${m.total} tasks done" style="background:conic-gradient(#14b8a6 0 ${m.completion}%, rgba(148,163,184,.18) ${m.completion}% 100%)"><div><strong>${m.completion}%</strong><small>complete</small></div></div><div class="ops-legends">${statusRows}</div></div></section>
      <section class="glass ops-panel"><div class="ops-ph"><h4>On everyone’s plate</h4><span>Active tasks</span></div>${work}</section></div>
      <div class="ops-grid2"><section class="glass ops-panel"><div class="ops-ph"><h4>Your boards</h4><button class="ops-link" data-act="modal-board">Create board <i class="fa-solid fa-plus"></i></button></div>${boards}</section>
      <section class="glass ops-panel"><div class="ops-ph"><h4>Latest movement</h4><span>Activity in this browser</span></div>${acts}</section></div>`;
  }
  function filtersHtml() {
    const f = ui.filters;
    return `<div class="ops-toolbar"><button class="ops-btn primary" data-act="new-task"><i class="fa-solid fa-plus"></i>New task</button><span class="ops-muted"><i class="fa-solid fa-filter"></i> Filter</span>
      <select data-filter="status" aria-label="Filter by status"><option value="">All statuses</option>${opts(STATUSES, f.status)}</select>
      <select data-filter="assignee" aria-label="Filter by person"><option value="">All people</option><option value="unassigned"${f.assignee === "unassigned" ? " selected" : ""}>Unassigned</option>${state.members.map((m) => `<option value="${esc(m.id)}"${m.id === f.assignee ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
      <select data-filter="priority" aria-label="Filter by priority"><option value="">All priorities</option>${opts(PRIORITIES, f.priority)}</select>
      <select data-filter="due" aria-label="Filter by due date"><option value="">Any due date</option>${opts(["overdue", "today", "week", "none"], f.due, ["Overdue", "Due today", "Next 7 days", "No due date"])}</select>
      ${Object.values(f).some(Boolean) ? `<button class="ops-link" data-act="clear-filters">Clear filters</button>` : ""}</div>`;
  }
  function rowHtml(t, showBoard) {
    const n = state.comments.filter((c) => c.task_id === t.id).length, b = state.boards.find((x) => x.id === t.board_id);
    return `<tr class="ops-tr" data-task="${esc(t.id)}"><td class="ops-tname"><button class="ops-tlink" data-act="open-task" data-id="${esc(t.id)}" aria-label="Open ${esc(t.title)}">${esc(t.title)}</button>${showBoard && b ? `<small class="ops-muted">${esc(b.name)}</small>` : ""}</td>
      <td><select data-tfield="assigneeId" data-id="${esc(t.id)}" aria-label="Assignee for ${esc(t.title)}">${memberOpts(t.assignee_id)}</select></td>
      <td><select class="ops-pill ${statusClass(t.status)}" data-tfield="status" data-id="${esc(t.id)}" aria-label="Status for ${esc(t.title)}">${opts(STATUSES, t.status)}</select></td>
      <td><input type="date" data-tfield="dueDate" data-id="${esc(t.id)}" value="${esc(t.due_date || "")}" aria-label="Due date for ${esc(t.title)}" class="${t.due_date && t.due_date < today() && t.status !== "Done" ? "overdue" : ""}"></td>
      <td><select class="ops-pill ${prioClass(t.priority)}" data-tfield="priority" data-id="${esc(t.id)}" aria-label="Priority for ${esc(t.title)}">${opts(PRIORITIES, t.priority)}</select></td>
      <td><button class="ops-upd" data-act="open-task" data-id="${esc(t.id)}" aria-label="Updates for ${esc(t.title)}"><i class="fa-regular fa-comment"></i> ${n}</button></td></tr>`;
  }
  const thead = `<thead><tr><th>Task</th><th>Person</th><th>Status</th><th>Due date</th><th>Priority</th><th>Updates</th></tr></thead>`;
  function tableHtml(tasks) {
    if (ui.page !== "board") return tasks.length ? `<div class="ops-tscroll glass"><table class="ops-table">${thead}<tbody>${tasks.map((t) => rowHtml(t, true)).join("")}</tbody></table></div>` : emptyHtml();
    const groups = state.groups.filter((g) => g.board_id === ui.boardId).sort((a, b) => a.position - b.position);
    return groups.map((g) => {
      const gt = tasks.filter((t) => t.group_id === g.id), col = ui.collapsed.includes(g.id);
      return `<section class="ops-group" data-group="${esc(g.id)}"><div class="ops-gh" style="--gc:${esc(g.color)}"><button class="ops-link" data-act="collapse" data-id="${esc(g.id)}" aria-label="${col ? "Expand" : "Collapse"} ${esc(g.name)}"><i class="fa-solid ${col ? "fa-chevron-right" : "fa-chevron-down"}"></i></button><h4>${esc(g.name)}</h4><span class="ops-muted">${gt.length} tasks</span><button class="ops-link" data-act="new-task" data-group="${esc(g.id)}" aria-label="Add task to ${esc(g.name)}"><i class="fa-solid fa-plus"></i></button></div>
        ${col ? "" : `<div class="ops-tscroll glass"><table class="ops-table">${thead}<tbody>${gt.map((t) => rowHtml(t)).join("") || `<tr><td colspan="6" class="ops-muted">No tasks here yet.</td></tr>`}<tr><td colspan="6"><button class="ops-link" data-act="new-task" data-group="${esc(g.id)}"><i class="fa-solid fa-plus"></i> Add task</button></td></tr></tbody></table></div>`}</section>`;
    }).join("") + `<button class="ops-btn" data-act="modal-group"><i class="fa-solid fa-plus"></i>Add group</button>`;
  }
  function kanbanHtml(tasks) {
    return `<div class="ops-kanban">${STATUSES.map((st) => { const col = tasks.filter((t) => t.status === st); return `<section class="ops-kcol" data-drop-status="${esc(st)}" aria-label="${esc(st)}"><div class="ops-kh"><span class="ops-sdot ${statusClass(st)}"></span><h4>${esc(st)}</h4><span class="ops-muted">${col.length}</span>${ui.page === "board" ? `<button class="ops-link" data-act="new-task" data-status="${esc(st)}" aria-label="Create ${esc(st)} task"><i class="fa-solid fa-plus"></i></button>` : ""}</div>
      <div class="ops-kcards">${col.map((t) => { const b = state.boards.find((x) => x.id === t.board_id), g = state.groups.find((x) => x.id === t.group_id); return `<article class="ops-card glass" draggable="true" data-card="${esc(t.id)}"><div class="ops-ctop"><span class="ops-pill ${prioClass(t.priority)}">${esc(t.priority)}</span><small class="ops-muted">${esc(ui.page === "board" ? (g ? g.name : "") : (b ? b.name : ""))}</small></div><button class="ops-tlink" data-act="open-task" data-id="${esc(t.id)}">${esc(t.title)}</button><div class="ops-cfoot">${avatar(t.assignee_id)}<small class="${t.due_date && t.due_date < today() && t.status !== "Done" ? "overdue" : "ops-muted"}">${esc(t.due_date || "No due date")}</small><select data-tfield="status" data-id="${esc(t.id)}" aria-label="Status for ${esc(t.title)}">${opts(STATUSES, t.status)}</select></div></article>`; }).join("") || `<div class="ops-muted ops-kempty">Drop a task here</div>`}</div></section>`; }).join("")}</div>`;
  }
  function emptyHtml() { const any = Object.values(ui.filters).some(Boolean); return `<div class="ops-empty glass"><i class="fa-solid ${any ? "fa-magnifying-glass" : "fa-circle"}"></i><h4>${any ? "No tasks match these filters" : "Nothing here yet"}</h4><p class="ops-muted">${any ? "Try clearing a filter or searching for something else." : "Create a task to get started."}</p>${any ? `<button class="ops-btn" data-act="clear-filters">Clear filters</button>` : ""}</div>`; }
  function workHtml() {
    const board = state.boards.find((b) => b.id === ui.boardId);
    let base = live();
    if (ui.page === "board") base = base.filter((t) => t.board_id === ui.boardId);
    if (ui.page === "mine") base = base.filter((t) => t.assignee_id === ME.id);
    const vis = filtered(base), bm = metrics(base);
    const auto = board && state.automations.find((a) => a.board_id === board.id);
    const head = ui.page === "board" && board
      ? `<div><div class="ops-row"><span class="ops-dot lg" style="background:${esc(board.color)}"></span><h3 id="ops-board-title">${esc(board.name)}</h3><button class="ops-link" data-act="modal-edit-board" aria-label="Edit board"><i class="fa-solid fa-pen"></i></button></div><p>${esc(board.description || "A shared place for your next great idea.")}</p></div>
         <div class="ops-row"><button class="ops-btn${auto && auto.enabled ? " on" : ""}" data-act="modal-automation"><i class="fa-solid fa-bolt"></i>Automation <span class="ops-badge">${auto && auto.enabled ? 1 : 0}</span></button></div>`
      : `<div><div class="ops-eyebrow">${ui.page === "mine" ? "YOUR NEXT SMALL STEP" : "EVERYTHING, TOGETHER"}</div><h3>${ui.page === "mine" ? "My work" : "All work"}</h3><p>${ui.page === "mine" ? "A clear view of the tasks assigned to you." : "Search and filter every board in this workspace."}</p></div>`;
    return `<div class="ops-head">${head}</div>
      <div class="ops-views"><button class="ops-vbtn${ui.view === "table" ? " on" : ""}" data-act="view" data-view="table"><i class="fa-solid fa-table-list"></i>Table</button><button class="ops-vbtn${ui.view === "kanban" ? " on" : ""}" data-act="view" data-view="kanban"><i class="fa-solid fa-table-columns"></i>Kanban</button><span class="ops-muted">${ui.page === "board" ? bm.done + " of " + bm.total + " done" : vis.length + " tasks"}</span></div>
      ${filtersHtml()}${ui.view === "table" ? (vis.length || (ui.page === "board" && !Object.values(ui.filters).some(Boolean)) ? tableHtml(vis) : emptyHtml()) : kanbanHtml(vis)}`;
  }
  function colorPicker(sel) { return `<div class="ops-colors" role="radiogroup" aria-label="Choose a color">${COLORS.map((c) => `<label style="background:${c}"><input type="radio" name="color" value="${c}"${c === (sel || COLORS[0]) ? " checked" : ""} aria-label="${c}"></label>`).join("")}</div>`; }
  function modalHtml() {
    const m = ui.modal; if (!m) return "";
    let title = "", body = "", submit = "Save";
    if (m.kind === "board" || m.kind === "editBoard") {
      const b = m.kind === "editBoard" ? state.boards.find((x) => x.id === ui.boardId) : null;
      title = b ? "Edit board" : "Create a board"; submit = b ? "Save changes" : "Create board";
      body = `<label>Board name<input name="name" required maxlength="80" value="${esc(b ? b.name : "")}" placeholder="e.g. Q4 launch"></label><label>Description <span class="ops-muted">optional</span><textarea name="description" maxlength="2000" placeholder="A little context helps everyone move forward.">${esc(b ? b.description : "")}</textarea></label><div>Choose a color</div>${colorPicker(b && b.color)}`;
    } else if (m.kind === "group") {
      title = "Add group"; submit = "Add group";
      body = `<label>Group name<input name="name" required maxlength="80" placeholder="e.g. Ready for review"></label><div>Choose a color</div>${colorPicker(COLORS[3])}`;
    } else if (m.kind === "task") {
      const groups = state.groups.filter((g) => g.board_id === m.boardId).sort((a, b) => a.position - b.position);
      title = "New task"; submit = "Create task";
      body = `<label>Task title<input name="title" required maxlength="200" placeholder="What needs to happen?"></label><label>Description <span class="ops-muted">optional</span><textarea name="description" maxlength="10000" placeholder="Add a little context…"></textarea></label>
        <div class="ops-form2"><label>Board<select name="boardId" data-act-change="task-board">${state.boards.map((b) => `<option value="${esc(b.id)}"${b.id === m.boardId ? " selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label><label>Group<select name="groupId">${groups.map((g) => `<option value="${esc(g.id)}"${g.id === m.groupId ? " selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>
        <label>Status<select name="status">${opts(STATUSES, m.status || "Not started")}</select></label><label>Priority<select name="priority">${opts(PRIORITIES, "Medium")}</select></label>
        <label>Person<select name="assigneeId">${memberOpts(ui.page === "mine" ? ME.id : "")}</select></label><label>Due date<input type="date" name="dueDate"></label></div>`;
    } else if (m.kind === "automation") {
      const a = state.automations.find((x) => x.board_id === ui.boardId) || {}, groups = state.groups.filter((g) => g.board_id === ui.boardId);
      title = "Automation"; submit = "Save automation";
      body = `<p class="ops-muted">When a task's status changes to <strong>Done</strong>, move it to the chosen group. It runs once per change and is off until you turn it on.</p><label class="ops-check"><input type="checkbox" name="enabled"${a.enabled ? " checked" : ""}> Turn on this automation</label><label>Move to group<select name="target">${groups.map((g) => `<option value="${esc(g.id)}"${g.id === a.target_group_id ? " selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>`;
    }
    return `<div class="ops-overlay" data-act="close-modal-bg"><form class="ops-modal glass" id="ops-form" data-kind="${esc(m.kind)}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="ops-mh"><h4>${esc(title)}</h4><button type="button" class="ops-link" data-act="close-modal" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="ops-mb">${body}<div class="ops-ferr hidden" id="ops-ferr" role="alert"></div></div><div class="ops-mf"><button type="button" class="ops-btn" data-act="close-modal">Cancel</button><button class="ops-btn primary" type="submit">${esc(submit)}</button></div></form></div>`;
  }
  function drawerHtml() {
    const t = state.tasks.find((x) => x.id === ui.taskId && !x.archived); if (!t) return "";
    const groups = state.groups.filter((g) => g.board_id === t.board_id).sort((a, b) => a.position - b.position), b = state.boards.find((x) => x.id === t.board_id);
    const comments = state.comments.filter((c) => c.task_id === t.id).sort((a, c) => a.created_at.localeCompare(c.created_at));
    const acts = state.activity.filter((a) => a.task_id === t.id).slice(0, 20);
    return `<div class="ops-overlay right" data-act="close-drawer-bg"><aside class="ops-drawer glass" role="dialog" aria-modal="true" aria-label="Task details">
      <div class="ops-mh"><small class="ops-muted">${esc(b ? b.name : "")}</small><button class="ops-link" data-act="close-drawer" aria-label="Close task"><i class="fa-solid fa-xmark"></i></button></div>
      <input class="ops-dtitle" id="ops-dtitle" maxlength="200" value="${esc(t.title)}" aria-label="Task title">
      <textarea id="ops-ddesc" maxlength="10000" placeholder="Add a little context…" aria-label="Description">${esc(t.description)}</textarea>
      <div class="ops-row end"><button class="ops-btn" data-act="save-text" data-id="${esc(t.id)}">Save title &amp; description</button></div>
      <div class="ops-form2">
        <label>Status<select data-tfield="status" data-id="${esc(t.id)}" aria-label="Task status">${opts(STATUSES, t.status)}</select></label>
        <label>Person<select data-tfield="assigneeId" data-id="${esc(t.id)}" aria-label="Task assignee">${memberOpts(t.assignee_id)}</select></label>
        <label>Due date<input type="date" data-tfield="dueDate" data-id="${esc(t.id)}" value="${esc(t.due_date || "")}" aria-label="Task due date"></label>
        <label>Priority<select data-tfield="priority" data-id="${esc(t.id)}" aria-label="Task priority">${opts(PRIORITIES, t.priority)}</select></label>
        <label>Group<select data-tfield="groupId" data-id="${esc(t.id)}" aria-label="Task group">${groups.map((g) => `<option value="${esc(g.id)}"${g.id === t.group_id ? " selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>
      </div>
      <h5>Updates</h5>
      <div class="ops-comments">${comments.map((c) => `<div class="ops-comment">${avatar(c.user_id)}<div><div><strong>${esc(memberName(c.user_id))}</strong> <small class="ops-muted">${esc(relative(c.created_at))}</small></div><p>${esc(c.body)}</p></div></div>`).join("") || `<p class="ops-muted">No updates yet.</p>`}</div>
      <form id="ops-cform" class="ops-cform"><textarea name="body" maxlength="5000" required placeholder="Share an update, ask a question, add a little context…" aria-label="Write an update"></textarea><button class="ops-btn primary" type="submit">Post update</button></form>
      <h5>Activity</h5><div class="ops-alist">${acts.map((a) => `<div class="ops-act sm"><div class="grow"><strong>${esc(a.action)}</strong><p>${esc(a.detail)}</p></div><small>${esc(relative(a.created_at))}</small></div>`).join("")}</div>
      <div class="ops-row end"><button class="ops-btn danger" data-act="archive" data-id="${esc(t.id)}"><i class="fa-solid fa-box-archive"></i>Archive task</button></div>
    </aside></div>`;
  }
  function render() {
    if (ui.page === "board" && !state.boards.some((b) => b.id === ui.boardId)) ui.page = "overview";
    const focusId = document.activeElement && document.activeElement.id === "ops-search" ? "ops-search" : null;
    const caret = focusId ? document.activeElement.selectionStart : null;
    root.innerHTML = `${storageError ? `<div class="ops-flash err">${esc(storageError)}</div>` : ""}<div id="ops-flash" class="ops-flash hidden" role="status" aria-live="polite"></div>
      ${navHtml()}<div class="ops-main">${!state.boards.length ? welcomeHtml() : ui.page === "overview" ? overviewHtml() : workHtml()}</div>${modalHtml()}${drawerHtml()}`;
    renderFlash();
    if (focusId) { const el = root.querySelector("#ops-search"); el.focus(); try { el.setSelectionRange(caret, caret); } catch (e) {} }
    if (ui.modal) { const first = root.querySelector("#ops-form input:not([type=radio]), #ops-form select"); if (first) first.focus(); }
    const counter = document.getElementById("ops-count"); if (counter) counter.textContent = live().length;
  }

  // ---------- events ----------
  function openModal(m) { ui.modal = m; render(); }
  function closeModal() { ui.modal = null; render(); }
  function newTask(groupId, status) {
    let boardId = ui.page === "board" ? ui.boardId : (state.boards[0] && state.boards[0].id);
    if (!boardId) return openModal({ kind: "board" });
    const g = groupId || (state.groups.filter((x) => x.board_id === boardId).sort((a, b) => a.position - b.position)[0] || {}).id;
    openModal({ kind: "task", boardId, groupId: g, status });
  }
  root.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]"); if (!el || !root.contains(el)) return;
    const act = el.dataset.act;
    if (act === "close-modal-bg" && e.target !== el) return;
    if (act === "close-drawer-bg" && e.target !== el) return;
    switch (act) {
      case "nav": ui.page = el.dataset.page; ui.boardId = null; render(); break;
      case "nav-board": ui.page = "board"; ui.boardId = el.dataset.id; render(); break;
      case "view": ui.view = el.dataset.view; render(); break;
      case "drill": ui.filters = Object.assign({ query: "", status: "", assignee: "", priority: "", due: "" }, JSON.parse(el.dataset.drill)); ui.page = "all"; render(); break;
      case "clear-filters": ui.filters = { query: "", status: "", assignee: "", priority: "", due: "" }; render(); break;
      case "collapse": { const id = el.dataset.id; ui.collapsed = ui.collapsed.includes(id) ? ui.collapsed.filter((x) => x !== id) : ui.collapsed.concat(id); render(); break; }
      case "modal-board": openModal({ kind: "board" }); break;
      case "modal-edit-board": openModal({ kind: "editBoard" }); break;
      case "modal-group": openModal({ kind: "group" }); break;
      case "modal-automation": openModal({ kind: "automation" }); break;
      case "new-task": newTask(el.dataset.group, el.dataset.status); break;
      case "close-modal": case "close-modal-bg": closeModal(); break;
      case "open-task": ui.taskId = el.dataset.id; render(); break;
      case "close-drawer": case "close-drawer-bg": ui.taskId = null; render(); break;
      case "demo": if (await commit((s) => seedDemo(s))) { ui.page = "board"; ui.boardId = "demo-launch-board"; render(); } break;
      case "save-text": { const id = el.dataset.id; const title = root.querySelector("#ops-dtitle").value, description = root.querySelector("#ops-ddesc").value; if (await commit((s) => updateTask(s, id, { title, description }))) flash("Saved."); break; }
      case "archive": { const id = el.dataset.id; if (!confirm("Archive this task? It will be hidden from boards (kept in backups).")) break; if (await commit((s) => { const t = s.tasks.find((x) => x.id === id); t.archived = true; t.updated_at = nowIso(); log(s, t.board_id, t.id, "Task archived", t.title); })) { ui.taskId = null; render(); flash("Task archived."); } break; }
      case "export": exportData(); break;
      case "import": root.querySelector("#ops-import-file").click(); break;
    }
  });
  root.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.id === "ops-import-file") { const f = el.files && el.files[0]; el.value = ""; if (f) await importData(f); return; }
    if (el.dataset.filter) { ui.filters[el.dataset.filter] = el.value; render(); return; }
    if (el.dataset.tfield) { const id = el.dataset.id, key = el.dataset.tfield, val = el.value; await commit((s) => updateTask(s, id, { [key]: val })); return; }
    if (el.dataset.actChange === "task-board") { const form = el.form, gs = state.groups.filter((g) => g.board_id === el.value).sort((a, b) => a.position - b.position); form.groupId.innerHTML = gs.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join(""); }
  });
  root.addEventListener("input", (e) => { if (e.target.id === "ops-search") { ui.filters.query = e.target.value; if (ui.page === "overview" || !state.boards.length) { if (e.target.value) ui.page = "all"; } render(); } });
  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.id === "ops-cform") { const body = form.body.value, id = ui.taskId; await commit((s) => { const t = s.tasks.find((x) => x.id === id); const b = clean(body, "Update", 5000); s.comments.push({ id: uid(), task_id: id, user_id: ME.id, body: b, created_at: nowIso() }); log(s, t.board_id, id, "Update posted", b.length > 100 ? b.slice(0, 100) + "…" : b); }); return; }
    if (form.id !== "ops-form") return;
    const fd = new FormData(form), kind = form.dataset.kind, v = (k) => (fd.get(k) == null ? "" : String(fd.get(k)));
    const showErr = (msg) => { const el = root.querySelector("#ops-ferr"); el.textContent = msg; el.classList.remove("hidden"); };
    const draft = JSON.parse(JSON.stringify(state));
    let after = null;
    try {
      if (kind === "board") { const id = createBoard(draft, v("name"), v("description"), v("color")); after = () => { ui.page = "board"; ui.boardId = id; }; }
      else if (kind === "editBoard") { const b = draft.boards.find((x) => x.id === ui.boardId); b.name = clean(v("name"), "Board name", 80); b.description = clean(v("description"), "Description", 2000, false); b.color = oneOf(v("color"), COLORS, "board color"); log(draft, b.id, null, "Board updated", b.name); }
      else if (kind === "group") { const pos = draft.groups.filter((g) => g.board_id === ui.boardId).reduce((m, g) => Math.max(m, g.position), -1) + 1; const name = clean(v("name"), "Group name", 80); draft.groups.push({ id: uid(), board_id: ui.boardId, name, color: oneOf(v("color") || COLORS[3], COLORS, "color"), position: pos, system_kind: null }); log(draft, ui.boardId, null, "Group added", name); }
      else if (kind === "task") { createTask(draft, { boardId: v("boardId"), groupId: v("groupId"), title: v("title"), description: v("description"), status: v("status"), priority: v("priority"), assigneeId: v("assigneeId"), dueDate: v("dueDate") }); }
      else if (kind === "automation") { const a = draft.automations.find((x) => x.board_id === ui.boardId); const target = draft.groups.find((g) => g.id === v("target") && g.board_id === ui.boardId); if (!target) throw new Error("Choose a group."); a.target_group_id = target.id; a.enabled = fd.get("enabled") === "on"; log(draft, ui.boardId, null, "Automation " + (a.enabled ? "enabled" : "disabled"), a.enabled ? "Enabled: Done → " + target.name : "Disabled: Done → move group"); }
    } catch (err) { showErr(err.message || String(err)); return; }
    if (await commit((s) => Object.assign(s, draft))) { ui.modal = null; if (after) after(); render(); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (ui.modal || ui.taskId) && !document.getElementById("view-ops").classList.contains("hidden")) { ui.modal = null; ui.taskId = null; render(); } });
  // Kanban drag & drop: drop a card on a status column to change its status
  root.addEventListener("dragstart", (e) => { const c = e.target.closest && e.target.closest("[data-card]"); if (c) { e.dataTransfer.setData("text/task-id", c.dataset.card); e.dataTransfer.effectAllowed = "move"; c.classList.add("dragging"); } });
  root.addEventListener("dragend", (e) => { const c = e.target.closest && e.target.closest("[data-card]"); if (c) c.classList.remove("dragging"); });
  root.addEventListener("dragover", (e) => { const col = e.target.closest && e.target.closest("[data-drop-status]"); if (col) { e.preventDefault(); col.classList.add("over"); } });
  root.addEventListener("dragleave", (e) => { const col = e.target.closest && e.target.closest("[data-drop-status]"); if (col && !col.contains(e.relatedTarget)) col.classList.remove("over"); });
  root.addEventListener("drop", async (e) => {
    const col = e.target.closest && e.target.closest("[data-drop-status]"); if (!col) return; e.preventDefault(); col.classList.remove("over");
    const id = e.dataTransfer.getData("text/task-id"), st = col.dataset.dropStatus; const t = state.tasks.find((x) => x.id === id);
    if (t && t.status !== st) await commit((s) => updateTask(s, id, { status: st }));
  });

  // ---------- export / import ----------
  function exportData() {
    const data = Object.assign({}, state, { format: FORMAT, version: 1, exported_at: nowIso() });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "ops-planning-backup-" + today() + ".json"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash("Backup downloaded (" + live().length + " tasks, " + state.boards.length + " boards).");
  }
  async function importData(file) {
    if (file.size > 50 * 1024 * 1024) { flash("That file is too large to be an Ops Planning backup.", "error"); return; }
    let parsed;
    try { parsed = validateImport(JSON.parse(await file.text())); } catch (err) { flash("Import failed: " + (err instanceof SyntaxError ? "the file isn't valid JSON." : err.message), "error"); return; }
    const has = state.boards.length > 0;
    if (has && !confirm("Replace all Ops Planning data in this browser with the backup (" + parsed.boards.length + " boards, " + parsed.tasks.filter((t) => !t.archived).length + " tasks)? Export first if you want to keep the current data.")) return;
    if (await commit((s) => { Object.keys(s).forEach((k) => delete s[k]); Object.assign(s, parsed); })) { ui.page = "overview"; ui.boardId = null; ui.taskId = null; render(); flash("Imported " + parsed.boards.length + " boards and " + parsed.tasks.filter((t) => !t.archived).length + " tasks."); }
  }

  // ---------- init ----------
  (async function init() {
    try {
      db = await openDB();
      const saved = await idbGet();
      if (saved) { try { state = validateImport(saved); } catch (e) { storageError = "Saved Ops Planning data couldn't be read: " + e.message; } }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (err) { storageError = "This browser blocked storage (private mode can do this). Ops Planning changes won't be saved."; }
    render();
  })();
  window.__opsPlanning = { get state() { return state; } };
})();
