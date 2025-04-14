import satori from 'satori';
// Resvg をインポート
import { Resvg, initWasm } from '@resvg/resvg-wasm'; // @resvg/resvg-wasm を使用
// WASM モジュールを直接インポート (wrangler.jsonc の rules で処理)
import wasmModule from '../vender/resvg.wasm';

// --- リソース読み込みとキャッシュ ---
let fontJPCache: ArrayBuffer | null = null; // Noto Sans JP
let wasmInitialized = false;

const FONT_JP_KEY = 'assets/NotoSansJP-Regular.ttf';

// ★★★ フォントのみを読み込むように修正 ★★★
async function loadFont(r2Bucket: R2Bucket): Promise<ArrayBuffer> {
  // Noto Sans JP の読み込みとキャッシュ
  if (!fontJPCache) {
    console.log(`Fetching font from R2: ${FONT_JP_KEY}`);
    const fontObject = await r2Bucket.get(FONT_JP_KEY);
    if (!fontObject) {
      throw new Error(`Font file not found in R2: ${FONT_JP_KEY}`);
    }
    fontJPCache = await fontObject.arrayBuffer();
    console.log('Noto Sans JP data loaded and cached.');
  }

  // キャッシュされたデータを返す
  if (!fontJPCache) {
    throw new Error('Failed to load font data from cache.');
  }

  return fontJPCache;
}

// --- Twemoji 関連ヘルパー ---
const UNKNOWN_EMOJI_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="#CCC"><rect width="36" height="36"/></svg>`;

// 絵文字から Twemoji のファイル名に使われるコードポイントを取得
// (基本的な絵文字のみ対応、結合絵文字などは未対応)
function getIconCode(text: string): string {
  const codePoint = text.codePointAt(0);
  if (codePoint) {
    return codePoint.toString(16);
  }
  return ''; // 不明な場合は空文字
}

// Twemoji SVG を fetch して Base64 データ URI に変換
// ★★★ 戻り値の型を Promise<string> に修正 ★★★
async function loadAdditionalAsset(_code: string, text: string): Promise<string> {
  // _code は 'emoji' 固定の想定
  if (_code !== 'emoji') {
    // emoji 以外は代替 SVG を返す (またはエラーを投げる)
    console.warn(`loadAdditionalAsset called with unexpected code: ${_code}`);
    return `data:image/svg+xml;base64,${btoa(UNKNOWN_EMOJI_SVG)}`;
  }

  const code = getIconCode(text);
  if (!code) {
    console.warn(`Could not get code point for emoji: ${text}`);
    return `data:image/svg+xml;base64,${btoa(UNKNOWN_EMOJI_SVG)}`;
  }

  const version = '15.1.0'; // Twemoji のバージョン (適宜更新)
  let emojiSvg;
  try {
    const url = `https://cdnjs.cloudflare.com/ajax/libs/twemoji/${version}/svg/${code.toLowerCase()}.svg`;
    console.log(`Fetching Twemoji: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch Twemoji SVG: ${response.statusText}`);
    }
    emojiSvg = await response.text();
  } catch (e) {
    console.error(`Error fetching Twemoji for ${text} (${code}):`, e);
    emojiSvg = UNKNOWN_EMOJI_SVG;
  }
  // btoa は Cloudflare Workers 環境で利用可能
  return `data:image/svg+xml;base64,${btoa(emojiSvg)}`;
}


/**
 * 指定されたURLからメタデータ(タイトル、著者)を抽出する
 * @param url Zennの記事URL
 * @returns { title: string, author: string }
 */
export async function fetchMetadata(url: string): Promise<{ title: string; author: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.statusText}`);
    }
    const html = await response.text();

    const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"\s*\/?>/i);
    const authorMatch = html.match(/<meta\s+content="([^"]+)さんによる記事"\s+name="zenn:description"\s*\/?>/i);

    let title = titleMatch ? titleMatch[1] : 'タイトル不明';
    let author = authorMatch ? authorMatch[1] : '著者不明';

    const zennDescMatch = html.match(/<meta\s+name="zenn:description"\s+content="([^"]+)さんによる記事"\s*\/?>/i);
    if (zennDescMatch) {
      author = zennDescMatch[1];
    }

    const sanitize = (str: string) => str.replace(/</g, '<').replace(/>/g, '>');

    return {
      title: sanitize(title),
      author: sanitize(author),
    };
  } catch (error) {
    console.error('Error fetching metadata:', error);
    return {
      title: 'タイトル取得エラー',
      author: '著者取得エラー',
    };
  }
}

/**
 * OGP画像を生成する
 * @param quote 引用文
 * @param title 記事タイトル
 * @param author 著者名
 * @param r2Bucket R2 バケットオブジェクト (フォント読み込み用)
 * @returns PNG画像のUint8Array
 */
export async function generateOgpImage(
  quote: string,
  title: string,
  author: string,
  r2Bucket: R2Bucket
): Promise<Uint8Array> {
  // R2 からフォントデータを読み込む
  const fontJP = await loadFont(r2Bucket); // ★★★ Noto Sans JP のみ読み込み ★★★

  // WASM の初期化 (初回のみ実行)
  if (!wasmInitialized) {
    console.log('Initializing Resvg WASM...');
    await initWasm(wasmModule);
    wasmInitialized = true;
    console.log('Resvg WASM initialized.');
  }

  // SatoriでSVGを生成
  const svg = await satori(
    // JSXライクな構文でテンプレートを記述
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: 1200,
          height: 1200, // 630,
          padding: '60px',
          backgroundColor: '#f8f8f8',
          border: '1px solid #e0e0e0',
          borderRadius: '10px',
          // ★★★ fontFamily から絵文字フォントを削除 ★★★
          fontFamily: '"Noto Sans JP"',
        },
        children: [
          // 上部: 引用文
          {
            type: 'div',
            props: {
              style: {
                fontSize: '48px',
                color: '#333',
                lineHeight: 1.6,
                marginBottom: '40px',
                overflow: 'hidden',
                display: '-webkit-box',
                webkitBoxOrient: 'vertical',
                webkitLineClamp: 5,
                // ★★★ fontFamily から絵文字フォントを削除 ★★★
                // fontFamily: '"Noto Sans JP", "Noto Color Emoji"',
              },
              children: `“${quote}”`,
            },
          },
          // 下部: タイトルと著者 (変更なし)
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                borderTop: '1px solid #eee',
                paddingTop: '30px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '40px',
                      fontWeight: 'bold',
                      color: '#111',
                      marginBottom: '15px',
                      maxWidth: '100%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                    children: title,
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '32px',
                      color: '#666',
                    },
                    children: `by ${author}`,
                  },
                },
              ],
            },
          },
        ],
      },
    },
    // Satoriの設定
    {
      width: 1200,
      height: 630,
      // ★★★ loadAdditionalAsset オプションを追加 ★★★
      loadAdditionalAsset: loadAdditionalAsset,
      fonts: [
        // ★★★ Noto Sans JP のみ設定 ★★★
        {
          name: 'Noto Sans JP',
          data: fontJP,
          weight: 400,
          style: 'normal',
        },
        // 絵文字フォントの設定は削除
      ],
    }
  );

  // ResvgでPNGに変換
  const resvg = new Resvg(svg, {});
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return pngBuffer;
}
