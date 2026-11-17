/* Stock Agents mobile app: talks to the GitHub REST API only (no other server). */
"use strict";

const $ = (id) => document.getElementById(id);
const STORE = "stockagents.settings.v1";
const PENDING = "stockagents.pending.v1";
const API = "https://api.github.com";
const TICKER_RE = /^[A-Z0-9.\-^=]{1,15}$/;
let pollTimer = null;
let lastIndex = [];

// ------------------------------------------------------------------ settings
function defaults() {
  // When hosted on GitHub Pages (https://OWNER.github.io/REPO/), guess owner and repo from the URL.
  const host = location.hostname.endsWith(".github.io") ? location.hostname.split(".")[0] : "";
  const repo = host ? location.pathname.split("/").filter(Boolean)[0] || "" : "";
  return { owner: host, repo, branch: "mobile", token: "", account: 10000, risk: 0.5, daily: 2,
           styles: ["investing", "swing", "day"], shorts: true, provider: "anthropic" };
}
function loadSettings() { return { ...defaults(), ...(JSON.parse(localStorage.getItem(STORE) || "{}")) }; }
function saveSettings(s) { localStorage.setItem(STORE, JSON.stringify(s)); }
function configured(s) { return s.owner && s.repo && s.branch && s.token; }

function fillSettingsForm(s) {
  $("sOwner").value = s.owner; $("sRepo").value = s.repo; $("sBranch").value = s.branch; $("sToken").value = s.token;
  $("pAccount").value = s.account; $("pRisk").value = s.risk; $("pDaily").value = s.daily;
  $("stInvesting").checked = s.styles.includes("investing"); $("stSwing").checked = s.styles.includes("swing");
  $("stDay").checked = s.styles.includes("day"); $("pShorts").checked = s.shorts; $("pProvider").value = s.provider;
}
function readSettingsForm() {
  const styles = [["stInvesting", "investing"], ["stSwing", "swing"], ["stDay", "day"]].filter(([id]) => $(id).checked).map(([, v]) => v);
  return { owner: $("sOwner").value.trim(), repo: $("sRepo").value.trim(), branch: $("sBranch").value.trim() || "mobile",
           token: $("sToken").value.trim(), account: +$("pAccount").value || 10000, risk: +$("pRisk").value || 0.5,
           daily: +$("pDaily").value || 2, styles: styles.length ? styles : ["investing", "swing", "day"],
           shorts: $("pShorts").checked, provider: $("pProvider").value };
}

