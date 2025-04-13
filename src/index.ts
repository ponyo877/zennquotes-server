// wrangler.jsonc の rules で設定した Data 型としてインポート
import fontRegular from '../assets/NotoSansJP-Regular.ttf';

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { fetchMetadata, generateOgpImage } from './ogp/generator'; // OGP生成関数をインポート

// バリデーションスキーマ
const OgpRequestSchema = z.object({
  quote: z.string().max(200, 'Quote must be 200 characters or less'),
  url: z.string().url().refine(url => url.startsWith('https://zenn.dev/'), {
    message: 'URL must start with https://zenn.dev/',
  }),
});

// D1 に保存するデータの型定義
interface QuoteLink {
  id: string; // UUID
  quote: string;
  title: string;
  author: string;
  originalUrl: string; // 元記事のURL (Text Fragment 付き)
  ogpImageUrl: string; // R2に保存した画像のURL
  createdAt: number; // Unix timestamp (ms)
}

// Cloudflare 環境の型定義 (R2, D1 バインディング用)
type Bindings = {
  R2_BUCKET: R2Bucket;
  D1_DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS ミドルウェア (Zennドメインからのリクエストのみ許可)
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin');
  // Chrome拡張機能からのリクエストを許可 (chrome-extension://...)
  // Zennドメインからのリクエストも許可 (https://zenn.dev)
  const allowedOrigins = [/^chrome-extension:\/\/.*/, /^https:\/\/zenn\.dev$/];

  let isAllowed = false;
  if (origin) {
    for (const pattern of allowedOrigins) {
      if (pattern.test(origin)) {
        isAllowed = true;
        c.header('Access-Control-Allow-Origin', origin);
        break;
      }
    }
  }

  // 許可されていないオリジンからの場合はここで処理を中断することも検討
  // if (!isAllowed) {
  //   return c.text('Forbidden', 403);
  // }

  c.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Vary', 'Origin'); // Originによってキャッシュを分ける

  // OPTIONS リクエストへの対応
  if (c.req.method === 'OPTIONS') {
    // ステータスコード 204 (No Content) を返す
    return c.newResponse(null, 204);
  }
  await next();
});


// POST /api/ogp エンドポイント
app.post(
  '/api/ogp',
  zValidator('json', OgpRequestSchema), // バリデーションミドルウェア
  async (c) => {
    const { quote, url: originalUrlInput } = c.req.valid('json');
    const id = crypto.randomUUID(); // UUIDを生成

    try {
      // 1. メタデータ取得
      const { title, author } = await fetchMetadata(originalUrlInput);

      // 2. OGP画像生成
      // fontRegular は ArrayBuffer としてインポートされる
      const pngBuffer = await generateOgpImage(quote, title, author, fontRegular);

      // 3. R2に保存
      const r2Key = `ogp/${id}.png`;
      // TODO: R2へのアップロード処理を実装 (c.env.R2_BUCKET.put)
      // await c.env.R2_BUCKET.put(r2Key, pngBuffer);
      // TODO: R2の公開URLを取得または構築する (要設定 or 固定URL)
      const ogpImageUrl = `https://your-r2-public-url.example.com/${r2Key}`; // ダミーURL

      // 4. Text Fragment 付き URL の生成
      const originalUrlWithFragment = `${originalUrlInput}#:~:text=${encodeURIComponent(quote)}`;

      // 5. D1に保存
      const createdAt = Date.now();
      const dataToSave: QuoteLink = {
        id,
        quote,
        title,
        author,
        originalUrl: originalUrlWithFragment,
        ogpImageUrl, // R2のURL
        createdAt,
      };
      // TODO: D1への保存処理を実装 (c.env.D1_DB.prepare)
      // const stmt = c.env.D1_DB.prepare(
      //   'INSERT INTO QuoteLinks (id, quote, title, author, originalUrl, ogpImageUrl, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
      // );
      // await stmt.bind(id, quote, title, author, originalUrlWithFragment, ogpImageUrl, createdAt).run();

      console.log('Generated OGP:', dataToSave);

      // 6. レスポンス (設計通り ogpImageUrl を返す)
      return c.json({ ogpImageUrl });

    } catch (error) {
      console.error('Error processing /api/ogp:', error);
      return c.json({ error: 'Failed to generate OGP link' }, 500);
    }
  }
);

// GET /:id エンドポイント
app.get('/:id', async (c) => {
  const id = c.req.param('id');

  try {
    // TODO: D1から情報を取得する処理を実装
    // const stmt = c.env.D1_DB.prepare('SELECT * FROM QuoteLinks WHERE id = ?');
    // const data = await stmt.bind(id).first<QuoteLink>();

    // --- ダミーデータここから ---
    const data: QuoteLink | null = { // ダミーデータ (取得成功時)
      id: id,
      quote: `引用文のダミー (${id})`,
      title: `ダミー記事タイトル (${id})`,
      author: 'ダミー著者',
      originalUrl: `https://zenn.dev/dummy/articles/abcdef123456#:~:text=${encodeURIComponent(
        `引用文のダミー (${id})`
      )}`,
      ogpImageUrl: `https://your-r2-public-url.example.com/ogp/${id}.png`, // ダミー画像URL
      createdAt: Date.now(),
    };
    // const data: QuoteLink | null = null; // ダミーデータ (取得失敗時)
    // --- ダミーデータここまで ---


    if (!data) {
      return c.text('Not Found', 404);
    }

    console.log('Fetched data for ID:', id, data);

    // OGP付きHTMLを返す
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${data.title}</title>
  <meta property="og:title" content="${data.title}" />
  <meta property="og:description" content="${data.quote}" />
  <meta property="og:image" content="${data.ogpImageUrl}" />
  <meta property="og:url" content="${data.originalUrl}" />
  <meta property="og:type" content="article" />
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${data.title}">
  <meta name="twitter:description" content="${data.quote}">
  <meta name="twitter:image" content="${data.ogpImageUrl}">
  <meta http-equiv="refresh" content="0; url=${data.originalUrl}" />
</head>
<body>
  <p>Redirecting to <a href="${data.originalUrl}">${data.originalUrl}</a>...</p>
</body>
</html>
  `;

    return c.html(html);

  } catch (error) {
    console.error(`Error fetching data for ID ${id}:`, error);
    return c.text('Internal Server Error', 500);
  }
});

export default app;
