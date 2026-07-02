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
      sheetTabs: [],
      activeGid: "",
      tabsDiscovered: false,  // true only when tab IDs were genuinely found
      parsedDays: [],   // parsed from sheet: [{num, exercises, abOptionA, abOptionB}]
      activeDay: 1,     // which day tab is selected
      abChoices: {},    // { "1": "A", "2": "B", ... } user's A/B pick per day
      sessions: [
        { id: cryptoId(), text: "Add a session note", done: false },
      ],
    },
    admin: [
      { id: cryptoId(), text: "Confirm fall tuition due date", done: false },
      { id: cryptoId(), text: "Check financial aid disbursement", done: false },
    ],
    tasks: [
      { id: cryptoId(), text: "Add your first task", done: false },
    ],
    events: [],
    calView: "week",
    calAnchor: "",
    finance: {
      // credentialId: stored WebAuthn credential (array of numbers).
      // null = biometrics not yet registered.
      credentialId: null,
      accounts: [],
      // accounts shape:
      //   checking: { id, type:"checking", name, balance, transactions:[] }
      //   credit:   { id, type:"credit",  name, balance, limit, owed, dueDate, minPayment, transactions:[] }
      // transactions: { id, date, description, amount (neg=expense/charge, pos=deposit/payment), category }
      activeAccountId: null,
    },
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
if (!state.training.parsedDays) state.training.parsedDays = [];
if (!state.training.activeDay)  state.training.activeDay  = 1;
if (!state.training.abChoices)  state.training.abChoices  = {};
if (!state.events)    state.events    = [];
if (!state.calView)   state.calView   = "week";
if (!state.calAnchor) state.calAnchor = "";
if (!state.finance)   state.finance   = { credentialId: null, accounts: [], activeAccountId: null };
if (!state.finance.activeAccountId) state.finance.activeAccountId = null;

// financeUnlocked lives ONLY in memory — never saved to localStorage.
// This means the finance section re-locks every time you close the app.
let financeUnlocked = false;

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- LIFT VARIANT DETECTION ----------
// Maps a lift name (from the sheet) to Squat / Bench / Deadlift.
// Warmup sets are generated only for these variants.
const LIFT_VARIANTS = {
  Squat:    ["squat","squats","tempo squat","high bar squat","box squat","pause squat","safety bar","ssb"],
  Bench:    ["bench"],
  Deadlift: ["deadlift","rdl","romanian","stiff leg","sumo dead","trap bar"],
};

