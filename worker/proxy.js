// cutref-proxy v6 — 컷 레퍼런스 전용 CORS 프록시
// Cloudflare 대시보드 → Workers & Pages → cutref-proxy → 코드 편집에 이 파일 내용을 그대로 붙여 넣고 배포.
//
// v5에서 바뀐 점
// - 허용 목록에 사이트가 실제로 쓰는 곳 추가: 위키(fandom · wiki.gg)와 그 이미지, 굿스마일 상품 사진, 핀터레스트 이미지 · 보드 RSS
//   (v5에는 없어서 위키 · 일부 이미지가 프록시로 우회할 때 항상 403이 났음)
// - 넓은 호스트(storage.googleapis.com, pinterest.com)는 경로까지 제한
// - 리디렉트를 한 단계씩 따라가며 매번 허용 목록 확인 (허용된 사이트의 리디렉트로 다른 곳에 가지 못하게)
// - 오류 응답(429 · 5xx)은 캐시하지 않음 (막힌 응답이 10분 동안 남던 문제)
// - 응답을 브라우저에서 직접 열어도 스크립트가 돌지 않게 sandbox · nosniff 헤더

// [호스트, 경로 조건(없으면 전체)] — 호스트는 그 자신과 하위 도메인까지 허용
const ALLOW = [
  ['film-grab.com'],
  ['sakugabooru.com'],
  ['goodsmile.com'],
  ['safebooru.org'],
  ['fandom.com'],                 // 게임 위키 API (genshin-impact.fandom.com 등)
  ['wikia.nocookie.net'],         // fandom 이미지
  ['wiki.gg'],                    // 명일방주 · 엔드필드 위키 API와 이미지
  ['pinimg.com'],                 // 핀터레스트 이미지
  ['pinterest.com', p => p.endsWith('.rss')],                              // 보드 RSS만
  ['storage.googleapis.com', p => p.startsWith('/gsc-webrevo-sdk-storage-prd/')], // 굿스마일 상품 사진만
];
const SITE = 'https://masoduregi07.github.io';
const MAX_REDIRECTS = 5;

function allowed(u) {
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return ALLOW.some(([d, pathOk]) => (host === d || host.endsWith('.' + d)) && (!pathOk || pathOk(u.pathname)));
}

function cors(h = new Headers()) {
  h.set('Access-Control-Allow-Origin', SITE);
  h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Expose-Headers', 'X-WP-Total, X-WP-TotalPages');
  h.set('Vary', 'Origin');
  return h;
}

function deny(msg, status = 403) {
  return new Response(msg, { status, headers: cors(new Headers({ 'content-type': 'text/plain; charset=utf-8' })) });
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny('GET만 허용', 405);

    // 다른 사이트에서 이 프록시를 쓰지 못하게 막음 (<img> 요청과 주소창에서 직접 여는 건 Origin이 없어 통과)
    const origin = req.headers.get('Origin');
    if (origin && origin !== SITE) return deny('허용 안 된 사이트');

    const target = new URL(req.url).searchParams.get('url');
    if (!target) return deny('url 없음', 400);

    let u;
    try { u = new URL(target); } catch { return deny('잘못된 url', 400); }
    if (!allowed(u)) return deny('허용 안 됨');

    // 리디렉트는 직접 따라가며 도착지마다 허용 목록 확인
    let res;
    for (let i = 0; ; i++) {
      res = await fetch(u.toString(), {
        method: req.method,
        headers: {
          'User-Agent': 'cutref/1.0 (drawing reference viewer; masoduregi07.github.io/bookmarks)',
          'Accept': req.headers.get('Accept') || '*/*',
        },
        redirect: 'manual',
        cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 600, '404': 60, '400-403': 0, '405-599': 0 } },
      });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get('Location');
      if (!loc || i >= MAX_REDIRECTS) return deny('리디렉트가 너무 많음', 502);
      try { u = new URL(loc, u); } catch { return deny('잘못된 리디렉트', 502); }
      if (!allowed(u)) return deny('허용 안 된 곳으로 리디렉트');
    }

    const h = cors(new Headers(res.headers));
    h.delete('set-cookie');
    h.delete('content-security-policy');
    h.delete('x-frame-options');
    // 프록시 주소를 브라우저에서 직접 열어도 받아 온 페이지의 스크립트가 돌지 않게
    h.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'");
    h.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },
};
