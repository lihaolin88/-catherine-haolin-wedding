// Cloudflare Worker: the backend for the wedding questionnaire.
//
//   POST /rsvp                     a guest submits the form (called by script.js)
//   GET  /admin?key=…              private page listing every response (phone-friendly)
//   GET  /admin/responses.xlsx?key=…  download the Excel file
//   POST /admin/delete?key=…       delete one guest's response (from the admin page)
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
  const row = {};
  for (const k of FIELDS) row[k] = String(data[k] ?? "").trim().slice(0, MAX_LEN);
  if (!row.name || !row.firstCourse || !row.mainCourse) {
    return json({ ok: false, error: "missing_fields" }, 400);
  }
  row.name = row.name.replace(/\s+/g, " ");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  row.submittedAt = now;

  // Read-modify-write with the file's sha; retry if another submission
  // landed in between (GitHub answers 409/422 on a stale sha).
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
        message: `RSVP ${idx >= 0 ? "updated" : "new"}: ${row.name}`,
        content: toBase64(JSON.stringify(rows, null, 2) + "\n"),
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.ok) return json({ ok: true, updated: idx >= 0 });
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
  <header><h2>${esc(r.name)}</h2><time>${esc(r.submittedAt)} UTC${r.firstSubmittedAt && r.firstSubmittedAt !== r.submittedAt ? " · 已修改" : ""}</time></header>
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
.picker{margin-bottom:22px}
.picker select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--cream);color:var(--ink)}
.picker ul{margin:10px 0 0;padding-left:20px}
.picker li{padding:2px 0}
</style></head><body><main>
<h1>宾客问卷回复</h1>
<p class="sub">共 ${rows.length} 份 · 刷新页面即可看到最新回复</p>
<div class="bar"><input id="q" type="search" placeholder="搜索名字、过敏、祝福…"><a class="btn" href="${xlsxHref}">下载 Excel</a></div>
${rows.length ? `<div class="tallies">${tally("头盘 First course", "firstCourse")}${tally("主菜 Main course", "mainCourse")}</div>` : ""}
${dishPicker}
${cards || '<p class="empty">还没有人填写</p>'}
</main>
<script>
var BY_DISH=${JSON.stringify(byDish).replace(/</g, () => String.fromCharCode(92) + "u003c")};
var dish=document.getElementById("dish");
if(dish)dish.addEventListener("change",function(){var ul=document.getElementById("dishNames");ul.innerHTML="";
(BY_DISH[dish.value]||[]).forEach(function(n){var li=document.createElement("li");li.textContent=n;ul.appendChild(li)})});
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
