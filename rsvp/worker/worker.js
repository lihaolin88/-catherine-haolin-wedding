// Cloudflare Worker: the backend for the wedding questionnaire.
//
//   POST /rsvp                     a guest submits the form (called by script.js)
//   GET  /admin?key=…              private page listing every response (phone-friendly)
//   GET  /admin/responses.xlsx?key=…  download the Excel file
//   POST /admin/delete?key=…       delete one guest's response (from the admin page)
//   POST /admin/import?key=…       add answers a guest sent over WeChat (pasted text)
//
// A guest who submits again under the same name (case/spacing ignored)
// replaces their earlier answers, so mistakes can be fixed by resubmitting.
//
// Responses are stored as responses.json in a private GitHub repo; a GitHub
// Action in that repo rebuilds responses.xlsx / responses.csv on every change.
//
// Secrets (set with `wrangler secret put`): GITHUB_TOKEN, ADMIN_KEY
// Vars (wrangler.toml): DATA_REPO ("owner/name"), ALLOWED_ORIGIN

const FIELDS = ["name", "arrival", "firstCourse", "mainCourse", "allergies", "drinks", "notes", "wishes", "lang"];
const MAX_LEN = 2000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/rsvp") {
        const origin = req.headers.get("Origin");
        if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), env, origin);
        if (req.method === "POST") return withCors(await submit(req, env), env, origin);
      }
      if (url.pathname.startsWith("/admin")) {
        if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
          return new Response("Not found", { status: 404 });
        }
        if (url.pathname === "/admin") return await adminPage(env, url);
        if (url.pathname === "/admin/responses.xlsx") return await downloadXlsx(env);
        if (url.pathname === "/admin/delete" && req.method === "POST") return await deleteResponse(req, env);
        if (url.pathname === "/admin/import" && req.method === "POST") return await importPasted(req, env);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return withCors(json({ ok: false, error: "server_error" }, 500), env, req.headers.get("Origin"));
    }
  },
};

/* ---------------- submit ---------------- */

