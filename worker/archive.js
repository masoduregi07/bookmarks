// cutref 보관함 서버 (Cloudflare Worker)
// 연결해야 하는 것 (Cloudflare 설정 화면 → 이 Worker → Settings → Bindings / Variables):
//   DB              D1 데이터베이스 (schema.sql 실행)
//   BUCKET          R2 버킷
//   GOOGLE_CLIENT_ID  구글 로그인 클라이언트 ID (일반 변수)
//   SESSION_SECRET  아무 긴 문자열 (Secret으로 저장)
//   ALLOW           (선택) 들어올 수 있는 이메일, 쉼표로 구분. 비워 두거나 "*" 이면 구글 계정 누구나
//   QUOTA_MB        (선택) 계정당 용량, 기본 1024
//   TOTAL_MB        (선택) 전체 합계 용량, 기본 9000 (R2 무료 한도 10GB 아래로)
//   ORIGINS         (선택) 사이트 주소, 기본 https://masoduregi07.github.io

const DEF_ORIGINS = 'https://masoduregi07.github.io';
const MAX_IMG = 25 * 1024 * 1024, MAX_VID = 60 * 1024 * 1024;
const SESSION_DAYS = 30;
const MAX_DOC = 1900000; // D1 row limit is 2MB
const DOC_KEYS = ['log', 'links', 'fav', 'set'];
const LINK_TTL = 600; // 연결 코드 10분

export default {
  async fetch(req, env) {
    const origins = (env.ORIGINS || DEF_ORIGINS).split(',').map(s => s.trim());
    const o = req.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': o && origins.includes(o) ? o : origins[0],
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Title,X-Src,X-Link,X-Folders',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(req, env);
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      const status = e.status || 500;
      return new Response(JSON.stringify({ error: e.expose ? e.message : '서버 오류' }), {
        status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  },
};

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });

