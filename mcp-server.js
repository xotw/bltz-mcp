#!/usr/bin/env node
/* Dispatch MCP — Bltz46. Zero dependencies, Node >= 18.
 *
 * Signs in as a real user and talks to Supabase's REST API directly, so every
 * call passes through the same row-level security as the browser. An agent can
 * never see or change anything the person behind it could not.
 *
 * Zero dependencies on purpose: the file is the release. No npm, no lockfile,
 * no build. Download it and it runs, which is what makes a one-line installer
 * possible for a teammate who should not have to clone a repo to check a task.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const URL_ = process.env.BLTZ_SUPABASE_URL || "https://iywkofiruinmkvsjocvz.supabase.co";
const ANON = process.env.BLTZ_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5d2tvZmlydWlubWt2c2pvY3Z6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NjI5NzcsImV4cCI6MjEwMzIzODk3N30.3ryrpXvH1N-mbR4fnmvSSIvALGO55nqSZkojEWvjDnQ";
const CONF_DIR = path.join(os.homedir(), ".config", "bltz");
const CONF = path.join(CONF_DIR, "config.json");

const loadConf = () => { try { return JSON.parse(fs.readFileSync(CONF, "utf8")); } catch { return null; } };
const saveConf = (c) => {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 });
};

/** Refresh once on a 401, then stop.
 *  The single boolean is what keeps a dead token from becoming an infinite
 *  loop of refresh attempts against an endpoint that will never say yes. */
async function refresh(conf) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: conf.refresh_token }),
  });
  if (!r.ok) return false;
  const j = await r.json();
  saveConf({ ...conf, access_token: j.access_token, refresh_token: j.refresh_token });
  return true;
}

async function rest(pathname, opts = {}, retry = true) {
  const conf = loadConf();
  if (!conf?.access_token) throw new Error("Not logged in. Run `bltz login`.");
  const headers = {
    apikey: ANON,
    Authorization: `Bearer ${conf.access_token}`,
    "Content-Type": "application/json",
    "Accept-Profile": "dispatch",
    "Content-Profile": "dispatch",
  };
  if (opts.method && opts.method !== "GET") headers.Prefer = "return=representation";
  const r = await fetch(URL_ + pathname, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (r.status === 401 && retry && conf.refresh_token) {
    if (await refresh(conf)) return rest(pathname, opts, false);
    throw new Error("Session expired — run `bltz login`.");
  }
  if (!r.ok) {
    const body = await r.text();
    throw new Error(body.slice(0, 300) || `HTTP ${r.status}`);
  }
  return r.status === 204 ? null : r.json();
}

/** Enough of the supabase-js surface that the tools copy across untouched.
 *
 *  The alternative was rewriting twenty-eight tool bodies with a regex, which
 *  is how you get code that looks converted and is quietly wrong in three
 *  places. A builder that is thenable — awaiting it runs the request and
 *  resolves to { data, error }, exactly as the real client does — means the
 *  tools are the same text in both files, and there is nothing to get wrong.
 */
function query(table) {
  const parts = [];
  let single = false;
  let write = null;

  const self = {
    select(cols = "*") { parts.push(`select=${encodeURIComponent(cols)}`); return self; },
    eq(c, v) { parts.push(`${c}=eq.${encodeURIComponent(v)}`); return self; },
    neq(c, v) { parts.push(`${c}=neq.${encodeURIComponent(v)}`); return self; },
    gt(c, v) { parts.push(`${c}=gt.${encodeURIComponent(v)}`); return self; },
    lte(c, v) { parts.push(`${c}=lte.${encodeURIComponent(v)}`); return self; },
    is(c, v) { parts.push(`${c}=is.${v === null ? "null" : v}`); return self; },
    like(c, v) { parts.push(`${c}=like.${encodeURIComponent(v)}`); return self; },
    ilike(c, v) { parts.push(`${c}=ilike.${encodeURIComponent(v)}`); return self; },
    in(c, vs) { parts.push(`${c}=in.(${vs.map((v) => encodeURIComponent(v)).join(",")})`); return self; },
    order(c, o = {}) {
      parts.push(`order=${c}.${o.ascending === false ? "desc" : "asc"}` +
        (o.nullsFirst ? ".nullsfirst" : o.nullsFirst === false ? ".nullslast" : ""));
      return self;
    },
    limit(n) { parts.push(`limit=${n}`); return self; },
    single() { single = true; return self; },
    maybeSingle() { single = true; return self; },
    insert(rows) { write = { method: "POST", body: rows }; return self; },
    // Skip the RETURNING clause. Some tables grant INSERT but refuse the
    // read-back, and asking for it turns a good write into a 401.
    minimal() { write = { ...write, headers: { ...(write?.headers || {}), Prefer: "return=minimal" } }; return self; },
    update(patch) { write = { method: "PATCH", body: patch }; return self; },
    upsert(rows, opts = {}) {
      write = { method: "POST", body: rows,
                headers: { Prefer: `return=representation,resolution=merge-duplicates${opts.onConflict ? "" : ""}` } };
      if (opts.onConflict) parts.push(`on_conflict=${opts.onConflict}`);
      return self;
    },
    delete() { write = { method: "DELETE" }; return self; },

    // Thenable: awaiting the builder is what sends the request.
    then(resolve, reject) {
      const qs = parts.length ? `?${parts.join("&")}` : "";
      const opts = write
        ? { method: write.method, body: write.body ? JSON.stringify(write.body) : undefined,
            headers: write.headers }
        : {};
      return rest(`/rest/v1/${table}${qs}`, opts)
        .then((data) => {
          const rows = Array.isArray(data) ? data : data == null ? [] : [data];
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        })
        .catch((e) => ({ data: null, error: { message: e.message, code: e.code } }))
        .then(resolve, reject);
    },
  };
  return self;
}

/** The same shape the tools expect from the real client. */
const db = {
  from: (table) => query(table),
  rpc: (fn, args = {}) =>
    rest(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) })
      .then((data) => ({ data, error: null }))
      .catch((e) => ({ data: null, error: { message: e.message } })),
  auth: {
    // The MCP signs in from the saved session rather than a password, so the
    // tools that ask who they are still work.
    getUser: async () => {
      const conf = loadConf();
      return { data: { user: conf ? { id: conf.user_id, email: conf.email } : null } };
    },
  },
};

let me = null;

const INSTRUCTIONS = `Dispatch is Bltz46's own system: missions, the Hunt pipeline, contracts,
invoices and the money. Every call runs as a real signed-in user under row-level
security, so what you can see is exactly what that person can see.

When Gab says "dispatch" or "where are we", open with a short standup: what is
waiting on a client (paperwork), what money is owed or due next (billing), and
anything unread (notifications). A few scannable lines, no preamble.

Rules that matter more than the tools:

- Reply in the user's language. He writes French and English; match him.
- Never invent a number. If a tool did not return it, say you do not have it.
  Money and dates in this system are real: an invoice reached a client by
  mistake once already.
- Destructive actions confirm the exact item first, always, and name what will
  be lost. Signed contracts and issued invoices cannot be deleted at all — the
  database refuses — so do not offer it.
- Secrets are never returned. \`credentials\` lists what exists, never a value.
  If someone needs one, tell them to read it in the app, where the read is
  logged.
- Test on the mission called Test, never on a client mission. Signing a contract
  there issues a real invoice and emails a real client.
- An empty result usually means row-level security hid it, not that nothing
  exists. Say "nothing visible to you" rather than "there is nothing".

ZEUS — the delivery machine, one per client (zeus_* tools). A "machine" is a
deployment slug: bltz is ours, trellis and others are clients. The board
(zeus_board), people (zeus_people) and the logs (zeus_events) take the same
filter document the app speaks; the canvas is tables (zeus_tables): live cuts
with history, actions, formula columns (zeus_add_formula — Excel-like, try
zeus_formula_preview first) and row workflows (zeus_set_workflow: if
<condition> then <action>, dry by default, zeus_workflow_runs for the log). Anything that spends or sends — enrich, launch, push
to the CRM, an auto action, a market signal — is confirmed with the person
first and needs the acting switch (zeus_access) unless you are staff. Promote
or dismiss only when the person has decided — a promotion sends. zeus_where_is
answers "where is this person" for any LinkedIn URL.

THE KITCHEN — before using an external API or running a delivery, call
\`playbook\` for it (\`playbooks\` lists them). A playbook is written for you: it
says how to call anything, has a Router (what you have → what you want → which
step), one executable step per scenario, the dead endpoints with their exact
bodies, and when its facts were measured. Follow it rather than the vendor's
docs or memory; if it says an endpoint is dead, do not call it. If you learn
something it does not say, tell the user so the playbook gets updated
(\`upsert_playbook\`).

DISPATCH covers every tab of a mission: settings (update_mission), members and
client levels, tasks and comments, the inbox, events, files, transcripts,
contacts, tools and the Gantt, creatives, the questionnaire, contracts and
proposals, agents; and the workspace: kitchen (playbooks), time, activity,
portfolio, the price book, the war room, studio, control, legal. Inviting
people (invite) and changing a client's level change what a real person
receives — read it back and get a go.`;


const ok = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (m) => ({ content: [{ type: "text", text: `Error: ${m}` }], isError: true });

/** One place to turn a PostgREST error into something a person can act on.
 *  An empty result and a refused query are different answers, and collapsing
 *  them into "nothing found" is how a permissions problem gets misread as an
 *  empty table. */
async function run(q) {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data;
}


/** Resolve a mission by name, so callers can say "Trellis" rather than a uuid. */
async function missionByName(name) {
  // ilike with wildcards, so "trel" finds Trellis — but an ambiguous name must
  // never resolve silently to the first row. Listing the options lets the agent
  // ask instead of guessing, and a wrong mission here writes to a real client.
  const rows = await run(db.from("missions").select("id,name").ilike("name", `%${name}%`).limit(5));
  if (rows.length === 0) throw new Error(`No mission matching "${name}".`);
  if (rows.length > 1) {
    throw new Error(`"${name}" matches ${rows.map((r) => r.name).join(", ")} — say which.`);
  }
  return rows[0];
}

/** Resolvers.
 *
 *  Nobody types a uuid, and every one of these refuses rather than guessing
 *  when a name is ambiguous. Picking the first match here writes to the wrong
 *  client, which is the failure that is expensive and silent.
 */
async function taskByRef(ref) {
  const m = /^([A-Za-z]+)-(\d+)$/.exec(String(ref).trim());
  if (!m) throw new Error(`Reference looks like TRL-12, got ${JSON.stringify(ref)}.`);
  const [mission] = await run(db.from("missions").select("id,name,key").ilike("key", m[1]));
  if (!mission) throw new Error(`No mission with key ${m[1].toUpperCase()}.`);
  const [task] = await run(db.from("tasks").select("id,title,num")
    .eq("mission_id", mission.id).eq("num", Number(m[2])));
  if (!task) throw new Error(`${mission.key}-${m[2]} does not exist.`);
  return task;
}

async function accountByName(name) {
  const rows = await run(db.from("accounts").select("id,company").ilike("company", `%${name}%`).limit(5));
  if (!rows.length) throw new Error(`No account matching "${name}".`);
  if (rows.length > 1) throw new Error(`"${name}" matches ${rows.map((r) => r.company).join(", ")} — say which.`);
  return rows[0];
}

async function personByName(name) {
  const rows = await run(db.from("profiles").select("id,name").ilike("name", `%${name}%`).limit(5));
  if (!rows.length) throw new Error(`No teammate matching "${name}".`);
  if (rows.length > 1) throw new Error(`"${name}" matches ${rows.map((r) => r.name).join(", ")} — say which.`);
  return rows[0];
}

// A payment dated in UTC is a day early every night before 02:00 Paris, and
// this lands on an accounting record.
const localDate = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};


/* ── Zeus ────────────────────────────────────────────────────────────────────
 * Zeus is the delivery machine (zeus.bltz46.com). Its BFF accepts the same
 * Dispatch session, verifies it against Dispatch's auth and reads the person's
 * role and missions as them — so these tools can see exactly what the person
 * would see in the app: staff every machine, a client theirs. No database
 * credential comes anywhere near this file. */
