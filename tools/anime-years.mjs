// Builds data/anime-years.json: Sakugabooru work (copyright) tag → first air year, via AniList.
// Run by .github/workflows/anime-years.yml (monthly, or when this file changes). Node 20+, no packages.
import fs from 'node:fs';
const OUT = 'data/anime-years.json', MIN_POSTS = 8, BATCH = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const known = old.years || {};

// 1) work tags, most clips first
const tags = [];
for (let page = 1; page < 40; page++) {
  const r = await fetch(`https://www.sakugabooru.com/tag.json?type=3&order=count&limit=500&page=${page}`, { headers: { 'User-Agent': 'cutref-anime-years (github.com/masoduregi07/bookmarks)' } });
  if (!r.ok) throw new Error('sakugabooru ' + r.status);
  const list = await r.json();
  const keep = list.filter(t => t.count >= MIN_POSTS);
  tags.push(...keep.map(t => t.name));
  if (keep.length < list.length || list.length < 500) break;
  await sleep(800);
}
console.log('work tags:', tags.length);

// 2) year: "(2011)" in the tag wins; else AniList best search match
const years = {}, todo = [];
for (const t of tags) {
  const m = t.match(/_\((\d{4})\)$/);
  if (m) years[t] = +m[1];
  else if (known[t]) years[t] = known[t];
  else todo.push(t);
}
const q = s => JSON.stringify(s.replace(/_\(.*?\)/g, '').replace(/_/g, ' ').trim());
for (let i = 0; i < todo.length; i += BATCH) {
  const part = todo.slice(i, i + BATCH);
  const query = '{' + part.map((t, k) => `a${k}:Page(perPage:1){media(search:${q(t)},type:ANIME,sort:SEARCH_MATCH){startDate{year}}}`).join(' ') + '}';
  for (let tries = 0; tries < 5; tries++) {
    const r = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query }) });
    if (r.status === 429) { await sleep((+r.headers.get('retry-after') || 60) * 1000 + 500); continue; }
    const d = await r.json().catch(() => ({}));
    part.forEach((t, k) => { const y = d.data && d.data['a' + k] && d.data['a' + k].media[0] && d.data['a' + k].media[0].startDate.year; if (y) years[t] = y; });
    break;
  }
  await sleep(2200); // AniList: ~30 requests a minute
  if (i % 200 === 0) console.log(`${i}/${todo.length}`);
}
const sorted = Object.fromEntries(Object.entries(years).sort((a, b) => a[0] < b[0] ? -1 : 1));
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString().slice(0, 10), count: Object.keys(sorted).length, years: sorted }));
console.log('with year:', Object.keys(sorted).length, '/', tags.length);