async function submit(req, env) {
  let data;
  try {
    data = JSON.parse(await req.text());
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const row = normalizeRow(data);
  if (!row) return json({ ok: false, error: "missing_fields" }, 400);
  const { updated } = await upsertRow(env, row);
  return json({ ok: true, updated });
}

// Keep only known fields, trimmed and length-capped; null if required ones are missing.
function normalizeRow(data) {
  const row = {};
  for (const k of FIELDS) row[k] = String(data[k] ?? "").trim().slice(0, MAX_LEN);
  row.name = row.name.replace(/\s+/g, " ");
  if (!row.name || !row.firstCourse || !row.mainCourse) return null;
  return row;
}

// Insert, or replace the guest's earlier answers if the name matches.
// Read-modify-write with the file's sha; retry if another write landed in
// between (GitHub answers 409/422 on a stale sha).
async function upsertRow(env, row) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  row.submittedAt = now;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows, sha } = await readResponses(env);
    const idx = rows.findIndex((r) => nameKey(r.name) === nameKey(row.name));
    if (idx >= 0) {
      row.firstSubmittedAt = rows[idx].firstSubmittedAt || rows[idx].submittedAt;
      rows[idx] = row;
    } else {
      row.firstSubmittedAt = now;
      rows.push(row);
    }
    const res = await gh(env, "contents/responses.json", {
      method: "PUT",
      body: JSON.stringify({
        message: `RSVP ${idx >= 0 ? "updated" : "new"}${row.source ? ` (${row.source})` : ""}: ${row.name}`,
        content: toBase64(JSON.stringify(rows, null, 2) + "\n"),
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.ok) return { updated: idx >= 0 };
    if (res.status !== 409 && res.status !== 422) {
      throw new Error(`GitHub PUT failed: ${res.status} ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
  }
  throw new Error("GitHub PUT kept conflicting");
}

// Same read-modify-write + retry pattern as submit(), removing one guest by name.
async function deleteResponse(req, env) {
  let name;
  try {
    name = JSON.parse(await req.text()).name;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows, sha } = await readResponses(env);
    const kept = rows.filter((r) => nameKey(r.name) !== nameKey(name));
    if (kept.length === rows.length) return json({ ok: false, error: "not_found" }, 404);
    const res = await gh(env, "contents/responses.json", {
      method: "PUT",
      body: JSON.stringify({
        message: `RSVP deleted: ${name}`,
        content: toBase64(JSON.stringify(kept, null, 2) + "\n"),
        sha,
      }),
    });
    if (res.ok) return json({ ok: true });
    if (res.status !== 409 && res.status !== 422) {
      throw new Error(`GitHub PUT failed: ${res.status} ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
  }
  throw new Error("GitHub PUT kept conflicting");
}

async function readResponses(env) {
  const res = await gh(env, "contents/responses.json");
  if (res.status === 404) return { rows: [], sha: null };
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);
  const file = await res.json();
  return { rows: JSON.parse(fromBase64(file.content)), sha: file.sha };
}

/* ---------------- import (admin "paste to add") ---------------- */

// Labels used by the "copy my answers" text on the site (script.js COPY_LABELS).
const PASTE_LABELS = {
  "名字 Name": "name",
  "头盘 First course": "firstCourse",
  "主菜 Main course": "mainCourse",
  "抵达夏威夷 Arrival": "arrival",
  "过敏 Allergies": "allergies",
  "酒水 Drinks": "drinks",
  "注意事项 Notes": "notes",
  "祝福 Blessings": "wishes",
};

// Accepts one or more pasted answer blocks. Each RSVP-DATA line is decoded
// exactly; if none survived (e.g. the guest trimmed it), fall back to reading
// the labelled lines.
function parsePasted(text) {
  const found = [];
  for (const m of text.matchAll(/RSVP-DATA:\s*([A-Za-z0-9+/=]+)/g)) {
    try {
      found.push(JSON.parse(fromBase64(m[1])));
    } catch {}
  }
  if (found.length) return found;

  const data = {};
  let key = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const label = Object.keys(PASTE_LABELS).find((l) => line.startsWith(l + ":") || line.startsWith(l + "："));
    if (label) {
      key = PASTE_LABELS[label];
      data[key] = line.slice(label.length + 1).trim();
    } else if (key && line && !line.startsWith("【")) {
      data[key] += "\n" + line; // continuation of a multi-line answer
    }
  }
  return data.name ? [data] : [];
}

async function importPasted(req, env) {
  let text;
  try {
    text = JSON.parse(await req.text()).text || "";
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const results = [];
  for (const data of parsePasted(text)) {
    const row = normalizeRow(data);
    if (!row) continue;
    row.source = "wechat";
    const { updated } = await upsertRow(env, row);
    results.push({ name: row.name, updated });
  }
  if (!results.length) return json({ ok: false, error: "nothing_found" }, 400);
  return json({ ok: true, results });
}

/* ---------------- admin ---------------- */

async function downloadXlsx(env) {
  const res = await gh(env, "contents/responses.xlsx", { headers: { Accept: "application/vnd.github.raw" } });
  if (!res.ok) return new Response("The Excel file hasn't been generated yet — try again in a minute.", { status: 404 });
  return new Response(res.body, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="wedding-rsvp.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}

async function adminPage(env, url) {
  const { rows } = await readResponses(env);
  rows.sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || "")); // newest first

  const count = (key) => {
    const c = {};
    for (const r of rows) c[r[key] || "—"] = (c[r[key] || "—"] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  };
  const tally = (title, key) =>
    `<div class="tally"><h3>${title}</h3>${count(key)
      .map(([k, n]) => `<div class="tl"><span>${esc(k)}</span><b>${n}</b></div>`)
      .join("")}</div>`;

  const line = (label, value) => (value ? `<div class="ln"><span>${label}</span><p>${esc(value)}</p></div>` : "");
  const cards = rows
    .map(
      (r) => `<article class="card" data-search="${esc(Object.values(r).join(" ").toLowerCase())}">
  <header><h2>${esc(r.name)}</h2><time>${esc(r.submittedAt)} UTC${r.firstSubmittedAt && r.firstSubmittedAt !== r.submittedAt ? " · 已修改" : ""}${r.source === "wechat" ? " · 微信补录" : ""}</time></header>
  ${line("抵达 Arrival", r.arrival)}
  ${line("头盘 First course", r.firstCourse)}
  ${line("主菜 Main course", r.mainCourse)}
  ${line("过敏 Allergies", r.allergies)}
  ${line("酒水 Drinks", r.drinks)}
  ${line("注意事项 Notes", r.notes)}
  ${line("祝福 Blessings", r.wishes)}
  <button class="del" type="button" data-name="${esc(r.name)}">删除这条回复</button>
</article>`
    )
    .join("\n");

  const byDish = {};
  for (const [label, key] of [["头盘", "firstCourse"], ["主菜", "mainCourse"]]) {
    for (const r of rows) {
      const k = `${label} · ${r[key] || "—"}`;
      (byDish[k] = byDish[k] || []).push(r.name);
    }
  }
  const dishPicker = rows.length
    ? `<div class="tally picker"><h3>按菜品查看谁选了</h3>
<select id="dish"><option value="">选择一道菜…</option>${Object.keys(byDish)
        .sort()
        .map((k) => `<option value="${esc(k)}">${esc(k)}（${byDish[k].length}）</option>`)
        .join("")}</select><ul id="dishNames"></ul></div>`
    : "";

  const xlsxHref = `/admin/responses.xlsx?key=${encodeURIComponent(url.searchParams.get("key"))}`;
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>宾客问卷 · ${rows.length}</title>
<style>
:root{--cream:#f6f0e2;--line:#e2d3ac;--gold:#a3823a;--deep:#7c5e28;--ink:#4a3b1e;--white:#fffdf8}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--ink);font:16px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:20px 16px 48px}
main{max-width:720px;margin:0 auto}
h1{color:var(--deep);font-size:24px;margin:0 0 4px}
.sub{color:var(--gold);margin:0 0 18px}
.bar{display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap}
.bar input{flex:1;min-width:180px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--white)}
.btn{display:inline-block;padding:10px 16px;border:1.5px solid var(--gold);border-radius:999px;color:var(--deep);text-decoration:none;background:var(--white)}
.tallies{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:22px}
.tally,.card{background:var(--white);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tally h3{margin:0 0 8px;font-size:14px;color:var(--gold);letter-spacing:.05em}
.tl{display:flex;justify-content:space-between;gap:10px;padding:3px 0}
.tl b{color:var(--deep)}
.card{margin-bottom:12px}
.card header{display:flex;justify-content:space-between;align-items:baseline;gap:10px;border-bottom:1px solid var(--line);padding-bottom:6px;margin-bottom:8px}
.card h2{margin:0;font-size:19px;color:var(--deep)}
.card time{font-size:12px;color:var(--gold);white-space:nowrap}
.del{margin-top:10px;padding:6px 14px;border:1px solid #c98b78;border-radius:999px;background:none;color:#b4573c;font:inherit;font-size:13px;cursor:pointer}
.del:disabled{opacity:.5}
.ln{display:grid;grid-template-columns:110px 1fr;gap:8px;padding:3px 0}
.ln span{font-size:13px;color:var(--gold)}
.ln p{margin:0;white-space:pre-wrap;word-break:break-word}
.empty{text-align:center;color:var(--gold);padding:40px 0}
.paste{margin-bottom:22px}
.paste summary{cursor:pointer;color:var(--deep);font-weight:600}
.paste .hint{font-size:13px;color:var(--gold);margin:10px 0}
.paste textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:14px;background:var(--cream);color:var(--ink);margin-bottom:10px}
.paste .msg{margin:8px 0 0;font-size:14px;color:var(--deep)}
.picker{margin-bottom:22px}
.picker select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--cream);color:var(--ink)}
.picker ul{margin:10px 0 0;padding-left:20px}
.picker li{padding:2px 0}
</style></head><body><main>
<h1>宾客问卷回复</h1>
<p class="sub">共 ${rows.length} 份 · 刷新页面即可看到最新回复</p>
<div class="bar"><input id="q" type="search" placeholder="搜索名字、过敏、祝福…"><a class="btn" href="${xlsxHref}">下载 Excel</a></div>
<details class="tally paste"><summary>粘贴添加（客人用微信发来的回答）</summary>
<p class="hint">把客人发来的整段文字原样粘贴进来，点「添加」。同名的客人会覆盖之前的记录。一次可以粘贴多位客人的。</p>
<textarea id="pasteText" rows="7" placeholder="【Catherine &amp; Haolin 婚礼问卷 RSVP】&#10;名字 Name: …&#10;…&#10;RSVP-DATA:…"></textarea>
<button class="btn" id="pasteBtn" type="button">添加</button><p class="msg" id="pasteMsg"></p>
</details>
${rows.length ? `<div class="tallies">${tally("头盘 First course", "firstCourse")}${tally("主菜 Main course", "mainCourse")}</div>` : ""}
${dishPicker}
${cards || '<p class="empty">还没有人填写</p>'}
</main>
<script>
var BY_DISH=${JSON.stringify(byDish).replace(/</g, () => String.fromCharCode(92) + "u003c")};
var dish=document.getElementById("dish");
if(dish)dish.addEventListener("change",function(){var ul=document.getElementById("dishNames");ul.innerHTML="";
(BY_DISH[dish.value]||[]).forEach(function(n){var li=document.createElement("li");li.textContent=n;ul.appendChild(li)})});
var IMPORT_URL=${JSON.stringify("/admin/import?key=" + encodeURIComponent(url.searchParams.get("key")))};
document.getElementById("pasteBtn").addEventListener("click",function(){
var btn=this,msg=document.getElementById("pasteMsg"),text=document.getElementById("pasteText").value;
if(!text.trim()){msg.textContent="请先粘贴内容。";return}
btn.disabled=true;msg.textContent="添加中…";
fetch(IMPORT_URL,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({text:text})})
.then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})})
.then(function(x){if(!x.ok){msg.textContent=x.d.error==="nothing_found"?"没有识别出回答，请确认粘贴的是完整内容（需要包含名字、头盘和主菜）。":"添加失败，请稍后再试。";btn.disabled=false;return}
msg.textContent="已添加："+x.d.results.map(function(r){return r.name+(r.updated?"（覆盖了旧记录）":"")}).join("、")+"，正在刷新…";
setTimeout(function(){location.reload()},1200)})
.catch(function(){msg.textContent="添加失败，请稍后再试。";btn.disabled=false})});
var DELETE_URL=${JSON.stringify("/admin/delete?key=" + encodeURIComponent(url.searchParams.get("key")))};
document.querySelectorAll(".del").forEach(function(btn){btn.addEventListener("click",function(){
var name=btn.getAttribute("data-name");
if(!confirm("确定要删除「"+name+"」的回复吗？它会从这个页面和 Excel 中移除。"))return;
btn.disabled=true;btn.textContent="删除中…";
fetch(DELETE_URL,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({name:name})})
.then(function(r){if(!r.ok)throw new Error(r.status);location.reload()})
.catch(function(){alert("删除失败，请稍后再试。");btn.disabled=false;btn.textContent="删除这条回复"})})});
document.getElementById("q").addEventListener("input",function(e){var q=e.target.value.trim().toLowerCase();
document.querySelectorAll(".card").forEach(function(c){c.style.display=!q||c.dataset.search.indexOf(q)>-1?"":"none"})});
</script></body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

/* ---------------- helpers ---------------- */

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.DATA_REPO}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "wedding-rsvp-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}

function nameKey(name) {
  return String(name || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function withCors(res, env, requestOrigin) {
  const h = new Headers(res.headers);
  // ALLOWED_ORIGIN is a comma-separated list; echo back whichever one matches.
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((o) => o.trim());
  const origin = requestOrigin || "";
  h.set("Access-Control-Allow-Origin", allowed.includes("*") || allowed.includes(origin) ? origin || "*" : allowed[0]);
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