const ZEUS = process.env.ZEUS_URL || "https://zeus.bltz46.com";
async function zeus(pathname, opts = {}, retry = true) {
  const conf = loadConf();
  if (!conf?.access_token) throw new Error("Not logged in. Run `bltz login`.");
  const r = await fetch(ZEUS + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${conf.access_token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (r.status === 401 && retry && conf.refresh_token) {
    if (await refresh(conf)) return zeus(pathname, opts, false);
    throw new Error("Session expired — run `bltz login`.");
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `Zeus HTTP ${r.status}`);
  return body;
}
/** A Dispatch edge function, as the signed-in user. */
async function edgeFn(name, body) {
  const conf = loadConf();
  if (!conf?.access_token) throw new Error("Not logged in. Run `bltz login`.");
  const r = await fetch(`${URL_}/functions/v1/${name}`, { method: "POST", headers: { Authorization: `Bearer ${conf.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error ?? `${name} failed (${r.status})`);
  return out;
}
/** Zeus, when the answer is a file (CSV) rather than JSON. */
async function zeusText(pathname, opts = {}, retry = true) {
  const conf = loadConf();
  if (!conf?.access_token) throw new Error("Not logged in. Run `bltz login`.");
  const r = await fetch(ZEUS + pathname, { ...opts, headers: { Authorization: `Bearer ${conf.access_token}`, "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (r.status === 401 && retry && conf.refresh_token) { if (await refresh(conf)) return zeusText(pathname, opts, false); throw new Error("Session expired — run `bltz login`."); }
  const text = await r.text();
  if (!r.ok) { try { throw new Error(JSON.parse(text)?.error || `Zeus HTTP ${r.status}`); } catch (e) { if (e instanceof SyntaxError) throw new Error(`Zeus HTTP ${r.status}`); throw e; } }
  return text;
}
/* The booth and ingest routes take a shared secret, not a session. Only set
 * ZEUS_BOOTH_SECRET where an agent is meant to feed a machine. */
async function zeusSecret(pathname, body) {
  const secret = process.env.ZEUS_BOOTH_SECRET;
  if (!secret) throw new Error("ZEUS_BOOTH_SECRET is not set for this MCP; the booth and ingest routes need it.");
  const r = await fetch(ZEUS + pathname, { method: "POST", headers: { "Content-Type": "application/json", "x-zeus-secret": secret }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `Zeus HTTP ${r.status}`);
  return j;
}

/* ── The Kitchen's grammar, in plain JS ─────────────────────────────────────
 * A port of bltz-dispatch/src/lib/playbook-parser.ts, kept here so a model can
 * upsert a playbook from Markdown with zero dependencies. Change one, change
 * the other; the round-trip test in Dispatch pins the TypeScript side.
 *
 *   ---  frontmatter: title, description, kind, tools, keys, repo, measured_on, kickoff_prompt
 *   intro (before the first `## `), with the `### Router` table
 *   ## Step — first fence = prompt; Tips: / Tools: / Requires: / Limitations: (a → b) / Day: +N
 *   ## Dead… / ## Sources — appendix sections, never steps
 *   <!-- kickoff:start --> … <!-- kickoff:end --> stripped
 */
const PB = (() => {
  const KINDS = ["playbook", "methodology", "setup", "reference"];
  const H2 = /^##\s+(.+?)\s*$/, APPENDIX = /^(dead\b|sources?\b|appendix\b|annexes?\b)/i;
  const TIPS = /^\s*(tips?|astuces?)\s*:\s*(.*)$/i, TOOLS_ = /^\s*(tools?|outils?)\s*:\s*(.*)$/i;
  const REQUIRES = /^\s*(requires?|pr[eé]requis|pre-?requis)\s*:\s*(.*)$/i, LIMITS = /^\s*(limitations?|limites?)\s*:\s*(.*)$/i;
  const LI = /^\s*[-*+]\s+(.+)$/, BQ = /^\s*>\s?(.*)$/, ROUTER = /^###\s+(router|routeur)\b/i, DAY = /^\s*(day|jour)\s*:\s*\+?\s*(\d+)\s*$/i;
  const stripQ = (v) => { const t = v.trim(); if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\])/g, "$1"); if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1); return t; };
  const inlineList = (v) => {
    const inner = v.trim().replace(/^\[/, "").replace(/\]$/, ""); if (!inner.trim()) return [];
    const out = []; let cur = "", q = null;
    for (const ch of inner) { if (q) { cur += ch; if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; } if (ch === ",") { out.push(cur); cur = ""; continue; } cur += ch; }
    out.push(cur); return out.map((s) => stripQ(s.trim())).filter(Boolean);
  };
  const fmBlock = (block) => {
    const out = {}; const lines = block.split("\n"); let i = 0;
    while (i < lines.length) {
      const line = lines[i]; if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/); if (!m) { i++; continue; }
      const key = m[1].toLowerCase(); const rest = /^\s*["']/.test(m[2]) ? m[2] : m[2].replace(/\s+#.*$/, "");
      if (rest.trim() === "|" || rest.trim() === "|-") {
        i++; const buf = []; let indent = -1;
        while (i < lines.length) { const l = lines[i]; if (l.trim() === "") { buf.push(""); i++; continue; } const lead = (l.match(/^(\s*)/) || ["", ""])[1].length; if (indent === -1) { if (lead === 0) break; indent = lead; } if (lead < indent) break; buf.push(l.slice(indent)); i++; }
        while (buf.length && buf[buf.length - 1] === "") buf.pop(); out[key] = buf.join("\n"); continue;
      }
      if (rest.trim() === "") { const items = []; i++; while (i < lines.length && /^\s*-\s+/.test(lines[i])) { items.push(stripQ(lines[i].replace(/^\s*-\s+/, ""))); i++; } out[key] = items; continue; }
      out[key] = rest.trim().startsWith("[") ? inlineList(rest) : stripQ(rest); i++;
    }
    return out;
  };
  const frontmatter = (md) => {
    const lines = md.split("\n"); if (lines.length < 2 || !/^---\s*$/.test(lines[0])) return { fm: {}, body: md };
    let end = -1; for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) { end = i; break; }
    if (end === -1) return { fm: {}, body: md };
    return { fm: fmBlock(lines.slice(1, end).join("\n")), body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
  };
  const str = (v) => v == null ? null : Array.isArray(v) ? (v.length ? v.join(", ") : null) : (v.trim() ? v.trim() : null);
  const list = (v) => v == null ? [] : Array.isArray(v) ? v.filter(Boolean) : v.split(",").map((s) => s.trim()).filter(Boolean);
  const guessType = (label) => { const l = label.toLowerCase(); if (/\b(api|token|clé api|key|endpoint|oauth|vault|secret)\b/.test(l)) return "api"; if (/\b(webhook|callback)\b/.test(l)) return "webhook"; if (/\b(donnée|dataset|csv|export|data|base|table)\b/.test(l)) return "data"; return "tool"; };
  const req = (item) => { const m = item.match(/^(api|webhook|tool|data)\s*:\s*(.+)$/i); return m ? { type: m[1].toLowerCase(), label: m[2].trim() } : { type: guessType(item), label: item.trim() }; };
  const lim = (item) => { const m = item.match(/^(.*?)\s+(?:→|->|=>)\s+(.*)$/); return m ? { limitation: m[1].trim(), workaround: m[2].trim() } : { limitation: item.trim(), workaround: "" }; };
  const stepBody = (B) => {
    const desc = [], tips = [], toolNames = [], requirements = [], limitations = []; let prompt = null, mode = null, i = 0, daysOffset = 0;
    while (i < B.length) {
      const line = B[i]; const fo = line.match(/^\s*(`{3,})/);
      if (fo) { const close = new RegExp("^\\s*`{" + fo[1].length + ",}\\s*$"); const code = []; const start = i; i++; while (i < B.length && !close.test(B[i])) { code.push(B[i]); i++; } const end = Math.min(i, B.length - 1); i++; if (prompt === null) prompt = code.join("\n").trim(); else desc.push(...B.slice(start, end + 1)); mode = null; continue; }
      let m;
      if ((m = line.match(BQ))) { tips.push(m[1]); i++; mode = null; continue; }
      if ((m = line.match(TIPS))) { if (m[2].trim()) tips.push(m[2].trim()); mode = "tips"; i++; continue; }
      if ((m = line.match(TOOLS_))) { m[2].split(",").map((s) => s.trim()).filter(Boolean).forEach((n) => toolNames.push(n)); mode = "tools"; i++; continue; }
      if ((m = line.match(REQUIRES))) { if (m[2].trim()) requirements.push(req(m[2].trim())); mode = "requires"; i++; continue; }
      if ((m = line.match(DAY))) { daysOffset = Number(m[2]); mode = null; i++; continue; }
      if ((m = line.match(LIMITS))) { if (m[2].trim()) limitations.push(lim(m[2].trim())); mode = "limitations"; i++; continue; }
      if ((m = line.match(LI)) && mode) { const it = m[1].trim(); if (mode === "requires") requirements.push(req(it)); else if (mode === "tools") toolNames.push(it); else if (mode === "tips") tips.push(it); else limitations.push(lim(it)); i++; continue; }
      if (line.trim() === "") { mode = null; desc.push(line); i++; continue; }
      mode = null; desc.push(line); i++;
    }
    return { description: desc.join("\n").trim(), prompt: prompt && prompt.length ? prompt : null, tips: tips.length ? tips.join("\n").trim() : null, toolNames, requirements, limitations, daysOffset };
  };
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  const isSep = (row) => /^\s*\|?\s*:?-{2,}/.test(row) && /^[\s|:-]+$/.test(row);
  const router = (intro) => {
    const lines = intro.split("\n"); let i = lines.findIndex((l) => ROUTER.test(l)); if (i === -1) return [];
    while (i < lines.length && !lines[i].trim().startsWith("|")) i++;
    if (i >= lines.length || !isSep(lines[i + 1] || "")) return [];
    const head = cells(lines[i]).map((h) => h.toLowerCase());
    const col = (re, d) => { const k = head.findIndex((h) => re.test(h)); return k === -1 ? d : k; };
    const cH = col(/have|input|j'ai/, 0), cW = col(/want|goal|je veux/, 1), cS = col(/step|go to|étape|etape/, 2), cT = col(/trap|piège|piege|note/, 3);
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) { const c = cells(lines[j]); rows.push({ have: c[cH] || "", want: c[cW] || "", step: (c[cS] || "").replace(/^[`*_]+|[`*_]+$/g, ""), trap: c[cT] || "" }); }
    return rows;
  };
  const doc = (body) => {
    const lines = body.replace(/<!--\s*kickoff:start\s*-->[\s\S]*?<!--\s*kickoff:end\s*-->\s*$/i, "").replace(/\s+$/, "").split("\n");
    const intro = [], steps = [], appendix = []; let i = 0, fence = null;
    const track = (l) => { const o = l.match(/^\s*(`{3,})/); if (fence) { if (fence.test(l)) fence = null; } else if (o) fence = new RegExp("^\\s*`{" + o[1].length + ",}\\s*$"); };
    const isH2 = (l) => !fence && H2.test(l);
    while (i < lines.length && !isH2(lines[i])) { track(lines[i]); intro.push(lines[i]); i++; }
    while (i < lines.length) {
      const m = lines[i].match(H2); if (!m) { i++; continue; } const title = m[1].trim(); i++; const B = [];
      while (i < lines.length && !isH2(lines[i])) { track(lines[i]); B.push(lines[i]); i++; }
      if (APPENDIX.test(title)) appendix.push({ title, body: B.join("\n").trim() }); else steps.push({ title, ...stepBody(B) });
    }
    const introText = intro.join("\n").trim();
    return { intro: introText, router: router(introText), steps, appendix };
  };
  const parse = (md) => {
    const raw = md.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const { fm, body } = frontmatter(raw); const d = doc(body);
    const kindRaw = str(fm.kind); const kind = kindRaw && KINDS.includes(kindRaw.toLowerCase()) ? kindRaw.toLowerCase() : null;
    const mo = str(fm.measured_on);
    return { raw, body, doc: d, frontmatter: { title: str(fm.title), description: str(fm.description) || str(fm.summary), kind, kindRaw, tools: list(fm.tools), keys: list(fm.keys), repo: str(fm.repo) || str(fm.repository) || str(fm.template_repo) || str(fm.template_repo_url), measured_on: mo && /^\d{4}-\d{2}-\d{2}$/.test(mo) ? mo : null, kickoff_prompt: str(fm.kickoff_prompt) || str(fm.kickoff) } };
  };
  const payload = (f, fallbackName) => ({
    name: f.frontmatter.title || fallbackName, kind: f.frontmatter.kind || "playbook", description: f.frontmatter.description, content: f.raw,
    kickoff_prompt: f.frontmatter.kickoff_prompt, template_repo_url: f.frontmatter.repo, measured_on: f.frontmatter.measured_on, keys: f.frontmatter.keys, tools: f.frontmatter.tools,
    steps: f.doc.steps.map((s) => ({ title: s.title, description: s.description || null, prompt: s.prompt, tips: s.tips, limitations: s.limitations,
      requirements: [...s.toolNames.filter((n) => !s.requirements.some((r) => r.label.toLowerCase() === n.toLowerCase())).map((n) => ({ type: "tool", label: n })), ...s.requirements], days_offset: s.daysOffset || 0 })),
  });
  return { KINDS, parse, payload, router };
})();

/** One playbook by name — exact first, then a unique contains-match. */
async function playbookByName(name) {
  const exact = await run(db.from("playbooks").select("id,name,kind,description,content,measured_on,keys,tools,kickoff_prompt,template_repo_url,created_at,updated_at").eq("name", name).limit(1));
  if (exact.length) return exact[0];
  const rows = await run(db.from("playbooks").select("id,name,kind,description,content,measured_on,keys,tools,kickoff_prompt,template_repo_url,created_at,updated_at").ilike("name", `%${name}%`).limit(5));
  if (rows.length === 0) throw new Error(`No playbook matching "${name}". Call playbooks to see the Kitchen.`);
  if (rows.length > 1) throw new Error(`"${name}" matches ${rows.map((r) => r.name).join(", ")} — say which.`);
  return rows[0];
}
const staleWord = (d) => { if (!d) return "never measured"; const n = Math.floor((Date.now() - new Date(d).getTime()) / 86400000); return n > 90 ? `measured ${d} — STALE (${n} days), re-measure before trusting a number` : `measured ${d}`; };

// Age in the words a person uses. A playbook's worth is mostly a function of how
// long ago someone last checked it was true, so every playbook answer carries
// when it was written and when it was last touched, not just a timestamp to
// subtract in your head. Gab, 12/09/2026: "put created X months or years ago and
// modified the same X months or years ago."
// ids to names, for anything that shows who said something
const namesFor = async (ids) => {
  if (!ids.length) return {};
  const rows = await run(db.from("profiles").select("id,name").in("id", ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
};

const ago = (t) => {
  if (!t) return null;
  const ms = Date.now() - new Date(t).getTime();
  if (ms < 0) return "just now";
  const min = Math.floor(ms / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  if (d < 31) { const w = Math.floor(d / 7); return `${w} week${w === 1 ? "" : "s"} ago`; }
  if (d < 365) { const mo = Math.round(d / 30.44); return `${mo} month${mo === 1 ? "" : "s"} ago`; }
  const y = Math.floor(d / 365.25), rem = Math.round((d - y * 365.25) / 30.44);
  return rem >= 1 && y < 3 ? `${y} year${y === 1 ? "" : "s"} ${rem} month${rem === 1 ? "" : "s"} ago` : `${y} year${y === 1 ? "" : "s"} ago`;
};
// "written 3 months ago, untouched since" reads louder than two identical dates.
const ageWords = (created, updated) => {
  const c = ago(created), u = ago(updated);
  if (!c && !u) return null;
  if (!u || c === u) return `written ${c}, never revised`;
  return `written ${c}, last modified ${u}`;
};

const TOOLS = [
  { name: "whoami", description: "Who this connection is signed in as, and what it can reach.",
    schema: { type: "object", properties: {} },
    run: async () => {
      // Named columns, never a star: day_rate is revoked from authenticated at
      // the grant level, so select("*") on profiles is a 403 for everyone
      // including an admin. The whole query fails, not just that field.
      const flags = await run(db.from("profiles")
        .select("dispatch_access,warroom_access,studio_access,control_access,manifesto_access")
        .eq("id", me.id).single());
      return { ...me, dispatch: flags.dispatch_access, war_room: flags.warroom_access,
               studio: flags.studio_access, control: flags.control_access,
               manifesto: flags.manifesto_access };
    } },

  { name: "missions", description: "Every mission visible to this account, with status and group.",
    schema: { type: "object", properties: {} },
    run: async () => run(db.from("missions").select("id,name,grp,status,goal,ends_on").order("created_at")) },

  { name: "tasks", description: "Tasks on a mission. Defaults to what is still open.",
    schema: { type: "object", required: ["mission"], properties: {
      mission: { type: "string", description: "Mission name or id" },
      include_done: { type: "boolean", description: "Include finished tasks (default false)" } } },
    run: async ({ mission, include_done }) => {
      const m = await findMission(mission);
      let q = db.from("tasks").select("num,title,status,urgency,due_date,owner_party,parent_task_id")
        .eq("mission_id", m.id).order("num");
      if (!include_done) q = q.neq("status", "done");
      return run(q);
    } },

  { name: "add_task", description: "Add a task to a mission.",
    schema: { type: "object", required: ["mission", "title"], properties: {
      mission: { type: "string" }, title: { type: "string" },
      urgency: { type: "string", enum: ["normal", "high", "critical"] },
      due_date: { type: "string", description: "YYYY-MM-DD" },
      client_visible: { type: "boolean", description: "Whether the client sees it (default false)" } } },
    run: async ({ mission, title, urgency, due_date, client_visible }) => {
      const m = await findMission(mission);
      const [row] = await run(db.from("tasks").insert({
        mission_id: m.id, title, urgency: urgency ?? "normal",
        due_date: due_date ?? null, client_visible: client_visible ?? false,
        created_by: me.id, owner_party: "bltz",
      }).select("num,title,status"));
      return row;
    } },

  { name: "complete_task", description: "Mark a task done, by mission and number.",
    schema: { type: "object", required: ["mission", "num"], properties: {
      mission: { type: "string" }, num: { type: "number" } } },
    run: async ({ mission, num }) => {
      const m = await findMission(mission);
      const [row] = await run(db.from("tasks").update({ status: "done" })
        .eq("mission_id", m.id).eq("num", num).select("num,title,status"));
      if (!row) throw new Error(`no task ${num} on ${m.name}`);
      return row;
    } },

  { name: "accounts", description: "The Hunt pipeline: accounts with stage, score and how cold they are.",
    schema: { type: "object", properties: {
      stage: { type: "string", description: "Filter by stage" } } },
    run: async ({ stage }) => {
      let q = db.from("account_overview")
        .select("company,domain,stage,score,contacts,days_cold,next_step,next_step_at,committed")
        .order("score", { ascending: false });
      if (stage) q = q.eq("stage", stage);
      return run(q);
    } },

  { name: "account", description: "One account in full, with its contacts.",
    schema: { type: "object", required: ["company"], properties: { company: { type: "string" } } },
    run: async ({ company }) => {
      const [a] = await run(db.from("account_overview").select("*").ilike("company", `%${company}%`).limit(1));
      if (!a) throw new Error(`no account matching "${company}"`);
      const contacts = await run(db.from("contact_profile")
        .select("name,role_title,seat,seniority,warmth,email,phone,days_cold,known").eq("account_id", a.id));
      return { ...a, contacts };
    } },

  { name: "log_touch", description: "Record contact with an account. Moves it out of cold.",
    schema: { type: "object", required: ["company", "body"], properties: {
      company: { type: "string" }, body: { type: "string" },
      kind: { type: "string", enum: ["call", "email", "linkedin", "meeting", "event", "intro", "note"] } } },
    run: async ({ company, body, kind }) => {
      const [a] = await run(db.from("accounts").select("id,company").ilike("company", `%${company}%`).limit(1));
      if (!a) throw new Error(`no account matching "${company}"`);
      await run(db.from("account_touches").insert({
        account_id: a.id, kind: kind ?? "note", body, actor_id: me.id }));
      // last_touch_at drives days_cold and the engagement score; without this
      // the account reads as cold immediately after being worked.
      const now = new Date().toISOString();
      await run(db.from("accounts").update({ last_touch_at: now }).eq("id", a.id));
      return { logged: a.company, kind: kind ?? "note" };
    } },

  { name: "pending_invites", description: "Who was invited and has still not set a password.",
    schema: { type: "object", properties: {} },
    run: async () => run(db.from("pending_activations")
      .select("name,email,hours_since_contact,nudge_count,nudges_stopped")) },

  { name: "money", description: "Control overview: owed, overdue, collected, burn and runway. Admin only.",
    schema: { type: "object", properties: {} },
    run: async () => {
      const overview = await run(db.from("control_overview").select("*").single());
      const runway = await run(db.from("runway").select("*").single());
      const people = await run(db.from("person_money").select("person,percent,collected,awaiting_payment"));
      return { overview, runway, people };
    } },

  { name: "paperwork", description:
      "Contracts, proposals and the documents shared with a client, for one mission or all of them. " +
      "Shows signature state and what is still waiting on somebody.",
    schema: { type: "object", properties: { mission: { type: "string", description: "Mission name, optional" } } },
    run: async ({ mission }) => {
      const m = mission ? await missionByName(mission) : null;
      let q = db.from("contracts").select(
        "id,title,kind,status,value,currency,starts_on,term_months,signed_by_name,signed_at,provider_signed_name,mission_id");
      if (m) q = q.eq("mission_id", m.id);
      const contracts = await run(q.order("created_at", { ascending: false }));

      let f = db.from("files").select("name,kind,audience,created_at,mission_id").eq("audience", "client");
      if (m) f = f.eq("mission_id", m.id);
      const documents = await run(f.order("created_at"));

      // Prose, not JSON. The agent re-reads every result it gets, so an object
      // tree is paid for twice and reads worse in a reply than the line it
      // would have been turned into anyway.
      const lines = contracts.map((c) => {
        const money = c.value ? ` ${c.value} ${c.currency}` : "";
        const term = c.term_months ? `, ${c.term_months} months from ${c.starts_on}` : "";
        const state = c.status === "signed"
          ? `signed by ${c.signed_by_name} on ${String(c.signed_at).slice(0, 10)}`
          : c.status === "sent" ? "WAITING on the client to sign" : c.status;
        return `${c.title} [${c.kind}]${money}${term} — ${state}`;
      });
      const docs = documents.map((d) => `${d.name} (${d.kind}, shared ${d.created_at.slice(0, 10)})`);
      return [
        lines.length ? lines.join("\n") : "No contracts.",
        "",
        docs.length ? `Documents the client can see:\n${docs.join("\n")}` : "No documents shared.",
      ].join("\n");
    } },

  { name: "billing", description:
      "Invoices, what has been paid, and what the automation will issue next. Admin only.",
    schema: { type: "object", properties: {} },
    run: async () => {
      const invoices = await run(db.from("invoices")
        .select("number,status,currency,issued_on,due_on,storage_path,stripe_invoice_id,hosted_invoice_url,mission_id")
        .order("number"));
      const payments = await run(db.from("payments").select("amount,paid_on,method,reference").order("paid_on"));
      const due = await run(db.from("billing_due").select("title,period_index,period_start,amount,currency,already_invoiced"));
      const inv = invoices.map((i) =>
        `${i.number} ${i.status}${i.due_on ? `, due ${i.due_on}` : ""}` +
        `${i.hosted_invoice_url ? ", payable online" : ""}`);
      const paid = payments.map((p) => `${p.amount} on ${p.paid_on} via ${p.method}`);
      const next = due.filter((d) => !d.already_invoiced)
        .map((d) => `${d.period_start}: ${d.amount} ${d.currency} — ${d.title} (period ${d.period_index})`);
      return [
        inv.length ? `Invoices:\n${inv.join("\n")}` : "No invoices yet.",
        paid.length ? `\nPaid:\n${paid.join("\n")}` : "\nNothing paid yet.",
        next.length ? `\nStill to issue:\n${next.join("\n")}` : "\nNothing scheduled.",
      ].join("\n");
    } },

  { name: "notifications", description:
      "What the app has told this user, newest first, and whether it has been read.",
    schema: { type: "object", properties: { unread_only: { type: "boolean" } } },
    run: async ({ unread_only }) => {
      let q = db.from("notifications")
        .select("subject,body,kind,link_tab,created_at,read_at,sent_at,pushed_at")
        .order("created_at", { ascending: false }).limit(30);
      if (unread_only) q = q.is("read_at", null);
      const rows = await run(q);
      if (rows.length === 0) return "Nothing visible to you.";
      return rows.map((n) =>
        `${n.read_at ? "  " : "• "}${n.created_at.slice(5, 16).replace("T", " ")}  ${n.subject}` +
        `${n.body ? ` — ${n.body}` : ""}`).join("\n");
    } },

  { name: "credentials", description:
      "Which credentials are on file, which mission each belongs to, and the last characters of " +
      "each so two keys for the same tool are told apart. Never returns a value — reveal_credential does that.",
    schema: { type: "object", properties: {
      mission: { type: "string", description: "Only this mission's keys." } } },
    run: async (a) => {
      let q = db.from("credentials")
        .select("label,kind,hint,created_at,mission_id,account_id").order("created_at");
      if (a.mission) q = q.eq("mission_id", (await missionByName(a.mission)).id);
      const rows = await run(q);
      if (rows.length === 0) return a.mission ? `No credentials on ${a.mission}.` : "No credentials on file.";
      const ms = await run(db.from("missions").select("id,name"));
      const where = (id) => ms.find((m) => m.id === id)?.name ?? "ours";
      return rows.map((c) =>
        `${c.label} [${c.kind}] ${c.hint ?? ""} — ${where(c.mission_id)} — added ${c.created_at.slice(0, 10)}`)
        .join("\n") + "\n\n(Values are not listed. reveal_credential returns one, and that read is logged.)";
    } },

  { name: "reveal_credential", description:
      "Return the value of one credential, for pasting into a tool or a config. The read is written to " +
      "the audit log with the caller's name on it before the value comes back. The value enters this " +
      "conversation: use it and do not repeat it. An ambiguous name is refused rather than guessed, " +
      "because handing back the wrong key is worse than handing back none.",
    schema: { type: "object", required: ["label"], properties: {
      label: { type: "string", description: "Part of the label — \"Lemlist\" matches \"Lemlist — API key\"." },
      mission: { type: "string", description: "Narrows it when two missions hold a key of the same name." } } },
    run: async (a) => {
      let q = db.from("credentials").select("id,label,mission_id").ilike("label", `%${a.label}%`);
      if (a.mission) q = q.eq("mission_id", (await missionByName(a.mission)).id);
      const rows = await run(q);
      if (rows.length === 0) throw new Error(`No credential matching "${a.label}".`);
      if (rows.length > 1) {
        throw new Error(`"${a.label}" matches ${rows.map((r) => r.label).join(", ")} — say which.`);
      }
      const { data, error } = await db.rpc("reveal_credential", { p_id: rows[0].id });
      if (error) throw new Error(error.message);
      return `${rows[0].label}\n${data}`;
    } },

  { name: "store_credential", description:
      "Put a key into a mission's Stack vault, encrypted at rest, so Zeus and the team can use it without " +
      "ever pasting it again. The value enters this conversation once; it is stored and not repeated back. " +
      "Say which mission holds it: a client's own subscription goes on the client's mission, a Bltz " +
      "subscription billed through goes on the Dispatch mission (where the Stack lives). Use the label " +
      "Zeus looks for — e.g. \"Exa — API key\", \"RapidAPI — LinkedIn bulk key\", \"FullEnrich — API key\".",
    schema: { type: "object", required: ["label", "secret", "mission"], properties: {
      label: { type: "string", description: "The label, as Zeus's stack names it: \"Exa — API key\"." },
      secret: { type: "string", description: "The key itself." },
      mission: { type: "string", description: "Mission name or key that holds it, e.g. Dispatch or Trellis." },
      kind: { type: "string", enum: ["api_key", "portal_login", "bank", "tax_id", "card_last4", "other"], description: "Default api_key. These are Dispatch's own kinds." },
      hint: { type: "string", description: "Optional. Defaults to the last 5 characters, so two keys can be told apart." } } },
    run: async (a) => {
      const m = await missionByName(a.mission);
      const secret = String(a.secret).trim();
      if (secret.length < 8) throw new Error("That does not look like a key (too short).");
      const existing = await run(db.from("credentials").select("id,label").eq("mission_id", m.id).ilike("label", a.label));
      if (existing.length) throw new Error(`"${existing[0].label}" already exists on ${m.name} — delete it in Dispatch first, or use a different label.`);
      const { data, error } = await db.rpc("store_credential", {
        p_label: a.label, p_kind: a.kind ?? "api_key", p_secret: secret,
        p_hint: a.hint ?? `ends ${secret.slice(-5)}`, p_account: null, p_profile: null, p_mission: m.id,
      });
      if (error) throw new Error(error.message);
      return `Stored "${a.label}" on ${m.name} (ends ${secret.slice(-5)}). Zeus resolves it by that label; nothing else needs the value.`;
    } },

  // ── The work ──────────────────────────────────────────────────────────────

  { name: "update_task", description:
      "Change a task: status, urgency, due date, assignee, or title. Only the fields you pass move. " +
      "Reference it as MISSION-number, e.g. TRL-12.",
    schema: { type: "object", required: ["ref"], properties: {
      ref: { type: "string", description: "MISSION-number, e.g. TRL-12" },
      status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
      urgency: { type: "string" }, due: { type: "string", description: "YYYY-MM-DD, or 'none' to clear" },
      assignee: { type: "string", description: "Teammate name, fuzzy" },
      title: { type: "string" }, client_visible: { type: "boolean" } } },
    run: async (a) => {
      const t = await taskByRef(a.ref);
      const patch = {};
      if (a.status) patch.status = a.status;
      if (a.urgency) patch.urgency = a.urgency;
      if (a.title) patch.title = a.title;
      if (a.client_visible !== undefined) patch.client_visible = a.client_visible;
      if (a.due) patch.due_date = a.due === "none" ? null : a.due;
      if (a.assignee) patch.assignee_id = (await personByName(a.assignee)).id;
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change — pass a field.");
      await run(db.from("tasks").update(patch).eq("id", t.id));
      return `${a.ref} updated: ${Object.keys(patch).join(", ")}.`;
    } },

  // ── Notes ─────────────────────────────────────────────────────────────────

  { name: "notes", description: "Notes on a mission, newest first.",
    schema: { type: "object", required: ["mission"], properties: {
      mission: { type: "string" } } },
    run: async (a) => {
      const m = await missionByName(a.mission);
      const rows = await run(db.from("notes").select("title,body,pinned,client_visible,updated_at")
        .eq("mission_id", m.id).order("updated_at", { ascending: false }).limit(20));
      if (!rows.length) return `No notes on ${m.name}.`;
      return rows.map((n) =>
        `${n.pinned ? "📌 " : ""}${n.title}${n.client_visible ? " (client can see)" : ""}\n` +
        `${(n.body ?? "").slice(0, 400)}`).join("\n\n");
    } },

  { name: "add_note", description: "Write a note on a mission. Client-visible only if you say so.",
    schema: { type: "object", required: ["mission", "title"], properties: {
      mission: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      client_visible: { type: "boolean" } } },
    run: async (a) => {
      const m = await missionByName(a.mission);
      await run(db.from("notes").insert({ mission_id: m.id, title: a.title, body: a.body ?? null,
        client_visible: !!a.client_visible, created_by: me.id }));
      return `Noted on ${m.name}: ${a.title}${a.client_visible ? " (visible to the client)" : ""}.`;
    } },

  // ── Hunt ──────────────────────────────────────────────────────────────────

  { name: "add_account", description: "Add a company to the pipeline.",
    schema: { type: "object", required: ["company"], properties: {
      company: { type: "string" }, domain: { type: "string" }, mission: { type: "string" },
      stage: { type: "string", enum: ["research","approach","contacted","call booked","proposal","client","dead"] },
      why_now: { type: "string" }, segment: { type: "string" }, industry: { type: "string" },
      hq_country: { type: "string" }, employees: { type: "number" } } },
    run: async (a) => {
      const m = a.mission ? await missionByName(a.mission) : null;
      const [row] = await run(db.from("accounts").insert({
        company: a.company, domain: a.domain ?? null, mission_id: m?.id ?? null,
        stage: a.stage ?? "research", why_now: a.why_now ?? null, segment: a.segment ?? null,
        industry: a.industry ?? null, hq_country: a.hq_country ?? null,
        employees: a.employees ?? null, owner_id: me.id,
      }).select("id,company,stage"));
      return `Added ${row.company} at ${row.stage}.`;
    } },

  { name: "update_account", description:
      "Move an account: stage, owner, next step, or any of the firmographics. Only what you pass changes.",
    schema: { type: "object", required: ["company"], properties: {
      company: { type: "string" },
      stage: { type: "string", enum: ["research","approach","contacted","call booked","proposal","client","dead"] },
      next_step: { type: "string" }, next_step_at: { type: "string", description: "YYYY-MM-DD" },
      why_now: { type: "string" }, icp_fit: { type: "number" }, owner: { type: "string" },
      segment: { type: "string" }, employees: { type: "number" }, notes: { type: "string" } } },
    run: async (a) => {
      const acc = await accountByName(a.company);
      const patch = {};
      for (const k of ["stage", "next_step", "why_now", "segment", "notes"]) if (a[k] !== undefined) patch[k] = a[k];
      if (a.next_step_at) patch.next_step_at = a.next_step_at;
      if (a.icp_fit !== undefined) patch.icp_fit = a.icp_fit;
      if (a.employees !== undefined) patch.employees = a.employees;
      if (a.owner) patch.owner_id = (await personByName(a.owner)).id;
      if (!Object.keys(patch).length) throw new Error("Nothing to change — pass a field.");
      await run(db.from("accounts").update(patch).eq("id", acc.id));
      return `${acc.company}: ${Object.entries(patch).map(([k, v]) => `${k} → ${v}`).join(", ")}.`;
    } },

  { name: "contacts", description: "People at an account, or across a mission.",
    schema: { type: "object", properties: { company: { type: "string" }, mission: { type: "string" } } },
    run: async (a) => {
      let q = db.from("account_contacts").select("name,role_title,email,seniority,warmth,last_touch_at,account_id");
      if (a.company) q = q.eq("account_id", (await accountByName(a.company)).id);
      const rows = await run(q.limit(60));
      if (!rows.length) return "Nobody on file.";
      return rows.map((c) => `${c.name}${c.role_title ? `, ${c.role_title}` : ""}` +
        `${c.email ? ` <${c.email}>` : ""}${c.warmth ? ` [${c.warmth}]` : ""}`).join("\n");
    } },

  { name: "add_contact", description: "Add a person at an account.",
    schema: { type: "object", required: ["company", "name"], properties: {
      company: { type: "string" }, name: { type: "string" }, role_title: { type: "string" },
      email: { type: "string" }, linkedin_url: { type: "string" }, seniority: { type: "string" },
      how_we_know: { type: "string" }, is_primary: { type: "boolean" } } },
    run: async (a) => {
      const acc = await accountByName(a.company);
      await run(db.from("account_contacts").insert({
        account_id: acc.id, name: a.name, role_title: a.role_title ?? null, email: a.email ?? null,
        linkedin_url: a.linkedin_url ?? null, seniority: a.seniority ?? null,
        how_we_know: a.how_we_know ?? null, is_primary: !!a.is_primary }));
      return `${a.name} added at ${acc.company}.`;
    } },

  // ── Commercial ────────────────────────────────────────────────────────────

  { name: "proposals", description: "Proposals on a mission, with their lines and totals.",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" } } },
    run: async (a) => {
      const m = await missionByName(a.mission);
      const props = await run(db.from("proposals")
        .select("id,number,title,status,currency,term_months,valid_until")
        .eq("mission_id", m.id).order("created_at", { ascending: false }));
      if (!props.length) return `No proposals on ${m.name}.`;
      const out = [];
      for (const p of props) {
        const lines = await run(db.from("proposal_lines")
          .select("name,quantity,unit,unit_price,amount,recurrence").eq("proposal_id", p.id).order("position"));
        out.push(`${p.number ?? "draft"} — ${p.title} [${p.status}]` +
          (p.valid_until ? `, valid to ${p.valid_until}` : "") + "\n" +
          lines.map((l) => `   ${l.name}: ${l.quantity ?? 1} ${l.unit ?? ""} × ${l.unit_price ?? l.amount} ${p.currency} (${l.recurrence})`).join("\n"));
      }
      return out.join("\n\n");
    } },

  { name: "add_proposal_line", description: "Add a line to a draft proposal.",
    schema: { type: "object", required: ["mission", "name", "unit_price"], properties: {
      mission: { type: "string" }, name: { type: "string" }, detail: { type: "string" },
      unit_price: { type: "number" }, quantity: { type: "number" }, unit: { type: "string" },
      recurrence: { type: "string", enum: ["monthly", "one_off"] } } },
    run: async (a) => {
      const m = await missionByName(a.mission);
      const [p] = await run(db.from("proposals").select("id,status,currency")
        .eq("mission_id", m.id).eq("status", "draft").limit(1));
      if (!p) throw new Error(`No draft proposal on ${m.name} — create one in the app first.`);
      const qty = a.quantity ?? 1;
      const prev = await run(db.from("proposal_lines").select("position").eq("proposal_id", p.id).order("position", { ascending: false }).limit(1));
      await run(db.from("proposal_lines").insert({
        proposal_id: p.id, name: a.name, detail: a.detail ?? null,
        quantity: qty, unit: a.unit ?? "unit", unit_price: a.unit_price,
        // A monthly line's amount is what recurs each month, not the total over
        // the term: the app reads it straight as the mission's monthly figure.
        amount: (a.recurrence ?? "monthly") === "monthly" ? a.unit_price : qty * a.unit_price,
        recurrence: a.recurrence ?? "monthly",
        position: (prev?.[0]?.position ?? 0) + 1 }).minimal());
      return `Added "${a.name}" — ${qty} × ${a.unit_price} ${p.currency}.`;
    } },

  { name: "record_payment", description:
      "Record money received against an invoice. Use the invoice number.",
    schema: { type: "object", required: ["invoice", "amount"], properties: {
      invoice: { type: "string" }, amount: { type: "number" },
      paid_on: { type: "string", description: "YYYY-MM-DD, defaults to today" },
      method: { type: "string" }, reference: { type: "string" } } },
    run: async (a) => {
      const [inv] = await run(db.from("invoices").select("id,number,currency").eq("number", a.invoice));
      if (!inv) throw new Error(`No invoice ${a.invoice}.`);
      await run(db.from("payments").insert({ invoice_id: inv.id, amount: a.amount,
        paid_on: a.paid_on ?? localDate(),
        method: a.method ?? "transfer", reference: a.reference ?? null, created_by: me.id }));
      return `Recorded ${a.amount} ${inv.currency} against ${inv.number}.`;
    } },

  // ── Mission plumbing ──────────────────────────────────────────────────────

  { name: "stack", description: "Tools on a mission, and what they cost.",
    schema: { type: "object", properties: { mission: { type: "string" } } },
    run: async (a) => {
      let q = db.from("stack_tools").select("name,category,url,monthly_price,currency,rebillable,mission_id");
      if (a.mission) q = q.eq("mission_id", (await missionByName(a.mission)).id);
      const rows = await run(q.order("name"));
      if (!rows.length) return "No tools listed.";
      return rows.map((t) => `${t.name} [${t.category ?? "—"}]` +
        `${t.monthly_price ? ` ${t.monthly_price} ${t.currency ?? ""}/mo${t.rebillable ? " (rebilled)" : " → burn"}` : ""}` +
        `${t.url ? ` ${t.url}` : ""}`).join("\n");
    } },

  { name: "add_stack_tool", description:
      "Add a tool to a mission's stack. A monthly_price here reaches Control burn on its own — there is no second expense to record.",
    schema: { type: "object", required: ["mission", "name"], properties: {
      mission: { type: "string" }, name: { type: "string" }, category: { type: "string" },
      url: { type: "string" }, monthly_price: { type: "number" },
      currency: { type: "string", description: "Three letters. Defaults to the base currency." },
      rebillable: { type: "boolean", description: "The client pays for it: kept out of our burn" },
      notes: { type: "string" } } },
    run: async (a) => {
      const m = await missionByName(a.mission);
      const row = { mission_id: m.id, name: a.name, category: a.category ?? null,
        url: a.url ?? null, monthly_price: a.monthly_price ?? null,
        rebillable: a.rebillable ?? false, notes: a.notes ?? null };
      if (a.currency) row.currency = a.currency.toUpperCase();
      await run(db.from("stack_tools").insert(row));
      if (!a.monthly_price) return `${a.name} added to ${m.name}'s stack.`;
      return `${a.name} added to ${m.name}'s stack at ${a.monthly_price} ${row.currency ?? "(base)"}/mo, ` +
        `${a.rebillable ? "rebilled to the client so it is not our burn." : "counted in Control burn."}`;
    } },

  { name: "send_email", description:
      "Send an email from Dispatch, as Bltz46, in the branded shell. Always copies Gab. " +
      "Show the recipient, subject and full body to the user and get an explicit go before calling this — " +
      "it leaves the building under the company's name and cannot be recalled. " +
      "Omit heading and cta for a plain-text message, which is what a personal reply to a client should be.",
    schema: { type: "object", required: ["to", "subject", "body"], properties: {
      to: { type: "string", description: "Recipient address, or several separated by commas." },
      subject: { type: "string" },
      body: { type: "string", description: "Paragraphs separated by a blank line." },
      name: { type: "string", description: "Recipient's name, for the greeting." },
      heading: { type: "string", description: "Bold line under the greeting. Its presence turns on the branded shell." },
      cta_label: { type: "string" },
      cta_link: { type: "string" },
      note: { type: "string", description: "Small print under the button." },
      lang: { type: "string", enum: ["en", "fr"] },
      reply_to: { type: "string" },
    } },
    run: async (a) => {
      const conf = loadConf();
      const payload = {
        to: String(a.to).split(",").map((s) => s.trim()).filter(Boolean),
        subject: a.subject,
        body: String(a.body).split(/\n{2,}/),
        name: a.name, heading: a.heading, note: a.note, lang: a.lang,
        reply_to: a.reply_to,
        ...(a.cta_label && a.cta_link ? { cta: { label: a.cta_label, link: a.cta_link } } : {}),
      };
      // Plain mode wants one string, the shell wants paragraphs.
      if (!a.heading && !a.cta_label) payload.body = String(a.body);
      const r = await fetch(`${URL_}/functions/v1/send-mail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${conf.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error ?? `send failed (${r.status})`);
      return `Sent to ${out.sent_to.join(", ")}${out.branded ? " (branded)" : " (plain)"}` +
             (out.audit_warning ? `\nAudit note: ${out.audit_warning}` : "");
    } },

  { name: "new_mission", description:
      "Start a mission. Group is 'client' for client work or 'internal' for our own.",
    schema: { type: "object", required: ["name"], properties: {
      name: { type: "string" },
      key: { type: "string", description: "Short reference like TRL. Task refs are built from it." },
      grp: { type: "string", enum: ["client", "internal"] },
      category: { type: "string" },
      visibility: { type: "string", enum: ["team", "private"] },
      sandbox: { type: "boolean", description: "Rehearsal mission: invoices use the TEST- series and never touch the client sequence." },
    } },
    run: async (a) => {
      const conf = loadConf();
      const [m] = await run(db.from("missions").insert({
        name: a.name, key: a.key ?? null, grp: a.grp ?? "client",
        category: a.category ?? "custom_build", visibility: a.visibility ?? "team",
        is_sandbox: a.sandbox === true,
        // NOT NULL: one person accountable for every mission, and by default
        // that is whoever started it.
        owner_id: conf.user_id,
      }));
      return `${m.name}${m.key ? ` (${m.key})` : ""} created — ${m.grp}, ${m.visibility}` +
             (a.sandbox ? ", sandbox" : "");
    } },

  { name: "invite", description:
      "Invite someone and email them an activation link. Read the name, email, role and mission " +
      "back to the user and get an explicit go first — this reaches a real person and cannot be recalled. " +
      "A client belongs to exactly one mission. Client level: 'exec' signs and sees paperwork, " +
      "'collaborator' does the work and never sees the contract, the proposal or the money. " +
      "Leave the level unset for a collaborator, which is the safer default.",
    schema: { type: "object", required: ["email", "name", "role"], properties: {
      email: { type: "string" },
      name: { type: "string", description: "Full name. It appears on their profile." },
      role: { type: "string", enum: ["admin", "head", "member", "freelance", "client", "counsel"] },
      mission: { type: "string", description: "Mission name or key. Required for a client." },
      client_level: { type: "string", enum: ["exec", "collaborator"] },
      specialty: { type: "array", items: { type: "string" } },
      day_rate: { type: "number" },
      locale: { type: "string", enum: ["en", "fr"] },
    } },
    run: async (a) => {
      const conf = loadConf();
      let mission_ids = [];
      if (a.mission) mission_ids = [(await missionByName(a.mission)).id];
      if (a.role === "client" && mission_ids.length !== 1) {
        throw new Error("A client must be given exactly one mission.");
      }
      const r = await fetch(`${URL_}/functions/v1/invite-user`, {
        method: "POST",
        headers: { Authorization: `Bearer ${conf.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: a.email, name: a.name, role: a.role, mission_ids,
          client_level: a.client_level ?? null,
          specialty: a.specialty ?? [], day_rate: a.day_rate ?? null,
          locale: a.locale ?? "en",
        }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error ?? `invite failed (${r.status})`);
      const lvl = a.role === "client" ? ` (${a.client_level ?? "collaborator"})` : "";
      return `Invited ${a.name} <${a.email}> as ${a.role}${lvl}. Activation link sent.`;
    } },

  { name: "resend_invite", description:
      "Send a fresh activation link to someone who has not signed in yet.",
    schema: { type: "object", required: ["email"], properties: { email: { type: "string" } } },
    run: async (a) => {
      const conf = loadConf();
      const r = await fetch(`${URL_}/functions/v1/invite-user`, {
        method: "POST",
        headers: { Authorization: `Bearer ${conf.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resend", email: a.email }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error ?? `resend failed (${r.status})`);
      return `Fresh activation link sent to ${a.email}.`;
    } },

  { name: "issue_invoice", description:
      "Issue the invoices whose billing period has opened, mirror them to Stripe and email the client " +
      "a payment link. Runs on its own every morning, so call this only to bill ahead of schedule or " +
      "after a failure. Always dry-run first and show the user exactly what would be billed, to whom, " +
      "and for how much — this emails a real client and takes a real invoice number. " +
      "'through' bills periods opening on or before that date; without it, today.",
    schema: { type: "object", properties: {
      through: { type: "string", description: "YYYY-MM-DD. Bill periods opening on or before this date." },
      dry: { type: "boolean", description: "List what would be issued and send nothing. Default true." },
    } },
    run: async (a) => {
      const conf = loadConf();
      // Defaults to a dry run on purpose: the caller has to say send.
      const dry = a.dry !== false;
      const qs = new URLSearchParams();
      if (dry) qs.set("dry", "1");
      if (a.through) qs.set("through", a.through);
      const r = await fetch(`${URL_}/functions/v1/issue-invoices?${qs}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${conf.access_token}`, "Content-Type": "application/json" },
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error ?? `failed (${r.status})`);
      if (out.dry_run) {
        const due = out.due ?? [];
        if (!due.length) return `Nothing to issue through ${out.through}.`;
        return `Would issue through ${out.through} (nothing sent):\n` +
          due.map((d) => `  ${d.title} — ${d.period_start} to ${d.period_end} — ${d.amount} ${d.currency}`)
             .join("\n") + "\n\nCall again with dry: false to send.";
      }
      const results = Object.entries(out.results ?? {})
        .map(([k, v]) => `  ${k}: ${v}`).join("\n");
      return `Issued ${out.issued}, sent ${out.sent}.` + (results ? `\n${results}` : "");
    } },

  { name: "team", description: "Who is on a mission, and everyone in the workspace.",
    schema: { type: "object", properties: { mission: { type: "string" } } },
    run: async (a) => {
      if (a.mission) {
        const m = await missionByName(a.mission);
        const rows = await run(db.from("mission_members").select("profile_id").eq("mission_id", m.id));
        const ids = rows.map((r) => r.profile_id);
        if (!ids.length) return `Nobody assigned to ${m.name}.`;
        const people = await run(db.from("profiles").select("name,role").in("id", ids));
        return people.map((p) => `${p.name} (${p.role})`).join("\n");
      }
      const people = await run(db.from("profiles").select("name,role").order("role"));
      return people.map((p) => `${p.name} (${p.role})`).join("\n");
    } },

  { name: "sql_readonly", description:
      "Read-only lookup against one view or table, for questions the other tools do not cover. " +
      "Row-level security still applies, so this can never return more than the signed-in user may see.",
    schema: { type: "object", required: ["from"], properties: {
      from: { type: "string", description: "Table or view name in the dispatch schema" },
      select: { type: "string", description: "Columns, comma separated (default *)" },
      limit: { type: "number", description: "Default 50, max 200" } } },
    run: async ({ from, select, limit }) =>
      run(db.from(from).select(select ?? "*").limit(Math.min(limit ?? 50, 200))) },
  /* ── Zeus ─────────────────────────────────────────────────────────────── */
  { name: "zeus_machines", description: "Every Zeus machine this account can see: ours and clients, with the legs lit and the last run.",
    schema: { type: "object", properties: {} },
    run: async () => (await zeus("/api/overview")).map((d) => ({ slug: d.slug, name: d.name, kind: d.kind, mission: d.mission_key, status: d.status, legs: d.legs, last_run: d.last_run })) },
  { name: "zeus_funnel", description: "Collected → accounts → qualified → in the room → promoted → sent, with heat and why rows are held.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string", description: "Machine slug, e.g. trellis or bltz" } } },
    run: async ({ machine }) => (await zeus(`/api/${machine}/funnel`)).funnel },
  { name: "zeus_antichambre", description: "The waiting room: people who earned a look and await a decision. Out-of-ICP hidden unless asked.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, include_out_of_icp: { type: "boolean" } } },
    run: async ({ machine, include_out_of_icp }) => (await zeus(`/api/${machine}/antichambre${include_out_of_icp ? "?all=1" : ""}`))
      .map((c) => ({ id: c.id, account: c.company_name, domain: c.domain, person: c.full_name, title: c.title, persona: c.persona, heat: c.heat, score: c.score, why: c.entered_reason, placement: c.placement, said: c.provenance?.items?.[0]?.said ?? null })) },
  { name: "zeus_refresh_room", description: "Seat everyone who has earned a look. Never re-opens a decision. Staff or the client's exec.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/antichambre/refresh`, { method: "POST" }) },
  { name: "zeus_promote", description: "Promote a candidate out of the antichambre. Promotion sends: the row goes to the outbox with the reason to write.",
    schema: { type: "object", required: ["machine", "candidate_id"], properties: { machine: { type: "string" }, candidate_id: { type: "string" } } },
    run: async ({ machine, candidate_id }) => zeus(`/api/${machine}/antichambre/${candidate_id}/promote`, { method: "POST" }) },
  { name: "zeus_dismiss", description: "Dismiss a candidate, with the reason kept on the record.",
    schema: { type: "object", required: ["machine", "candidate_id", "reason"], properties: { machine: { type: "string" }, candidate_id: { type: "string" }, reason: { type: "string" } } },
    run: async ({ machine, candidate_id, reason }) => zeus(`/api/${machine}/antichambre/${candidate_id}/dismiss`, { method: "POST", body: JSON.stringify({ reason }) }) },
  { name: "zeus_where_is", description: "Where a person is right now, in one sentence — any LinkedIn URL shape. Nobody vanishes.",
    schema: { type: "object", required: ["machine", "linkedin_url"], properties: { machine: { type: "string" }, linkedin_url: { type: "string" } } },
    run: async ({ machine, linkedin_url }) => zeus(`/api/${machine}/where-is?url=${encodeURIComponent(linkedin_url)}`) },
  { name: "zeus_accounts", description: "Every account a machine knows, with score, heat, verdict and why. Filter qualified/held, search by name or domain.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, filter: { type: "string", enum: ["all", "qualified", "held"] }, find: { type: "string" } } },
    run: async ({ machine, filter = "all", find }) => (await zeus(`/api/${machine}/accounts`))
      .filter((a) => filter === "all" || (filter === "qualified" ? a.qualified === true : a.qualified === false))
      .filter((a) => !find || `${a.company_name} ${a.domain ?? ""}`.toLowerCase().includes(find.toLowerCase()))
      .map((a) => ({ id: a.id, account: a.company_name, domain: a.domain, country: a.country, score: a.score, heat: a.heat, verdict: a.qualified === null ? "unscored" : a.qualified ? "qualified" : `held · ${a.reason}`, facts: a.facts, people: a.people, signals: a.signals, crm: a.crm_id ? a.crm_provider : null })) },
  { name: "zeus_account", description: "One account in full: why this score (each signal and its points), facts, people, signals, outbox, antichambre state.",
    schema: { type: "object", required: ["machine", "account_id"], properties: { machine: { type: "string" }, account_id: { type: "string" } } },
    run: async ({ machine, account_id }) => zeus(`/api/${machine}/accounts/${account_id}`) },
  { name: "zeus_scoring", description: "The ICP as config: the gate stack in order, bands, points, personas, routing. Read-only.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => { const c = await zeus(`/api/${machine}/config`); const d = c.doc || {}; return { version: c.version, mission: d.mission, filters: d.filters, scoring: d.scoring, personas: d.personas, routing: d.routing, antichambre: d.antichambre, outbound: { provider: d.outbound?.provider, limits: d.outbound?.limits } }; } },
  { name: "zeus_connections", description: "The plug board: which provider does each job and whose key it runs on. check=true resolves every key (staff only; reveals are audited).",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, check: { type: "boolean" } } },
    run: async ({ machine, check }) => zeus(`/api/${machine}/connections${check ? "?check=1" : ""}`) },
  { name: "zeus_decide", description: "The booth: a live decision for a visitor mid-conversation. Returns the sentence to say and who follows up. Needs ZEUS_BOOTH_SECRET.",
    schema: { type: "object", required: ["machine", "company", "role"], properties: { machine: { type: "string" }, name: { type: "string" }, company: { type: "string" }, role: { type: "string" }, use_case: { type: "string" }, geo: { type: "string", description: "ISO country, e.g. US" }, domain: { type: "string" }, email: { type: "string" }, linkedin_url: { type: "string" }, event: { type: "string" }, facts: { type: "object", description: "What the visitor said, e.g. {unit_count: 60}" } } },
    run: async ({ machine, ...lead }) => zeusSecret(`/decide/${machine}`, lead) },
  { name: "zeus_ingest_linkedin", description: "Feed a machine what a collector found: one post and the people who engaged with it. Normalises and stops; the nightly drain does the rest. Needs ZEUS_BOOTH_SECRET.",
    schema: { type: "object", required: ["machine", "post", "interactions"], properties: { machine: { type: "string" },
      post: { type: "object", required: ["post_urn"], properties: { post_urn: { type: "string" }, author_name: { type: "string" }, post_url: { type: "string" }, preview: { type: "string" }, topic: { type: "string" }, owner: { type: "string", enum: ["client", "competitor"] }, competitor: { type: "string" } } },
      interactions: { type: "array", items: { type: "object", required: ["person_linkedin_url", "interaction_type"], properties: { person_name: { type: "string" }, person_linkedin_url: { type: "string" }, person_headline: { type: "string" }, interaction_type: { type: "string", enum: ["like", "comment", "repost", "follow", "view"] }, comment_text: { type: "string" }, domain: { type: "string" }, country: { type: "string" } } } } } },
    run: async ({ machine, post, interactions }) => zeusSecret(`/ingest/${machine}/linkedin`, { post, interactions }) },

  /* ── Dispatch · missions, people, settings ─────────────────────────────────── */
  { name: "update_mission", description: "Change a mission's settings: name, client name, category, phase, language, goal, description, dates, status, visibility, colour, domains. Only the fields you pass change.",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" }, name: { type: "string" }, client_name: { type: "string" }, category: { type: "string", enum: ["custom_build", "abx", "abm", "gtm", "product", "other"] }, phase: { type: "string", enum: ["setup", "build", "run", "handover", "closed"] }, lang: { type: "string", enum: ["en", "fr"] }, goal: { type: "string" }, description: { type: "string" }, starts_on: { type: "string" }, ends_on: { type: "string" }, status: { type: "string", enum: ["active", "paused", "done"] }, visibility: { type: "string", enum: ["team", "private"] }, color: { type: "string" }, domains: { type: "array", items: { type: "string" } } } },
    run: async ({ mission, ...patch }) => {
      const m = await findMission(mission);
      const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (!Object.keys(fields).length) throw new Error("nothing to change");
      const [row] = await run(db.from("missions").update(fields).eq("id", m.id).select("name,key,status,phase,category,visibility"));
      return row;
    } },
  { name: "delete_mission", description: "Delete a mission and everything on it. Destructive and final: confirm the exact mission with the user first, then pass confirm=true.",
    schema: { type: "object", required: ["mission", "confirm"], properties: { mission: { type: "string" }, confirm: { type: "boolean" } } },
    run: async ({ mission, confirm }) => {
      if (confirm !== true) throw new Error("say confirm=true after the user confirmed the exact mission");
      const m = await findMission(mission);
      await run(db.from("missions").delete().eq("id", m.id));
      return `${m.name} deleted.`;
    } },
  { name: "members", description: "Who is on a mission: staff, freelance and client members, with the client level (exec signs and sees paperwork; collaborator does the work).",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" } } },
    run: async ({ mission }) => {
      const m = await findMission(mission);
      const rows = await run(db.from("mission_members").select("profile_id,client_level,profiles(name,role)").eq("mission_id", m.id));
      return rows.map((r) => ({ name: r.profiles?.name, role: r.profiles?.role, level: r.profiles?.role === "client" ? r.client_level : null, profile_id: r.profile_id }));
    } },
  { name: "add_member", description: "Put a teammate or freelance on a mission (they must already have an account — see invite). For a client, use invite.",
    schema: { type: "object", required: ["mission", "person"], properties: { mission: { type: "string" }, person: { type: "string", description: "name" } } },
    run: async ({ mission, person }) => {
      const m = await findMission(mission); const p = await personByName(person);
      await run(db.from("mission_members").insert({ mission_id: m.id, profile_id: p.id }));
      return `${p.name} is on ${m.name}.`;
    } },
  { name: "remove_member", description: "Take someone off a mission. Confirm the name with the user first.",
    schema: { type: "object", required: ["mission", "person"], properties: { mission: { type: "string" }, person: { type: "string" } } },
    run: async ({ mission, person }) => {
      const m = await findMission(mission); const p = await personByName(person);
      await run(db.from("mission_members").delete().eq("mission_id", m.id).eq("profile_id", p.id));
      return `${p.name} is off ${m.name}.`;
    } },
  { name: "set_client_level", description: "Make a client member an exec (signs, sees paperwork and invoices) or a collaborator (does the work, sees no money). Confirm first: it changes what a real person receives.",
    schema: { type: "object", required: ["mission", "person", "level"], properties: { mission: { type: "string" }, person: { type: "string" }, level: { type: "string", enum: ["exec", "collaborator"] } } },
    run: async ({ mission, person, level }) => {
      const m = await findMission(mission); const p = await personByName(person);
      const rows = await run(db.from("mission_members").update({ client_level: level }).eq("mission_id", m.id).eq("profile_id", p.id).select("client_level"));
      if (!rows.length) throw new Error(`${p.name} is not on ${m.name}`);
      return `${p.name} is now ${level} on ${m.name}.`;
    } },
  { name: "set_user_active", description: "Deactivate (or reactivate) someone's account. Admin only. Confirm the name first.",
    schema: { type: "object", required: ["email", "active"], properties: { email: { type: "string" }, active: { type: "boolean" } } },
    run: async ({ email, active }) => edgeFn("invite-user", { action: "set_active", email, active }) },
  { name: "delete_invitation", description: "Remove a pending invitation (the account, if any, stays).",
    schema: { type: "object", required: ["email"], properties: { email: { type: "string" } } },
    run: async ({ email }) => edgeFn("invite-user", { action: "delete_invitation", email }) },

  /* ── Dispatch · tasks, inbox, calendar ─────────────────────────────────────── */
  { name: "task_comments", description: "The comments on a task.",
    schema: { type: "object", required: ["task_ref"], properties: { task_ref: { type: "string", description: "TRL-12" } } },
    run: async ({ task_ref }) => { const t = await taskByRef(task_ref); return run(db.from("comments").select("body,created_at,profiles(name)").eq("task_id", t.id).order("created_at")); } },
  { name: "comment_task", description: "Write a comment on a task.",
    schema: { type: "object", required: ["task_ref", "text"], properties: { task_ref: { type: "string" }, text: { type: "string" } } },
    run: async ({ task_ref, text }) => { const t = await taskByRef(task_ref); await run(db.from("comments").insert({ task_id: t.id, author_id: me.id, body: text })); return `Commented on ${task_ref}.`; } },
  { name: "delete_task", description: "Delete a task. Confirm the exact reference with the user first.",
    schema: { type: "object", required: ["task_ref", "confirm"], properties: { task_ref: { type: "string" }, confirm: { type: "boolean" } } },
    run: async ({ task_ref, confirm }) => { if (confirm !== true) throw new Error("confirm the exact task first"); const t = await taskByRef(task_ref); await run(db.from("tasks").delete().eq("id", t.id)); return `${task_ref} deleted.`; } },
  { name: "my_today", description: "What is on my plate: my open tasks due today or overdue, across missions.",
    schema: { type: "object", properties: {} },
    run: async () => run(db.from("tasks").select("num,title,status,urgency,due_date,missions(key,name)").eq("assignee_id", me.id).in("status", ["todo", "doing", "blocked"]).lte("due_date", localDate()).order("due_date")) },
  { name: "inbox", description: "Client requests waiting for triage (the Inbox), newest first.",
    schema: { type: "object", properties: { mission: { type: "string" }, status: { type: "string", enum: ["pending", "accepted", "declined", "all"] } } },
    run: async ({ mission, status = "pending" }) => {
      let q = db.from("inbox_items").select("id,title,body,kind,urgency,status,created_at,missions(key,name)").order("created_at", { ascending: false }).limit(50);
      if (mission) q = q.eq("mission_id", (await findMission(mission)).id);
      if (status !== "all") q = q.eq("status", status);
      return run(q);
    } },
  { name: "triage_inbox", description: "Accept a client request (it becomes a task) or decline it with a reason.",
    schema: { type: "object", required: ["id", "decision"], properties: { id: { type: "string" }, decision: { type: "string", enum: ["accepted", "declined"] }, reason: { type: "string" } } },
    run: async ({ id, decision, reason }) => {
      const [it] = await run(db.from("inbox_items").select("id,mission_id,title,body").eq("id", id));
      if (!it) throw new Error("no such request");
      let task_id = null;
      if (decision === "accepted") { const [t] = await run(db.from("tasks").insert({ mission_id: it.mission_id, title: it.title, description: it.body, urgency: "normal", client_visible: true, created_by: me.id, owner_party: "bltz" }).select("id,num")); task_id = t.id; }
      await run(db.from("inbox_items").update({ status: decision, decline_reason: reason ?? null, triaged_at: new Date().toISOString(), triaged_by: me.id, task_id }).eq("id", id));
      return decision === "accepted" ? `Accepted — it is a task now.` : `Declined${reason ? ` — ${reason}` : ""}.`;
    } },
  { name: "events", description: "Meetings and events on a mission, from today on.",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" }, past: { type: "boolean" } } },
    run: async ({ mission, past }) => { const m = await findMission(mission); let q = db.from("events").select("id,title,starts_at,ends_at,location,notes,client_visible").eq("mission_id", m.id).order("starts_at"); if (!past) q = q.gt("starts_at", new Date().toISOString()); return run(q.limit(50)); } },
  { name: "add_event", description: "Put a meeting or event on a mission's calendar.",
    schema: { type: "object", required: ["mission", "title", "starts_at"], properties: { mission: { type: "string" }, title: { type: "string" }, starts_at: { type: "string", description: "ISO datetime" }, ends_at: { type: "string" }, location: { type: "string" }, notes: { type: "string" }, client_visible: { type: "boolean" } } },
    run: async ({ mission, ...e }) => { const m = await findMission(mission); const [row] = await run(db.from("events").insert({ mission_id: m.id, created_by: me.id, ...e }).select("id,title,starts_at")); return row; } },
  { name: "delete_event", description: "Remove an event by id.",
    schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: async ({ id }) => { await run(db.from("events").delete().eq("id", id)); return "Event removed."; } },

  /* ── Dispatch · files, transcripts, contacts, tools, Gantt ─────────────────── */
  { name: "files", description: "Files on a mission: paperwork or deliverables, with audience and pins.",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" }, kind: { type: "string", enum: ["paperwork", "deliverable", "all"] } } },
    run: async ({ mission, kind = "all" }) => { const m = await findMission(mission); let q = db.from("files").select("id,name,kind,audience,pinned,size_bytes,created_at").eq("mission_id", m.id).order("created_at", { ascending: false }); if (kind !== "all") q = q.eq("kind", kind); return run(q); } },
  { name: "share_file", description: "Change who sees a file: team, freelance or client. Pin or unpin it.",
    schema: { type: "object", required: ["id"], properties: { id: { type: "string" }, audience: { type: "string", enum: ["team", "freelance", "client"] }, pinned: { type: "boolean" } } },
    run: async ({ id, audience, pinned }) => { const patch = {}; if (audience) patch.audience = audience; if (pinned !== undefined) patch.pinned = pinned; const [row] = await run(db.from("files").update(patch).eq("id", id).select("name,audience,pinned")); return row; } },
  { name: "delete_file", description: "Delete a file. Confirm the name first.",
    schema: { type: "object", required: ["id", "confirm"], properties: { id: { type: "string" }, confirm: { type: "boolean" } } },
    run: async ({ id, confirm }) => { if (confirm !== true) throw new Error("confirm first"); await run(db.from("files").delete().eq("id", id)); return "File deleted (the stored object goes with the next sweep)."; } },
  { name: "transcripts", description: "Meeting transcripts on a mission, newest first (titles, dates, summaries).",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" } } },
    run: async ({ mission }) => { const m = await findMission(mission); return run(db.from("transcripts").select("id,title,source,recorded_on,summary,client_visible,created_at").eq("mission_id", m.id).order("recorded_on", { ascending: false })); } },
  { name: "transcript", description: "One transcript in full.",
    schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    run: async ({ id }) => { const [t] = await run(db.from("transcripts").select("*").eq("id", id)); if (!t) throw new Error("no such transcript"); return t; } },
  { name: "add_transcript", description: "Save a meeting transcript on a mission (the body in full, a summary if you have one).",
    schema: { type: "object", required: ["mission", "title", "body"], properties: { mission: { type: "string" }, title: { type: "string" }, body: { type: "string" }, summary: { type: "string" }, source: { type: "string", description: "claap, zoom, notes…" }, url: { type: "string" }, recorded_on: { type: "string", description: "YYYY-MM-DD" }, client_visible: { type: "boolean" } } },
    run: async ({ mission, ...t }) => { const m = await findMission(mission); const [row] = await run(db.from("transcripts").insert({ mission_id: m.id, created_by: me.id, recorded_on: t.recorded_on ?? localDate(), ...t }).select("id,title,recorded_on")); return row; } },
  { name: "mission_contacts", description: "The client's people on a mission (name, role, email, phone, warmth).",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" } } },
    run: async ({ mission }) => { const m = await findMission(mission); return run(db.from("mission_contacts").select("id,name,role_title,email,phone,linkedin_url,is_primary,warmth,seniority,last_touch_at").eq("mission_id", m.id).order("is_primary", { ascending: false })); } },
  { name: "add_mission_contact", description: "Add one of the client's people to a mission.",
    schema: { type: "object", required: ["mission", "name"], properties: { mission: { type: "string" }, name: { type: "string" }, role_title: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, linkedin_url: { type: "string" }, is_primary: { type: "boolean" }, notes: { type: "string" } } },
    run: async ({ mission, ...c }) => { const m = await findMission(mission); const [row] = await run(db.from("mission_contacts").insert({ mission_id: m.id, ...c }).select("id,name,role_title")); return row; } },
  { name: "mission_tools", description: "The tools on a mission (Gantt, RACI, links…), with their data.",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" } } },
    run: async ({ mission }) => { const m = await findMission(mission); return run(db.from("mission_tools").select("id,kind,name,data,client_visible,position").eq("mission_id", m.id).order("position")); } },
  { name: "gantt_set_bar", description: "Add or move a bar on a mission's Gantt (the Roadmap tab). Dates YYYY-MM-DD.",
    schema: { type: "object", required: ["mission", "label", "start", "end"], properties: { mission: { type: "string" }, tool_name: { type: "string", description: "which Gantt, when there are several" }, label: { type: "string" }, start: { type: "string" }, end: { type: "string" }, done: { type: "number", description: "0–100" } } },
    run: async ({ mission, tool_name, label, start, end, done }) => {
      const m = await findMission(mission);
      let q = db.from("mission_tools").select("id,name,data").eq("mission_id", m.id).eq("kind", "gantt"); if (tool_name) q = q.ilike("name", `%${tool_name}%`);
      let [t] = await run(q.limit(1));
      if (!t) { [t] = await run(db.from("mission_tools").insert({ mission_id: m.id, kind: "gantt", name: "Build plan", data: { bars: [] }, created_by: me.id }).select("id,name,data")); }
      const bars = Array.isArray(t.data?.bars) ? t.data.bars : [];
      const bar = bars.find((b) => (b.label || "").toLowerCase() === label.toLowerCase());
      if (bar) { bar.start = start; bar.end = end; if (done != null) bar.done = done; } else bars.push({ id: `b${Date.now().toString(36)}`, label, start, end, done: done ?? 0 });
      await run(db.from("mission_tools").update({ data: { ...t.data, bars } }).eq("id", t.id));
      return `${t.name}: ${label} ${start} → ${end}${done != null ? ` (${done}%)` : ""}`;
    } },
  { name: "set_tool_visibility", description: "Show or hide a mission tool to the client.",
    schema: { type: "object", required: ["id", "client_visible"], properties: { id: { type: "string" }, client_visible: { type: "boolean" } } },
    run: async ({ id, client_visible }) => { const [row] = await run(db.from("mission_tools").update({ client_visible }).eq("id", id).select("name,client_visible")); return row; } },

  /* ── Dispatch · creatives, questionnaire, paperwork, agents ────────────────── */
  { name: "creatives", description: "Ad creatives on a mission with status (draft, submitted, approved, rejected) and open comments.",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" } } },
    run: async ({ mission }) => { const m = await findMission(mission); return run(db.from("ad_assets").select("id,title,platform,format,status,version,headline,cta,submitted_at,decided_at,ad_comments(body,resolved_at)").eq("mission_id", m.id).order("position")); } },
  { name: "decide_creative", description: "Approve or reject a submitted creative, with a comment. This is the client's decision unless staff steps in — say so.",
    schema: { type: "object", required: ["id", "decision"], properties: { id: { type: "string" }, decision: { type: "string", enum: ["approved", "rejected"] }, comment: { type: "string" } } },
    run: async ({ id, decision, comment }) => { const { data, error } = await db.rpc("decide_ad", { p_asset: id, p_decision: decision, p_comment: comment ?? null }); if (error) throw new Error(error.message); return data ?? `Creative ${decision}.`; } },
  { name: "comment_creative", description: "Comment on a creative.",
    schema: { type: "object", required: ["id", "text"], properties: { id: { type: "string" }, text: { type: "string" } } },
    run: async ({ id, text }) => { await run(db.from("ad_comments").insert({ asset_id: id, author_id: me.id, body: text })); return "Commented."; } },
  { name: "questionnaire", description: "A mission's questionnaire: status, who answered, and under each question every co-founder's answer with their name (one questionnaire, one answer box per person).",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" } } },
    run: async ({ mission }) => {
      const m = await findMission(mission);
      const [q] = await run(db.from("questionnaires").select("id,title,status,sent_at,completed_at").eq("mission_id", m.id).order("created_at", { ascending: false }).limit(1));
      if (!q) return { status: "none" };
      const questions = await run(db.from("questionnaire_questions").select("id,section,position,prompt,kind,required").eq("questionnaire_id", q.id).order("position"));
      // One answer box per person (0104): every co-founder's answer, named.
      const answers = await run(db.from("questionnaire_answers").select("question_id,body,updated_at,answered_by").eq("questionnaire_id", q.id));
      const ids = [...new Set(answers.map((a) => a.answered_by))];
      const names = ids.length ? Object.fromEntries((await run(db.from("profiles").select("id,name").in("id", ids))).map((p) => [p.id, p.name])) : {};
      const byQ = {};
      for (const a of answers) { if (!a.body || !a.body.trim()) continue; (byQ[a.question_id] ||= []).push({ by: names[a.answered_by] || a.answered_by, answer: a.body, at: a.updated_at }); }
      return { ...q, respondents: ids.map((i) => names[i] || i), questions: questions.map((x) => ({ section: x.section, prompt: x.prompt, kind: x.kind, answers: byQ[x.id] || [] })) };
    } },
  { name: "add_question", description: "Add a question to a mission's questionnaire (before it is sent, or as a follow-up).",
    schema: { type: "object", required: ["mission", "prompt"], properties: { mission: { type: "string" }, prompt: { type: "string" }, section: { type: "string" }, help: { type: "string" }, kind: { type: "string", enum: ["text", "long", "choice", "multi", "number", "date"] }, required: { type: "boolean" } } },
    run: async ({ mission, ...qq }) => {
      const m = await findMission(mission);
      let [q] = await run(db.from("questionnaires").select("id").eq("mission_id", m.id).order("created_at", { ascending: false }).limit(1));
      if (!q) { [q] = await run(db.from("questionnaires").insert({ mission_id: m.id, title: "Kickoff questionnaire", status: "draft", created_by: me.id }).select("id")); }
      const last = await run(db.from("questionnaire_questions").select("position").eq("questionnaire_id", q.id).order("position", { ascending: false }).limit(1));
      const n = last?.[0]?.position ?? 0;
      const [row] = await run(db.from("questionnaire_questions").insert({ questionnaire_id: q.id, section: qq.section ?? "General", position: n + 1, prompt: qq.prompt, help: qq.help ?? null, kind: qq.kind ?? "long", required: qq.required ?? false }).select("id,prompt,section"));
      return row;
    } },
  { name: "send_questionnaire", description: "Mark the questionnaire sent: the client is notified and it opens in their portal. Confirm first — it reaches a real person.",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" } } },
    run: async ({ mission }) => { const m = await findMission(mission); const rows = await run(db.from("questionnaires").update({ status: "sent", sent_at: new Date().toISOString() }).eq("mission_id", m.id).eq("status", "draft").select("id,title")); if (!rows.length) throw new Error("no draft questionnaire to send"); return `Sent: ${rows[0].title}.`; } },
  { name: "contracts", description: "Contracts on a mission with status, value, term and dates. Signed contracts cannot be deleted.",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" } } },
    run: async ({ mission }) => { const m = await findMission(mission); return run(db.from("contracts").select("id,kind,status,title,reference,currency,value,term_months,starts_on,ends_on,sent_at,signed_at,signed_by_name,billing_active").eq("mission_id", m.id).order("created_at", { ascending: false })); } },
  { name: "send_proposal", description: "Send a draft proposal to the client (status → sent; the client sees it in the portal). Confirm the totals with the user first.",
    schema: { type: "object", required: ["proposal_id"], properties: { proposal_id: { type: "string" } } },
    run: async ({ proposal_id }) => { const rows = await run(db.from("proposals").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", proposal_id).eq("status", "draft").select("number,title")); if (!rows.length) throw new Error("not a draft proposal"); return `Proposal ${rows[0].number ?? ""} sent.`; } },
  { name: "agents", description: "The agents on a mission and their last runs.",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" } } },
    run: async ({ mission }) => { const m = await findMission(mission); return run(db.from("agents").select("id,name,archetype,model,trigger_kind,schedule,enabled,monthly_budget_usd,spent_month,last_run_at,agent_runs(status,summary,cost_usd,created_at)").eq("mission_id", m.id)); } },
  { name: "run_agent", description: "Run a mission agent now.",
    schema: { type: "object", required: ["agent_id"], properties: { agent_id: { type: "string" } } },
    run: async ({ agent_id }) => edgeFn("agent-run", { agent_id }) },

  /* ── Dispatch · kitchen, time, activity, portfolio ─────────────────────────── */
  { name: "playbooks", description: "The Kitchen, as a list: every playbook's name, kind (playbook | methodology | setup | reference), how old it is (written N ago, last modified N ago), when its facts were last measured (and whether that is stale), one line of what a session can do with it, and its step count. Call this first when you are about to use an external API or run a delivery, then `playbook` for the one you need.",
    schema: { type: "object", properties: { find: { type: "string", description: "part of a name" } } },
    run: async ({ find }) => {
      let q = db.from("playbooks").select("name,kind,description,measured_on,created_at,updated_at,keys,tools,playbook_steps(id)").order("name"); if (find) q = q.ilike("name", `%${find}%`);
      const rows = await run(q);
      return rows.map((r) => ({ name: r.name, kind: r.kind, age: ageWords(r.created_at, r.updated_at), created: r.created_at, modified: r.updated_at, measured: staleWord(r.measured_on), what: r.description, steps: (r.playbook_steps || []).length, keys: r.keys, tools: r.tools }));
    } },
  { name: "playbook", description: "The whole playbook, in one call: the Markdown with its frontmatter (title, kind, keys = vault labels, measured_on), the intro (how to call anything: hosts, headers, rate limits, envelopes, ids), the `### Router` table (what you have → what you want → which step), every step (When / Do / Expect / Verify / If it fails, the runnable prompt, tips, limitations, requirements), the Dead list and the Sources. Read it before touching the API or the delivery it describes; you should not need to open anything else. Name is exact or a unique part of it.",
    schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    run: async ({ name }) => {
      const pb = await playbookByName(name);
      const { data, error } = await db.rpc("playbook_markdown", { p_name: pb.name });
      if (error) throw new Error(error.message);
      return `# ${pb.name} · ${pb.kind} · ${staleWord(pb.measured_on)}${ageWords(pb.created_at, pb.updated_at) ? ` · ${ageWords(pb.created_at, pb.updated_at)}` : ""}${pb.keys && pb.keys.length ? ` · keys (vault labels): ${pb.keys.join(", ")}` : ""}\n\n${data}`;
    } },
  { name: "playbook_comments", description: "Comment threads left on a playbook, anchored to the exact text they are about. Open threads are things someone flagged as wrong or missing and nobody has corrected yet — read them before trusting the playbook, and before editing it. Each thread carries the quoted passage, the section it sits in, who wrote it and when; `quote_still_present` is false when that passage is no longer in the document, which usually means the correction already landed.",
    schema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "playbook name, exact or a unique part" }, status: { type: "string", enum: ["open", "resolved", "all"], description: "default open" } } },
    run: async ({ name, status }) => {
      const pb = await playbookByName(name);
      let q = db.from("anchor_comments").select("id,parent_id,quote,prefix,suffix,section,body,status,created_at,resolved_at,created_by,resolved_by").eq("subject_kind", "playbook").eq("subject_id", pb.id).order("created_at");
      if ((status ?? "open") !== "all") q = q.eq("status", status ?? "open");
      const rows = await run(q);
      if (rows.length === 0) return { playbook: pb.name, threads: [], note: `No ${status ?? "open"} comments on this playbook.` };
      const who = await namesFor([...new Set(rows.flatMap((r) => [r.created_by, r.resolved_by]).filter(Boolean))]);
      const doc = pb.content ?? "";
      // whitespace-tolerant: the stored quote comes from rendered HTML, the
      // document is Markdown, so line breaks and table pipes differ
      const present = (quote) => {
        if (!quote) return null;
        const parts = quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        try { return new RegExp(parts.join("[\\s|*_`>#-]*"), "i").test(doc); } catch { return null; }
      };
      const roots = rows.filter((r) => !r.parent_id);
      return {
        playbook: pb.name,
        open_threads: roots.filter((r) => r.status === "open").length,
        how_to_act: "Fix what the thread points at by editing the playbook (upsert_playbook), then resolve_playbook_comment on that thread id. Resolving without changing anything is how a Kitchen fills up with stale warnings.",
        threads: roots.map((r) => ({
          id: r.id, section: r.section, status: r.status,
          about: r.quote, quote_still_present: present(r.quote),
          comment: r.body, by: who[r.created_by] ?? "someone", at: r.created_at,
          resolved_by: r.resolved_by ? (who[r.resolved_by] ?? "someone") : undefined,
          replies: rows.filter((x) => x.parent_id === r.id).map((x) => ({ by: who[x.created_by] ?? "someone", at: x.created_at, body: x.body })),
        })),
      };
    } },
  { name: "comment_playbook", description: "Leave a comment on a playbook, anchored to an exact passage of its text. Use it when you find something wrong or out of date in a playbook you are not going to fix right now — a figure that no longer holds, an endpoint that answered differently, a step that failed. `about` must be text copied verbatim from the playbook's document; anything else leaves the comment unanchored and it will read as orphaned.",
    schema: { type: "object", required: ["name", "about", "comment"], properties: { name: { type: "string", description: "playbook name" }, about: { type: "string", description: "the passage this is about, copied verbatim from the document" }, comment: { type: "string", description: "what is wrong, and what it should say instead" }, section: { type: "string", description: "the heading it sits under, if you know it" } } },
    run: async ({ name, about, comment, section }) => {
      const pb = await playbookByName(name);
      const doc = pb.content ?? "";
      const anchored = doc.includes(about.trim());
      const [row] = await run(db.from("anchor_comments").insert({
        subject_kind: "playbook", subject_id: pb.id, quote: about.trim(), section: section ?? null, body: comment, created_by: me.id,
      }).select("id"));
      return { id: row.id, playbook: pb.name, anchored,
        warning: anchored ? undefined : "That passage is not in the document verbatim, so the thread will show as orphaned. Copy the text exactly if you want it to highlight." };
    } },
  { name: "document_comments", description: "Comment threads left on a mission's deliverables — what the client or the team marked up in a document we delivered. Each thread quotes the exact passage it is about. Read this before revising a deliverable: it is the client's own words about what is wrong with it, anchored to the sentence they mean. A comment sits on the .md copy of a document, which is the one the app can anchor to; the PDF beside it carries the same text.",
    schema: { type: "object", required: ["mission"], properties: { mission: { type: "string" }, file: { type: "string", description: "part of a file name; omit for every deliverable on the mission" }, status: { type: "string", enum: ["open", "resolved", "all"], description: "default open" } } },
    run: async ({ mission, file, status }) => {
      const m = await findMission(mission);
      let fq = db.from("files").select("id,name,audience").eq("mission_id", m.id);
      if (file) fq = fq.ilike("name", `%${file}%`);
      const files = await run(fq);
      if (files.length === 0) return { mission: m.name, note: file ? `No file matching "${file}" on ${m.name}.` : `No files on ${m.name}.` };
      let q = db.from("anchor_comments").select("id,parent_id,subject_id,quote,section,body,status,created_at,created_by,resolved_by")
        .eq("subject_kind", "file").in("subject_id", files.map((f) => f.id)).order("created_at");
      if ((status ?? "open") !== "all") q = q.eq("status", status ?? "open");
      const rows = await run(q);
      if (rows.length === 0) return { mission: m.name, threads: [], note: `No ${status ?? "open"} comments on ${file ? file : "any deliverable"}.` };
      const who = await namesFor([...new Set(rows.flatMap((r) => [r.created_by, r.resolved_by]).filter(Boolean))]);
      const nameOf = Object.fromEntries(files.map((f) => [f.id, f.name]));
      const roots = rows.filter((r) => !r.parent_id);
      return {
        mission: m.name,
        open_threads: roots.filter((r) => r.status === "open").length,
        how_to_act: "Each thread quotes the passage it is about. Fix the source document, re-deliver it, then resolve_playbook_comment on the thread id — the same tool closes a document thread.",
        threads: roots.map((r) => ({
          id: r.id, file: nameOf[r.subject_id], section: r.section, status: r.status,
          about: r.quote, comment: r.body, by: who[r.created_by] ?? "someone", at: r.created_at,
          replies: rows.filter((x) => x.parent_id === r.id).map((x) => ({ by: who[x.created_by] ?? "someone", at: x.created_at, body: x.body })),
        })),
      };
    } },
  { name: "resolve_playbook_comment", description: "Close a comment thread — on a playbook or on a delivered document — after the thing it points at has actually been corrected. Resolving a thread you did not act on is how the Kitchen loses its warnings. Pass reopen: true to put one back.",
    schema: { type: "object", required: ["comment_id"], properties: { comment_id: { type: "string" }, reply: { type: "string", description: "what you changed, left on the thread before closing it" }, reopen: { type: "boolean" } } },
    run: async ({ comment_id, reply, reopen }) => {
      const [c] = await run(db.from("anchor_comments").select("id,subject_kind,subject_id,quote,status").eq("id", comment_id).limit(1));
      if (!c) throw new Error(`No comment ${comment_id}. Call playbook_comments or document_comments to list them.`);
      if (reply) await run(db.from("anchor_comments").insert({ subject_kind: c.subject_kind, subject_id: c.subject_id, parent_id: c.id, body: reply, created_by: me.id }));
      const [row] = await run(db.from("anchor_comments").update({ status: reopen ? "open" : "resolved" }).eq("id", comment_id).select("id,status,resolved_at"));
      return { ...row, about: c.quote, replies_added: reply ? 1 : 0 };
    } },

  { name: "playbook_step", description: "One step of a playbook, by number (1-based) or by title: its description (When / Do / Expect / Verify / If it fails), the runnable prompt, tips, limitations with workarounds, requirements. Use after `playbook_router` pointed you at a step, or when you know the step already.",
    schema: { type: "object", required: ["name", "step"], properties: { name: { type: "string" }, step: { type: ["string", "number"], description: "1-based position, or the step's title (exact or a unique part)" } } },
    run: async ({ name, step }) => {
      const pb = await playbookByName(name);
      const steps = await run(db.from("playbook_steps").select("position,title,description,prompt,tips,limitations,requirements,days_offset").eq("playbook_id", pb.id).order("position"));
      const n = Number(step);
      let hit = Number.isInteger(n) && n >= 1 ? steps[n - 1] : null;
      if (!hit && typeof step === "string") {
        const t = step.toLowerCase();
        hit = steps.find((s) => s.title.toLowerCase() === t) || (() => { const c = steps.filter((s) => s.title.toLowerCase().includes(t)); if (c.length > 1) throw new Error(`"${step}" matches ${c.map((s) => s.title).join(" · ")} — say which`); return c[0]; })();
      }
      if (!hit) throw new Error(`No step "${step}" in ${pb.name}. Steps: ${steps.map((s) => `${s.position}. ${s.title}`).join(" · ")}`);
      return { playbook: pb.name, measured: staleWord(pb.measured_on), age: ageWords(pb.created_at, pb.updated_at), ...hit };
    } },
  { name: "playbook_router", description: "Ask a playbook's Router where to go: give what you have and what you want in your own words (\"I have a person's name and the company, I want their LinkedIn URL\"), get the matching Router rows — each with the step to follow, its trap, and the step's full text. Use this instead of guessing which endpoint to call.",
    schema: { type: "object", required: ["name", "query"], properties: { name: { type: "string" }, query: { type: "string", description: "what you have / what you want" }, limit: { type: "number" } } },
    run: async ({ name, query, limit = 3 }) => {
      const pb = await playbookByName(name);
      const { data: md, error } = await db.rpc("playbook_markdown", { p_name: pb.name });
      if (error) throw new Error(error.message);
      const parsed = PB.parse(md);
      const rows = parsed.doc.router;
      if (!rows.length) return { playbook: pb.name, router: [], note: "this playbook has no ### Router table — read `playbook` and pick the step by title" };
      const words = (t) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !["the", "and", "with", "from", "have", "want", "their", "that", "this", "for", "une", "des", "les", "pour", "avec"].includes(w)));
      const q = words(query);
      const scored = rows.map((r) => { const w = words(`${r.have} ${r.want} ${r.step}`); let n = 0; for (const x of q) if (w.has(x)) n++; return { ...r, score: n }; }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
      const steps = await run(db.from("playbook_steps").select("position,title,description,prompt,tips,limitations,requirements").eq("playbook_id", pb.id).order("position"));
      const out = scored.map((r) => ({ have: r.have, want: r.want, step: r.step, trap: r.trap, detail: steps.find((s) => s.title.toLowerCase() === r.step.toLowerCase()) || null }));
      return { playbook: pb.name, measured: staleWord(pb.measured_on), age: ageWords(pb.created_at, pb.updated_at), matches: out, all_rows: out.length ? undefined : rows };
    } },
  { name: "upsert_playbook", description: "Write a playbook from its Markdown — frontmatter (title = the name, kind, description, keys as vault labels never values, tools, measured_on, kickoff_prompt), intro with `### Router`, one `## Step` per scenario (first fence = prompt; Tips: / Limitations: a → b / Requires: / Tools:), `## Dead — do not call`, `## Sources`. Parsed deterministically, written with its steps in one transaction; the same title updates in place. Returns what changed. Confirm with the user before overwriting an existing playbook.",
    schema: { type: "object", required: ["markdown"], properties: { markdown: { type: "string" }, name: { type: "string", description: "fallback name when the frontmatter has no title" } } },
    run: async ({ markdown, name }) => {
      const f = PB.parse(markdown);
      if (!f.frontmatter.title && !name) throw new Error("the frontmatter needs a title (or pass name)");
      if (f.frontmatter.kindRaw && !f.frontmatter.kind) throw new Error(`kind must be one of ${PB.KINDS.join(", ")} (got ${f.frontmatter.kindRaw})`);
      const p = PB.payload(f, name);
      const { data, error } = await db.rpc("playbook_upsert", { p });
      if (error) throw new Error(error.message);
      const known = [...f.doc.steps.map((s) => s.title), ...f.doc.appendix.map((a) => a.title)].map((t) => t.toLowerCase());
      const dangling = f.doc.router.map((r) => r.step).filter((t) => t && !known.includes(t.toLowerCase()));
      return { ...data, router_rows: f.doc.router.length, appendix: f.doc.appendix.map((a) => a.title), router_points_at_missing_steps: dangling.length ? dangling : undefined };
    } },
  { name: "add_playbook", description: "Create a playbook with its steps (title, description, days offset from the start).",
    schema: { type: "object", required: ["name", "steps"], properties: { name: { type: "string" }, kind: { type: "string" }, description: { type: "string" }, steps: { type: "array", items: { type: "object", required: ["title"], properties: { title: { type: "string" }, description: { type: "string" }, days_offset: { type: "number" } } } } } },
    run: async ({ name, kind, description, steps }) => {
      const [pb] = await run(db.from("playbooks").insert({ name, kind: kind ?? "delivery", description: description ?? null, created_by: me.id }).select("id,name"));
      await run(db.from("playbook_steps").insert(steps.map((st, i) => ({ playbook_id: pb.id, position: i + 1, title: st.title, description: st.description ?? null, days_offset: st.days_offset ?? 0 }))));
      return `${pb.name}: ${steps.length} steps.`;
    } },
  { name: "apply_playbook", description: "Turn a playbook into tasks on a mission, dated from a start day.",
    schema: { type: "object", required: ["mission", "playbook"], properties: { mission: { type: "string" }, playbook: { type: "string", description: "name" }, start: { type: "string", description: "YYYY-MM-DD, default today" } } },
    run: async ({ mission, playbook, start }) => {
      const m = await findMission(mission);
      const pbs = await run(db.from("playbooks").select("id,name,playbook_steps(position,title,description,days_offset)").ilike("name", `%${playbook}%`).limit(2));
      if (!pbs.length) throw new Error(`no playbook matching "${playbook}"`); if (pbs.length > 1) throw new Error(`"${playbook}" matches ${pbs.map((x) => x.name).join(", ")} — say which`);
      const base = new Date(start ?? localDate());
      const steps = [...(pbs[0].playbook_steps ?? [])].sort((a, b) => a.position - b.position);
      const rows = await run(db.from("tasks").insert(steps.map((st) => ({ mission_id: m.id, title: st.title, description: st.description ?? null, urgency: "normal", due_date: new Date(base.getTime() + (st.days_offset ?? 0) * 86400000).toISOString().slice(0, 10), created_by: me.id, owner_party: "bltz", source: "bltz" }))).select("num,title,due_date"));
      return `${pbs[0].name} applied to ${m.name}: ${rows.length} tasks.`;
    } },
  { name: "log_time", description: "Log hours on a mission for a day.",
    schema: { type: "object", required: ["mission", "hours"], properties: { mission: { type: "string" }, hours: { type: "number" }, day: { type: "string", description: "YYYY-MM-DD, default today" }, note: { type: "string" } } },
    run: async ({ mission, hours, day, note }) => { const m = await findMission(mission); const [row] = await run(db.from("time_entries").insert({ mission_id: m.id, profile_id: me.id, day: day ?? localDate(), hours, note: note ?? null }).select("day,hours")); return `${row.hours}h on ${m.name}, ${row.day}.`; } },
  { name: "time", description: "Hours logged, per mission, over the last N days (default 30).",
    schema: { type: "object", properties: { days: { type: "number" }, mission: { type: "string" } } },
    run: async ({ days = 30, mission }) => {
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      let q = db.from("time_entries").select("day,hours,note,missions(key,name),profiles(name)").gt("day", since).order("day", { ascending: false }).limit(200);
      if (mission) q = q.eq("mission_id", (await findMission(mission)).id);
      const rows = await run(q);
      const byMission = {}; for (const r of rows) { const k = r.missions?.key ?? "?"; byMission[k] = (byMission[k] ?? 0) + Number(r.hours); }
      return { since, total_hours: rows.reduce((n, r) => n + Number(r.hours), 0), by_mission: byMission, entries: rows.slice(0, 40) };
    } },
  { name: "activity", description: "What happened lately on a mission (or everywhere), newest first.",
    schema: { type: "object", properties: { mission: { type: "string" }, limit: { type: "number" } } },
    run: async ({ mission, limit = 40 }) => { let q = db.from("activity").select("kind,detail,created_at,missions(key),profiles:actor_id(name)").order("created_at", { ascending: false }).limit(Math.min(limit, 200)); if (mission) q = q.eq("mission_id", (await findMission(mission)).id); return run(q); } },
  { name: "portfolio", description: "Every mission at a glance (the Portfolio view): status, phase, open tasks, money where you may see it.",
    schema: { type: "object", properties: {} },
    run: async () => run(db.from("mission_portfolio").select("*")) },

  /* ── Dispatch · Hunt, war room, studio, control, legal ─────────────────────── */
  { name: "price_book", description: "The price book: what we sell, list price, recurrence, active or not.",
    schema: { type: "object", properties: {} },
    run: async () => run(db.from("price_book").select("id,name,detail,currency,list_amount,list_amount_max,recurrence,default_term_months,active,pricing_note").order("position")) },
  { name: "advance_account", description: "Move a Hunt account to a stage (research, approach, contacted, call booked, proposal, client, dead) and log why.",
    schema: { type: "object", required: ["account", "stage"], properties: { account: { type: "string" }, stage: { type: "string", enum: ["research", "approach", "contacted", "call booked", "proposal", "client", "dead"] }, kind: { type: "string", description: "touch kind, e.g. call, email, note" }, body: { type: "string" } } },
    run: async ({ account, stage, kind, body }) => { const a = await accountByName(account); const { error } = await db.rpc("advance_account", { p_account: a.id, p_to: stage, p_kind: kind ?? "note", p_body: body ?? `moved to ${stage}` }); if (error) throw new Error(error.message); return `${a.company} → ${stage}.`; } },
  { name: "launch_gates", description: "The war room's launch gates: what is done and what is not.",
    schema: { type: "object", properties: {} },
    run: async () => run(db.from("launch_gates").select("key,label,done,auto,updated_at").order("sort")) },
  { name: "manifesto", description: "The current manifesto (war room).",
    schema: { type: "object", properties: {} },
    run: async () => { const [m] = await run(db.from("manifesto").select("version,body,updated_at").order("version", { ascending: false }).limit(1)); return m ?? { body: null }; } },
  { name: "boards", description: "Studio boards and their assets, with open comments.",
    schema: { type: "object", properties: { mission: { type: "string" } } },
    run: async ({ mission }) => { let q = db.from("boards").select("id,name,description,archived,missions(key),assets(id,name,mime,created_at,asset_comments(body,resolved_at))").eq("archived", false); if (mission) q = q.eq("mission_id", (await findMission(mission)).id); return run(q); } },
  { name: "comment_asset", description: "Comment on a studio asset.",
    schema: { type: "object", required: ["asset_id", "text"], properties: { asset_id: { type: "string" }, text: { type: "string" } } },
    run: async ({ asset_id, text }) => { await run(db.from("asset_comments").insert({ asset_id, author_id: me.id, body: text })); return "Commented."; } },
  { name: "invoices", description: "Invoices: status, amounts due and paid, per mission or all. Admin sees everything, others what RLS allows.",
    schema: { type: "object", properties: { mission: { type: "string" }, status: { type: "string" } } },
    run: async ({ mission, status }) => { let q = db.from("invoices").select("number,direction,status,currency,issued_on,due_on,stripe_status,stripe_paid_at,hosted_invoice_url,missions(key,name)").order("issued_on", { ascending: false }).limit(100); if (mission) q = q.eq("mission_id", (await findMission(mission)).id); if (status) q = q.eq("status", status); return run(q); } },
  { name: "money_todos", description:
      "The to-do list for the money (Control): cancel this subscription, settle that bill, chase a refund. " +
      "Each line can point at an expense; only one that CANCELS it counts the line's cost as a saving, so a " +
      "to-do that merely concerns a cost shows no figure and that is correct, not missing data. Open ones first.",
    schema: { type: "object", properties: { all: { type: "boolean", description: "include the done ones" } } },
    run: async ({ all }) => {
      let q = db.from("money_todo_list").select("id,title,note,status,urgency,due_date,overdue,cancels,expense_label,saving_per_month,saving_currency,expense_cadence,done_at");
      if (!all) q = q.neq("status", "done");
      const rows = await run(q.order("status").order("due_date", { nullsFirst: false }));
      if (!rows.length) return all ? "Nothing on the money to-do list." : "Nothing open on the money to-do list.";
      const saves = rows.filter((t) => t.status !== "done" && t.expense_cadence !== "one_off" && Number(t.saving_per_month || 0) > 0);
      const per = {};
      for (const t of saves) per[t.saving_currency || "USD"] = (per[t.saving_currency || "USD"] || 0) + Number(t.saving_per_month);
      const head = Object.entries(per).map(([c, n]) => `${n} ${c}`).join(" + ");
      return [
        rows.map((t) => {
          const worth = t.status !== "done" && Number(t.saving_per_month || 0) > 0 && t.expense_cadence !== "one_off"
            ? ` — worth ${t.saving_per_month} ${t.saving_currency || "USD"}/mo` : "";
          const about = t.expense_label ? ` [${t.cancels ? "cancels" : "about"} ${t.expense_label}]` : "";
          const when = t.due_date ? ` · due ${t.due_date}${t.overdue ? " OVERDUE" : ""}` : "";
          return `${t.status === "done" ? "done" : t.status}${t.urgency !== "normal" ? ` ${t.urgency}` : ""}: ${t.title}${about}${when}${worth} — id ${t.id}`;
        }).join("\n"),
        head ? `\nOff the burn once all of these are done: ${head} a month.` : "",
      ].filter(Boolean).join("\n");
    } },
  { name: "add_money_todo", description:
      "Add a to-do about the money. Link it to an expense with expense_label (part of the name is enough). " +
      "Set cancels true ONLY when doing it removes that line — that is what lets the list count its cost as a " +
      "saving. Never set it to make a number look better.",
    schema: { type: "object", required: ["title"], properties: { title: { type: "string" }, note: { type: "string" },
      expense_label: { type: "string", description: "part of the expense's name" }, cancels: { type: "boolean" },
      urgency: { type: "string", enum: ["normal", "high", "critical"] }, due_date: { type: "string", description: "YYYY-MM-DD" } } },
    run: async ({ title, note, expense_label, cancels, urgency, due_date }) => {
      let expense_id = null, matched = null;
      if (expense_label) {
        const hits = await run(db.from("expense_monthly").select("id,label").ilike("label", `%${expense_label}%`).limit(5));
        if (!hits.length) throw new Error(`No expense matching "${expense_label}".`);
        if (hits.length > 1) throw new Error(`"${expense_label}" matches ${hits.map((h) => h.label).join(", ")} — say which.`);
        expense_id = hits[0].id; matched = hits[0].label;
      }
      const [row] = await run(db.from("money_todos").insert({
        title, note: note || null, expense_id, cancels: expense_id ? !!cancels : false,
        urgency: urgency || "normal", due_date: due_date || null, created_by: me.id,
      }).select("id"));
      return `Added: ${title}${matched ? ` (${cancels ? "cancels" : "about"} ${matched})` : ""}${due_date ? `, due ${due_date}` : ""} — id ${row.id}`;
    } },
  { name: "close_money_todo", description:
      "Move a money to-do on: done, doing, blocked, or back to todo. Name part of its title. done_at is stamped by the database.",
    schema: { type: "object", required: ["title"], properties: { title: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "blocked", "done"] } } },
    run: async ({ title, status }) => {
      const hits = await run(db.from("money_todos").select("id,title").ilike("title", `%${title}%`).limit(5));
      if (!hits.length) throw new Error(`No money to-do matching "${title}".`);
      if (hits.length > 1) throw new Error(`"${title}" matches ${hits.map((h) => h.title).join(", ")} — say which.`);
      await run(db.from("money_todos").update({ status: status || "done" }).eq("id", hits[0].id));
      return `${hits[0].title} → ${status || "done"}.`;
    } },
  { name: "expenses", description:
      "Recurring and one-off expenses (Control), each normalised to a month and converted to the " +
      "base currency. A cost whose currency has no exchange rate comes back with fx_missing true " +
      "and is NOT in burn — say so rather than adding it up anyway. Rows with from_stack true are " +
      "priced tools on a mission stack: change those with add_stack_tool, not here.",
    schema: { type: "object", properties: {} },
    run: async () => run(db.from("expense_monthly").select("label,vendor,category,cadence,amount,currency,monthly_amount,monthly_usd,fx_missing,from_stack,mission_name,starts_on,ends_on,rebillable,is_active").order("monthly_usd", { ascending: false, nullsFirst: false })) },

  { name: "add_expense", description:
      "Record something we pay for (Control). A tool tied to one mission belongs on that mission's " +
      "stack instead — use add_stack_tool, it reaches burn on its own. Give the amount in the " +
      "currency actually charged and never convert it yourself: set_fx_rate holds the rates.",
    schema: { type: "object", required: ["label", "amount"], properties: {
      label: { type: "string" }, amount: { type: "number" },
      currency: { type: "string", description: "Three letters, e.g. EUR. Defaults to the base currency." },
      cadence: { enum: ["monthly", "quarterly", "annual", "one_off"] },
      category: { enum: ["tool","infra","travel","legal","accounting","marketing","hardware","office","contractor","other"] },
      vendor: { type: "string" }, url: { type: "string" }, notes: { type: "string" },
      mission: { type: "string", description: "Only if the cost belongs to a client" },
      rebillable: { type: "boolean", description: "The client pays: kept out of our burn" },
      starts_on: { type: "string" }, ends_on: { type: "string" } } },
    run: async (a) => {
      const row = { label: a.label, amount: a.amount, vendor: a.vendor ?? null,
        cadence: a.cadence ?? "monthly", category: a.category ?? "tool",
        url: a.url ?? null, notes: a.notes ?? null, rebillable: a.rebillable ?? false };
      if (a.currency) row.currency = a.currency.toUpperCase();
      if (a.starts_on) row.starts_on = a.starts_on;
      if (a.ends_on) row.ends_on = a.ends_on;
      if (a.mission) row.mission_id = (await missionByName(a.mission)).id;
      await run(db.from("expenses").insert(row));
      const [back] = await run(db.from("expense_monthly").select("currency,monthly_usd,fx_missing").eq("label", a.label).limit(1));
      const warn = back && back.fx_missing
        ? ` No ${back.currency} exchange rate, so it is NOT counted in burn yet — set_fx_rate fixes that.`
        : "";
      return `${a.label} recorded at ${a.amount} ${row.currency ?? "(base)"} ${row.cadence}.${warn}`;
    } },

  { name: "set_fx_rate", description:
      "Set how many units of the base currency one unit of another buys. Costs in a currency with " +
      "no rate are deliberately left out of burn rather than summed as if they matched. Use a real " +
      "quoted rate; never estimate one.",
    schema: { type: "object", required: ["currency", "rate"], properties: {
      currency: { type: "string", description: "Three letters, e.g. EUR" },
      rate: { type: "number", description: "Base-currency value of one unit" },
      note: { type: "string", description: "Where the rate came from" } } },
    run: async (a) => {
      const ccy = String(a.currency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(ccy)) throw new Error("A currency is three letters, like EUR.");
      if (!(a.rate > 0)) throw new Error("A rate has to be above zero.");
      await run(db.from("fx_rates").upsert({ currency: ccy, rate_to_usd: a.rate,
        as_of: new Date().toISOString().slice(0, 10), note: a.note ?? null }, { onConflict: "currency" }));
      const [r] = await run(db.from("runway").select("monthly_burn,unconverted_costs").limit(1));
      return `1 ${ccy} = ${a.rate}. Burn is now ${r?.monthly_burn ?? "?"}` +
        `${r?.unconverted_costs ? `, still ${r.unconverted_costs} cost(s) without a rate.` : "."}`;
    } },
  { name: "legal_documents", description: "Legal documents and templates (Legal), with review state.",
    schema: { type: "object", properties: { mission: { type: "string" } } },
    run: async ({ mission }) => { let q = db.from("legal_documents").select("id,title,family,kind,version,is_template,jurisdiction,review_requested_at,reviewed_at,executed_at,missions(key)").order("updated_at", { ascending: false }).limit(100); if (mission) q = q.eq("mission_id", (await findMission(mission)).id); return run(q); } },
  { name: "ask_counsel", description: "Ask the counsel a legal question (Legal → Questions).",
    schema: { type: "object", required: ["question"], properties: { question: { type: "string" }, context: { type: "string" }, urgency: { type: "string", enum: ["normal", "high", "critical"] }, jurisdiction: { type: "string" } } },
    run: async ({ question, context, urgency, jurisdiction }) => { const [row] = await run(db.from("legal_questions").insert({ question, context: context ?? null, urgency: urgency ?? "normal", jurisdiction: jurisdiction ?? null, asked_by: me.id }).select("id,question")); return row; } },
  { name: "legal_questions", description: "Open and answered legal questions.",
    schema: { type: "object", properties: { open_only: { type: "boolean" } } },
    run: async ({ open_only = true }) => { let q = db.from("legal_questions").select("id,question,urgency,answer,answered_at,created_at").order("created_at", { ascending: false }).limit(50); if (open_only) q = q.is("answer", null); return run(q); } },

  /* ── Zeus · the universe, the board, people ────────────────────────────────── */
  { name: "zeus_board", description: "The Hunting board: accounts under a filter document (the same the app speaks: q, country[], city[], heat[], verdict, has[], or a tree {and:[{field,op,value}]}), with the total. Sort: score | intent | moved | size | touched | name | recent.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, filters: { type: "object" }, sort: { type: "string" }, limit: { type: "number" }, offset: { type: "number" }, facets: { type: "boolean", description: "also the rail's counts" } } },
    run: async ({ machine, filters = {}, sort = "score", limit = 50, offset = 0, facets }) => zeus(`/api/${machine}/accounts?f=${encodeURIComponent(JSON.stringify(filters))}&sort=${sort}&limit=${Math.min(limit, 500)}&offset=${offset}&facets=${facets ? 1 : 0}`) },
  { name: "zeus_people", description: "People on a machine under a filter (persona[], heat[], stage[], has[] like email|phone|linkedin|engagement|replied, where[], or a tree). Sort: score | engaged | touched | replied | recent | name.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, filters: { type: "object" }, sort: { type: "string" }, limit: { type: "number" }, offset: { type: "number" }, facets: { type: "boolean" } } },
    run: async ({ machine, filters = {}, sort = "score", limit = 50, offset = 0, facets }) => zeus(`/api/${machine}/people?f=${encodeURIComponent(JSON.stringify(filters))}&sort=${sort}&limit=${Math.min(limit, 500)}&offset=${offset}&facets=${facets ? 1 : 0}`) },
  { name: "zeus_signals", description: "What moved: the last signals across a cut, in words, with their family (intent | behaviour | market).",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, filters: { type: "object" }, family: { type: "string", enum: ["intent", "behaviour", "market"] }, limit: { type: "number" } } },
    run: async ({ machine, filters = {}, family, limit = 50 }) => zeus(`/api/${machine}/signals?f=${encodeURIComponent(JSON.stringify(filters))}&limit=${limit}${family ? `&family=${family}` : ""}`) },
  { name: "zeus_signal_types", description: "The signals a machine listens to: family, words, points, decay, how many seen.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/signal-types`) },
  { name: "zeus_market_signal", description: "Add a market signal by hand onto a cut (every account in the cut gets it, with points that fade). Confirm the title and cut with the user first.",
    schema: { type: "object", required: ["machine", "title", "cut"], properties: { machine: { type: "string" }, title: { type: "string" }, cut: { type: "object", description: "a filter document" }, cut_words: { type: "string" }, points: { type: "number" }, decay_days: { type: "number" }, source_url: { type: "string" }, body: { type: "string" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/market`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_competitors", description: "A machine's competitors: what they sell, what they charge (monthly range), threat, where they sit and sell; the four-corner map (x, y 0–100, placed or price-derived) and the axes' names.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/competitors`) },
  { name: "zeus_add_competitor", description: "Put a competitor on a machine's map. Prices are monthly in the machine's currency; hq_country and geos are ISO-2. Confirm the name with the user first.",
    schema: { type: "object", required: ["machine", "name"], properties: { machine: { type: "string" }, name: { type: "string" }, url: { type: "string" }, hq_country: { type: "string" }, geos: { type: "array", items: { type: "string" } }, offer: { type: "string" }, niche: { type: "string" }, pricing: { type: "string" }, price_low: { type: "number" }, price_high: { type: "number" }, price_model: { type: "string", enum: ["retainer", "flat", "pilot", "percent", "quote"] }, threat: { type: "string", enum: ["high", "mid", "low"] }, axis_x: { type: "number" }, axis_y: { type: "number" }, notes: { type: "string" }, source: { type: "string" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/competitors`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_update_competitor", description: "Change a competitor's facts or place it on the map (axis_x, axis_y 0–100). Only the fields given change.",
    schema: { type: "object", required: ["machine", "id"], properties: { machine: { type: "string" }, id: { type: "string" }, url: { type: "string" }, hq_country: { type: "string" }, geos: { type: "array", items: { type: "string" } }, offer: { type: "string" }, niche: { type: "string" }, pricing: { type: "string" }, price_low: { type: "number" }, price_high: { type: "number" }, price_model: { type: "string" }, threat: { type: "string", enum: ["high", "mid", "low"] }, axis_x: { type: "number" }, axis_y: { type: "number" }, notes: { type: "string" } } },
    run: async ({ machine, id, ...b }) => zeus(`/api/${machine}/competitors/${id}`, { method: "PATCH", body: JSON.stringify(b) }) },
  { name: "zeus_competitor_axes", description: "Name the two dimensions of a machine's competitor map (labels and the words at each end).",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, x_label: { type: "string" }, x_low: { type: "string" }, x_high: { type: "string" }, y_label: { type: "string" }, y_low: { type: "string" }, y_high: { type: "string" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/competitors/axes`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_verify", description: "Mark accounts verified or rejected (the words of the machine's view), with a note.",
    schema: { type: "object", required: ["machine", "account_ids", "verification"], properties: { machine: { type: "string" }, account_ids: { type: "array", items: { type: "string" } }, verification: { type: "string", enum: ["verified", "rejected", "unverified"] }, note: { type: "string" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/accounts/verify`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_exclude", description: "Exclude accounts for good as a customer, in an open cycle, or blocked. The gate holds them from the next pass. Confirm first.",
    schema: { type: "object", required: ["machine", "account_ids", "kind"], properties: { machine: { type: "string" }, account_ids: { type: "array", items: { type: "string" } }, kind: { type: "string", enum: ["customer", "in_cycle", "blocked"] }, note: { type: "string" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/accounts/exclude`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_assign", description: "Put an owner's name on accounts (or none).",
    schema: { type: "object", required: ["machine", "account_ids"], properties: { machine: { type: "string" }, account_ids: { type: "array", items: { type: "string" } }, owner: { type: "string" } } },
    run: async ({ machine, account_ids, owner }) => zeus(`/api/${machine}/accounts/assign`, { method: "POST", body: JSON.stringify({ account_ids, owner: owner ?? null }) }) },
  { name: "zeus_note", description: "Write a note on an account's history.",
    schema: { type: "object", required: ["machine", "account_id", "body"], properties: { machine: { type: "string" }, account_id: { type: "string" }, body: { type: "string" } } },
    run: async ({ machine, account_id, body }) => zeus(`/api/${machine}/accounts/${account_id}/notes`, { method: "POST", body: JSON.stringify({ body }) }) },
  { name: "zeus_edit_account", description: "Correct an account's facts (any registered column) or its name, domain, country. Edits are kept over imports.",
    schema: { type: "object", required: ["machine", "account_id", "patch"], properties: { machine: { type: "string" }, account_id: { type: "string" }, patch: { type: "object" } } },
    run: async ({ machine, account_id, patch }) => zeus(`/api/${machine}/accounts/${account_id}`, { method: "PATCH", body: JSON.stringify(patch) }) },
  { name: "zeus_forget_contact_field", description: "Delete an email or a phone from a person, for good; the account's history keeps a line saying who removed it.",
    schema: { type: "object", required: ["machine", "contact_id", "field"], properties: { machine: { type: "string" }, contact_id: { type: "string" }, field: { type: "string", enum: ["email", "phone"] } } },
    run: async ({ machine, contact_id, field }) => zeus(`/api/${machine}/contacts/${contact_id}`, { method: "PATCH", body: JSON.stringify({ forget: field }) }) },

  /* ── Zeus · acting: enrich, launch, CRM, export ────────────────────────────── */
  { name: "zeus_enrich_ready", description: "Before enriching: is there a key on this machine's stack? Says which credential is missing and where to add it in Dispatch.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/enrich/ready`) },
  { name: "zeus_enrich", description: "Enrich whole accounts (everyone inside who lacks an email or a phone) or exactly these people, on the client's enrichment credits. Confirm the count first — it spends.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, account_ids: { type: "array", items: { type: "string" } }, contact_ids: { type: "array", items: { type: "string" } } } },
    run: async ({ machine, account_ids, contact_ids }) => contact_ids?.length ? zeus(`/api/${machine}/people/enrich`, { method: "POST", body: JSON.stringify({ contact_ids }) }) : zeus(`/api/${machine}/accounts/enrich`, { method: "POST", body: JSON.stringify({ account_ids: account_ids ?? [] }) }) },
  { name: "zeus_enrich_check", description: "Look at the open enrichment jobs; apply the answers that arrived.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/enrich/check`, { method: "POST", body: "{}" }) },
  { name: "zeus_create_campaign", description: "Create a new campaign in the client's Lemlist and register it on the machine, ready to launch into. Returns campaign_id and sequence_id — the sequence_id is what zeus_add_steps hangs steps off. The campaign starts empty and in draft: nothing sends until steps exist and someone approves a launch. Confirm the name with the person first.",
    schema: { type: "object", required: ["machine", "name"], properties: { machine: { type: "string" }, name: { type: "string", description: "3 to 120 characters, what it will be called in Lemlist" }, timezone: { type: "string", description: "IANA name, e.g. Europe/Madrid. Defaults to Europe/Paris" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/campaigns`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_add_steps", description: "Add steps to a campaign's sequence, in order. Types: email (needs subject and message), linkedinInvite, linkedinSend (needs message), linkedinVisit, linkedinFollow, whatsappMessage, sms, manual (needs title), phone. delay is in days before that step. Messages may use Lemlist variables like {{firstName}}, {{companyName}}, and the ones Zeus supplies: {{zeusContext}}, {{zeusPersona}}, {{msgInvite}}, {{msg1}}, {{emailSubject}}. Read the copy back to the person before adding it.",
    schema: { type: "object", required: ["machine", "sequence_id", "steps"], properties: { machine: { type: "string" }, sequence_id: { type: "string" }, steps: { type: "array", maxItems: 20, items: { type: "object", required: ["type"], properties: { type: { type: "string", enum: ["email", "linkedinInvite", "linkedinSend", "linkedinVisit", "linkedinFollow", "whatsappMessage", "sms", "manual", "phone"] }, subject: { type: "string" }, message: { type: "string" }, altMessage: { type: "string" }, title: { type: "string" }, delay: { type: "number", description: "days before this step" }, index: { type: "number" } } } } } },
    run: async ({ machine, sequence_id, steps }) => zeus(`/api/${machine}/sequences/${sequence_id}/steps`, { method: "POST", body: JSON.stringify({ steps }) }) },
  { name: "zeus_sequence", description: "The steps of a campaign's sequence as Lemlist holds them: type, delay, subject and message per step. Use it to show someone what a campaign actually says before launching into it.",
    schema: { type: "object", required: ["machine", "campaign_id"], properties: { machine: { type: "string" }, campaign_id: { type: "string" } } },
    run: async ({ machine, campaign_id }) => zeus(`/api/${machine}/campaigns/${campaign_id}/sequences`) },
  { name: "zeus_launch_check", description: "What a launch would do, without doing it: how many are ready, how many are already queued, how many have nobody reachable, and every account whose evidence disagrees with itself (the person is in another country, or their title names another employer) with the reason. Read this out loud before launching.",
    schema: { type: "object", required: ["machine", "campaign_id"], properties: { machine: { type: "string" }, campaign_id: { type: "string" }, account_ids: { type: "array", items: { type: "string" } }, segment_id: { type: "string", description: "a table id" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/outbox/launch/check`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_launch", description: "Launch accounts into a Lemlist campaign, by ids or by a saved table's id (best 500). Queues into the outbox within the daily cap. REFUSES with 409 and names the rows when an account's evidence disagrees with itself — then either skip_blocked:true to launch the rest and leave those out (the usual answer), or override:true to send them anyway. Confirm the count and campaign with the person first, and show them what zeus_launch_check said.",
    schema: { type: "object", required: ["machine", "campaign_id"], properties: { machine: { type: "string" }, campaign_id: { type: "string" }, account_ids: { type: "array", items: { type: "string" } }, segment_id: { type: "string", description: "a table id" }, note: { type: "string" }, skip_blocked: { type: "boolean", description: "launch the clean accounts, leave the flagged ones out" }, override: { type: "boolean", description: "launch the flagged ones too — only on an explicit yes from the person" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/outbox/launch`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_outbox", description: "The outbox and today's caps per channel: queued, sent, held, failed; the campaigns the machine knows.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/outbox`) },
  { name: "zeus_drain", description: "Send what the outbox queued, now, keys through the vault (STAFF ONLY — a client gets 403 here; their sends go out on approval instead). live=false says what it would send.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, live: { type: "boolean" }, channels: { type: "array", items: { type: "string", enum: ["sequence", "crm"] } }, max: { type: "number" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/outbox/drain`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_push_crm", description: "Push accounts to the client's CRM: queued, then sent now when the CRM is reachable; says why when it is not.",
    schema: { type: "object", required: ["machine", "account_ids"], properties: { machine: { type: "string" }, account_ids: { type: "array", items: { type: "string" } }, note: { type: "string" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/accounts/crm`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_export", description: "The call sheet for a cut or a selection, as CSV text (one row per account with its best person). Large cuts are truncated to 2,000 rows here.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, filters: { type: "object" }, account_ids: { type: "array", items: { type: "string" } }, sort: { type: "string" } } },
    run: async ({ machine, filters = {}, account_ids, sort = "score" }) => {
      const text = account_ids?.length ? await zeusText(`/api/${machine}/accounts/export`, { method: "POST", body: JSON.stringify({ account_ids, sort }) }) : await zeusText(`/api/${machine}/accounts.csv?f=${encodeURIComponent(JSON.stringify(filters))}&sort=${sort}`);
      const lines = text.split("\n"); return { rows: lines.length - 1, csv: lines.slice(0, 2001).join("\n") };
    } },
  { name: "zeus_lemlist_sync", description: "Pull the sequencer's memory (campaigns, stats, activities) from the client's Lemlist. Staff: the key is revealed through the vault as you.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/lemlist/sync`, { method: "POST", body: "{}" }) },
  { name: "zeus_reach", description: "Outreach overview: what went out and what came back, per channel and day.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/reach`) },

  /* ── Zeus · tables on the canvas ───────────────────────────────────────────── */
  { name: "zeus_tables", description: "The canvas: every table (a live cut with history and actions), with counts, thirty days of history and what it does.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => { const r = await zeus(`/api/${machine}/tables`); return { universe: r.universe, doors: r.sources, workbooks: (r.workbooks ?? []).map((w) => ({ id: w.id, name: w.name, kind: w.kind, tables: w.tables, members: w.members })), tables: r.tables.map((t) => ({ id: t.id, name: t.name, kind: t.kind, workbook_id: t.workbook_id, parent_id: t.parent_id, filters: t.filters, members: t.member_count, actions: (t.actions ?? []).map((a) => `${a.kind}${a.mode === "auto" ? " (auto)" : ""}`), last_30_days: (t.history ?? []).map((h) => h.members), recent: t.recent })) }; } },
  { name: "zeus_create_table", description: "Create a table: kind account | person | event, a filter document, optionally under a parent (same kind; the parent's cut AND this one) or derived across kinds — people at an accounts table: filters {in_table: <id>}; accounts of a people table: {accounts_of: <id>}; a log: kind event with {source: ['albacross']}.",
    schema: { type: "object", required: ["machine", "name", "kind"], properties: { machine: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: ["account", "person", "event"] }, filters: { type: "object" }, parent_id: { type: "string" }, workbook_id: { type: "string", description: "the workbook it sits in; omitted → its parent's, or the Universe" }, note: { type: "string" } } },
    run: async ({ machine, ...b }) => { const t = await zeus(`/api/${machine}/tables`, { method: "POST", body: JSON.stringify(b) }); return { id: t.id, name: t.name, kind: t.kind, members: t.refresh?.members }; } },
  { name: "zeus_table_rows", description: "The rows of a table (its cut AND an extra filter), as the console shows them.",
    schema: { type: "object", required: ["machine", "table_id"], properties: { machine: { type: "string" }, table_id: { type: "string" }, filters: { type: "object" }, sort: { type: "string" }, limit: { type: "number" }, offset: { type: "number" } } },
    run: async ({ machine, table_id, filters = {}, sort, limit = 50, offset = 0 }) => zeus(`/api/${machine}/tables/${table_id}/rows?f=${encodeURIComponent(JSON.stringify(filters))}${sort ? `&sort=${sort}` : ""}&limit=${Math.min(limit, 500)}&offset=${offset}`) },
  { name: "zeus_update_table", description: "Rename a table, change its filters, parent, note, colour — or move it to another workbook (workbook_id; its children and derived tables move with it).",
    schema: { type: "object", required: ["machine", "table_id"], properties: { machine: { type: "string" }, table_id: { type: "string" }, name: { type: "string" }, filters: { type: "object" }, parent_id: { type: "string" }, workbook_id: { type: "string" }, note: { type: "string" }, color: { type: "string" } } },
    run: async ({ machine, table_id, ...b }) => zeus(`/api/${machine}/tables/${table_id}`, { method: "PATCH", body: JSON.stringify(b) }) },
  { name: "zeus_workbooks", description: "The workbooks of a machine — one canvas per project: the Universe, one per conference (made with it), campaigns and markets — with their table counts, members and thirty days of history.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/workbooks`) },
  { name: "zeus_create_workbook", description: "Create a workbook (kind campaign | market | custom; conferences get theirs on their own). Tables are then created in it with zeus_create_table's workbook_id, or moved in with zeus_update_table.",
    schema: { type: "object", required: ["machine", "name"], properties: { machine: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: ["campaign", "market", "custom"] }, note: { type: "string" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/workbooks`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_archive_workbook", description: "Archive a workbook: its tables go back to the Universe, nothing is lost. The Universe itself cannot be archived. Confirm first.",
    schema: { type: "object", required: ["machine", "workbook_id"], properties: { machine: { type: "string" }, workbook_id: { type: "string" } } },
    run: async ({ machine, workbook_id }) => zeus(`/api/${machine}/workbooks/${workbook_id}`, { method: "DELETE" }) },
  { name: "zeus_zagents", description: "The Zagent squad of a machine: system prompts that act on its data when called (the Drafter first), with runs and cost over 7 days and which key pays.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/zagents`) },
  { name: "zeus_set_zagent", description: "Change a Zagent: its brief (this machine's specifics: who writes, to whom, why, what each pretext means), its system prompt, model, or enabled.",
    schema: { type: "object", required: ["machine", "key"], properties: { machine: { type: "string" }, key: { type: "string" }, brief: { type: "string" }, system_prompt: { type: "string" }, model: { type: "string" }, enabled: { type: "boolean" }, purpose: { type: "string" } } },
    run: async ({ machine, key, ...b }) => zeus(`/api/${machine}/zagents/${key}`, { method: "PATCH", body: JSON.stringify(b) }) },
  { name: "zeus_draft_table", description: "Draft the messages for every person in a people table: one pretext per person (even, stable split), the Drafter writes every touch, nothing goes out until approved. Spends the Anthropic key on the stack — confirm with the person first.",
    schema: { type: "object", required: ["machine", "table_id", "campaign_id"], properties: { machine: { type: "string" }, table_id: { type: "string" }, campaign_id: { type: "string" }, pretexts: { type: "array", items: { type: "object", properties: { key: { type: "string" }, meaning: { type: "string" } } } }, note: { type: "string" }, limit: { type: "number" }, write: { type: "boolean", description: "false = make the rows, do not call the model yet" } } },
    run: async ({ machine, table_id, ...b }) => zeus(`/api/${machine}/tables/${table_id}/draft`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_drafts", description: "The drafts of a people table — per person: pretext, status (drafted, approved, sent, replied), the messages — and the test readout per pretext.",
    schema: { type: "object", required: ["machine", "table_id"], properties: { machine: { type: "string" }, table_id: { type: "string" } } },
    run: async ({ machine, table_id }) => { const r = await zeus(`/api/${machine}/tables/${table_id}/drafts`); return { results: r.results, rows: r.rows.map((x) => ({ id: x.id, who: x.contact.full_name, company: x.account.company_name, pretext: x.pretext, status: x.status, replied: x.replied, accepted: x.accepted, invite: x.draft?.msgInvite ?? null, msg1: x.draft?.msg1 ?? null })) }; } },
  { name: "zeus_approve_drafts", description: "Approve drafts AND SEND THEM: the ids given, or every filled draft of a table. The machine drains straight after approving, within the day's cap, so approving IS the send — there is no second step and no undo. Every row still passes the send guard, so a flagged one is held rather than mailed. Read the drafts back to the person and get an explicit yes first.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, ids: { type: "array", items: { type: "number" } }, table_id: { type: "string" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/outbox/drafts/approve`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_archive_table", description: "Archive a table and its children (the history stays). Confirm first.",
    schema: { type: "object", required: ["machine", "table_id"], properties: { machine: { type: "string" }, table_id: { type: "string" } } },
    run: async ({ machine, table_id }) => zeus(`/api/${machine}/tables/${table_id}`, { method: "DELETE" }) },
  { name: "zeus_table_history", description: "Members per day and the feed of a table (entered, left, actions run).",
    schema: { type: "object", required: ["machine", "table_id"], properties: { machine: { type: "string" }, table_id: { type: "string" }, days: { type: "number" } } },
    run: async ({ machine, table_id, days = 30 }) => zeus(`/api/${machine}/tables/${table_id}/history?days=${days}`) },
  { name: "zeus_add_action", description: "Give a table an action: launch (config.campaign_id), export, crm, audience (config.network linkedin|meta, list company|contact), enrich, stamp (config.facts), notify. mode auto runs on every member that enters (launch, crm, stamp, notify only). Confirm an auto launch with the user.",
    schema: { type: "object", required: ["machine", "table_id", "kind"], properties: { machine: { type: "string" }, table_id: { type: "string" }, kind: { type: "string", enum: ["launch", "export", "crm", "audience", "enrich", "notify", "stamp"] }, mode: { type: "string", enum: ["once", "auto"] }, config: { type: "object" } } },
    run: async ({ machine, table_id, ...b }) => zeus(`/api/${machine}/tables/${table_id}/actions`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_add_formula", description: "Add (or replace) a formula column on a table: an Excel-like expression compiled on the server — IF(days_since(last_touch) > 30, \"cold\", \"warm\"). Fields by kind: accounts (score, heat, verdict, stage, owner, people, with_email, signals, last_signal, last_touch, size, employees, founded, software, industry, country, city, has_email, has_phone, has_linkedin, has_signals, has_crm, facts.<key>), people (name, title, seniority, persona, email, phone, has_*, company, country, city, heat, score, stage, engagements, last_engaged, sent, opened, replied, booked, last_touch, place, facts.<key>), events (source, signal_type, occurred_at, resolved, company_name, domain, country, city, score, heat, identity.<key>, detail.<key>). Functions: IF COALESCE LOWER UPPER TRIM LEN CONTAINS STARTS_WITH CONCAT & NUM TEXT ROUND ABS MIN MAX DAYS_SINCE DAYS_UNTIL YEAR TODAY IS_BLANK IN and/or/not. Try zeus_formula_preview first.",
    schema: { type: "object", required: ["machine", "table_id", "key", "expr"], properties: { machine: { type: "string" }, table_id: { type: "string" }, key: { type: "string", description: "a-z, 0-9, _ — starts with a letter" }, label: { type: "string" }, expr: { type: "string" } } },
    run: async ({ machine, table_id, key, label, expr }) => {
      const t = await zeus(`/api/${machine}/tables/${table_id}`);
      const rest = (t.columns || []).filter((c) => !(c && typeof c === "object" && c.kind === "formula" && c.key === key));
      const u = await zeus(`/api/${machine}/tables/${table_id}`, { method: "PATCH", body: JSON.stringify({ columns: [...rest, { key, label: label || key, kind: "formula", expr }] }) });
      const col = (u.columns || []).find((c) => c && typeof c === "object" && c.key === key);
      return { table: u.name, column: col, values_computed: u.formulas };
    } },
  { name: "zeus_formula_preview", description: "Try a formula on a table's first five rows before making it a column: returns its type and the values.",
    schema: { type: "object", required: ["machine", "table_id", "expr"], properties: { machine: { type: "string" }, table_id: { type: "string" }, expr: { type: "string" } } },
    run: async ({ machine, table_id, expr }) => zeus(`/api/${machine}/tables/${table_id}/formula/preview`, { method: "POST", body: JSON.stringify({ expr }) }) },
  { name: "zeus_workflows", description: "A table's workflows: name, dry or live, auto or once, the steps (if <condition> then <action>), last week's outcomes, rows waiting.",
    schema: { type: "object", required: ["machine", "table_id"], properties: { machine: { type: "string" }, table_id: { type: "string" } } },
    run: async ({ machine, table_id }) => zeus(`/api/${machine}/tables/${table_id}/workflows`) },
  { name: "zeus_set_workflow", description: "Create a workflow on a table, or update one by id: name, steps [{name, when: null | {formula: \"score > 60 and not has_email\"}, do: {kind: launch|crm|stamp|notify|move_to|wait_enrich, config: {campaign_id} | {facts: {k: v}} | {to} | {table_id}}, on_fail: stop|continue}], dry (default true — log only), mode auto (every row that enters or changes) | once, enabled. Conditions are formulas that are true or false; the server compiles them. Going live (dry: false) acts on real rows — confirm with the person first.",
    schema: { type: "object", required: ["machine", "table_id"], properties: { machine: { type: "string" }, table_id: { type: "string" }, workflow_id: { type: "string" }, name: { type: "string" }, steps: { type: "array", items: { type: "object" } }, dry: { type: "boolean" }, mode: { type: "string", enum: ["auto", "once"] }, enabled: { type: "boolean" } } },
    run: async ({ machine, table_id, workflow_id, ...b }) => workflow_id
      ? zeus(`/api/${machine}/tables/${table_id}/workflows/${workflow_id}`, { method: "PATCH", body: JSON.stringify(b) })
      : zeus(`/api/${machine}/tables/${table_id}/workflows`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_run_workflow", description: "Run a workflow now on the given rows (keys) or on every current member of its table. Dry workflows only log; a live one acts — confirm first.",
    schema: { type: "object", required: ["machine", "table_id", "workflow_id"], properties: { machine: { type: "string" }, table_id: { type: "string" }, workflow_id: { type: "string" }, keys: { type: "array", items: { type: "string" } } } },
    run: async ({ machine, table_id, workflow_id, keys }) => zeus(`/api/${machine}/tables/${table_id}/workflows/${workflow_id}/run`, { method: "POST", body: JSON.stringify(keys ? { keys } : {}) }) },
  { name: "zeus_workflow_runs", description: "The log of a workflow: per row and step, the outcome (skipped, done, dry, waiting, error, stopped) with detail, newest first; optionally one row's key.",
    schema: { type: "object", required: ["machine", "table_id", "workflow_id"], properties: { machine: { type: "string" }, table_id: { type: "string" }, workflow_id: { type: "string" }, key: { type: "string" }, limit: { type: "number" } } },
    run: async ({ machine, table_id, workflow_id, key, limit }) => zeus(`/api/${machine}/tables/${table_id}/workflows/${workflow_id}/runs?limit=${limit || 100}${key ? `&key=${encodeURIComponent(key)}` : ""}`) },
  { name: "zeus_workflow_explain", description: "What a workflow would do to one row, step by step — matches or not, already ran or not — without writing anything.",
    schema: { type: "object", required: ["machine", "table_id", "workflow_id", "key"], properties: { machine: { type: "string" }, table_id: { type: "string" }, workflow_id: { type: "string" }, key: { type: "string" } } },
    run: async ({ machine, table_id, workflow_id, key }) => zeus(`/api/${machine}/tables/${table_id}/workflows/${workflow_id}/explain/${encodeURIComponent(key)}`) },
  { name: "zeus_run_action", description: "Run one of a table's actions now, on today's members. Export and audience return the file's first rows.",
    schema: { type: "object", required: ["machine", "table_id", "action_id"], properties: { machine: { type: "string" }, table_id: { type: "string" }, action_id: { type: "string" } } },
    run: async ({ machine, table_id, action_id }) => { const text = await zeusText(`/api/${machine}/tables/${table_id}/actions/${action_id}/run`, { method: "POST", body: "{}" }); try { return JSON.parse(text); } catch { const lines = text.split("\n"); return { rows: lines.length - 1, csv: lines.slice(0, 201).join("\n") }; } } },
  { name: "zeus_refresh_table", description: "Recompute a table's members now (entered, left).",
    schema: { type: "object", required: ["machine", "table_id"], properties: { machine: { type: "string" }, table_id: { type: "string" } } },
    run: async ({ machine, table_id }) => zeus(`/api/${machine}/tables/${table_id}/refresh`, { method: "POST", body: "{}" }) },
  { name: "zeus_events", description: "The raw rows the doors sent (the logs): source, type, when, the JSON they carried, resolved or not. Filter by source[], signal_type[], resolved, or a tree on identity.<key> / detail.<key>.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, filters: { type: "object" }, limit: { type: "number" }, offset: { type: "number" } } },
    run: async ({ machine, filters = {}, limit = 50, offset = 0 }) => zeus(`/api/${machine}/events?f=${encodeURIComponent(JSON.stringify(filters))}&limit=${Math.min(limit, 500)}&offset=${offset}&facets=1`) },
  { name: "zeus_event_keys", description: "The JSON keys a door sends, with counts — what an event table can show as columns.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, source: { type: "string" } } },
    run: async ({ machine, source }) => zeus(`/api/${machine}/events/keys${source ? `?source=${encodeURIComponent(source)}` : ""}`) },

  /* ── Zeus · conferences, data, columns, the machine ────────────────────────── */
  { name: "zeus_conferences", description: "Conferences with countdown, targets, and progress (touched, replied, booked).",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/conferences`) },
  { name: "zeus_add_conference", description: "Add a conference (name, city, country, dates). Its targets default to the accounts in its city, or a table you name.",
    schema: { type: "object", required: ["machine", "name"], properties: { machine: { type: "string" }, name: { type: "string" }, city: { type: "string" }, country: { type: "string" }, starts_on: { type: "string" }, ends_on: { type: "string" }, note: { type: "string" }, segment_id: { type: "string", description: "a table id for the targets" } } },
    run: async ({ machine, ...b }) => {
      if (!b.segment_id && b.city) { const t = await zeus(`/api/${machine}/tables`, { method: "POST", body: JSON.stringify({ name: `${b.name} — targets`, kind: "account", filters: { and: [{ field: "city", op: "in", value: [b.city] }] } }) }); b.segment_id = t.id; }
      return zeus(`/api/${machine}/conferences`, { method: "POST", body: JSON.stringify(b) });
    } },
  /* ── Zeus · creatives: the ads the customer reviews, numbered, with comments ── */
  { name: "zeus_creatives", description: "The Creatives section of a machine: every batch (one per language, one per target for ABM) with its counters — cards, validated, to redo, open comments; with a batch id, that batch's cards in order (number, title, direction, format, status, comments) as prose.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, batch: { type: "string", description: "a batch id or its key (<customer>/<lang>) for the cards" } } },
    run: async ({ machine, batch }) => {
      const o = await zeus(`/api/${machine}/creatives`);
      if (!batch) return o.batches.length ? o.batches.map((b) => `${b.key} [${b.kind}${b.target_name ? ` × ${b.target_name}` : ""}, ${b.language}] — ${b.status}: ${b.creatives} cards, ${b.validated} validated, ${b.redo} to redo, ${b.dropped} dropped, ${b.open_comments} open comment(s)${b.last_comment_at ? `, last ${String(b.last_comment_at).slice(0, 10)}` : ""} — id ${b.id}`).join("\n") : "No batch on this machine yet.";
      const b = o.batches.find((x) => x.id === batch || x.key === batch); if (!b) throw new Error(`No batch "${batch}" — ${o.batches.map((x) => x.key).join(", ") || "none"}.`);
      const d = await zeus(`/api/${machine}/creatives/batches/${b.id}`);
      return [`${b.key} — ${d.status}, ${d.creatives} cards${b.note ? ` — ${b.note}` : ""}`, ...d.creatives.map((c) => `#${c.position} ${c.key} · ${c.direction ?? "?"} · ${c.format ?? "?"} · "${c.copy?.title ?? ""}" — ${c.status}${c.decided_by ? ` by ${c.decided_by}` : ""}${c.open_comments ? ` · ${c.open_comments} open comment(s)` : c.comments ? ` · ${c.comments} comment(s)` : ""}${c.diffusion ? ` · before it runs: ${c.diffusion}` : ""} — id ${c.id}`)].join("\n");
    } },
  { name: "zeus_creative_comments", description: "Every comment of a batch (open by default), grouped by card: kind (note, change, problem, validation), author, the quoted line, the proposed wording, and where on the ad it was pinned — what the skill must act on before re-running the flagged cards.",
    schema: { type: "object", required: ["machine", "batch"], properties: { machine: { type: "string" }, batch: { type: "string", description: "batch id or key" }, all: { type: "boolean", description: "include resolved threads" } } },
    run: async ({ machine, batch, all }) => {
      const o = await zeus(`/api/${machine}/creatives`);
      const b = o.batches.find((x) => x.id === batch || x.key === batch); if (!b) throw new Error(`No batch "${batch}".`);
      const d = await zeus(`/api/${machine}/creatives/batches/${b.id}`);
      const out = [];
      for (const c of d.creatives) {
        if (!c.comments) continue;
        const ks = (await zeus(`/api/${machine}/creatives/${c.id}/comments`)).filter((k) => all || k.status === "open");
        if (!ks.length) continue;
        out.push(`#${c.position} ${c.key} (${c.status}) — id ${c.id}`);
        for (const k of ks) out.push(`  [${k.kind}${k.status === "resolved" ? ", resolved" : ""}] ${k.author} ${String(k.created_at).slice(0, 10)}: ${k.body}${k.quoted ? ` — about "${k.quoted}"` : ""}${k.proposal ? ` — proposes "${k.proposal}"` : ""} (comment ${k.id})`);
      }
      return out.length ? out.join("\n") : `No ${all ? "" : "open "}comment on ${b.key}.`;
    } },
  { name: "zeus_creative_decide", description: "Decide one card: validated, redo, dropped, or back to review. The batch's status follows its cards. Staff or someone allowed to act on the machine.",
    schema: { type: "object", required: ["machine", "creative_id", "status"], properties: { machine: { type: "string" }, creative_id: { type: "string" }, status: { type: "string", enum: ["validated", "redo", "dropped", "review"] } } },
    run: async ({ machine, creative_id, status }) => { const r = await zeus(`/api/${machine}/creatives/${creative_id}/decide`, { method: "POST", body: JSON.stringify({ status }) }); return `#${r.position} ${r.key} → ${r.status}; batch now ${r.batch_status}.`; } },
  { name: "zeus_creative_comment", description: "Write a comment on one card as the signed-in person (kind note | change | problem | validation; optional quoted line and proposal), or resolve/reopen a thread with comment_id + status. `anchor` {x, y} as fractions of the image (0-1 from the top left) pins the comment to a spot on the ad, which is how a person points at a clipped logo instead of describing it; the app numbers the pins in the order they were left.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, creative_id: { type: "string" }, kind: { type: "string", enum: ["note", "change", "problem", "validation"] }, body: { type: "string" }, quoted: { type: "string" }, proposal: { type: "string" }, anchor: { type: "object", description: "{x, y} fractions of the image, 0 to 1 from the top left", properties: { x: { type: "number" }, y: { type: "number" } } }, comment_id: { type: "number" }, status: { type: "string", enum: ["open", "resolved"] } } },
    run: async ({ machine, creative_id, kind, body, quoted, proposal, anchor, comment_id, status }) => {
      if (comment_id) { const r = await zeus(`/api/${machine}/creatives/comments/${comment_id}/status`, { method: "POST", body: JSON.stringify({ status: status || "resolved" }) }); return `comment ${r.id} ${r.status}.`; }
      if (!creative_id || !body) throw new Error("creative_id and body, or comment_id and status.");
      const r = await zeus(`/api/${machine}/creatives/${creative_id}/comments`, { method: "POST", body: JSON.stringify({ kind: kind || "note", body, quoted, proposal, anchor: anchor ?? null }) });
      return `comment ${r.id} (${r.kind}) written${r.anchor ? `, pinned at ${Math.round(r.anchor.x * 100)}%/${Math.round(r.anchor.y * 100)}%` : ""}${r.decided ? "; the card is validated" : ""}.`;
    } },
  { name: "zeus_register_creatives", description: "Register (or re-register) a batch of creatives in a machine's Creatives section after the files were delivered to the mission in Dispatch — what skills/zeus-creas/scripts/deliver.mjs does; here for a session that has the storage paths. batch {key <customer>/<lang> or <customer>/<target>/<lang>, kind emitter|abm, language, target_name, formats, note, brief, paid_plan_key — the key of the paid plan this batch belongs to, which makes it appear in the machine's Paid section beside the budget that buys it}; creatives [{position, key, file_path (mission-files storage path), file_name, width, height, format, direction, hook, copy, prompt, model, cost_cents, qa, diffusion}]. Idempotent on key and position; a changed file puts the card back to review, its thread kept.",
    schema: { type: "object", required: ["machine", "batch", "creatives"], properties: { machine: { type: "string" }, batch: { type: "object" }, creatives: { type: "array", items: { type: "object" } } } },
    run: async ({ machine, batch, creatives }) => { const b = await zeus(`/api/${machine}/creatives/batches`, { method: "POST", body: JSON.stringify({ batch, creatives }) }); return `${b.key}: ${b.creatives} cards, status ${b.status} — id ${b.id}`; } },
  { name: "zeus_functions", description: "What every function in a machine does, read out of the database itself so it cannot drift from what is really installed. Grouped into areas a person can read: who we go after, the people, what the machine hears, what it sends, the guards, the market, the canvas, the work we deliver, the CRM. Pass an area to read one, a search to find one by name or by what it does, or all to include the plumbing. A function with no written sentence shows up marked as such, which is the point.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, area: { type: "string" }, search: { type: "string" }, all: { type: "boolean", description: "include the plumbing nobody needs to read" } } },
    run: async ({ machine, area, search, all }) => {
      const o = await zeus(`/api/${machine}/functions${all ? "?all=1" : ""}`);
      const h = o.health ?? {};
      let rows = o.rows ?? [];
      if (area) rows = rows.filter((r) => r.area.toLowerCase().includes(String(area).toLowerCase()));
      if (search) { const t = String(search).toLowerCase(); rows = rows.filter((r) => r.name.toLowerCase().includes(t) || (r.does ?? "").toLowerCase().includes(t)); }
      const head = `${h.functions} functions installed, ${h.written} explained, ${h.checked} confirmed against the code${h.missing ? `, ${h.missing} with no sentence yet` : ""}.`;
      if (!rows.length) return `${head}\n\nNothing matches.`;
      const by = new Map();
      for (const r of rows) (by.get(r.area) ?? by.set(r.area, []).get(r.area)).push(r);
      const out = [head, ""];
      for (const [a, xs] of by) {
        out.push(`## ${a} (${xs.length})`);
        for (const r of xs) {
          out.push(`- ${r.name} — ${r.does}${r.checked ? " [confirmed]" : ""}`);
          if (r.guards) out.push(`    guard: ${r.guards}`);
        }
        out.push("");
      }
      return out.join("\n");
    } },
  { name: "zeus_crm", description: "The copy of the customer's own CRM held inside Zeus: when it was taken, what it holds, what is missing from it, and every change we could make to it with the evidence behind it. Nothing here writes to their CRM. A unit count is only ever offered as a correction when the company states that number about itself; a number we reached by counting what a website lists is raised as a question instead.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, repairs: { type: "boolean", description: "list the proposed changes rather than the summary" }, confidence: { type: "string", description: "evidenced | ask a person | worth a look" } } },
    run: async ({ machine, repairs, confidence }) => {
      const o = await zeus(`/api/${machine}/crm`);
      const v = o.overview ?? {};
      if (repairs || confidence) {
        let rs = o.repairs ?? [];
        if (confidence) rs = rs.filter((r) => r.confidence === confidence);
        if (!rs.length) return "Nothing of that kind.";
        return rs.map((r) => `${r.company} — ${r.field}: the CRM says ${r.crm_says}, we hold ${r.zeus_says}\n    ${r.evidence} [${r.confidence}]`).join("\n");
      }
      const out = [
        `Copied ${v.pulled_at ? new Date(v.pulled_at).toISOString().slice(0, 16).replace("T", " ") : "not yet"}: ${(v.records ?? 0).toLocaleString()} records across ${v.objects} kinds.`,
        `${v.companies} companies and ${v.people} people; ${v.matched} of those companies we already hold ourselves.`,
        `${v.repairs} things to put right: ${v.evidenced} we can evidence, ${v.questions} need a person to settle.`,
        "",
        "What is missing:",
        ...(o.gaps ?? []).map((g) => `- ${g.gap}: ${g.companies} (${g.share}%) — ${g.costs}`),
        "",
        "What the copy contains:",
        ...(o.objects ?? []).map((x) => `- ${x.object}: ${Number(x.rows).toLocaleString()} records, ${x.fields} fields`),
      ];
      return out.join("\n");
    } },
  { name: "zeus_crm_clean", description: "The table we work on, built from the raw copy of the customer's CRM. Shows how many companies are complete, what each field gained over the raw copy, where each value came from, and what is still wrong. action refresh rebuilds it from the raw copy, dry shows what a rebuild would change without touching anything, and edit records a correction a person decided, which is held apart and put back on top of every later rebuild so it is never quietly undone.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" },
      action: { type: "string", description: "board (default) | dry | refresh | edit" },
      crm_id: { type: "string", description: "edit: the record in their CRM" },
      field: { type: "string", description: "edit: name, domain, country, city, units, email, phone, linkedin, icp or pms" },
      value: { type: "string", description: "edit: what it should say" },
      why: { type: "string", description: "edit: where that came from" } } },
    run: async ({ machine, action, crm_id, field, value, why }) => {
      const a = action || "board";
      if (a === "edit") {
        if (!crm_id || !field) return "an edit needs a record and a field.";
        const r = await zeus(`/api/${machine}/crm/edit`, { method: "POST", body: JSON.stringify({ crm_id, field, value, why }) });
        return `${r.field} on ${r.crm_id} is now "${r.value ?? "empty"}", set by hand. It will survive every rebuild from here.`;
      }
      if (a === "dry" || a === "refresh") {
        const r = await zeus(`/api/${machine}/crm/refresh`, { method: "POST", body: JSON.stringify({ dry: a === "dry" }) });
        if (r.error) return r.error;
        return a === "dry"
          ? `Nothing was touched. A rebuild would add ${r.new_rows} row(s) and change ${r.fields_changed} field(s) across ${r.companies} companies.`
          : `Rebuilt: ${r.new_rows} new row(s), ${r.fields_changed} field(s) changed, ${r.hand_edits_kept} hand edit(s) kept, ${r.companies_with_an_issue} companies still carrying an issue.`;
      }
      const o = await zeus(`/api/${machine}/crm`);
      const c = o.clean;
      if (!c) return "this machine holds no clean table yet.";
      const out = [
        `${c.companies} companies and ${c.people} people in the table we work on. ${c.flagged} still carry an issue, ${c.hand_edits} value(s) were set by hand.`,
        c.last_run ? `Last rebuilt ${new Date(c.last_run.at).toISOString().slice(0, 16).replace("T", " ")} by ${c.last_run.by ?? "someone"}: ${c.last_run.new_rows} new, ${c.last_run.fields_changed} changed.` : "Never rebuilt.",
        "",
        "What the rebuild adds, raw to clean:",
        ...(c.gained ?? []).map((g) => `- ${g.field}: ${g.raw} to ${g.clean}${g.clean > g.raw ? ` (+${g.clean - g.raw})` : ""}`),
        "",
        "What is still wrong:",
        ...(c.issues ?? []).map((i) => `- ${i.issue}: ${i.companies}`),
        "",
        "Where the values come from:",
        ...(c.sources ?? []).map((x) => `- ${x.field} from ${x.source}: ${x.companies}`),
      ];
      return out.join("\n");
    } },
  { name: "zeus_replies", description: "Everyone who answered a Trellis-style outbound campaign, in their own words: what they wrote, when, whether anyone came back to them, and what the reply looks like (asked to talk, left a number, asked something, about the price, later, no, already solved, selling to us). Defaults to the ones still waiting, longest wait first. This is where a missed meeting hides: a person who said yes to a call and never got an answer sits here, not in the counters.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, all: { type: "boolean", description: "include the ones already answered or cleared" }, kind: { type: "string", description: "only this kind" }, thread: { type: "string", description: "a name or company: print the whole exchange with that person" } } },
    run: async ({ machine, all, kind, thread }) => {
      const o = await zeus(`/api/${machine}/replies`);
      const v = o.overview ?? {};
      const rows = (o.rows ?? []).filter((r) => (all || r.waiting) && (!kind || r.kind === kind));
      const who = (r) => `${r.who ?? "someone"}${r.company && r.company !== r.who ? ` (${r.company})` : ""}`;
      const ago = (n) => (n === 0 ? "today" : n === 1 ? "yesterday" : n < 31 ? `${n} days` : `${Math.round(n / 30)} months`);
      if (thread) {
        const t = String(thread).toLowerCase();
        const r = (o.rows ?? []).find((x) => `${x.who ?? ""} ${x.company ?? ""}`.toLowerCase().includes(t));
        if (!r) return `Nobody matching "${thread}" has replied.`;
        const out = [`${who(r)} — ${r.channel}, ${r.campaign ?? "no campaign"}${r.waiting ? `, WAITING ${ago(r.days_waiting)}` : r.handled_at ? ", handled" : ", answered"}`, ""];
        for (const m of r.thread ?? []) out.push(`${String(m.at).slice(0, 10)} ${m.mine ? "us " : "THEM"}: ${m.text ? m.text.replace(/\s+/g, " ") : `(${m.type}, no text kept)`}`);
        return out.join("\n");
      }
      const rank = { "wants to talk": 0, "gave a number": 1, "a question": 2, price: 3, "said something": 4, "not now": 5, "read it in the inbox": 6, "already solved": 7, no: 8, "selling to us": 9 };
      rows.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || b.days_waiting - a.days_waiting);
      const head = `${v.waiting ?? 0} waiting of ${v.people ?? 0} people who answered (${v.replies ?? 0} replies since ${String(v.since ?? "").slice(0, 10)}) · ${v.wants_to_talk ?? 0} asked to talk or left a number · longest wait ${v.oldest_waiting ?? 0} days`;
      if (!rows.length) return `${head}\n\nNothing waiting.`;
      return [head, "", ...rows.slice(0, 60).map((r) => `[${r.kind}] ${who(r)} · ${r.channel}${r.campaign ? ` · ${r.campaign}` : ""} · ${r.waiting ? `waiting ${ago(r.days_waiting)}` : "answered"}\n    ${(r.last_text ?? "(email body not in Zeus, read it in the inbox)").replace(/\s+/g, " ").slice(0, 240)}`)].join("\n");
    } },
  { name: "zeus_approach", description: "How to get into an account: who matters, how they connect, and the order to reach them. An account is entered from the OUTSIDE IN and each ring is a month — connections and operators first, champions next, the decision last and never cold. With no account, every map with its honest coverage: how many of the names are relationships actually held versus names research merely identified. With an account, the situation first (blockers, who is going cold, moves waiting, intel freshness), then the NEXT MOVES ranked by date with their channel and hook, then what the map says, the hook and the story, then the map ring by ring: each person with their power (1-5), disposition (champion, warm, neutral, blocker, unknown), temperature (hot under 14 days since contact, warm under 45, cooling beyond, cold never), provenance, why they matter, the evidence, their next move, and the dated intel about them.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, account: { type: "string", description: "an approach id, or part of the account name" } } },
    run: async ({ machine, account }) => {
      const o = await zeus(`/api/${machine}/approach`);
      if (!account) return o.plans.length
        ? o.plans.map((p) => `${p.account} [${p.status}${p.hottest ? `, ${p.hottest}` : ""}]${p.money_cents != null ? ` — worth $${Math.round(p.money_cents / 100).toLocaleString()}/yr${p.units ? ` (${p.units} units)` : ""}` : ""} — ${p.nodes} people, ${p.held} held / ${p.identified} identified / ${p.bridges} bridge(s), ${p.reached} reached · ${p.blockers} blocker(s), ${p.cooling} going cold, ${p.moves} move(s) waiting${p.next_by ? ` (first due ${String(p.next_by).slice(0, 10)})` : ""}, ${p.intel} intel${p.last_intel ? ` (freshest ${String(p.last_intel).slice(0, 10)})` : ""} · https://zeus.bltz46.com/#/${machine}/Approach/${p.id}${p.door ? ` · door: ${p.door}` : ""}${p.decision ? ` · decision: ${p.decision}` : ""}${p.verified_on ? ` · checked ${p.verified_on}` : " · never checked"} — id ${p.id}`).join("\n")
        : "No account mapped yet on this machine.";
      const p0 = o.plans.find((x) => x.id === account) ?? o.plans.find((x) => String(x.account).toLowerCase().includes(String(account).toLowerCase()));
      if (!p0) throw new Error(`No approach for "${account}" — ${o.plans.map((x) => x.account).join(", ") || "none"}.`);
      const d = await zeus(`/api/${machine}/approach/${p0.id}`);
      const rings = Object.fromEntries((d.rings ?? []).map((r) => [r.ring, r]));
      const byId = Object.fromEntries((d.nodes ?? []).map((n) => [n.id, n.name]));
      const out = [`${d.plan.account} — approach${d.plan.verified_on ? `, people checked ${d.plan.verified_on}` : ", NEVER CHECKED: treat every role as unverified"}`];
      if (d.plan.doctrine) out.push("", d.plan.doctrine);
      if (d.plan.money_cents != null) out.push(`WORTH: $${Math.round(d.plan.money_cents / 100).toLocaleString()} a year${d.plan.money_label ? ` (${d.plan.money_label})` : ""}`);
      if (d.plan.window_note) out.push(`WHY NOW: ${d.plan.window_note}`);
      if (d.plan.narrative) out.push("", `WHAT THE MAP SAYS: ${d.plan.narrative}`);
      if (d.plan.hook) out.push(`THE HOOK: ${d.plan.hook}`);
      if ((d.plan.story ?? []).length) { out.push("", "THE STORY"); (d.plan.story ?? []).forEach((s, i) => out.push(`  ${i + 1}. ${s.title} — ${s.text}`)); }
      out.push("", `SITUATION: ${d.plan.blockers} blocker(s), ${d.plan.cooling} going cold, ${d.plan.moves} move(s) waiting, ${d.plan.intel} intel item(s)${d.plan.last_intel ? ` (freshest ${String(d.plan.last_intel).slice(0, 10)})` : ""}.`);
      out.push(`COVERAGE: ${d.plan.held} held in the CRM, ${d.plan.identified} identified in research only, ${d.plan.bridges} bridge(s). ${d.plan.reached} of ${d.plan.nodes} actually spoken to.`);
      const intelOf = (id) => (d.intel ?? []).filter((i) => i.node_id === id);
      const moves = (d.nodes ?? []).filter((n) => n.next_action).sort((a, b) => String(a.next_by ?? "9999").localeCompare(String(b.next_by ?? "9999")) || b.power - a.power);
      if (moves.length) {
        out.push("", "NEXT MOVES");
        moves.forEach((n, i) => {
          const hook = intelOf(n.id).find((x) => x.usable);
          out.push(`  ${i + 1}. ${n.is_door ? "★ " : ""}${n.name} (power ${n.power}, ${n.disposition})${n.next_channel ? ` · ${n.next_channel}` : ""}${n.next_by ? ` · by ${String(n.next_by).slice(0, 10)}` : ""} — ${n.next_action}${hook ? `\n      hook: ${hook.headline}` : ""}`);
        });
      } else out.push("", "NEXT MOVES: none set. A map without a next action is a picture.");
      const acct = (d.intel ?? []).filter((i) => !i.node_id);
      if (acct.length) { out.push("", "ABOUT THE ACCOUNT"); for (const i of acct) out.push(`  ${String(i.on_date).slice(0, 10)} · ${i.kind}: ${i.headline}${i.usable ? "" : " [not for use]"}${i.source ? ` (${i.source})` : ""}`); }
      // outermost first, because that is the order the account is worked
      for (const ring of [...new Set((d.nodes ?? []).map((n) => n.ring))].sort((a, b) => b - a)) {
        const r = rings[ring] ?? {};
        out.push("", `${String(r.label ?? `ring ${ring}`).toUpperCase()}${r.month != null ? ` · MONTH ${r.month}` : ""}`);
        if (r.intent) out.push(`  ${r.intent}`);
        if (r.rule) out.push(`  RULE: ${r.rule}`);
        for (const n of (d.nodes ?? []).filter((x) => x.ring === ring).sort((a, b) => a.position - b.position)) {
          const edges = (d.edges ?? []).filter((e) => e.from_node === n.id || e.to_node === n.id)
            .map((e) => `${e.kind.replace(/_/g, " ")} ${byId[e.from_node === n.id ? e.to_node : e.from_node]} (${e.strength})`);
          const temp = n.temperature === "cold" ? "never contacted" : `${n.temperature}, ${n.days_since}d since contact`;
          const lossBits = n.role === "loss" ? `${n.amount_cents != null ? `, $${Math.round(n.amount_cents / 100).toLocaleString()}` : ""}${n.on_date ? `, ${String(n.on_date).slice(0, 10)}` : ""}` : "";
          out.push(`  ${n.is_door ? "★ " : ""}${n.name}${n.title ? ` — ${n.title}` : ""} [${n.role}${lossBits}, power ${n.power}, ${n.disposition}, ${temp}, ${n.provenance}${n.reached_at ? `, reached ${String(n.reached_at).slice(0, 10)}` : ""}] — id ${n.id}`);
          if (n.why) out.push(`      ${n.why}`);
          if (n.evidence) out.push(`      evidence: ${n.evidence}`);
          if (n.next_action) out.push(`      next: ${n.next_action}${n.next_channel ? ` (${n.next_channel}` : ""}${n.next_by ? `${n.next_channel ? ", " : "("}by ${String(n.next_by).slice(0, 10)})` : n.next_channel ? ")" : ""}`);
          for (const i of intelOf(n.id)) out.push(`      intel ${String(i.on_date).slice(0, 10)} · ${i.kind}: ${i.headline}${i.usable ? "" : " [not for use]"}`);
          if (edges.length) out.push(`      connects: ${edges.join("; ")}`);
        }
      }
      return out.join("\n");
    } },
  { name: "zeus_approach_reached", description: "Mark that someone on an approach map has actually been spoken to, or undo it. This is the write that turns a plan into a record of what happened, so only record it when a real conversation took place.",
    schema: { type: "object", required: ["machine", "node_id"], properties: { machine: { type: "string" }, node_id: { type: "string" }, on: { type: ["string", "null"], description: "the date, or null to undo" } } },
    run: async ({ machine, node_id, on }) => {
      const r = await zeus(`/api/${machine}/approach/nodes/${node_id}/reached`, { method: "POST", body: JSON.stringify({ on }) });
      return `${r.name}: ${r.reached_at ? `reached ${r.reached_at}` : "back to not reached"}.`;
    } },
  { name: "zeus_approach_touch", description: "Record a contact with someone on an approach map: a call, a reply, a conversation at a booth. Sets their last contact date (the clock that drives hot, warm, cooling) and marks them reached if they were not yet. Only for a real exchange, never for an email sent into silence.",
    schema: { type: "object", required: ["machine", "node_id"], properties: { machine: { type: "string" }, node_id: { type: "string" }, on: { type: "string", description: "the date of the contact, default today" } } },
    run: async ({ machine, node_id, on }) => {
      const r = await zeus(`/api/${machine}/approach/nodes/${node_id}/touch`, { method: "POST", body: JSON.stringify({ on: on ?? new Date().toISOString().slice(0, 10) }) });
      return `${r.name}: last contact ${String(r.last_touch_at).slice(0, 10)}, reached since ${String(r.reached_at).slice(0, 10)}.`;
    } },
  { name: "zeus_brief", description: "The creative brief of a machine: what gets made, why that and not something else, and how we will know. With no brief, every brief with its counters. With a key or id, the whole thing — the test equation, the four fields that decide whether the result can be read at all (the readability floor, the kill rule, the scale rule, the plumbing check), the dated stages with their blockers, the messages being compared, the formats that carry them with their levers and specs, the full grid of masters with the words on each one, the non-negotiables, and the open comment threads. Read this before producing any creative for that machine: the grid is the production list and the rules are checked at QA.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, brief: { type: "string", description: "a brief id or its key, e.g. meta-2026-q4-en" }, grid: { type: "boolean", description: "include every cell's words and picture (30+ rows); default true when a brief is named" }, body: { type: "boolean", description: "include the argument in full" } } },
    run: async ({ machine, brief, grid, body }) => {
      const o = await zeus(`/api/${machine}/briefs`);
      const money = (c, ccy) => c == null ? "—" : `${(Number(c) / 100).toLocaleString(undefined, { style: "currency", currency: ccy || "EUR", maximumFractionDigits: 0 })}`;
      if (!brief) return o.briefs.length
        ? o.briefs.map((b) => `${b.key} — ${b.title} [${b.channel}, ${b.status}] ${b.props}×${b.formats} = ${b.cells} ads${b.cells_blocked ? `, ${b.cells_blocked} blocked` : ""}${b.cells_made ? `, ${b.cells_made} made` : ""} · ${money(b.budget_cents, b.currency)}/month${b.go_on ? `, go ${b.go_on}` : ""} · stages ${b.stages_done}/${b.stages}${b.open_comments ? ` · ${b.open_comments} open comment(s)` : ""} — id ${b.id}`).join("\n")
        : "No creative brief on this machine yet. skills/zeus-ctvp/scripts/deliverbrief.mjs registers one.";
      const b0 = o.briefs.find((x) => x.id === brief || x.key === brief);
      if (!b0) throw new Error(`No brief "${brief}" — ${o.briefs.map((x) => x.key).join(", ") || "none"}.`);
      const d = await zeus(`/api/${machine}/briefs/${b0.id}`);
      const f = d.fields ?? {};
      const out = [`${d.brief.title} [${d.brief.channel}, ${d.brief.status}, ${d.brief.version}]${d.brief.geo ? ` — ${d.brief.geo}` : ""}`];
      if (d.brief.thesis) out.push("", d.brief.thesis);
      if (f.test_equation) out.push("", `THE TEST EQUATION: ${f.test_equation}`);
      for (const [k, v] of [["Can it be read", f.readable_floor], ["Kill a variant", f.kill_rule], ["Scale a variant", f.scale_rule], ["Before a euro is spent", f.plumbing], ["Verdict on", f.verdict_on], ["If everything is flat", f.dry_well]])
        if (v) out.push(`  ${k}: ${v}`);
      if (d.stages?.length) { out.push("", "STAGES"); for (const s of d.stages) out.push(`  ${s.done_at ? "[x]" : "[ ]"} ${s.label}${s.on_date ? ` (${s.on_date})` : ""}${s.owner !== "bltz" ? ` · ${s.owner === "client" ? "theirs" : "both"}` : ""}: ${s.what}${s.blocker ? `  BLOCKED BY: ${s.blocker}` : ""}`); }
      if (d.rules?.length) { out.push("", "NON-NEGOTIABLE, checked at QA"); for (const r of d.rules) out.push(`  ${r.kind === "required" ? "MUST" : "NEVER"}: ${r.rule}${r.reason ? ` — ${r.reason}` : ""}`); }
      if (d.props?.length) { out.push("", "THE MESSAGES"); for (const p of d.props) out.push(`  ${p.code} · ${p.label}${p.pain ? `\n      pain: ${p.pain}` : ""}${p.promise ? `\n      promise: ${p.promise}` : ""}${p.cta ? `\n      cta: ${p.cta}` : ""}${p.market ? `\n      market: ${p.market}` : ""}`); }
      if (d.formats?.length) { out.push("", "THE FORMATS"); for (const x of d.formats) out.push(`  ${x.code} · ${x.name} — lever: ${x.lever}${x.control ? " (CONTROL GROUP)" : ""}${x.why ? `\n      why: ${x.why}` : ""}${x.visual_spec ? `\n      visual: ${String(x.visual_spec).replace(/\n/g, " ")}` : ""}${x.copy_rules ? `\n      copy: ${String(x.copy_rules).replace(/\n/g, " ")}` : ""}`); }
      if (grid !== false && d.cells?.length) {
        const fc = Object.fromEntries((d.formats ?? []).map((x) => [x.id, x.code]));
        const pc = Object.fromEntries((d.props ?? []).map((x) => [x.id, x.code]));
        out.push("", `THE GRID — ${d.cells.length} masters, ${d.cells.filter((c) => c.blocked_by).length} blocked`);
        for (const c of d.cells.sort((a, b) => `${fc[a.format_id]}${pc[a.prop_id]}`.localeCompare(`${fc[b.format_id]}${pc[b.prop_id]}`)))
          out.push(`  ${fc[c.format_id]}.${pc[c.prop_id]}${c.blocked_by ? " [BLOCKED: " + c.blocked_by + "]" : c.creative_id ? " [made]" : ""}\n      on screen: ${String(c.on_screen ?? "").replace(/\n/g, " / ")}\n      picture: ${c.visual ?? "—"}`);
      }
      const open = (d.comments ?? []).filter((c) => !c.parent_id && c.status === "open");
      if (open.length) { out.push("", `OPEN COMMENTS (${open.length}) — act on these before producing`); for (const c of open) out.push(`  [${c.id}] ${c.section ? c.section + " · " : ""}${c.author}${c.quote ? ` — about "${String(c.quote).slice(0, 90)}"` : c.cell_id ? " — on one master" : ""}\n        ${c.body}`); }
      if (body && f.body) out.push("", "THE ARGUMENT", f.body);
      return out.join("\n");
    } },
  { name: "zeus_brief_comment", description: "Comment on a passage of a creative brief, on one master in the grid (cell_id), reply to a thread, or resolve one. A thread needs either the passage it quotes, verbatim, or the cell it is about. Resolve only after the thing it points at has actually changed.",
    schema: { type: "object", required: ["machine", "brief"], properties: { machine: { type: "string" }, brief: { type: "string" }, body: { type: "string" }, quote: { type: "string" }, section: { type: "string" }, cell_id: { type: "string" }, parent_id: { type: "number" }, comment_id: { type: "number" }, status: { type: "string", enum: ["open", "resolved"] } } },
    run: async ({ machine, brief, body, quote, section, cell_id, parent_id, comment_id, status }) => {
      const o = await zeus(`/api/${machine}/briefs`);
      const b0 = o.briefs.find((x) => x.id === brief || x.key === brief);
      if (!b0) throw new Error(`No brief "${brief}".`);
      if (comment_id) { const r = await zeus(`/api/${machine}/briefs/comments/${comment_id}/status`, { method: "POST", body: JSON.stringify({ status: status || "resolved" }) }); return `comment ${r.id} ${r.status}.`; }
      if (!body) throw new Error("body, plus quote or cell_id (a new thread) or parent_id (a reply).");
      const r = await zeus(`/api/${machine}/briefs/${b0.id}/comments`, { method: "POST", body: JSON.stringify({ body, quote, section, cell_id, parent_id }) });
      return `comment ${r.id} written on ${b0.key}.`;
    } },
  { name: "zeus_brief_status", description: "Move a creative brief: draft, review, validated, in_production, shipped. Validated is the customer's sign-off and their exec may do it when the preset allows (briefs.client_validates, default off).",
    schema: { type: "object", required: ["machine", "brief", "status"], properties: { machine: { type: "string" }, brief: { type: "string" }, status: { type: "string", enum: ["draft", "review", "validated", "in_production", "shipped"] } } },
    run: async ({ machine, brief, status }) => {
      const o = await zeus(`/api/${machine}/briefs`);
      const b0 = o.briefs.find((x) => x.id === brief || x.key === brief);
      if (!b0) throw new Error(`No brief "${brief}".`);
      const r = await zeus(`/api/${machine}/briefs/${b0.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      return `${b0.key} is now ${r.status}.`;
    } },
  { name: "zeus_brief_unblock", description: "Clear or set what a master in the grid is waiting for. Pass blocked_by null once the missing thing arrives (a cleared number, a customer quote in writing), or a reason to block it. Also edits the words or the picture of one cell.",
    schema: { type: "object", required: ["machine", "cell_id"], properties: { machine: { type: "string" }, cell_id: { type: "string" }, blocked_by: { type: ["string", "null"] }, on_screen: { type: "string" }, visual: { type: "string" } } },
    run: async ({ machine, cell_id, blocked_by, on_screen, visual }) => {
      const payload = { on_screen, visual };
      if (blocked_by !== undefined) payload.blocked_by = blocked_by;
      const r = await zeus(`/api/${machine}/briefs/cells/${cell_id}`, { method: "POST", body: JSON.stringify(payload) });
      return `cell ${r.id}${r.blocked_by ? ` still blocked: ${r.blocked_by}` : " is free to produce"}.`;
    } },
  { name: "zeus_paid", description: "The Paid section of a machine: the advertising plans the customer reads and signs off. With no plan, every plan with its monthly budget, period, how much of the roadmap is done and what comments are open. With a plan key or id, the whole thing: the argument, the budget split market by market with the reasoning on each line, the roadmap with its dates and who owns each stage, and the open comment threads with the passage each one quotes. Read this before revising a paid plan: the threads are the customer's own words about what is wrong with it.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, plan: { type: "string", description: "a plan id or its key, e.g. meta-2026-q4" }, body: { type: "boolean", description: "include the full markdown of the plan" } } },
    run: async ({ machine, plan, body }) => {
      const o = await zeus(`/api/${machine}/paid`);
      const money = (c, ccy) => c == null ? "—" : `${(Number(c) / 100).toLocaleString(undefined, { style: "currency", currency: ccy || "USD", maximumFractionDigits: 0 })}`;
      if (!plan) return o.plans.length
        ? o.plans.map((p) => `${p.key} — ${p.title} [${p.channel}, ${p.status}] ${money(p.budget_cents || p.monthly_cents, p.currency)}/month across ${p.markets} market(s)${p.period_start ? `, ${p.period_start} to ${p.period_end}` : ""} · roadmap ${p.milestones_done}/${p.milestones}${p.open_comments ? ` · ${p.open_comments} open comment(s)` : ""} — id ${p.id}`).join("\n")
        : "No paid plan on this machine yet. skills/zeus-ctvp/scripts/deliverpaid.mjs registers one from the plan's markdown.";
      const p0 = o.plans.find((x) => x.id === plan || x.key === plan);
      if (!p0) throw new Error(`No plan "${plan}" — ${o.plans.map((x) => x.key).join(", ") || "none"}.`);
      const d = await zeus(`/api/${machine}/paid/${p0.id}`);
      const ccy = d.plan.currency;
      const out = [`${d.plan.title} [${d.plan.channel}, ${d.plan.status}] — ${money(d.plan.budget_cents || d.plan.monthly_cents, ccy)}/month${d.plan.period_start ? `, ${d.plan.period_start} to ${d.plan.period_end}` : ""}`];
      if (d.plan.summary) out.push("", d.plan.summary);
      if (d.budget?.length) {
        out.push("", "BUDGET, market by market");
        for (const b of d.budget) out.push(`  ${b.market}: ${money(b.monthly_cents, ccy)}/month` +
          `${Number(b.prospecting_cents) ? ` (prospecting ${money(b.prospecting_cents, ccy)}` : " ("}${Number(b.warm_cents) ? `, warm list ${money(b.warm_cents, ccy)}` : ""}${Number(b.other_cents) ? `, other ${money(b.other_cents, ccy)}` : ""})` +
          `${b.accounts_in_base != null ? ` · ${b.accounts_in_base} accounts in their base` : ""}${b.rationale ? ` — ${b.rationale}` : ""}`);
      }
      if (d.milestones?.length) {
        out.push("", "ROADMAP");
        for (const m of d.milestones) out.push(`  ${m.done_at ? "[x]" : "[ ]"} ${m.label}${m.starts_on ? ` (${m.starts_on}${m.ends_on && m.ends_on !== m.starts_on ? ` to ${m.ends_on}` : ""})` : " (no dates yet)"}${m.owner !== "bltz" ? ` · ${m.owner === "client" ? "theirs" : "both"}` : ""}: ${m.what}${m.outcome ? ` → ${m.outcome}` : ""}`);
      }
      if (d.creatives?.length) {
        out.push("", "THE ADS THIS BUDGET BUYS");
        for (const b of d.creatives) out.push(`  ${b.key} [${b.language}] — ${b.creatives} ad(s), ${b.validated} validated, ${b.in_review} waiting${b.open_comments ? `, ${b.open_comments} open comment(s)` : ""}`);
      }
      const open = (d.comments ?? []).filter((c) => !c.parent_id && c.status === "open");
      if (open.length) {
        out.push("", `OPEN COMMENTS (${open.length}) — the customer's own words, act on these before revising`);
        for (const c of open) {
          out.push(`  [${c.id}] ${c.section ? `${c.section} · ` : ""}${c.author} — about "${String(c.quote).slice(0, 110)}"`);
          out.push(`        ${c.body}`);
          for (const r of (d.comments ?? []).filter((x) => x.parent_id === c.id)) out.push(`        ↳ ${r.author}: ${r.body}`);
        }
      }
      if (body && d.body) out.push("", "THE PLAN", d.body);
      return out.join("\n");
    } },
  { name: "zeus_paid_comment", description: "Comment on a passage of a paid plan, reply to a thread, or resolve one. A thread must quote the passage it is about, copied verbatim from the plan, because the app re-finds that text to highlight it; a quote it cannot find shows as orphaned. Resolve only after the thing the thread points at has actually been changed.",
    schema: { type: "object", required: ["machine", "plan"], properties: { machine: { type: "string" }, plan: { type: "string", description: "plan id or key" }, body: { type: "string" }, quote: { type: "string", description: "the passage this is about, verbatim from the plan" }, section: { type: "string" }, parent_id: { type: "number", description: "reply into this thread" }, comment_id: { type: "number", description: "resolve or reopen this thread" }, status: { type: "string", enum: ["open", "resolved"] } } },
    run: async ({ machine, plan, body, quote, section, parent_id, comment_id, status }) => {
      const o = await zeus(`/api/${machine}/paid`);
      const p0 = o.plans.find((x) => x.id === plan || x.key === plan);
      if (!p0) throw new Error(`No plan "${plan}" — ${o.plans.map((x) => x.key).join(", ") || "none"}.`);
      if (comment_id) { const r = await zeus(`/api/${machine}/paid/comments/${comment_id}/status`, { method: "POST", body: JSON.stringify({ status: status || "resolved" }) }); return `comment ${r.id} ${r.status}${r.parent_id ? "" : " (its replies too)"}.`; }
      if (!body) throw new Error("body, plus either quote (a new thread) or parent_id (a reply).");
      const d = await zeus(`/api/${machine}/paid/${p0.id}`);
      const anchored = quote && d.body ? d.body.includes(String(quote).trim()) : null;
      const r = await zeus(`/api/${machine}/paid/${p0.id}/comments`, { method: "POST", body: JSON.stringify({ body, quote, section, parent_id }) });
      return `comment ${r.id} written on ${p0.key}${anchored === false ? " — warning: that passage is not in the plan verbatim, so the thread will read as orphaned" : ""}.`;
    } },
  { name: "zeus_paid_status", description: "Move a paid plan: draft, review, validated, running, stopped. Validated is the customer's sign-off on the budget, so their exec may do it when the preset allows (paid.client_validates, default off); everything else is staff.",
    schema: { type: "object", required: ["machine", "plan", "status"], properties: { machine: { type: "string" }, plan: { type: "string" }, status: { type: "string", enum: ["draft", "review", "validated", "running", "stopped"] } } },
    run: async ({ machine, plan, status }) => {
      const o = await zeus(`/api/${machine}/paid`);
      const p0 = o.plans.find((x) => x.id === plan || x.key === plan);
      if (!p0) throw new Error(`No plan "${plan}".`);
      const r = await zeus(`/api/${machine}/paid/${p0.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      return `${p0.key} is now ${r.status}.`;
    } },
  { name: "zeus_paid_milestone", description: "Tick a stage of a paid plan's roadmap as done, or untick it. Use the label or the id from zeus_paid.",
    schema: { type: "object", required: ["machine", "plan", "milestone"], properties: { machine: { type: "string" }, plan: { type: "string" }, milestone: { type: "string", description: "the stage's id or its label, e.g. \"Week 2\"" }, done: { type: "boolean", description: "false to untick" } } },
    run: async ({ machine, plan, milestone, done }) => {
      const o = await zeus(`/api/${machine}/paid`);
      const p0 = o.plans.find((x) => x.id === plan || x.key === plan);
      if (!p0) throw new Error(`No plan "${plan}".`);
      const d = await zeus(`/api/${machine}/paid/${p0.id}`);
      const m = (d.milestones ?? []).find((x) => x.id === milestone || x.label.toLowerCase() === String(milestone).toLowerCase());
      if (!m) throw new Error(`No stage "${milestone}" — ${(d.milestones ?? []).map((x) => x.label).join(", ") || "none"}.`);
      const r = await zeus(`/api/${machine}/paid/milestones/${m.id}/done`, { method: "POST", body: JSON.stringify({ done: done !== false }) });
      return `${r.label} ${r.done_at ? "done" : "back to not done"}.`;
    } },
  { name: "zeus_data", description: "The Data page: what the universe is made of, provenance, verification, files loaded.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/data`) },
  { name: "zeus_import", description: "Load rows into a machine: give the rows as objects and a mapping {header: {to: company|domain|country|city|person_name|title|linkedin_url|email|phone|skip|<column key>}}. Ask zeus_import_preview first for a suggested mapping.",
    schema: { type: "object", required: ["machine", "file", "rows", "mapping"], properties: { machine: { type: "string" }, file: { type: "string", description: "a name for the load" }, rows: { type: "array", items: { type: "object" } }, mapping: { type: "object" } } },
    run: async ({ machine, file, rows, mapping }) => {
      let out = null; const totals = { rows: 0, used: 0, dirt: 0, people: 0, drained: 0 };
      for (let i = 0; i < rows.length; i += 500) {
        out = await zeus(`/api/${machine}/imports`, { method: "POST", body: JSON.stringify({ file, rows: rows.slice(i, i + 500), mapping, done: i + 500 >= rows.length }) });
        for (const k of Object.keys(totals)) totals[k] += Number(out?.[k] ?? 0);
      }
      // the rows are in the door; resolving runs in short passes so no request outlives the proxy
      let pending = Number(out?.pending ?? 0), passes = 0;
      while (pending > 0 && passes++ < 400) {
        const r = await zeus(`/api/${machine}/imports/drain`, { method: "POST", body: JSON.stringify({ file }) });
        totals.drained += Number(r.drained ?? 0); pending = Number(r.pending ?? 0);
        if (r.error) return `${totals.used} rows loaded, ${totals.drained} resolved, then: ${r.error}. ${pending} still waiting; call zeus_import_drain to continue.`;
      }
      return `${totals.used} of ${totals.rows} rows became accounts or people (${totals.dirt} had neither a company nor a website), ${totals.people} carried a person, ${totals.drained} resolved${pending ? `, ${pending} still waiting` : ""}.`;
    } },
  { name: "zeus_import_drain", description: "Resolve rows that are waiting in the door of a machine (after an import that stopped early, or one loaded by a script). Runs short passes until nothing is pending; call it again if it reports rows still waiting.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" }, file: { type: "string", description: "the load to stamp once it is fully resolved" } } },
    run: async ({ machine, file }) => {
      let pending = 1, drained = 0, passes = 0, r = null;
      while (pending > 0 && passes++ < 400) { r = await zeus(`/api/${machine}/imports/drain`, { method: "POST", body: JSON.stringify({ file }) }); drained += Number(r.drained ?? 0); pending = Number(r.pending ?? 0); if (r.error) return `${drained} resolved, then: ${r.error}. ${pending} still waiting.`; }
      return `${drained} resolved, ${pending} waiting.`;
    } },
  { name: "zeus_import_preview", description: "A suggested mapping for a file's headers (remembered by shape).",
    schema: { type: "object", required: ["machine", "headers"], properties: { machine: { type: "string" }, headers: { type: "array", items: { type: "string" } } } },
    run: async ({ machine, headers }) => zeus(`/api/${machine}/imports/preview`, { method: "POST", body: JSON.stringify({ headers }) }) },
  { name: "zeus_columns", description: "The columns a machine's table is made of (built-in, from the preset, added by a person or an import).",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/columns`) },
  { name: "zeus_add_column", description: "Add a column to the machine's registry — typed (text, number, currency, date, url, email, checkbox, select, multiselect, person), or a FORMULA: type \"formula\" with expr (Excel-like, compiled on the server, e.g. IF(days_since(last_touch) > 30, \"cold\", \"warm\")) and options.kind account | person. A formula column shows on the hunting board, on People and on every table, filters and sorts like a fact; its value type becomes the column type. Try zeus_column_preview first. An enrichment column may carry options.run_if {expr} — \"only run if\" — so the machine buys an email or phone only where the condition holds.",
    schema: { type: "object", required: ["machine", "label", "type"], properties: { machine: { type: "string" }, label: { type: "string" }, key: { type: "string" }, type: { type: "string" }, expr: { type: "string", description: "for type formula" }, source: { type: "string", enum: ["person", "import", "enrichment", "formula"] }, options: { type: "object", description: "kind: account|person for a formula; provider, capability, run_if {expr} for an enrichment column" }, facet: { type: "boolean" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/columns`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_column_preview", description: "Try a registry formula on the machine's top five rows before adding it as a column: its type and the values. kind account (default) or person.",
    schema: { type: "object", required: ["machine", "expr"], properties: { machine: { type: "string" }, expr: { type: "string" }, kind: { type: "string", enum: ["account", "person"] } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/columns/formula/preview`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_set_run_if", description: "\"Only run if\" on an enrichment column: a condition on the account (e.g. \"score > 40 and size > 0\") below which the machine does not buy that capability for its people. Empty expr removes the condition. Clay's credit doctrine; Bltz pays the credits.",
    schema: { type: "object", required: ["machine", "key"], properties: { machine: { type: "string" }, key: { type: "string", description: "the enrichment column's key" }, expr: { type: "string" } } },
    run: async ({ machine, key, expr }) => zeus(`/api/${machine}/columns/${key}`, { method: "PATCH", body: JSON.stringify({ options: { run_if: expr && expr.trim() ? { expr } : null } }) }) },
  { name: "zeus_machine", description: "How the machine works: every door in, the six steps, the signals it listens to, the enrichers, the doors out — each with built / not built and what happened here.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/machine`) },
  { name: "zeus_status", description: "What the machine runs (service, sequences, CRM, modules) and whether each part is running.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/status`) },
  { name: "zeus_settings", description: "Machine settings: timezone, status, legs lit, what Dispatch says was sold.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/settings`) },
  { name: "zeus_set_leg", description: "Light or dim a module on a machine (staff).",
    schema: { type: "object", required: ["machine", "leg", "active"], properties: { machine: { type: "string" }, leg: { type: "string" }, active: { type: "boolean" } } },
    run: async ({ machine, leg, active }) => zeus(`/api/${machine}/settings/legs`, { method: "POST", body: JSON.stringify({ leg, active }) }) },
  { name: "zeus_access", description: "Who can ACT on a machine (enrich, exclude, launch, push, edit, promote). Everyone on the mission reads; acting is a switch per person, off by default. Staff only.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/access`) },
  { name: "zeus_set_access", description: "Turn acting on or off for a person on a machine (staff). Confirm the name first.",
    schema: { type: "object", required: ["machine", "profile_id", "can_act"], properties: { machine: { type: "string" }, profile_id: { type: "string" }, name: { type: "string" }, can_act: { type: "boolean" } } },
    run: async ({ machine, ...b }) => zeus(`/api/${machine}/access`, { method: "POST", body: JSON.stringify(b) }) },
  { name: "zeus_reindex", description: "Rebuild the read models and refresh every table from the truth (staff). The repair for a doubt.",
    schema: { type: "object", required: ["machine"], properties: { machine: { type: "string" } } },
    run: async ({ machine }) => zeus(`/api/${machine}/reindex`, { method: "POST", body: "{}" }) },
  { name: "zeus_ingest_webhook", description: "Push one event through the generic door (a demo request, a pricing-page visit, anything): company or person and what they did. Needs ZEUS_BOOTH_SECRET.",
    schema: { type: "object", required: ["machine", "signal_type"], properties: { machine: { type: "string" }, source: { type: "string", description: "webform | zapier | albacross | web | inbound" }, signal_type: { type: "string" }, company: { type: "string" }, domain: { type: "string" }, name: { type: "string" }, title: { type: "string" }, email: { type: "string" }, linkedin_url: { type: "string" }, phone: { type: "string" }, country: { type: "string" }, city: { type: "string" }, detail: { type: "object" } } },
    run: async ({ machine, ...b }) => zeusSecret(`/ingest/${machine}/webhook`, b) },
];

async function findMission(nameOrId) {
  const byId = /^[0-9a-f-]{36}$/i.test(nameOrId);
  const q = byId
    ? db.from("missions").select("id,name").eq("id", nameOrId)
    : db.from("missions").select("id,name").ilike("name", `%${nameOrId}%`);
  const rows = await run(q.limit(2));
  if (rows.length === 0) throw new Error(`no mission matching "${nameOrId}"`);
  // Ambiguity is reported rather than resolved by picking the first: silently
  // writing to the wrong mission is worse than an error.
  if (rows.length > 1) throw new Error(`"${nameOrId}" matches more than one mission — be specific`);
  return rows[0];
}

/** Returned on initialize, and read by the agent before any tool is called.
 *
 *  This is the highest-leverage text here. A tool list makes a bag of
 *  functions; this is what makes it behave. Most of what a person feels when
 *  using it lives in these lines rather than in any tool. */
// ── the protocol ──────────────────────────────────────────────────────────
//
// Four methods over newline-delimited JSON on stdio. Nothing but JSON-RPC may
// ever reach stdout: one stray console.log corrupts the stream and the client
// goes quiet with no error worth reading. Debug to stderr.

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const errReply = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

let signedIn = false;
async function ensureSession() {
  if (signedIn) return;
  const conf = loadConf();
  if (!conf?.access_token) throw new Error("Not logged in. Run `bltz login` in a terminal.");
  const { data } = await db.from("profiles").select("id,name,role").eq("id", conf.user_id).single();
  if (!data) throw new Error("Signed in, but no profile — ask Gab for access.");
  me = data;
  signedIn = true;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "bltz", version: "2.8.0" },
      instructions: INSTRUCTIONS,
    });
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, { tools: TOOLS.map((t) => ({
      name: t.name, description: t.description, inputSchema: t.schema })) });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return reply(id, fail(`unknown tool ${params?.name}`));
    try {
      await ensureSession();
      return reply(id, ok(await tool.run(params.arguments || {})));
    } catch (e) {
      return reply(id, fail(e.message));
    }
  }
  if (id !== undefined) errReply(id, -32601, `Method not found: ${method}`);
}

// Chunks split mid-message, so lines must be accumulated rather than parsed
// as they arrive.
let buf = "";
process.stdin.setEncoding("utf8");
/** `node mcp-server.js login [email]` — sign in without the bltz CLI.
 *
 *  Karim, 21/09/2026, on Codex: `codex mcp add` worked, then `bltz login` was
 *  "command not found". He had the MCP and not the CLI, and the MCP cannot do
 *  anything at all until a token exists on disk.
 *
 *  Shipping him the CLI would have fixed it and handed a customer every staff
 *  command in the same file. The MCP already knows the URL and the anon key, so
 *  it can write its own token and a client needs exactly one file. */
if (process.argv[2] === "login") {
  const readline = require("node:readline");
  // Exactly one prompt, and the email comes from the command line.
  //
  // Two sequential readline questions look natural and do not work: the first
  // consumes the stream, the second prints and never receives a line, and node
  // exits 0 having done nothing — a login whose failure mode is silence. One
  // question has no such edge, on a terminal or a pipe.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const askHidden = (q) => new Promise((resolve) => {
    rl._writeToOutput = (str) => { if (str.includes(q)) rl.output.write(q); };
    rl.question(q, (a) => { rl._writeToOutput = null; process.stdout.write("\n"); resolve(a.trim()); });
  });
  (async () => {
    const email = process.argv[3];
    if (!email) { rl.close(); console.error("Usage: node mcp-server.js login you@company.com"); process.exit(1); }
    const password = await askHidden(`password for ${email}: `);
    const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) {
      let b = {}; try { b = await r.json(); } catch {}
      rl.close();
      console.error(`Login failed (${r.status}) — ${b.error_description || b.msg || "check the password"}`);
      process.exit(1);
    }
    const j = await r.json();
    rl.close();
    saveConf({ email, access_token: j.access_token, refresh_token: j.refresh_token, user_id: j.user.id });
    console.log(`Logged in as ${email}. Restart your agent to pick it up.`);
    process.exit(0);
  })();
} else {

process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => msg?.id !== undefined && errReply(msg.id, -32603, e.message));
  }
});
}
