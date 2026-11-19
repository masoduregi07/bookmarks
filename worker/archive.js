// cutref 보관함 서버 (Cloudflare Worker)
// 연결해야 하는 것 (Cloudflare 설정 화면 → 이 Worker → Settings → Bindings / Variables):
//   DB              D1 데이터베이스 (schema.sql 실행)
//   BUCKET          R2 버킷
//   GOOGLE_CLIENT_ID  구글 로그인 클라이언트 ID (일반 변수)
//   SESSION_SECRET  아무 긴 문자열 (Secret으로 저장)
//   ALLOW           들어올 수 있는 이메일, 쉼표로 구분. "*" 이면 구글 계정 누구나
//   QUOTA_MB        (선택) 계정당 용량, 기본 2048
//   ORIGINS         (선택) 사이트 주소, 기본 https://masoduregi07.github.io

const DEF_ORIGINS = 'https://masoduregi07.github.io';
const MAX_IMG = 25 * 1024 * 1024, MAX_VID = 60 * 1024 * 1024;
const SESSION_DAYS = 30;

export default {
  async fetch(req, env) {
    const origins = (env.ORIGINS || DEF_ORIGINS).split(',').map(s => s.trim());
    const o = req.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': o && origins.includes(o) ? o : origins[0],
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
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

  // image bytes: <img> can't send headers, so the session token rides in ?t=
  let mm = p.match(/^\/img\/([\w-]+)$/);
  if (mm && m === 'GET') {
    const sub = await session(env, u.searchParams.get('t'));
    const row = await env.DB.prepare('SELECT r2,type FROM items WHERE id=? AND sub=?').bind(mm[1], sub).first();
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
    return json({ items: rows.map(pub), next: rows.length === limit ? rows[rows.length - 1].created : null });
  }
  if (p === '/check' && m === 'GET') { // is this source url already saved? (heart state)
    const url = u.searchParams.get('url') || '';
    const row = await env.DB.prepare('SELECT * FROM items WHERE sub=? AND ckey=?').bind(sub, ckeyOf(url)).first();
    if (!row) return json({ item: null });
    await attachFolders(env, [row]);
    return json({ item: pub(row) });
  }
  if (p === '/items' && m === 'POST') { // save from a source url (heart, X bookmarks import)
    const b = await body(req);
    const url = String(b.url || '');
    if (!/^https?:\/\//i.test(url)) throw fail(400, '이미지 주소가 아님');
    const ck = ckeyOf(url);
    const dup = await env.DB.prepare('SELECT * FROM items WHERE sub=? AND ckey=?').bind(sub, ck).first();
    if (dup) { await setFolders(env, sub, dup.id, b.folders, true); await attachFolders(env, [dup]); return json({ item: pub(dup), dup: true }); }
    const got = await pull(url);
    const item = await store(env, sub, got.bytes, got.type, { ckey: ck, url, title: b.title, link: b.link, src: b.src, w: b.w, h: b.h });
    await setFolders(env, sub, item.id, b.folders);
    item.folders = await folderIds(env, item.id);
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
    if (dup) { await setFolders(env, sub, dup.id, folders, true); await attachFolders(env, [dup]); return json({ item: pub(dup), dup: true }); }
    const item = await store(env, sub, bytes, type, { ckey: ck, title: dec(req.headers.get('X-Title')), src: dec(req.headers.get('X-Src')) || '업로드', link: dec(req.headers.get('X-Link')) });
    await setFolders(env, sub, item.id, folders);
    item.folders = await folderIds(env, item.id);
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
const pub = r => ({ id: r.id, type: r.type, size: r.size, w: r.w, h: r.h, src: r.src, title: r.title, link: r.link, url: r.url, created: r.created, folders: r.folders || [] });

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
  const allow = (env.ALLOW || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
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

// ---------- small utils
async function body(req) { try { return await req.json(); } catch { throw fail(400, '요청 형식이 이상함'); } }
const quota = env => (+env.QUOTA_MB || 2048) * 1024 * 1024;
const clean = (s, n) => s == null ? null : String(s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) || null;
const int = v => Number.isFinite(+v) && +v > 0 ? Math.round(+v) : null;
const safeUrl = v => { try { const x = new URL(String(v)); return /^https?:$/.test(x.protocol) ? x.toString().slice(0, 2000) : null; } catch { return null; } };
const ckeyOf = url => { try { const x = new URL(url); if (x.hostname === 'pbs.twimg.com') { x.search = ''; } x.hash = ''; return x.toString(); } catch { return String(url); } };
const dec = v => { try { return v ? decodeURIComponent(v) : null; } catch { return v; } };
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64e = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64dStr = s => new TextDecoder().decode(b64d(s));