function detectLiftKey(name) {
  // Names with parenthetical modifiers like "Bench (Moderate/Narrower)"
  // are bench variations treated as accessories, not the main competition lift.
  if (/\(/.test(name)) return null;
  const n = name.toLowerCase();
  for (const [key, variants] of Object.entries(LIFT_VARIANTS)) {
    if (variants.some((v) => n.includes(v))) return key;
  }
  return null;
}

// Scan a header row to find which column index holds what data.
// The "Day N" row in this sheet doubles as the column header row,
// so we can detect column positions dynamically instead of hard-coding them.
function detectColMap(row) {
  const lower = row.map((c) => (c || "").toLowerCase().trim());
  const idx = (...terms) => lower.findIndex((c) => terms.some((t) => c.includes(t)));

  const weightIdx = idx("weight", "wt", "load");
  const pctIdx    = idx("% / rpe", "%/rpe", "% rpe", "intensity");
  const pctIdx2   = pctIdx >= 0 ? pctIdx : idx("%", "rpe");
  const repsIdx   = idx("reps");
  const setsIdx   = idx("sets");
  const notesIdx  = idx("notes");

  // Only update the map if we found the weight column (most reliable signal)
  if (weightIdx > 0) {
    return {
      name:   1,
      pct:    pctIdx2   >= 0 ? pctIdx2   : 2,
      reps:   repsIdx   >= 0 ? repsIdx   : 3,
      sets:   setsIdx   >= 0 ? setsIdx   : 4,
      weight: weightIdx,
      notes:  notesIdx  >= 0 ? notesIdx  : weightIdx + 1,
    };
  }
  return null;
}

// ---------- SHEET DAY PARSER ----------
// Reads the CSV rows (array of arrays) and builds a structured
// array of training days, each with main lifts, direct accessories,
// and A/B variation options scraped from the right-side columns.
//
// Column layout of this program's sheet (0-indexed):
//   0: row number or "Day N" header
//   1: exercise name
//   2: % or RPE
//   3: reps
//   4: sets
//   5: weight (pre-calculated)
//   6: notes
//   7: (empty spacer)
//   8: A/B label on right side ("A", "B", or "DAY N")
//   9: A/B exercise text on right side

function parseSheetDays(rows) {
  const days = [];
  let currentDay = null;
  // Default column map — updated dynamically when a Day header row is found
  let colMap = { name: 1, pct: 2, reps: 3, sets: 4, weight: 5, notes: 6 };

  // — LEFT-SIDE PASS: build day blocks with exercises —
  rows.forEach((row) => {
    const col0 = (row[0] || "").trim();

    // "Day 1", "Day 2", etc. — start a new day block.
    // This row also doubles as the column header row in the sheet,
    // so we detect column positions from it.
    if (/^day\s*\d+/i.test(col0)) {
      const detected = detectColMap(row);
      if (detected) colMap = detected;

      const num = parseInt(col0.match(/\d+/)[0]);
      currentDay = { num, exercises: [], abOptionA: [], abOptionB: [] };
      days.push(currentDay);
      return;
    }

    if (!currentDay) return;

    const col1 = (row[colMap.name]   || "").trim();  // exercise name
    const col2 = (row[colMap.pct]    || "").trim();  // % / RPE
    const col3 = (row[colMap.reps]   || "").trim();  // reps
    const col4 = (row[colMap.sets]   || "").trim();  // sets
    const col5 = (row[colMap.weight] || "").trim();  // weight
    const col6 = (row[colMap.notes]  || "").trim();  // notes

    if (!col1) return;

    // "CHOOSE VARIATION..." rows mark an A/B slot in the exercise order
    if (/choose variation/i.test(col1)) {
      currentDay.exercises.push({ type: "ab_slot" });
      return;
    }

    const weight  = Number(col5);
    const hasPct  = hasPercent(col2);
    const liftKey = detectLiftKey(col1);

    // A TRUE main lift: recognised name WITHOUT parenthetical modifier
    // (e.g. "Squats", "Bench", "Deadlift"). Gets warmup sets.
    if (liftKey && (hasPct || weight > 0)) {
      currentDay.exercises.push({
        type: "main",
        name: col1, pct: col2, reps: col3, sets: col4,
        weight: weight || null, notes: col6, liftKey,
      });
    } else if (col1 && (hasPct || col3 || col4)) {
      // Everything else: bench variations, accessories, conditioning.
      // Show the % and weight as detail text, but no warmup calculator.
      currentDay.exercises.push({
        type: "accessory",
        name: col1, pct: col2, reps: col3, sets: col4,
        weight: weight || null, notes: col6,
      });
    }
  });

  // — RIGHT-SIDE PASS: collect A/B options per day —
  let rightDay  = null;
  let abSection = null;

  rows.forEach((row) => {
    const col8 = (row[8] || "").trim();
    const col9 = (row[9] || "").trim();

    if (/^day\s*\d+$/i.test(col8)) {
      const num = parseInt(col8.match(/\d+/)[0]);
      rightDay  = days.find((d) => d.num === num) || null;
      abSection = null;
      return;
    }

    if (!rightDay) return;

    if (col8 === "A") abSection = "A";
    if (col8 === "B") abSection = "B";

    if (col9 && /^\d+[ABab]\)/.test(col9)) {
      const clean = col9.replace(/^\d+[ABab]\)\s*/, "").trim();
      if (abSection === "A") rightDay.abOptionA.push(clean);
      else if (abSection === "B") rightDay.abOptionB.push(clean);
    }
  });

  return days;
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
    state.training.tabsDiscovered = true;
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
  state.training.tabsDiscovered = false;
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
  const { sheetUrl, activeGid, tabsDiscovered } = state.training;

  if (!sheetUrl) {
    statusEl.textContent = "Paste your sheet URL and load tabs first.";
    statusEl.className = "sheet-sync-status is-error";
    return;
  }

  // Only use a gid-specific URL if we actually discovered real tab IDs.
  // If tab discovery fell back to fake IDs (0,1,2…), use the original
  // URL as-is — it already points to the correct sheet.
  const csvUrl = tabsDiscovered ? toCsvUrl(sheetUrl, activeGid) : sheetUrl;
  statusEl.textContent = "Syncing…";
  statusEl.className = "sheet-sync-status";

  try {
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error(`Sheet returned ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text);
    let updated = 0;

    // Parse full day structure for the training view
    state.training.parsedDays = parseSheetDays(rows);

    // Extract working weights from the parsed days.
    const liftWeights = {};
    state.training.parsedDays.forEach((day) => {
      day.exercises.forEach((ex) => {
        if (ex.type === "main" && ex.liftKey && ex.weight) {
          liftWeights[ex.liftKey] = ex.weight; // last occurrence wins
        }
      });
    });
    state.training.lifts.forEach((lift) => {
      if (liftWeights[lift.name] !== undefined) {
        lift.workingWeight = liftWeights[lift.name];
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

const MODULES = ["today", "training", "cal", "finance", "admin", "tasks"];

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
  renderCal();
  // Finance renders lazily (only when active) to avoid biometric prompt on load
  if (state.activeModule === "finance") renderFinance();

  MODULES.forEach((key) => {
    document
      .getElementById(`module-${key}`)
      .classList.toggle("is-active", state.activeModule === key);
  });
}

function renderPlateRack() {
  // Count upcoming events in the next 7 days for the cal plate
  const todayStr = dateStr(new Date());
  const in7 = dateStr(addDays(new Date(), 7));
  const upcomingCount = state.events.filter(
    (e) => e.date >= todayStr && e.date <= in7
  ).length;

  const totalOwed = state.finance.accounts
    .filter((a) => a.type === "credit" && (a.owed || 0) > 0)
    .length;

  const counts = {
    today: openCount(state.admin) + openCount(state.tasks) + openCount(state.training.sessions),
    training: openCount(state.training.sessions),
    cal: upcomingCount,
    finance: totalOwed,
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

  // Show today's + tomorrow's events in the Today view
  const todayStr  = dateStr(new Date());
  const tomorrowStr = dateStr(addDays(new Date(), 1));
  const upcoming = state.events
    .filter((e) => e.date === todayStr || e.date === tomorrowStr)
    .sort((a, b) => (a.date + (a.time||"") > b.date + (b.time||"") ? 1 : -1));

  const calToday = document.getElementById("today-cal-list");
  if (upcoming.length === 0) {
    calToday.innerHTML = `<div class="today-cal-empty">Nothing today or tomorrow</div>`;
  } else {
    calToday.innerHTML = upcoming.map((e) => `
      <div class="today-cal-item ${e.type}">
        <span class="today-cal-dot"></span>
        <span class="today-cal-label">${e.date === todayStr ? "Today" : "Tomorrow"}${e.time ? " " + fmtTime(e.time) : ""}</span>
        <span class="today-cal-title">${escapeHtml(e.title)}</span>
      </div>`).join("");
  }
}

function renderTraining() {
  const unit = state.training.unit;
  const bar  = state.training.barWeight;
  document.getElementById("unit-toggle").textContent = unit;
  renderTabSelector();
  const urlInput = document.getElementById("sheet-url-input");
  if (document.activeElement !== urlInput) {
    urlInput.value = state.training.sheetUrl || "";
  }

  const days = state.training.parsedDays;
  const dayContainer = document.getElementById("training-day-display");

  // — No sheet synced yet: show manual lift entry —
  if (!days || days.length === 0) {
    dayContainer.innerHTML = renderManualLifts(unit, bar);
    wireManualLiftInputs();
    return;
  }

  // — Day selector tabs —
  const dayNavEl = document.getElementById("training-day-nav");
  dayNavEl.innerHTML = days.map((d) => `
    <button class="day-tab-btn ${d.num === state.training.activeDay ? "is-active" : ""}"
            data-day="${d.num}" type="button">Day ${d.num}</button>`
  ).join("");
  dayNavEl.querySelectorAll(".day-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.training.activeDay = Number(btn.dataset.day);
      saveState();
      renderTraining();
    });
  });

  const day = days.find((d) => d.num === state.training.activeDay) || days[0];
  if (!day) { dayContainer.innerHTML = ""; return; }

  const abChoice = state.training.abChoices[day.num] || null;

  let html = "";

  day.exercises.forEach((ex) => {
    if (ex.type === "main") {
      // Resolve warmup weight: prefer the day's own weight, fall back to lifts[] reference
      const refLift = ex.liftKey
        ? state.training.lifts.find((l) => l.name === ex.liftKey)
        : null;
      const warmupWeight = ex.weight || (refLift ? Number(refLift.workingWeight) : 0);
      const warmups = warmupWeight ? generateWarmups(warmupWeight, unit, bar) : [];

      html += `
        <div class="day-lift-card">
          <div class="day-lift-header">
            <div class="day-lift-name">${escapeHtml(ex.name)}</div>
            <div class="day-lift-prescription">${ex.sets ? ex.sets + " × " : ""}${ex.reps || ""}${ex.pct ? " @ " + ex.pct : ""}${ex.weight ? " · " + ex.weight + unit : ""}</div>
          </div>
          ${ex.notes ? `<div class="day-lift-notes">${escapeHtml(ex.notes)}</div>` : ""}
          ${warmups.length ? `
            <div class="warmup-list">
              ${warmups.map((s) => `
                <div class="warmup-row${s.label === "Work set" ? " is-work" : ""}">
                  <span class="warmup-label">${s.label}</span>
                  <span class="warmup-weight">${s.weight}${unit}</span>
                  <span class="warmup-reps">${s.reps ? "× " + s.reps : ""}</span>
                </div>`).join("")}
            </div>` : `<div class="day-no-warmup">Enter a working weight to generate warmups</div>`}
        </div>`;

    } else if (ex.type === "accessory") {
      const detail = [
        ex.sets && ex.reps ? `${ex.sets} × ${ex.reps}` : (ex.reps || ex.sets || ""),
        ex.pct  ? `@ ${ex.pct}` : "",
        ex.weight ? `· ${ex.weight}${unit}` : "",
      ].filter(Boolean).join(" ");

      html += `
        <div class="day-accessory-row">
          <div class="day-acc-left">
            <div class="day-acc-name">${escapeHtml(ex.name)}</div>
            ${ex.notes ? `<div class="day-acc-notes">${escapeHtml(ex.notes)}</div>` : ""}
          </div>
          ${detail ? `<div class="day-acc-detail">${detail}</div>` : ""}
        </div>`;

    } else if (ex.type === "ab_slot") {
      const hasOptions = day.abOptionA.length > 0 || day.abOptionB.length > 0;
      html += `
        <div class="ab-block">
          <div class="ab-toggle-row">
            <span class="ab-label">Variation</span>
            ${hasOptions ? `
              <button class="ab-btn ${abChoice === "A" ? "is-active" : ""}" data-ab="A" type="button">Option A</button>
              <button class="ab-btn ${abChoice === "B" ? "is-active" : ""}" data-ab="B" type="button">Option B</button>
            ` : `<span class="day-acc-notes">Pick A or B from your sheet</span>`}
          </div>
          ${abChoice === "A" && day.abOptionA.length ? `
            <div class="ab-exercises">
              ${day.abOptionA.map((e) => `<div class="ab-exercise-row"><span class="ab-dot a"></span>${escapeHtml(e)}</div>`).join("")}
            </div>` : ""}
          ${abChoice === "B" && day.abOptionB.length ? `
            <div class="ab-exercises">
              ${day.abOptionB.map((e) => `<div class="ab-exercise-row"><span class="ab-dot b"></span>${escapeHtml(e)}</div>`).join("")}
            </div>` : ""}
          ${!abChoice && hasOptions ? `<div class="ab-prompt">Tap A or B to see your options</div>` : ""}
        </div>`;
    }
  });

  dayContainer.innerHTML = html || `<div class="empty-state">No exercises found for Day ${day.num}</div>`;

  // Wire A/B toggle buttons
  dayContainer.querySelectorAll(".ab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cur = state.training.abChoices[day.num];
      state.training.abChoices[day.num] = cur === btn.dataset.ab ? null : btn.dataset.ab;
      saveState();
      renderTraining();
    });
  });

  renderList("training-sessions", state.training.sessions,
    (item) => toggleItem(state.training.sessions, item.id),
    (id)  => removeItem(state.training.sessions, id));
}

function renderManualLifts(unit, bar) {
  return state.training.lifts.map((l, i) => {
    const warmups = generateWarmups(l.workingWeight, unit, bar);
    const warmupHtml = warmups.length
      ? warmups.map((s) => `
          <div class="warmup-row${s.label === "Work set" ? " is-work" : ""}">
            <span class="warmup-label">${s.label}</span>
            <span class="warmup-weight">${s.weight}${unit}</span>
            <span class="warmup-reps">${s.reps ? "× " + s.reps : ""}</span>
          </div>`).join("")
      : `<div class="empty-state" style="padding:10px 0;">Enter weight to generate warmups</div>`;
    return `
      <div class="lift-card">
        <div class="lift-name">${l.name}</div>
        <div class="lift-input-row">
          <blur type="text" inputmode="decimal" class="lift-weight-input"
                 data-lift-index="${i}" placeholder="e.g. 225" step="any" value="${l.workingWeight}" />
          <span class="unit-tag">${unit}</span>
        </div>
        <div class="warmup-list">${warmupHtml}</div>
      </div>`;
  }).join("");
}

let _warmupDebounce = null;
function wireManualLiftInputs() {
  const grid = document.getElementById("training-day-display");
  grid.querySelectorAll(".lift-weight-input").forEach((input) => {
    input.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.liftIndex);
      state.training.lifts[idx].workingWeight = e.target.value;
      saveState();
      // Debounce: wait until typing stops before re-rendering warmups.
      // This prevents the keyboard from closing on every keystroke on iOS.
      clearTimeout(_warmupDebounce);
      _warmupDebounce = setTimeout(() => renderTraining(), 700);
    });
  });
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

// ---------- BANK CSV IMPORT ----------
// Both Wells Fargo and Capital One let you download transaction history
// as CSV from their websites. This parser auto-detects which bank's
// format you're using based on the column headers.
//
// Wells Fargo columns: Date, Amount, *, *, Description
// Capital One columns: Transaction Date, Posted Date, Card No., Description, Category, Debit, Credit

function importBankCSV(file, account) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const rows = parseCsv(text);
    if (rows.length < 2) { alert("CSV appears empty."); return; }

    const header = rows[0].map((h) => h.toLowerCase().trim());
    let imported = 0;

    // — Capital One format detection —
    const isCapOne = header.some((h) => h.includes("transaction date") || h.includes("card no"));
    if (isCapOne) {
      const dateIdx  = header.findIndex((h) => h.includes("transaction date"));
      const descIdx  = header.findIndex((h) => h.includes("description"));
      const catIdx   = header.findIndex((h) => h.includes("category"));
      const debitIdx = header.findIndex((h) => h === "debit");
      const credIdx  = header.findIndex((h) => h === "credit");

      rows.slice(1).forEach((row) => {
        const date   = (row[dateIdx] || "").trim();
        const desc   = (row[descIdx] || "").trim();
        const cat    = (row[catIdx]  || "").trim();
        const debit  = parseFloat(row[debitIdx])  || 0;
        const credit = parseFloat(row[credIdx]) || 0;
        if (!date || !desc) return;

        const amount = credit > 0 ? credit : -debit; // positive = payment, negative = charge
        const isoDate = toISODate(date);
        if (!isoDate) return;

        // Skip duplicates
        if (!account.transactions.some((t) => t.date === isoDate && t.description === desc && Math.abs(t.amount) === Math.abs(amount))) {
          account.transactions.unshift({ id: cryptoId(), date: isoDate, description: desc, amount, category: cat });
          imported++;
        }
      });
    } else {
      // — Wells Fargo format —
      // No header row; columns are: Date, Amount, *, *, Description
      const allRows = rows[0].length >= 5 ? rows : rows.slice(1);
      allRows.forEach((row) => {
        const date   = (row[0] || "").trim();
        const amount = parseFloat(row[1]) || 0;
        const desc   = (row[4] || row[3] || row[2] || "").trim().replace(/^"|"$/g, "");
        if (!date || !desc || amount === 0) return;

        const isoDate = toISODate(date);
        if (!isoDate) return;

        if (!account.transactions.some((t) => t.date === isoDate && t.description === desc && t.amount === amount)) {
          account.transactions.unshift({ id: cryptoId(), date: isoDate, description: desc, amount, category: "" });
          imported++;
        }
      });
    }

    // Sort by date descending
    account.transactions.sort((a, b) => b.date.localeCompare(a.date));
    saveState();
    renderFinance();

    const zone = document.getElementById("bank-import-zone");
    if (zone) {
      zone.innerHTML = `<span class="import-icon">✓</span><span class="import-label">${imported} transaction(s) imported</span>`;
      setTimeout(() => renderFinance(), 2000);
    }
  };
  reader.readAsText(file);
}

// Converts MM/DD/YYYY or YYYY-MM-DD to YYYY-MM-DD
function toISODate(str) {
  str = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  return null;
}
// WebAuthn lets the browser call the device's biometric hardware
// (Face ID on iPhone, Touch ID on Mac). It works on HTTPS only —
// so it works on your deployed GitHub Pages site but NOT on a
// local file:// URL. In local dev the buttons will show a fallback.
//
// IMPORTANT: This is UI-level locking. The data still lives in
// localStorage in plain text — anyone with DevTools can read it.
// For personal use on your own device this is fine; for anything
// truly sensitive you'd need server-side encryption.

function webAuthnAvailable() {
  return window.PublicKeyCredential &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function";
}

async function platformAuthAvailable() {
  if (!webAuthnAvailable()) return false;
  return window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

// Step 1 — called the first time user sets up Face ID.
async function registerFaceId() {
  const statusEl = document.getElementById("finance-auth-status");
  try {
    const available = await platformAuthAvailable();
    if (!available) {
      statusEl.textContent = "⚠️ Face ID not available — deploy to HTTPS first (GitHub Pages).";
      return;
    }
    statusEl.textContent = "Follow the Face ID prompt…";

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId    = crypto.getRandomValues(new Uint8Array(16));

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: "Loadout" },
        user: { id: userId, name: "loadout-user", displayName: "You" },
        pubKeyCredParams: [
          { alg: -7,  type: "public-key" },   // ES256
          { alg: -257, type: "public-key" },  // RS256 fallback
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 60000,
      },
    });

    // Store the raw credential ID as an array of numbers (JSON-safe)
    state.finance.credentialId = Array.from(new Uint8Array(credential.rawId));
    saveState();
    financeUnlocked = true;
    renderFinance();
  } catch (err) {
    statusEl.textContent = err.name === "NotAllowedError"
      ? "Face ID cancelled — try again."
      : `Setup failed: ${err.message}`;
  }
}

// Step 2 — called every time user opens the finance tab after setup.
async function authenticateFaceId() {
  const statusEl = document.getElementById("finance-auth-status");
  try {
    const available = await platformAuthAvailable();
    if (!available) {
      // Localhost / no HTTPS fallback: just unlock for dev purposes
      statusEl.textContent = "⚠️ Face ID only works on HTTPS. Unlocking for local dev.";
      financeUnlocked = true;
      renderFinance();
      return;
    }
    statusEl.textContent = "Follow the Face ID prompt…";

    const challenge    = crypto.getRandomValues(new Uint8Array(32));
    const credentialId = new Uint8Array(state.finance.credentialId);

    await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: "public-key", id: credentialId, transports: ["internal"] }],
        userVerification: "required",
        timeout: 60000,
      },
    });

    financeUnlocked = true;
    renderFinance();
  } catch (err) {
    statusEl.textContent = err.name === "NotAllowedError"
      ? "Face ID cancelled — try again."
      : `Auth failed: ${err.message}`;
  }
}

// ---------- FINANCE RENDER ----------

function renderFinance() {
  const el = document.getElementById("module-finance");

  // — Locked: not set up yet —
  if (!state.finance.credentialId) {
    el.innerHTML = `
      <h2 style="--dot-color: var(--plate-finance);">Finances</h2>
      <div class="finance-lock-screen">
        <div class="finance-lock-icon">🔒</div>
        <p class="finance-lock-title">Protect with Face ID</p>
        <p class="finance-lock-sub">Your financial data never leaves your device.<br>
           Face ID locks this section every time you close the app.</p>
        <button id="finance-setup-btn" class="finance-auth-btn" type="button">Set Up Face ID</button>
        <div id="finance-auth-status" class="finance-auth-status"></div>
      </div>`;
    document.getElementById("finance-setup-btn")
      .addEventListener("click", registerFaceId);
    return;
  }

  // — Locked: set up but not authenticated this session —
  if (!financeUnlocked) {
    el.innerHTML = `
      <h2 style="--dot-color: var(--plate-finance);">Finances</h2>
      <div class="finance-lock-screen">
        <div class="finance-lock-icon">󰒃</div>
        <p class="finance-lock-title">Locked</p>
        <button id="finance-unlock-btn" class="finance-auth-btn" type="button">
          Unlock with Face ID
        </button>
        <div id="finance-auth-status" class="finance-auth-status"></div>
      </div>`;
    document.getElementById("finance-unlock-btn")
      .addEventListener("click", authenticateFaceId);
    return;
  }

  // — Unlocked —
  const accounts = state.finance.accounts;
  const activeId  = state.finance.activeAccountId || accounts[0]?.id || null;
  const active    = accounts.find((a) => a.id === activeId) || null;

  let html = `<div class="finance-header-row">
    <h2 style="--dot-color: var(--plate-finance); margin:0;">Finances</h2>
    <button id="finance-lock-btn" class="finance-lock-btn" type="button">🔒 Lock</button>
  </div>`;

  // Account cards row
  html += `<div class="finance-account-rail">`;
  accounts.forEach((acc) => {
    const isActive = acc.id === activeId;
    const balance  = computeBalance(acc);
    html += `
      <div class="finance-account-card ${isActive ? "is-active" : ""} ${acc.type}"
           data-account-id="${acc.id}">
        <div class="fac-name">${escapeHtml(acc.name)}</div>
        <div class="fac-balance">${formatMoney(balance)}</div>
        ${acc.type === "credit" ? `
          <div class="fac-owed">Owed: ${formatMoney(acc.owed || 0)}</div>
          ${acc.dueDate ? `<div class="fac-due">Due ${acc.dueDate}</div>` : ""}
          ${acc.limit ? utilBar(balance, acc.limit) : ""}
        ` : ""}
      </div>`;
  });
  html += `<button id="finance-add-account-btn" class="finance-add-account-card" type="button">+ Add Account</button>`;
  html += `</div>`;

  // Active account detail
  if (active) {
    html += renderAccountDetail(active);
  } else if (accounts.length === 0) {
    html += `<div class="empty-state" style="margin-top:24px;">Add an account above to get started</div>`;
  }

  el.innerHTML = html;

  // Wire account card clicks
  el.querySelectorAll(".finance-account-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.finance.activeAccountId = card.dataset.accountId;
      saveState();
      renderFinance();
    });
  });

  // Add account
  el.querySelector("#finance-add-account-btn")
    .addEventListener("click", () => showAddAccountModal());

  // Lock button
  el.querySelector("#finance-lock-btn").addEventListener("click", () => {
    financeUnlocked = false;
    renderFinance();
  });

  // Transaction form
  const txForm = el.querySelector("#tx-form");
  if (txForm) {
    txForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const desc   = el.querySelector("#tx-desc").value.trim();
      const amount = parseFloat(el.querySelector("#tx-amount").value);
      const date   = el.querySelector("#tx-date").value;
      const cat    = el.querySelector("#tx-cat").value.trim();
      const dir    = el.querySelector("#tx-dir").value; // "out" | "in"
      if (!desc || isNaN(amount) || !date) return;
      const signed = dir === "out" ? -Math.abs(amount) : Math.abs(amount);
      active.transactions.unshift({ id: cryptoId(), date, description: desc, amount: signed, category: cat });
      if (active.type === "checking") {
        active.balance = (active.balance || 0) + signed;
      }
      saveState();
      renderFinance();
    });
  }

  // Delete transaction buttons
  el.querySelectorAll(".tx-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      const txId = btn.dataset.txId;
      active.transactions = active.transactions.filter((t) => t.id !== txId);
      saveState();
      renderFinance();
    });
  });

  // Credit card meta (owed / due / min payment) save
  const saveMeta = el.querySelector("#save-credit-meta");
  if (saveMeta && active) {
    saveMeta.addEventListener("click", () => {
      active.owed       = parseFloat(el.querySelector("#edit-owed").value) || 0;
      active.dueDate    = el.querySelector("#edit-due").value || "";
      active.minPayment = parseFloat(el.querySelector("#edit-min").value) || 0;
      saveState();
      renderFinance();
    });
  }

  // Bank CSV import — drag-and-drop or file picker
  const importZone = el.querySelector("#bank-import-zone");
  const importInput = el.querySelector("#bank-csv-input");
  if (importZone && importInput && active) {
    importZone.addEventListener("dragover", (e) => { e.preventDefault(); importZone.classList.add("is-dragging"); });
    importZone.addEventListener("dragleave", () => importZone.classList.remove("is-dragging"));
    importZone.addEventListener("drop", (e) => {
      e.preventDefault();
      importZone.classList.remove("is-dragging");
      const file = e.dataTransfer.files[0];
      if (file) importBankCSV(file, active);
    });
    importInput.addEventListener("change", () => {
      if (importInput.files[0]) importBankCSV(importInput.files[0], active);
    });
  }
}

function renderAccountDetail(acc) {
  const txs = (acc.transactions || []).slice(0, 40); // show last 40

  // Credit card: editable owed / due date fields
  const creditMeta = acc.type === "credit" ? `
    <div class="credit-meta-row">
      <div class="credit-meta-field">
        <label>Amount owed</label>
        <div class="credit-meta-edit">
          <span>$</span>
          <input type="number" class="credit-inline-input" id="edit-owed"
                 value="${acc.owed || ""}" placeholder="0.00" step="0.01" />
        </div>
      </div>
      <div class="credit-meta-field">
        <label>Due date</label>
        <input type="date" class="credit-inline-input" id="edit-due"
               value="${acc.dueDate || ""}" />
      </div>
      <div class="credit-meta-field">
        <label>Min payment</label>
        <div class="credit-meta-edit">
          <span>$</span>
          <input type="number" class="credit-inline-input" id="edit-min"
                 value="${acc.minPayment || ""}" placeholder="0.00" step="0.01" />
        </div>
      </div>
      <button class="credit-save-btn" id="save-credit-meta" type="button">Save</button>
    </div>` : "";

  const txRows = txs.length ? txs.map((t) => `
    <div class="tx-row ${t.amount < 0 ? "is-debit" : "is-credit"}">
      <div class="tx-left">
        <div class="tx-desc">${escapeHtml(t.description)}</div>
        <div class="tx-meta">${t.date}${t.category ? " · " + escapeHtml(t.category) : ""}</div>
      </div>
      <div class="tx-amount">${t.amount < 0 ? "−" : "+"}${formatMoney(Math.abs(t.amount))}</div>
      <button class="tx-del" data-tx-id="${t.id}" type="button">×</button>
    </div>`).join("") :
    `<div class="empty-state">No transactions yet</div>`;

  const dirLabel = acc.type === "credit"
    ? `<option value="out">Charge</option><option value="in">Payment</option>`
    : `<option value="out">Withdrawal / expense</option><option value="in">Deposit</option>`;

  return `
    <div class="account-detail">
      ${creditMeta}

      <!-- Bank CSV import -->
      <div class="bank-import-zone" id="bank-import-zone">
        <span class="import-icon">📥</span>
        <span class="import-label">Drop your bank's transaction CSV here, or <label for="bank-csv-input" class="import-link">browse</label></span>
        <input id="bank-csv-input" type="file" accept=".csv" style="display:none;" />
        <span class="import-hint">Works with Wells Fargo &amp; Capital One CSV exports</span>
      </div>

      <div class="tx-list">${txRows}</div>
      <form id="tx-form" class="tx-add-form">
        <input id="tx-desc"   type="text"   placeholder="Description" required autocomplete="off" />
        <input id="tx-amount" type="number" placeholder="Amount"  step="0.01" min="0" required />
        <input id="tx-date"   type="date"   value="${dateStr(new Date())}" required />
        <input id="tx-cat"    type="text"   placeholder="Category (optional)" autocomplete="off" />
        <select id="tx-dir">${dirLabel}</select>
        <button type="submit">Add</button>
      </form>
    </div>`;
}

function computeBalance(acc) {
  if (acc.type === "checking") return acc.balance || 0;
  // For credit: balance = sum of all charges (negative txs)
  const spent = (acc.transactions || []).reduce((sum, t) => sum + (t.amount < 0 ? Math.abs(t.amount) : 0), 0);
  return spent;
}

function formatMoney(n) {
  return "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function utilBar(spent, limit) {
  const pct = Math.min(100, (spent / limit) * 100);
  const color = pct > 80 ? "var(--plate-load)" : pct > 50 ? "var(--plate-task)" : "var(--plate-finance)";
  return `<div class="util-bar-bg"><div class="util-bar-fill" style="width:${pct}%;background:${color};"></div></div>
          <div class="util-label">${Math.round(pct)}% of $${limit.toLocaleString()} limit</div>`;
}

function showAddAccountModal() {
  // Simple inline modal appended to the finance module
  const el = document.getElementById("module-finance");
  const existing = el.querySelector(".finance-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.className = "finance-modal";
  modal.innerHTML = `
    <div class="finance-modal-box">
      <h3>Add Account</h3>
      <select id="new-acc-type">
        <option value="checking">Checking</option>
        <option value="credit">Credit Card</option>
      </select>
      <input id="new-acc-name"    type="text"   placeholder="Account name (e.g. Chase Checking)" />
      <input id="new-acc-balance" type="number" placeholder="Current balance" step="0.01" />
      <div id="new-acc-credit-fields" style="display:none; flex-direction:column; gap:8px;">
        <input id="new-acc-limit" type="number" placeholder="Credit limit" step="1" />
        <input id="new-acc-due"   type="date"   />
      </div>
      <div class="finance-modal-btns">
        <button id="modal-cancel" type="button">Cancel</button>
        <button id="modal-save"   type="button">Add</button>
      </div>
    </div>`;

  el.appendChild(modal);

  modal.querySelector("#new-acc-type").addEventListener("change", (e) => {
    modal.querySelector("#new-acc-credit-fields").style.display =
      e.target.value === "credit" ? "flex" : "none";
  });

  modal.querySelector("#modal-cancel").addEventListener("click", () => modal.remove());

  modal.querySelector("#modal-save").addEventListener("click", () => {
    const type    = modal.querySelector("#new-acc-type").value;
    const name    = modal.querySelector("#new-acc-name").value.trim();
    const balance = parseFloat(modal.querySelector("#new-acc-balance").value) || 0;
    const limit   = parseFloat(modal.querySelector("#new-acc-limit")?.value) || 0;
    const dueDate = modal.querySelector("#new-acc-due")?.value || "";
    if (!name) return;
    const newAcc = { id: cryptoId(), type, name, balance, transactions: [],
                     ...(type === "credit" ? { owed: 0, limit, dueDate, minPayment: 0 } : {}) };
    state.finance.accounts.push(newAcc);
    state.finance.activeAccountId = newAcc.id;
    saveState();
    modal.remove();
    renderFinance();
  });
}

// ---------- ICS / APPLE CALENDAR EXPORT ----------
// Generates a standard .ics file for a single event. When opened on
// iPhone, iOS prompts to add it to Apple Calendar automatically.

function generateICS(ev) {
  const [y, m, d] = ev.date.split("-");
  let dtStart, dtEnd, allDay;

  if (ev.time) {
    const [h, min] = ev.time.split(":");
    dtStart = `${y}${m}${d}T${h}${min}00`;
    const endH = String((parseInt(h) + 1) % 24).padStart(2, "0");
    dtEnd   = `${y}${m}${d}T${endH}${min}00`;
    allDay  = false;
  } else {
    dtStart = `${y}${m}${d}`;
    dtEnd   = `${y}${m}${d}`;
    allDay  = true;
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Loadout//EN",
    "BEGIN:VEVENT",
    allDay ? `DTSTART;VALUE=DATE:${dtStart}` : `DTSTART:${dtStart}`,
    allDay ? `DTEND;VALUE=DATE:${dtEnd}`     : `DTEND:${dtEnd}`,
    `SUMMARY:${ev.title}`,
    ev.type === "deadline" ? "CATEGORIES:DEADLINE" : "CATEGORIES:EVENT",
    `UID:loadout-${ev.id}@loadout`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.join("\r\n");
}

function downloadICS(ev) {
  const blob = new Blob([generateICS(ev)], { type: "text/calendar;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), {
    href: url,
    download: `${ev.title.replace(/[^a-zA-Z0-9]/g, "_")}.ics`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

function downloadAllICS() {
  if (!state.events.length) return;
  const inner = state.events.map((ev) => {
    const [y, m, d] = ev.date.split("-");
    let dtStart, dtEnd, allDay;
    if (ev.time) {
      const [h, min] = ev.time.split(":");
      dtStart = `${y}${m}${d}T${h}${min}00`;
      const endH = String((parseInt(h) + 1) % 24).padStart(2, "0");
      dtEnd = `${y}${m}${d}T${endH}${min}00`;
      allDay = false;
    } else { dtStart = dtEnd = `${y}${m}${d}`; allDay = true; }
    return [
      "BEGIN:VEVENT",
      allDay ? `DTSTART;VALUE=DATE:${dtStart}` : `DTSTART:${dtStart}`,
      allDay ? `DTEND;VALUE=DATE:${dtEnd}`     : `DTEND:${dtEnd}`,
      `SUMMARY:${ev.title}`,
      `UID:loadout-${ev.id}@loadout`,
      "END:VEVENT",
    ].join("\r\n");
  }).join("\r\n");

  const ics  = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Loadout//EN\r\n${inner}\r\nEND:VCALENDAR`;
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: "loadout-events.ics" });
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- CALENDAR ----------
// Date utilities — all work with plain JS Date objects and
// YYYY-MM-DD strings (safe for localStorage, no timezone drift).

