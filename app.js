/* ============================================================
   LOADOUT — app.js
   This file is written with comments because you said you want
   to learn while building. Read top to bottom; it runs in order.
   ============================================================ */

// ---------- 1. STATE ----------
// Everything the app remembers lives in one object, then we save
// that whole object to localStorage every time it changes.
// localStorage only stores strings, so we JSON.stringify/parse.

const STORAGE_KEY = "loadout-state-v1";

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) return JSON.parse(raw);

  // Default starter data on first run, so the app isn't empty.
  return {
    activeModule: "today",
    training: {
      lifts: [
        { name: "Squat", workingWeight: "", workingReps: 5 },
        { name: "Bench", workingWeight: "", workingReps: 5 },
        { name: "Deadlift", workingWeight: "", workingReps: 5 },
      ],
      unit: "lb",
      barWeight: 45,
      sheetUrl: "",
      sheetTabs: [],   // [{name: "Week 1", gid: "0"}, ...] discovered from pubhtml
      activeGid: "",   // which tab is currently selected for sync
      sessions: [
        { id: cryptoId(), text: "Import your program from Excel", done: false },
      ],
    },
    admin: [
      { id: cryptoId(), text: "Confirm fall tuition due date", done: false },
      { id: cryptoId(), text: "Check financial aid disbursement", done: false },
    ],
    tasks: [
      { id: cryptoId(), text: "Add your first task", done: false },
    ],
  };
}

function cryptoId() {
  return Math.random().toString(36).slice(2, 9);
}

let state = loadState();

// Safety net: if state was saved before the warmup calculator existed,
// upgrade the old lift shape so the app doesn't break.
if (state.training.lifts.some((l) => l.value !== undefined)) {
  state.training.lifts = state.training.lifts.map((l) => ({
    name: l.name,
    workingWeight: "",
    workingReps: 5,
  }));
  state.training.unit = state.training.unit || "lb";
  state.training.barWeight = state.training.barWeight || 45;
  state.training.sheetTabs = state.training.sheetTabs || [];
  state.training.activeGid = state.training.activeGid || "";
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- WARMUP CALCULATOR ----------
// Standard percentage-based ramp toward a working weight.
// Reps taper down as the weight climbs, which is the usual pattern
// lifters use: build up CNS/joint readiness without burning gas
// before the working set.
const WARMUP_SCHEME = [
  { pct: 0.4, reps: 5 },
  { pct: 0.55, reps: 3 },
  { pct: 0.7, reps: 2 },
  { pct: 0.85, reps: 1 },
];

// Rounds to the nearest loadable increment (2.5kg / 5lb per side
// jumps = 5kg / 10lb total), so every number is one you can actually
// put on the bar with standard plates.
function roundToIncrement(weight, unit) {
  const increment = unit === "kg" ? 5 : 10;
  return Math.round(weight / increment) * increment;
}

function generateWarmups(workingWeight, unit, barWeight) {
  const w = Number(workingWeight);
  if (!w || w <= 0) return [];

  const sets = [{ label: "Bar", weight: barWeight, reps: 8 }];

  WARMUP_SCHEME.forEach((step) => {
    let weight = roundToIncrement(w * step.pct, unit);
    weight = Math.max(weight, barWeight); // never below an empty bar
    if (weight < w) {
      sets.push({ label: `${Math.round(step.pct * 100)}%`, weight, reps: step.reps });
    }
  });

  sets.push({ label: "Work set", weight: w, reps: null });
  return sets;
}

// ---------- GOOGLE SHEETS SYNC ----------
// Two-step flow:
//  1. User pastes CSV URL → clicks "Load Tabs" → app fetches the
//     pubhtml and finds each sheet tab + its gid number.
//  2. Tabs appear as buttons → user picks a week → clicks Sync →
//     app fetches that tab's CSV and pulls Squat/Bench/Deadlift weights.
//
// NOTE: fetch() to Google Sheets is blocked inside Claude's preview
// sandbox. Everything works normally once deployed to GitHub Pages /
// Netlify. The status bar will tell you if that's the issue.

const LIFT_ALIASES = {
  Squat:    ["squat", "squats"],
  Bench:    ["bench"],
  Deadlift: ["deadlift"],
};

function parseCsv(text) {
  return text.trim().split("\n").map((line) => {
    const cells = [];
    let inQuote = false, cell = "";
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === "," && !inQuote) { cells.push(cell.trim()); cell = ""; }
      else cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  });
}

function hasPercent(val) {
  return /\d+(%|rpe)/i.test(val || "");
}