async function route(req, env) {
  const u = new URL(req.url), p = u.pathname.replace(/\/+$/, '') || '/', m = req.method;
  if (!env.DB || !env.BUCKET) throw fail(500, 'DB 또는 BUCKET 연결이 없음');
  if (p === '/' ) return json({ ok: true, service: 'cutref-archive' });
  if (p === '/auth' && m === 'POST') return auth(req, env);
  // public board RSS for the 보드 tab (Pinterest sends no CORS headers). Only pinterest.com/<user>/<board>.rss, nothing else
  if (p === '/pin/rss' && m === 'GET') {
    const b = (u.searchParams.get('b') || '').split('/').filter(Boolean);
    if (b.length !== 2 || !b.every(x => /^[\w.%-]{1,100}$/.test(x))) throw fail(400, '보드 주소 형식이 이상함');
    const r = await fetch(`https://www.pinterest.com/${b[0]}/${b[1]}.rss`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cutref-board-reader/1.0; +https://masoduregi07.github.io/bookmarks/)', Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.5' },
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    const text = await r.text();
    if (!r.ok || !/<rss[\s>]/i.test(text)) return json({ error: r.ok ? '보드 내용이 RSS가 아님' : '핀터레스트 HTTP ' + r.status, status: r.status }, r.status === 404 ? 404 : 502);
    return new Response(text, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' } });
  }
  if (p === '/link/claim' && m === 'POST') { // trade a short code from a signed-in device for a session (iPad home-screen app)
    const { code } = await body(req);
    const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    await codesTable(env);
    const row = c.length === 8 ? await env.DB.prepare('SELECT sub,exp FROM codes WHERE code=?').bind(c).first() : null;
    if (!row || row.exp < Date.now()) throw fail(400, '코드가 틀렸거나 만료됨');
    await env.DB.prepare('DELETE FROM codes WHERE code=?').bind(c).run(); // one use only
    const me = await env.DB.prepare('SELECT email,name FROM users WHERE sub=?').bind(row.sub).first();
    const token = await sign(env, { sub: row.sub, exp: Date.now() + SESSION_DAYS * 864e5 });
    return json({ token, email: me ? me.email : '', name: me ? me.name || '' : '' });
  }

  // image bytes: <img> can't send headers. ?s= is a per-image signature (safe to leak: opens that one image only);
  // ?t= (the session token) still works for older links
  let mm = p.match(/^\/img\/([\w-]+)$/);
  if (mm && m === 'GET') {
    let row;
    if (u.searchParams.get('s')) {
      if (u.searchParams.get('s') !== await imgSig(env, mm[1])) throw fail(403, '이미지 주소가 맞지 않음');
      row = await env.DB.prepare('SELECT r2,type FROM items WHERE id=?').bind(mm[1]).first();
    } else {
      const sub = await session(env, u.searchParams.get('t'));
      row = await env.DB.prepare('SELECT r2,type FROM items WHERE id=? AND sub=?').bind(mm[1], sub).first();
    }
    if (!row) throw fail(404, '없는 이미지');
    const obj = await env.BUCKET.get(row.r2);
    if (!obj) throw fail(404, '창고에 파일이 없음');
    return new Response(obj.body, { headers: { 'Content-Type': row.type, 'Cache-Control': 'private, max-age=31536000, immutable' } });
  }

  const sub = await session(env, (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));

  if (p === '/me' && m === 'GET') {
    const me = await env.DB.prepare('SELECT email,name,picture FROM users WHERE sub=?').bind(sub).first();
    const st = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) used FROM items WHERE sub=?').bind(sub).first();
    return json({ ...me, count: st.n, used: st.used, quota: quota(env) });
  }

  if (p === '/link' && m === 'POST') {
    await codesTable(env);
    const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', r = crypto.getRandomValues(new Uint8Array(8));
    const code = [...r].map(x => AB[x % AB.length]).join(''), now = Date.now();
    await env.DB.batch([env.DB.prepare('DELETE FROM codes WHERE exp<? OR sub=?').bind(now, sub),
      env.DB.prepare('INSERT INTO codes(code,sub,exp) VALUES(?,?,?)').bind(code, sub, now + LINK_TTL * 1000)]);
    return json({ code, ttl: LINK_TTL });
  }

  // ---- synced docs (연습 기록 · 링크 · 보관함 목록 · 설정): whole JSON per key, ver for compare-and-set
  if (p === '/docs' && m === 'GET') {
    let have = {}; try { have = JSON.parse(u.searchParams.get('have') || '{}') || {}; } catch { have = {}; }
    const rows = (await env.DB.prepare('SELECT k,v,ver FROM docs WHERE sub=?').bind(sub).all()).results;
    return json({ docs: rows.map(r => r.ver === have[r.k] ? { k: r.k, ver: r.ver } : { k: r.k, ver: r.ver, v: JSON.parse(r.v) }) });
  }
  mm = p.match(/^\/docs\/(\w+)$/);
  if (mm && m === 'PUT') {
    if (!DOC_KEYS.includes(mm[1])) throw fail(404, '없는 연동 항목');
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_DOC) throw fail(413, '연동 데이터가 너무 큼 · 오래된 기록 정리 필요');
    let b; try { b = JSON.parse(raw); } catch { throw fail(400, '요청 형식이 이상함'); }
    if (!b || typeof b.v !== 'object' || b.v === null) throw fail(400, '내용이 없음');
    const base = Number.isInteger(b.base) && b.base > 0 ? b.base : 0, v = JSON.stringify(b.v), now = Date.now();
    const r = base
      ? await env.DB.prepare('UPDATE docs SET v=?,ver=ver+1,updated=? WHERE sub=? AND k=? AND ver=?').bind(v, now, sub, mm[1], base).run()
      : await env.DB.prepare('INSERT OR IGNORE INTO docs(sub,k,v,ver,updated) VALUES(?,?,?,1,?)').bind(sub, mm[1], v, now).run();
    if (r.meta.changes) return json({ ver: base + 1 });
    // someone saved in between: hand back the current copy so the client can merge and retry
    const cur = await env.DB.prepare('SELECT v,ver FROM docs WHERE sub=? AND k=?').bind(sub, mm[1]).first();
    return json({ ver: cur ? cur.ver : 0, v: cur ? JSON.parse(cur.v) : null }, 409);
  }

  // ---- folders
  if (p === '/folders' && m === 'GET') {
    const r = await env.DB.prepare(`SELECT f.id,f.name,f.ord,(SELECT COUNT(*) FROM item_folders x WHERE x.folder=f.id) n
      FROM folders f WHERE f.sub=? ORDER BY f.ord,f.created`).bind(sub).all();
    return json(r.results);
  }
  if (p === '/folders' && m === 'POST') {
    const { name } = await body(req);
    const nm = clean(name, 40); if (!nm) throw fail(400, '폴더 이름이 비었음');
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM folders WHERE sub=?').bind(sub).first();
    if (n.n >= 200) throw fail(400, '폴더는 200개까지');
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO folders(id,sub,name,ord,created) VALUES(?,?,?,?,?)').bind(id, sub, nm, n.n, Date.now()).run();
    return json({ id, name: nm, ord: n.n, n: 0 }, 201);
  }
  mm = p.match(/^\/folders\/([\w-]+)$/);
  if (mm) {
    const f = await env.DB.prepare('SELECT id FROM folders WHERE id=? AND sub=?').bind(mm[1], sub).first();
    if (!f) throw fail(404, '없는 폴더');
    if (m === 'PATCH') {
      const { name, ord } = await body(req);
      if (name != null) { const nm = clean(name, 40); if (!nm) throw fail(400, '폴더 이름이 비었음');
        await env.DB.prepare('UPDATE folders SET name=? WHERE id=?').bind(nm, f.id).run(); }
      if (Number.isInteger(ord)) await env.DB.prepare('UPDATE folders SET ord=? WHERE id=?').bind(ord, f.id).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') { // images stay in 전체
      await env.DB.batch([env.DB.prepare('DELETE FROM item_folders WHERE folder=?').bind(f.id),
        env.DB.prepare('DELETE FROM folders WHERE id=?').bind(f.id)]);
      return json({ ok: true });
    }
  }

  // ---- items
  if (p === '/items' && m === 'GET') {
    const folder = u.searchParams.get('folder'), before = +u.searchParams.get('before') || 9e15;
    const limit = Math.min(200, Math.max(1, +u.searchParams.get('limit') || 60));
    const q = folder
      ? env.DB.prepare(`SELECT i.* FROM items i JOIN item_folders x ON x.item=i.id WHERE i.sub=? AND x.folder=? AND i.created<? ORDER BY i.created DESC LIMIT ?`).bind(sub, folder, before, limit)
      : env.DB.prepare(`SELECT * FROM items WHERE sub=? AND created<? ORDER BY created DESC LIMIT ?`).bind(sub, before, limit);
    const rows = (await q.all()).results;
    await attachFolders(env, rows);
    await signRows(env, rows);
    return json({ items: rows.map(pub), next: rows.length === limit ? rows[rows.length - 1].created : null });
  }
  if (p === '/check' && m === 'GET') { // is this source url already saved? (heart state)
    const url = u.searchParams.get('url') || '';
    const row = await env.DB.prepare('SELECT * FROM items WHERE sub=? AND ckey=?').bind(sub, ckeyOf(url)).first();
    if (!row) return json({ item: null });
    await attachFolders(env, [row]); await signRows(env, [row]);
    return json({ item: pub(row) });
  }
  if (p === '/items' && m === 'POST') { // save from a source url (heart, X bookmarks import)
    const b = await body(req);
    const url = String(b.url || '');
    if (!/^https?:\/\//i.test(url)) throw fail(400, '이미지 주소가 아님');
    const ck = ckeyOf(url);
    const dup = await env.DB.prepare('SELECT * FROM items WHERE sub=? AND ckey=?').bind(sub, ck).first();
    if (dup) { await setFolders(env, sub, dup.id, b.folders, true); await attachFolders(env, [dup]); await signRows(env, [dup]); return json({ item: pub(dup), dup: true }); }
    const got = await pull(url);
    const item = await store(env, sub, got.bytes, got.type, { ckey: ck, url, title: b.title, link: b.link, src: b.src, w: b.w, h: b.h });
    await setFolders(env, sub, item.id, b.folders);
    item.folders = await folderIds(env, item.id);
    await signRows(env, [item]);
    return json({ item: pub(item) }, 201);
  }
  if (p === '/upload' && m === 'POST') { // raw file body; meta in headers
    const type = (req.headers.get('Content-Type') || '').split(';')[0].trim();
    if (!/^(image|video)\//.test(type)) throw fail(400, '이미지나 영상 파일만');
    const bytes = await req.arrayBuffer();
    checkSize(bytes.byteLength, type);
    const ck = 'up:' + hex(await crypto.subtle.digest('SHA-256', bytes));
    const dup = await env.DB.prepare('SELECT * FROM items WHERE sub=? AND ckey=?').bind(sub, ck).first();
    const folders = (req.headers.get('X-Folders') || '').split(',').filter(Boolean);
    if (dup) { await setFolders(env, sub, dup.id, folders, true); await attachFolders(env, [dup]); await signRows(env, [dup]); return json({ item: pub(dup), dup: true }); }
    const item = await store(env, sub, bytes, type, { ckey: ck, title: dec(req.headers.get('X-Title')), src: dec(req.headers.get('X-Src')) || '업로드', link: dec(req.headers.get('X-Link')) });
    await setFolders(env, sub, item.id, folders);
    item.folders = await folderIds(env, item.id);
    await signRows(env, [item]);
    return json({ item: pub(item) }, 201);
  }
  mm = p.match(/^\/items\/([\w-]+)$/);
  if (mm) {
    const row = await env.DB.prepare('SELECT * FROM items WHERE id=? AND sub=?').bind(mm[1], sub).first();
    if (!row) throw fail(404, '없는 이미지');
    if (m === 'PATCH') { const b = await body(req);
      if (Array.isArray(b.folders)) await setFolders(env, sub, row.id, b.folders);
      if (b.title != null) await env.DB.prepare('UPDATE items SET title=? WHERE id=?').bind(clean(b.title, 200), row.id).run();
      return json({ ok: true, folders: await folderIds(env, row.id) });
    }
    if (m === 'DELETE') {
      await env.BUCKET.delete(row.r2);
      await env.DB.batch([env.DB.prepare('DELETE FROM item_folders WHERE item=?').bind(row.id),
        env.DB.prepare('DELETE FROM items WHERE id=?').bind(row.id)]);
      return json({ ok: true });
    }
  }
  throw fail(404, '없는 주소');
}

// ---------- storage helpers
async function store(env, sub, bytes, type, meta) {
  const size = bytes.byteLength;
  const st = await env.DB.prepare('SELECT COALESCE(SUM(size),0) used FROM items WHERE sub=?').bind(sub).first();
  if (st.used + size > quota(env)) throw fail(413, '보관함 용량이 가득 참');
  const all = await env.DB.prepare('SELECT COALESCE(SUM(size),0) used FROM items').first();
  if (all.used + size > (+env.TOTAL_MB || 9000) * 1024 * 1024) throw fail(507, '서버 전체 창고가 가득 참 · 관리자에게 문의');
  const id = crypto.randomUUID(), r2 = `u/${sub}/${id}`, now = Date.now();
  await env.BUCKET.put(r2, bytes, { httpMetadata: { contentType: type } });
  const row = { id, sub, ckey: meta.ckey, r2, type, size, w: int(meta.w), h: int(meta.h), src: clean(meta.src, 40),
    title: clean(meta.title, 200), link: safeUrl(meta.link), url: safeUrl(meta.url), created: now };
  try {
    await env.DB.prepare(`INSERT INTO items(id,sub,ckey,r2,type,size,w,h,src,title,link,url,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(row.id, sub, row.ckey, r2, type, size, row.w, row.h, row.src, row.title, row.link, row.url, now).run();
  } catch (e) { await env.BUCKET.delete(r2); throw e; }
  return row;
}
async function setFolders(env, sub, item, ids, addOnly) {
  if (!Array.isArray(ids)) return;
  const own = ids.length ? (await env.DB.prepare(`SELECT id FROM folders WHERE sub=? AND id IN (${ids.map(() => '?').join(',')})`).bind(sub, ...ids).all()).results.map(r => r.id) : [];
  const st = [];
  if (!addOnly) st.push(env.DB.prepare('DELETE FROM item_folders WHERE item=?').bind(item));
  for (const f of own) st.push(env.DB.prepare('INSERT OR IGNORE INTO item_folders(item,folder) VALUES(?,?)').bind(item, f));
  if (st.length) await env.DB.batch(st);
}
async function folderIds(env, item) { return (await env.DB.prepare('SELECT folder FROM item_folders WHERE item=?').bind(item).all()).results.map(r => r.folder); }
async function attachFolders(env, rows) {
  if (!rows.length) return;
  const r = await env.DB.prepare(`SELECT item,folder FROM item_folders WHERE item IN (${rows.map(() => '?').join(',')})`).bind(...rows.map(x => x.id)).all();
  const map = {}; for (const x of r.results) (map[x.item] ||= []).push(x.folder);
  for (const x of rows) x.folders = map[x.id] || [];
}
const pub = r => ({ sig: r.sig, id: r.id, type: r.type, size: r.size, w: r.w, h: r.h, src: r.src, title: r.title, link: r.link, url: r.url, created: r.created, folders: r.folders || [] });

// download a source image server-side (no browser CORS limits)
async function pull(url) {
  let u = url;
  if (/^https:\/\/pbs\.twimg\.com\/media\//.test(u)) { const x = new URL(u); x.searchParams.set('name', 'orig'); u = x.toString(); }
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (cutref archive)', 'Referer': new URL(u).origin + '/', 'Accept': 'image/*,video/*;q=0.9,*/*;q=0.5' }, redirect: 'follow' });
  if (!res.ok) throw fail(502, `원본을 받지 못함 (${res.status})`);
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!/^(image|video)\//.test(type)) throw fail(415, '이미지가 아닌 주소');
  const len = +res.headers.get('Content-Length') || 0; checkSize(len, type);
  const bytes = await res.arrayBuffer(); checkSize(bytes.byteLength, type);
  return { bytes, type };
}
function checkSize(n, type) { if (n > (type.startsWith('video/') ? MAX_VID : MAX_IMG)) throw fail(413, '파일이 너무 큼'); }

// ---------- auth: Google ID token -> our own 30-day session
async function auth(req, env) {
  const { credential } = await body(req);
  const g = await verifyGoogle(String(credential || ''), env.GOOGLE_CLIENT_ID);
  const allow = (env.ALLOW || '*').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.includes('*') && !allow.includes(String(g.email).toLowerCase())) throw fail(403, '허용되지 않은 계정');
  await env.DB.prepare(`INSERT INTO users(sub,email,name,picture,created) VALUES(?,?,?,?,?)
    ON CONFLICT(sub) DO UPDATE SET email=excluded.email,name=excluded.name,picture=excluded.picture`)
    .bind(g.sub, g.email, g.name || null, g.picture || null, Date.now()).run();
  const token = await sign(env, { sub: g.sub, exp: Date.now() + SESSION_DAYS * 864e5 });
  return json({ token, email: g.email, name: g.name || '', picture: g.picture || '' });
}
let JWKS = null, JWKS_AT = 0;
async function verifyGoogle(jwt, aud) {
  const [h, p, s] = jwt.split('.'); if (!s) throw fail(401, '로그인 정보가 이상함');
  let head, pl; try { head = JSON.parse(b64dStr(h)); pl = JSON.parse(b64dStr(p)); } catch { throw fail(401, '로그인 정보가 이상함'); }
  if (Date.now() - JWKS_AT > 3600e3 || !JWKS) { JWKS = (await (await fetch('https://www.googleapis.com/oauth2/v3/certs')).json()).keys; JWKS_AT = Date.now(); }
  const jwk = JWKS.find(k => k.kid === head.kid); if (!jwk) { JWKS_AT = 0; throw fail(401, '로그인 키를 찾지 못함 · 다시 시도'); }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64d(s), new TextEncoder().encode(h + '.' + p));
  if (!ok) throw fail(401, '로그인 서명이 맞지 않음');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(pl.iss)) throw fail(401, '구글 로그인이 아님');
  if (pl.aud !== aud) throw fail(401, '다른 앱의 로그인');
  if (pl.exp * 1000 < Date.now()) throw fail(401, '로그인이 만료됨');
  if (!pl.email_verified) throw fail(401, '이메일 인증이 안 된 계정');
  return pl;
}
async function imgSig(env, id) { return b64e(await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode('img:' + id))).slice(0, 22); }
async function signRows(env, rows) { for (const r of rows) r.sig = await imgSig(env, r.id); }
async function hmacKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) throw fail(500, 'SESSION_SECRET이 없거나 짧음');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(env, data) {
  const p = b64e(new TextEncoder().encode(JSON.stringify(data)));
  return p + '.' + b64e(await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(p)));
}
async function session(env, tok) {
  const [p, s] = String(tok || '').split('.');
  if (!p || !s) throw fail(401, '로그인 필요');
  const key = await hmacKey(env);
  let d; try {
    if (!await crypto.subtle.verify('HMAC', key, b64d(s), new TextEncoder().encode(p))) throw 0;
    d = JSON.parse(b64dStr(p));
  } catch { throw fail(401, '로그인 필요'); }
  if (d.exp < Date.now()) throw fail(401, '로그인이 만료됨');
  return d.sub;
}

// made on first use, so an existing database needs no extra SQL
let CODES_OK = false;
async function codesTable(env) { if (CODES_OK) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, sub TEXT NOT NULL, exp INTEGER NOT NULL)').run(); CODES_OK = true; }

// ---------- small utils
async function body(req) { try { return await req.json(); } catch { throw fail(400, '요청 형식이 이상함'); } }
const quota = env => (+env.QUOTA_MB || 1024) * 1024 * 1024;
const clean = (s, n) => s == null ? null : String(s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) || null;
const int = v => Number.isFinite(+v) && +v > 0 ? Math.round(+v) : null;
const safeUrl = v => { try { const x = new URL(String(v)); return /^https?:$/.test(x.protocol) ? x.toString().slice(0, 2000) : null; } catch { return null; } };
const ckeyOf = url => { try { const x = new URL(url); if (x.hostname === 'pbs.twimg.com') { x.search = ''; } x.hash = ''; return x.toString(); } catch { return String(url); } };
const dec = v => { try { return v ? decodeURIComponent(v) : null; } catch { return v; } };
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64e = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64dStr = s => new TextDecoder().decode(b64d(s));
