// フォントは動的に読み込むためインポートを削除

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { fetchMetadata, generateOgpImage } from './ogp/generator'; // OGP生成関数をインポート

// --- Helper: 7桁のランダム英数字ID生成 ---
function generateShortId(length = 7): string {
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

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
  original_url: string; // 元記事のURL (Text Fragment 付き)
  ogp_image_url: string; // R2に保存した画像のURL
  author_avatar_url?: string | null; // ★★★ 著者アイコン URL (オプショナル) ★★★
  created_at: number; // Unix timestamp (ms)
}

// Cloudflare 環境の型定義 (R2, D1 バインディング用)
type Bindings = {
  R2_BUCKET: R2Bucket;
  D1_DB: D1Database;
  R2_BUCKET_PUBLIC_URL?: string; // R2 公開 URL (環境変数)
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
    const id = generateShortId(); // ★★★ 7桁の短いIDを生成 ★★★

    try {
      // 1. メタデータ取得 (authorAvatarUrl も取得)
      const { title, author, authorAvatarUrl } = await fetchMetadata(originalUrlInput);

      // 2. OGP画像生成 (authorAvatarUrl を渡す)
      const pngBuffer = await generateOgpImage(quote, title, author, authorAvatarUrl, c.env.R2_BUCKET);

      // 3. R2に保存
      const r2Key = `ogp/${id}.png`;
      // R2 へのアップロード処理
      await c.env.R2_BUCKET.put(r2Key, pngBuffer, {
        httpMetadata: { contentType: 'image/png' }, // Content-Type を設定
      });
      console.log(`Image uploaded to R2: ${r2Key}`);
      // R2 の公開 URL を構築 (カスタムドメインを使用)
      const ogpImageUrl = `https://${c.env.R2_BUCKET_PUBLIC_URL || 'zennq-img.folks-chat.com'}/${r2Key}`; // 環境変数または直接指定

      // 4. Text Fragment 付き URL の生成
      const originalUrlWithFragment = `${originalUrlInput}#:~:text=${encodeURIComponent(quote)}`;

      // 5. D1に保存
      const createdAt = Date.now();
      const dataToSave: QuoteLink = {
        id,
        quote,
        title,
        author,
        original_url: originalUrlWithFragment,
        ogp_image_url: ogpImageUrl, // R2のURL
        author_avatar_url: authorAvatarUrl, // ★★★ アイコン URL を追加 ★★★
        created_at: createdAt,
      };
      // D1 への保存処理 (カラムとプレースホルダを追加)
      const stmt = c.env.D1_DB.prepare(
        'INSERT INTO quote_links (id, quote, title, author, original_url, ogp_image_url, author_avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      await stmt.bind(
        dataToSave.id,
        dataToSave.quote,
        dataToSave.title,
        dataToSave.author,
        dataToSave.original_url,
        dataToSave.ogp_image_url,
        dataToSave.author_avatar_url, // ★★★ バインドする値を追加 ★★★
        dataToSave.created_at
      ).run();
      console.log('Data saved to D1:', dataToSave);

      // 6. レスポンス (設計通り ogpImageUrl を返す)
      return c.json({ id, ogpImageUrl });

    } catch (error) {
      console.error('Error processing /api/ogp:', error);
      return c.json({ error: 'Failed to generate OGP link' }, 500);
    }
  }
);

// GET /:id エンドポイント
app.get('/:id', async (c) => {
  const id = c.req.param('id');

  // ★★★ id が "undefined" という文字列の場合はすぐに 404 を返す ★★★
  if (id === 'undefined') {
    console.log('Received request with ID "undefined", returning 404.');
    return c.text('Not Found', 404);
  }

  try {
    // D1 から情報を取得する処理 (テーブル名を修正, author_avatar_url も取得)
    // ★★★ SELECT 文に author_avatar_url を追加 ★★★
    const stmt = c.env.D1_DB.prepare('SELECT id, quote, title, author, original_url, ogp_image_url, author_avatar_url, created_at FROM quote_links WHERE id = ?');
    const data = await stmt.bind(id).first<QuoteLink>();

    if (!data) {
      console.log(`Data not found for ID: ${id}`);
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
  <meta property="og:image" content="${data.ogp_image_url}" />
  <meta property="og:url" content="${data.original_url}" />
  <meta property="og:type" content="article" />
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${data.title}">
  <meta name="twitter:description" content="${data.quote}">
  <meta name="twitter:image" content="${data.ogp_image_url}">
  <meta http-equiv="refresh" content="0; url=${data.original_url}" />
</head>
<body>
  <p>Redirecting to <a href="${data.original_url}">${data.original_url}</a>...</p>
</body>
</html>
  `;

    return c.html(html);

  } catch (error) {
    console.error(`Error fetching data for ID ${id}:`, error);
    return c.text('Internal Server Error', 500);
  }
});

// favicon.ico へのリクエストを無視する (204 No Content)
app.get('/favicon.ico', (c) => c.newResponse(null, 204));

app.get('/', (c) => c.text('Hello Zenn Quotes!'))

export default app;