// Build the pubhtml URL from a CSV pub URL so we can discover tabs.
function toPubHtmlUrl(csvUrl) {
  const base = csvUrl.match(/(https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[^\/]+\/pub)/)?.[1];
  return base ? base + "html?widget=true&headers=false" : null;
}

// Build a per-tab CSV URL by injecting gid into the base pub URL.
function toCsvUrl(csvUrl, gid) {
  const base = csvUrl.match(/(https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[^\/]+\/pub)/)?.[1];
  if (!base) return csvUrl;
  return gid
    ? `${base}?gid=${gid}&single=true&output=csv`
    : `${base}?output=csv`;
}

async function discoverTabs(rawUrl) {
  const url = rawUrl.trim();
  const statusEl = document.getElementById("sheet-sync-status");
  const tabsRow = document.getElementById("sheet-tabs-row");

  statusEl.textContent = "Looking for tabs in your sheet…";
  statusEl.className = "sheet-sync-status";
  tabsRow.innerHTML = "";

  if (!url) {
    statusEl.textContent = "Paste your 'Publish to web' CSV link first.";
    statusEl.classList.add("is-error");
    return;
  }

  const htmlUrl = toPubHtmlUrl(url);
  if (!htmlUrl) {
    statusEl.textContent = "Couldn't parse that URL — make sure it's a Google Sheets publish link.";
    statusEl.classList.add("is-error");
    return;
  }

  try {
    const res = await fetch(htmlUrl);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const html = await res.text();

    const tabs = [];
    const seen = new Set();

    // Google pubhtml tab nav: <li ... id="tapanel_GIDNUMBER">Tab Name</li>
    const panelRe = /id="tapanel_(\d+)"[^>]*>\s*([^<\n]+?)\s*</g;
    let m;
    while ((m = panelRe.exec(html)) !== null) {
      const gid = m[1], name = m[2].trim();
      if (!seen.has(gid) && name) { seen.add(gid); tabs.push({ name, gid }); }
    }

    // Fallback: href anchors like href="...pub?gid=12345..."
    if (tabs.length === 0) {
      const hrefRe = /href="[^"]*[?&]gid=(\d+)[^"#]*"[^>]*>\s*([^<]+?)\s*</g;
      while ((m = hrefRe.exec(html)) !== null) {
        const gid = m[1], name = m[2].trim();
        if (!seen.has(gid) && name && name.length < 40) {
          seen.add(gid); tabs.push({ name, gid });
        }
      }
    }

    if (tabs.length === 0) {
      // Can't auto-detect — offer manual fallback
      statusEl.textContent =
        "Couldn't auto-detect tabs. Use the manual week buttons below, or make sure your sheet is published.";
      statusEl.classList.add("is-error");
      showManualWeekFallback(url);
      return;
    }

    state.training.sheetUrl  = url;
    state.training.sheetTabs = tabs;
    state.training.activeGid = tabs[0].gid;
    saveState();
    renderTabSelector();
    statusEl.textContent = `Found ${tabs.length} tab(s) — pick a week, then hit Sync.`;
    statusEl.classList.add("is-ok");

  } catch (err) {
    const isNetworkBlock = err.message.includes("Failed to fetch") || err.message.includes("NetworkError");
    statusEl.textContent = isNetworkBlock
      ? "⚠️ Fetch blocked — this works once the app is deployed (GitHub Pages / Netlify). The preview sandbox blocks external requests."
      : `Couldn't load tabs: ${err.message}`;
    statusEl.classList.add("is-error");
  }
}

// If auto-discovery fails, show simple Week 1–5 buttons so the user
// can at least pick a week manually (they'll need the first tab's CSV
// URL already saved, and we'll derive others via gid=0,1,2…).
// This is a best-effort fallback; gid numbers aren't always sequential.
function showManualWeekFallback(url) {
  const tabsRow = document.getElementById("sheet-tabs-row");
  const weeks = ["Week 1","Week 2","Week 3","Week 4","Week 5"];
  state.training.sheetUrl  = url;
  state.training.sheetTabs = weeks.map((name, i) => ({ name, gid: String(i) }));
  state.training.activeGid = "0";
  saveState();
  renderTabSelector();
}

function renderTabSelector() {
  const tabsRow = document.getElementById("sheet-tabs-row");
  const { sheetTabs, activeGid } = state.training;

  if (!sheetTabs.length) { tabsRow.innerHTML = ""; return; }

  tabsRow.innerHTML = sheetTabs
    .map(
      (t) => `
      <button
        class="week-tab-btn ${t.gid === activeGid ? "is-active" : ""}"
        data-gid="${t.gid}"
        type="button"
      >${t.name}</button>`
    )
    .join("");

  tabsRow.querySelectorAll(".week-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.training.activeGid = btn.dataset.gid;
      saveState();
      renderTabSelector();
    });
  });
}