const DAY_NAMES  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTH_NAMES = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"];

function dateStr(d) {
  // Returns YYYY-MM-DD in local time (not UTC, avoids day-off-by-one)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(str) {
  // Parse YYYY-MM-DD as local midnight (not UTC)
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfWeek(d) {
  // Returns the Sunday of the week containing d
  const r = new Date(d);
  r.setDate(r.getDate() - r.getDay());
  return r;
}

function fmtTime(t) {
  // "14:30" → "2:30 PM"
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2,"0")} ${ampm}`;
}

function eventsOnDate(str) {
  return state.events.filter((e) => e.date === str)
    .sort((a, b) => (a.time || "") > (b.time || "") ? 1 : -1);
}

function renderCal() {
  const anchor = state.calAnchor ? parseDate(state.calAnchor) : new Date();

  // View toggle buttons
  document.getElementById("cal-week-btn").classList.toggle("is-active", state.calView === "week");
  document.getElementById("cal-month-btn").classList.toggle("is-active", state.calView === "month");

  if (state.calView === "week") renderWeekView(anchor);
  else renderMonthView(anchor);
}

function renderWeekView(anchor) {
  const grid = document.getElementById("cal-grid");
  const title = document.getElementById("cal-title");
  const weekStart = startOfWeek(anchor);
  const weekEnd   = addDays(weekStart, 6);
  const todayStr  = dateStr(new Date());

  title.textContent = weekStart.getMonth() === weekEnd.getMonth()
    ? `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getFullYear()}`
    : `${MONTH_NAMES[weekStart.getMonth()].slice(0,3)} – ${MONTH_NAMES[weekEnd.getMonth()].slice(0,3)} ${weekEnd.getFullYear()}`;

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  grid.innerHTML = `
    <div class="week-grid">
      ${days.map((d) => {
        const ds = dateStr(d);
        const evs = eventsOnDate(ds);
        const isToday = ds === todayStr;
        return `
          <div class="week-col ${isToday ? "is-today" : ""}">
            <div class="week-day-name">${DAY_NAMES[d.getDay()]}</div>
            <div class="week-day-num ${isToday ? "is-today-num" : ""}">${d.getDate()}</div>
            <div class="week-events">
              ${evs.length
                ? evs.map((e) => `
                    <div class="cal-event-chip ${e.type}" data-id="${e.id}">
                      ${e.time ? `<span class="chip-time">${fmtTime(e.time)}</span>` : ""}
                      <span class="chip-title">${escapeHtml(e.title)}</span>
                      <button class="chip-ics" data-id="${e.id}" title="Add to Apple Calendar">⊕</button>
                      <button class="chip-del" data-id="${e.id}">×</button>
                    </div>`).join("")
                : ""}
            </div>
          </div>`;
      }).join("")}
    </div>`;

  grid.querySelectorAll(".chip-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteEvent(btn.dataset.id);
    });
  });
  grid.querySelectorAll(".chip-ics").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const ev = state.events.find((ev) => ev.id === btn.dataset.id);
      if (ev) downloadICS(ev);
    });
  });
}

function renderMonthView(anchor) {
  const grid = document.getElementById("cal-grid");
  const title = document.getElementById("cal-title");
  const todayStr = dateStr(new Date());
  const year = anchor.getFullYear();
  const month = anchor.getMonth();

  title.textContent = `${MONTH_NAMES[month]} ${year}`;

  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let cells = "";
  // Day-name headers
  DAY_NAMES.forEach((n) => { cells += `<div class="month-header">${n}</div>`; });
  // Leading empty cells
  for (let i = 0; i < firstDay; i++) cells += `<div class="month-cell is-empty"></div>`;
  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const evs = eventsOnDate(ds);
    const isToday = ds === todayStr;
    cells += `
      <div class="month-cell ${isToday ? "is-today" : ""}">
        <div class="month-day-num ${isToday ? "is-today-num" : ""}">${d}</div>
        <div class="month-dots">
          ${evs.map((e) => `<span class="month-dot ${e.type}" title="${escapeHtml(e.title)}"></span>`).join("")}
        </div>
      </div>`;
  }

  grid.innerHTML = `<div class="month-grid">${cells}</div>`;
}

// Navigate the calendar anchor (prev/next week or month)
function calNav(dir) {
  const anchor = state.calAnchor ? parseDate(state.calAnchor) : new Date();
  const delta  = state.calView === "week" ? dir * 7 : dir * 32;
  const next   = addDays(anchor, delta);
  // For month nav, snap to 1st of the new month
  if (state.calView === "month") {
    state.calAnchor = dateStr(new Date(next.getFullYear(), next.getMonth(), 1));
  } else {
    state.calAnchor = dateStr(next);
  }
  saveState();
  renderCal();
}

function deleteEvent(id) {
  state.events = state.events.filter((e) => e.id !== id);
  saveState();
  render();
}

function addEvent(title, date, time, type) {
  if (!title.trim() || !date) return;
  state.events.push({ id: cryptoId(), title: title.trim(), date, time, type });
  state.events.sort((a, b) => (a.date + (a.time||"")) > (b.date + (b.time||"")) ? 1 : -1);
  saveState();
  render();
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

// Use event delegation for all data-go buttons (today + training notes area)
document.querySelector("main").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-go]");
  if (btn) setActiveModule(btn.dataset.go);
});

// Calendar nav + view toggle + add-event form
document.getElementById("cal-export-all-btn").addEventListener("click", downloadAllICS);
document.getElementById("cal-prev").addEventListener("click", () => calNav(-1));document.getElementById("cal-next").addEventListener("click", () => calNav(1));
document.getElementById("cal-week-btn").addEventListener("click", () => {
  state.calView = "week"; saveState(); renderCal();
});
document.getElementById("cal-month-btn").addEventListener("click", () => {
  state.calView = "month"; saveState(); renderCal();
});

document.getElementById("cal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = document.getElementById("cal-title-input").value;
  const date  = document.getElementById("cal-date-input").value;
  const time  = document.getElementById("cal-time-input").value;
  const type  = document.getElementById("cal-type-input").value;
  addEvent(title, date, time, type);
  document.getElementById("cal-title-input").value = "";
  document.getElementById("cal-time-input").value  = "";
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

// ---------- PWA: service worker + auto-update ----------
// When a new version is deployed to GitHub Pages, the service worker
// detects it and silently reloads the app in the background.
// Next time you open Loadout on your phone it's already up to date —
// no reinstalling needed.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");

      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            // New version is ready — tell it to take over immediately
            newWorker.postMessage("skipWaiting");
          }
        });
      });

      // When the new worker takes control, reload the page once
      // so the user gets the fresh version without doing anything
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });

    } catch (err) {
      console.log("Service worker registration failed:", err);
    }
  });
}

// ---------- 7. INITIAL RENDER ----------
render();