// ------------------------------------------------------------------ GitHub API
async function gh(path, { method = "GET", body, raw = false } = {}) {
  const s = loadSettings();
  const res = await fetch(`${API}/repos/${s.owner}/${s.repo}${path}`, {
    method, cache: "no-store",
    headers: { Authorization: `Bearer ${s.token}`, "X-GitHub-Api-Version": "2022-11-28",
               Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
               ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status}${res.statusText ? " " + res.statusText : ""}`;
    try { msg += ": " + (await res.json()).message; } catch (_) { /* ignore */ }
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return raw ? res.text() : res.json();
}
const b64 = (str) => btoa(unescape(encodeURIComponent(str)));
const ref = () => `ref=${encodeURIComponent(loadSettings().branch)}`;

async function fetchIndex() {
  try {
    return JSON.parse(await gh(`/contents/docs/reports/index.json?${ref()}&t=${Date.now()}`, { raw: true }));
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

async function latestRun() {
  try {
    const s = loadSettings();
    const r = await gh(`/actions/runs?branch=${encodeURIComponent(s.branch)}&per_page=1`);
    return r.workflow_runs && r.workflow_runs[0];
  } catch (_) { return null; } // token may not have Actions permission
}

// ------------------------------------------------------------------ actions
async function submitAnalysis(ticker) {
  const s = loadSettings();
  const now = new Date();
  const id = `${now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}_${ticker.replace(/[^A-Z0-9]/g, "")}`;
  const request = { id, ticker, provider: s.provider, created: now.toISOString(),
    profile: { account_size: s.account, risk_per_trade_pct: s.risk, max_daily_loss_pct: s.daily, styles: s.styles, allow_shorts: s.shorts } };
  await gh(`/contents/requests/${id}.json`, { method: "PUT",
    body: { message: `Mobile request: ${ticker}`, content: b64(JSON.stringify(request, null, 1)), branch: s.branch } });
  const pending = JSON.parse(localStorage.getItem(PENDING) || "[]");
  pending.push({ id, ticker, created: request.created });
  localStorage.setItem(PENDING, JSON.stringify(pending));
  return id;
}

async function openReport(item) {
  showView("viewReport");
  $("reportTitle").textContent = `${item.ticker} · loading…`;
  $("frame").srcdoc = "<p style='font-family:sans-serif;padding:20px'>Loading report…</p>";
  try {
    const html = await gh(`/contents/docs/reports/${item.id}.html?${ref()}`, { raw: true });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    $("frame").removeAttribute("srcdoc");
    $("frame").src = url;
    $("btnOpenNew").href = url;
    $("reportTitle").textContent = `${item.ticker}${item.price ? " · $" + item.price : ""}`;
  } catch (e) {
    $("frame").srcdoc = `<p style='font-family:sans-serif;padding:20px;color:#c62828'>Could not load report: ${escapeHtml(e.message)}</p>`;
  }
}

// ------------------------------------------------------------------ UI
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now"; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString();
}
function showView(id) {
  for (const v of ["viewHome", "viewReport", "viewSettings"]) $(v).classList.toggle("hidden", v !== id);
  window.scrollTo(0, 0);
}
function notice(msg, isError = false) {
  const n = $("notice");
  if (!msg) { n.classList.add("hidden"); return; }
  n.innerHTML = msg; n.classList.toggle("error", isError); n.classList.remove("hidden");
}
function updateProfileLine() {
  const s = loadSettings();
  $("profileLine").textContent = `Account $${(+s.account).toLocaleString()} · risk ${s.risk}% · ${s.styles.join(", ")} · ${s.provider}`;
}

function render(index) {
  const done = new Set(index.map((e) => e.id));
  let pending = JSON.parse(localStorage.getItem(PENDING) || "[]").filter((p) => !done.has(p.id));
  pending = pending.filter((p) => Date.now() - new Date(p.created).getTime() < 3 * 3600 * 1000); // drop very old
  localStorage.setItem(PENDING, JSON.stringify(pending));
  const items = [...pending.map((p) => ({ ...p, status: "pending" })), ...index];
  const ul = $("list");
  ul.innerHTML = items.length ? "" : "<li class='meta'>No reports yet. Enter a ticker above.</li>";
  for (const it of items) {
    const li = document.createElement("li");
    const label = it.status === "pending" ? "running… (3-5 min)" : it.status === "error" ? "error" : "ready";
    const fallbackNote = it.ai_fallbacks ? ` · ⚠️ ${it.ai_fallbacks} agent(s) without AI` : "";
    li.innerHTML = `<div class="top"><span class="tk">${escapeHtml(it.ticker)}</span>
        <span class="badge ${it.status}">${label}</span></div>
      <div class="meta">${escapeHtml(it.company || "")} ${it.price ? "· $" + it.price : ""} · ${ago(it.created)}${it.seconds ? " · " + Math.round(it.seconds) + "s" : ""}${fallbackNote}</div>
      ${it.headline ? `<div class="head">${escapeHtml(it.headline)}</div>` : ""}
      ${it.error ? `<div class="head" style="color:#c62828">${escapeHtml(it.error)}</div>` : ""}`;
    if (it.status === "done") li.onclick = () => openReport(it);
    ul.appendChild(li);
  }
  return pending.length;
}

async function refresh() {
  const s = loadSettings();
  if (!configured(s)) {
    notice("Open <b>⚙️ Settings</b> and connect your GitHub repository to start.");
    $("list").innerHTML = "";
    return;
  }
  try {
    lastIndex = await fetchIndex();
    const nPending = render(lastIndex);
    notice("");
    const run = await latestRun();
    $("serverStatus").textContent = run
      ? `Server: last job ${run.status}${run.conclusion ? " (" + run.conclusion + ")" : ""} · ${ago(run.created_at)}`
      : "";
    schedulePoll(nPending > 0 ? 15000 : 0);
  } catch (e) {
    notice(`Could not reach GitHub: ${escapeHtml(e.message)}. Check ⚙️ Settings (owner, repo, branch, token).`, true);
    schedulePoll(0);
  }
}
function schedulePoll(ms) {
  clearTimeout(pollTimer);
  if (ms) pollTimer = setTimeout(refresh, ms);
}

// ------------------------------------------------------------------ wiring
$("formAnalyze").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const ticker = $("ticker").value.trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) { notice("Please enter a valid ticker (letters, numbers, . - ^ =).", true); return; }
  if (!configured(loadSettings())) { showView("viewSettings"); return; }
  $("btnAnalyze").disabled = true;
  try {
    await submitAnalysis(ticker);
    $("ticker").value = "";
    notice(`✅ Request for <b>${escapeHtml(ticker)}</b> sent. The GitHub server is starting; the report appears here in about 3-5 minutes.`);
    render(lastIndex);
    schedulePoll(15000);
  } catch (e) {
    notice(`Could not send the request: ${escapeHtml(e.message)}`, true);
  } finally {
    $("btnAnalyze").disabled = false;
  }
});
$("btnRefresh").onclick = refresh;
$("btnBack").onclick = () => { showView("viewHome"); refresh(); };
$("btnSettings").onclick = () => { fillSettingsForm(loadSettings()); $("testResult").textContent = ""; showView("viewSettings"); };
$("btnCancel").onclick = () => showView("viewHome");
$("formSettings").addEventListener("submit", (ev) => {
  ev.preventDefault(); saveSettings(readSettingsForm()); updateProfileLine(); showView("viewHome"); refresh();
});
$("btnTest").onclick = async () => {
  const s = readSettingsForm();
  if (!configured(s)) { $("testResult").textContent = "❌ Fill in owner, repository, branch and token first."; return; }
  saveSettings(s);
  $("testResult").textContent = "Testing…";
  try {
    const r = await gh("");
    const perm = r.permissions ? (r.permissions.push ? "write access ✅" : "read-only ❌ (token needs Contents: Read and write)") : "";
    await gh(`/branches/${encodeURIComponent(loadSettings().branch)}`);
    $("testResult").textContent = `Connected to ${r.full_name} (${r.private ? "private" : "public"}), branch OK, ${perm}`;
  } catch (e) {
    $("testResult").textContent = `❌ ${e.message}`;
  }
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
updateProfileLine();
refresh();