async function syncFromSheet() {
  const statusEl = document.getElementById("sheet-sync-status");
  const { sheetUrl, activeGid } = state.training;

  if (!sheetUrl) {
    statusEl.textContent = "Paste your sheet URL and load tabs first.";
    statusEl.className = "sheet-sync-status is-error";
    return;
  }

  const csvUrl = toCsvUrl(sheetUrl, activeGid);
  statusEl.textContent = "Syncing…";
  statusEl.className = "sheet-sync-status";

  try {
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error(`Sheet returned ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text);
    let updated = 0;

    state.training.lifts.forEach((lift) => {
      const aliases = LIFT_ALIASES[lift.name] || [lift.name.toLowerCase()];
      const matches = rows.filter((row) => {
        const name   = (row[1] || "").toLowerCase();
        const pct    = row[2] || "";
        const weight = Number(row[5]);
        return aliases.some((a) => name.includes(a)) && hasPercent(pct) && weight > 0;
      });
      if (matches.length > 0) {
        lift.workingWeight = Number(matches[matches.length - 1][5]);
        updated++;
      }
    });

    saveState();
    render();

    const tabName = state.training.sheetTabs.find((t) => t.gid === activeGid)?.name || "sheet";
    statusEl.textContent =
      updated > 0
        ? `Synced ${tabName} — updated ${updated} lift(s).`
        : `Connected to ${tabName}, but no Squat/Bench/Deadlift rows found with weights.`;
    statusEl.classList.add(updated > 0 ? "is-ok" : "is-error");
  } catch (err) {
    const isNetworkBlock = err.message.includes("Failed to fetch") || err.message.includes("NetworkError");
    statusEl.textContent = isNetworkBlock
      ? "⚠️ Fetch blocked in preview — deploy the app first (GitHub Pages / Netlify), then sync works."
      : `Sync failed: ${err.message}`;
    statusEl.classList.add("is-error");
  }
}

// ---------- 2. NAVIGATION ----------
// Each "plate" in the rack and each "module" panel share a key
// (today / training / admin / tasks). Switching just toggles
// which module has the .is-active class.

const MODULES = ["today", "training", "admin", "tasks"];

function setActiveModule(key) {
  state.activeModule = key;
  saveState();
  render();
}

// ---------- 3. RENDER ----------
// We re-render the whole UI from `state` any time something
// changes. Simple, and plenty fast for an app this size.

function render() {
  renderPlateRack();
  renderToday();
  renderTraining();
  renderAdmin();
  renderTasks();

  MODULES.forEach((key) => {
    document
      .getElementById(`module-${key}`)
      .classList.toggle("is-active", state.activeModule === key);
  });
}

function renderPlateRack() {
  const counts = {
    today: openCount(state.admin) + openCount(state.tasks) + openCount(state.training.sessions),
    training: openCount(state.training.sessions),
    admin: openCount(state.admin),
    tasks: openCount(state.tasks),
  };

  MODULES.forEach((key) => {
    const plate = document.querySelector(`.plate[data-module="${key}"]`);
    plate.querySelector(".count").textContent = counts[key];
    plate.classList.toggle("is-active", state.activeModule === key);
  });
}

function openCount(items) {
  return items.filter((i) => !i.done).length;
}

function renderToday() {
  document.getElementById("today-training-count").textContent =
    openCount(state.training.sessions);
  document.getElementById("today-admin-count").textContent = openCount(state.admin);
  document.getElementById("today-tasks-count").textContent = openCount(state.tasks);
}

function renderTraining() {
  const grid = document.getElementById("lift-grid");
  const unit = state.training.unit;
  const bar = state.training.barWeight;
  document.getElementById("unit-toggle").textContent = unit;
  renderTabSelector();
  const urlInput = document.getElementById("sheet-url-input");
  if (document.activeElement !== urlInput) {
    urlInput.value = state.training.sheetUrl || "";
  }

  grid.innerHTML = state.training.lifts
    .map((l, i) => {
      const warmups = generateWarmups(l.workingWeight, unit, bar);
      const warmupHtml = warmups.length
        ? warmups
            .map(
              (s) => `
              <div class="warmup-row${s.label === "Work set" ? " is-work" : ""}">
                <span class="warmup-label">${s.label}</span>
                <span class="warmup-weight">${s.weight}${unit}</span>
                <span class="warmup-reps">${s.reps ? `× ${s.reps}` : ""}</span>
              </div>`
            )
            .join("")
        : `<div class="empty-state" style="padding:10px 0;">Enter a working weight to generate warmups</div>`;

      return `
      <div class="lift-card">
        <div class="lift-name">${l.name}</div>
        <div class="lift-input-row">
          <input
            type="number"
            inputmode="decimal"
            class="lift-weight-input"
            data-lift-index="${i}"
            placeholder="Working wt"
            value="${l.workingWeight}"
          />
          <span class="unit-tag">${unit}</span>
        </div>
        <div class="warmup-list">${warmupHtml}</div>
      </div>`;
    })
    .join("");

  grid.querySelectorAll(".lift-weight-input").forEach((input) => {
    input.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.liftIndex);
      state.training.lifts[idx].workingWeight = e.target.value;
      saveState();
      renderTraining();
      // re-focus + restore cursor since we just re-rendered this input
      const fresh = grid.querySelector(`.lift-weight-input[data-lift-index="${idx}"]`);
      if (fresh) {
        fresh.focus();
        fresh.setSelectionRange(fresh.value.length, fresh.value.length);
      }
    });
  });

  renderList("training-sessions", state.training.sessions, (item) =>
    toggleItem(state.training.sessions, item.id)
  , (id) => removeItem(state.training.sessions, id));
}

function renderAdmin() {
  renderList("admin-list", state.admin, (item) => toggleItem(state.admin, item.id), (id) =>
    removeItem(state.admin, id)
  );
}

function renderTasks() {
  renderList("tasks-list", state.tasks, (item) => toggleItem(state.tasks, item.id), (id) =>
    removeItem(state.tasks, id)
  );
}

// Generic renderer reused by training/admin/tasks lists, since
// they all behave the same way: checkbox + text + delete.
function renderList(containerId, items, onToggle, onDelete) {
  const el = document.getElementById(containerId);
  if (items.length === 0) {
    el.innerHTML = `<div class="empty-state">Nothing here yet</div>`;
    return;
  }
  el.innerHTML = items
    .map(
      (item) => `
      <div class="item-row ${item.done ? "done" : ""}" data-id="${item.id}">
        <div class="checkbox" data-action="toggle"></div>
        <div class="item-text">${escapeHtml(item.text)}</div>
        <button class="delete-btn" data-action="delete" aria-label="Delete">×</button>
      </div>`
    )
    .join("");

  el.querySelectorAll(".item-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-action="toggle"]').addEventListener("click", () => onToggle({ id }));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => onDelete(id));
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- 4. MUTATIONS ----------
function toggleItem(list, id) {
  const item = list.find((i) => i.id === id);
  if (item) item.done = !item.done;
  saveState();
  render();
}

function removeItem(list, id) {
  const idx = list.findIndex((i) => i.id === id);
  if (idx !== -1) list.splice(idx, 1);
  saveState();
  render();
}

function addItem(list, text) {
  if (!text.trim()) return;
  list.push({ id: cryptoId(), text: text.trim(), done: false });
  saveState();
  render();
}

// ---------- 5. WIRE UP EVENTS ----------
document.querySelectorAll(".plate").forEach((plate) => {
  plate.addEventListener("click", () => setActiveModule(plate.dataset.module));
});

document.getElementById("training-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("training-input");
  addItem(state.training.sessions, input.value);
  input.value = "";
});

document.getElementById("admin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("admin-input");
  addItem(state.admin, input.value);
  input.value = "";
});

document.getElementById("tasks-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("tasks-input");
  addItem(state.tasks, input.value);
  input.value = "";
});

document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => setActiveModule(btn.dataset.go));
});

document.getElementById("sheet-load-tabs-btn").addEventListener("click", () => {
  const url = document.getElementById("sheet-url-input").value.trim();
  discoverTabs(url);
});

document.getElementById("sheet-sync-btn").addEventListener("click", () => {
  syncFromSheet();
});

document.getElementById("sheet-url-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); document.getElementById("sheet-load-tabs-btn").click(); }
});

document.getElementById("unit-toggle").addEventListener("click", () => {
  const goingTo = state.training.unit === "kg" ? "lb" : "kg";
  // Convert existing working weights + bar weight so numbers stay accurate.
  state.training.lifts.forEach((l) => {
    if (l.workingWeight) {
      const num = Number(l.workingWeight);
      l.workingWeight = goingTo === "lb" ? Math.round(num * 2.20462) : Math.round(num / 2.20462);
    }
  });
  state.training.barWeight = goingTo === "lb" ? 45 : 20;
  state.training.unit = goingTo;
  document.getElementById("unit-toggle").textContent = goingTo;
  saveState();
  render();
});

// ---------- 6. PWA: register service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.log("Service worker registration failed:", err);
    });
  });
}

// ---------- 7. INITIAL RENDER ----------
render();
