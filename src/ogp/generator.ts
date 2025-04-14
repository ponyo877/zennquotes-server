import satori from 'satori';
// Resvg をインポート
import { Resvg, initWasm } from '@resvg/resvg-wasm'; // @resvg/resvg-wasm を使用
// ★★★ WASM モジュールを直接インポート (wrangler.jsonc の rules で処理) ★★★
import wasmModule from '../vender/resvg.wasm';

// --- リソース読み込みとキャッシュ ---
let fontDataCache: ArrayBuffer | null = null;
// let wasmBufferCache: ArrayBuffer | null = null; // WASM は直接インポートするため不要
let wasmInitialized = false;

const FONT_KEY = 'assets/NotoSansJP-Regular.ttf';
// const WASM_KEY = 'vender/resvg.wasm'; // R2 からは読み込まない

// ★★★ フォントのみを読み込むように修正 ★★★
async function loadFont(r2Bucket: R2Bucket): Promise<ArrayBuffer> {
  // フォントデータの読み込みとキャッシュ
  if (!fontDataCache) {
    console.log(`Fetching font from R2: ${FONT_KEY}`);
    const fontObject = await r2Bucket.get(FONT_KEY);
    if (!fontObject) {
      throw new Error(`Font file not found in R2: ${FONT_KEY}`);
    }
    fontDataCache = await fontObject.arrayBuffer();
    console.log('Font data loaded and cached.');
  }

  // キャッシュされたデータを返す
  if (!fontDataCache) {
    throw new Error('Failed to load font data from cache.');
  }

  return fontDataCache;
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

    // 正規表現またはDOMパーサーライブラリを使ってメタタグを抽出
    const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"\s*\/?>/i);
    // <meta content="haru067さんによる記事" name="zenn:description"/>
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
  const fontData = await loadFont(r2Bucket); // ★★★ フォントのみ読み込み ★★★

  // WASM の初期化 (初回のみ実行)
  if (!wasmInitialized) {
    console.log('Initializing Resvg WASM...');
    // ★★★ インポートした WASM モジュールで初期化 ★★★
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
              },
              children: `“${quote}”`,
            },
          },
          // 下部: タイトルと著者
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
      fonts: [
        {
          name: 'Noto Sans JP',
          data: fontData,
          weight: 400,
          style: 'normal',
        },
      ],
    }
  );

  // ResvgでPNGに変換
  const resvg = new Resvg(svg, {});
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return pngBuffer;
}
