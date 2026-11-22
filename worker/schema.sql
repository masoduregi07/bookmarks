-- cutref 보관함 장부 (Cloudflare D1)
CREATE TABLE IF NOT EXISTS users (
  sub TEXT PRIMARY KEY,          -- 구글 계정 고유 ID
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  ckey TEXT NOT NULL,            -- 중복 확인용: 원본 주소 또는 업로드 파일 해시
  r2 TEXT NOT NULL,              -- 창고(R2) 안의 파일 이름
  type TEXT NOT NULL,            -- image/jpeg, video/mp4 …
  size INTEGER NOT NULL,
  w INTEGER, h INTEGER,
  src TEXT,                      -- 영화 · 애니 · X · 업로드 …
  title TEXT,
  link TEXT,                     -- 원본 페이지
  url TEXT,                      -- 원본 이미지 주소
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS items_dup ON items(sub, ckey);
CREATE INDEX IF NOT EXISTS items_list ON items(sub, created DESC);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  name TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS folders_sub ON folders(sub, ord);
CREATE TABLE IF NOT EXISTS item_folders (
  item TEXT NOT NULL,
  folder TEXT NOT NULL,
  PRIMARY KEY (item, folder)
);
CREATE INDEX IF NOT EXISTS if_folder ON item_folders(folder);
-- 기기 연동: 연습 기록 · 링크 · 보관함 목록 · 설정 (계정당 4줄)
CREATE TABLE IF NOT EXISTS docs (
  sub TEXT NOT NULL,
  k TEXT NOT NULL,               -- log · links · fav · set
  v TEXT NOT NULL,               -- JSON
  ver INTEGER NOT NULL,          -- 저장할 때마다 +1 (동시 저장 감지)
  updated INTEGER NOT NULL,
  PRIMARY KEY (sub, k)
);
