-- 'INSERT INTO QuoteLinks (id, quote, title, author, originalUrl, ogpImageUrl, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
-- interface QuoteLink {
--   id: string; // UUID
--   quote: string;
--   title: string;
--   author: string;
--   originalUrl: string; // 元記事のURL (Text Fragment 付き)
--   ogpImageUrl: string; // R2に保存した画像のURL
--   createdAt: number; // Unix timestamp (ms)
-- }

CREATE TABLE IF NOT EXISTS quote_links (
  id                TEXT    PRIMARY KEY,
  quote             TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  author            TEXT    NOT NULL,
  original_url      TEXT    NOT NULL,
  ogp_image_url     TEXT    NOT NULL,
  author_avatar_url TEXT, -- ★★★ 著者アイコン URL カラムを追加 (NULL許容) ★★★
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_created_at ON quote_links (created_at DESC);
