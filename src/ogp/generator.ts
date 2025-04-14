import satori from 'satori';
// Resvg をインポート
import { Resvg, initWasm } from '@resvg/resvg-wasm'; // @resvg/resvg-wasm を使用
// WASM モジュールを直接インポート (wrangler.jsonc の rules で処理)
import wasmModule from '../vender/resvg.wasm';

// --- リソース読み込みとキャッシュ ---
let fontJPCache: ArrayBuffer | null = null; // Noto Sans JP
let wasmInitialized = false;

const FONT_JP_KEY = 'assets/NotoSansJP-Regular.ttf';

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

  if (!fontJPCache) {
    throw new Error('Failed to load font data from cache.');
  }

  return fontJPCache;
}

// --- Twemoji 関連ヘルパー ---
const UNKNOWN_EMOJI_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="#CCC"><rect width="36" height="36"/></svg>`;

function getIconCode(text: string): string {
  const codePoint = text.codePointAt(0);
  if (codePoint) {
    return codePoint.toString(16);
  }
  return '';
}

async function loadAdditionalAsset(_code: string, text: string): Promise<string> {
  if (_code !== 'emoji') {
    console.warn(`loadAdditionalAsset called with unexpected code: ${_code}`);
    return `data:image/svg+xml;base64,${btoa(UNKNOWN_EMOJI_SVG)}`;
  }

  const code = getIconCode(text);
  if (!code) {
    console.warn(`Could not get code point for emoji: ${text}`);
    return `data:image/svg+xml;base64,${btoa(UNKNOWN_EMOJI_SVG)}`;
  }

  const version = '15.1.0';
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
  return `data:image/svg+xml;base64,${btoa(emojiSvg)}`;
}


/**
 * 指定されたURLからメタデータ(タイトル、著者名、著者アイコンURL)を抽出する
 * @param url Zennの記事URL
 * @returns { title: string, author: string, authorAvatarUrl: string | null }
 */
// ★★★ 戻り値の型を変更 ★★★
export async function fetchMetadata(url: string): Promise<{ title: string; author: string; authorAvatarUrl: string | null }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.statusText}`);
    }
    const html = await response.text();

    // ★★★ __NEXT_DATA__ から JSON を抽出 ★★★
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json" nonce=".+?">(.+?)<\/script>/);
    if (!nextDataMatch || !nextDataMatch[1]) {
      throw new Error('Could not find __NEXT_DATA__ script tag.');
    }

    const nextData = JSON.parse(nextDataMatch[1]);

    // ★★★ JSON から情報を取得 ★★★
    const articleTitle = nextData?.props?.pageProps?.article?.title;
    const authorName = nextData?.props?.pageProps?.user?.username; // username を使う
    const authorAvatar = nextData?.props?.pageProps?.user?.avatarUrl;

    if (!articleTitle || !authorName) {
      throw new Error('Could not extract title or author from __NEXT_DATA__.');
    }

    const sanitize = (str: string) => str.replace(/</g, '<').replace(/>/g, '>');

    return {
      title: sanitize(articleTitle),
      author: sanitize(authorName),
      authorAvatarUrl: authorAvatar || null, // avatarUrl がなければ null
    };
  } catch (error) {
    console.error('Error fetching or parsing metadata:', error);
    // エラー時はデフォルト値を返す
    return {
      title: 'タイトル取得エラー',
      author: '著者取得エラー',
      authorAvatarUrl: null,
    };
  }
}

/**
 * OGP画像を生成する
 * @param quote 引用文
 * @param title 記事タイトル
 * @param author 著者名
 * @param authorAvatarUrl 著者アイコンURL
 * @param r2Bucket R2 バケットオブジェクト (フォント読み込み用)
 * @returns PNG画像のUint8Array
 */
// ★★★ 引数に authorAvatarUrl を追加 ★★★
export async function generateOgpImage(
  quote: string,
  title: string,
  author: string,
  authorAvatarUrl: string | null, // 追加
  r2Bucket: R2Bucket
): Promise<Uint8Array> {
  // R2 からフォントデータを読み込む
  const fontJP = await loadFont(r2Bucket);

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
          height: 630, // ★★★ 高さを 630 に戻す ★★★
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
                // ★★★ 下部の高さ確保のため、引用文の高さを制限 (例) ★★★
                maxHeight: '350px', // 高さを調整
                overflow: 'hidden',
                // display: '-webkit-box', // line-clamp は使わず overflow で隠す
                // webkitBoxOrient: 'vertical',
                // webkitLineClamp: 5,
              },
              children: `“${quote}”`,
            },
          },
          // 下部: タイトルと著者情報
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                // ★★★ 横並びにしてアイコンとテキストを配置 ★★★
                flexDirection: 'row',
                justifyContent: 'space-between', // 両端揃え
                alignItems: 'flex-end', // 下揃え
                borderTop: '1px solid #eee',
                paddingTop: '30px',
                width: '100%', // 幅を 100% に
              },
              children: [
                // 左側: タイトルと著者名
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start', // 左揃え
                      // ★★★ 幅を制限して折り返すようにする ★★★
                      maxWidth: authorAvatarUrl ? '880px' : '100%', // アイコンがある場合は幅を狭める
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
                            // ★★★ 折り返し設定 ★★★
                            // maxWidth: '100%',
                            // overflow: 'hidden',
                            // textOverflow: 'ellipsis',
                            // whiteSpace: 'nowrap', // 折り返しのため削除
                            lineHeight: 1.3, // 行間調整
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
                    ]
                  }
                },
                // ★★★ 右側: 著者アイコン (存在する場合) ★★★
                authorAvatarUrl ? {
                  type: 'img',
                  props: {
                    src: authorAvatarUrl,
                    style: {
                      width: '80px', // アイコンサイズ調整
                      height: '80px',
                      borderRadius: '50%', // 円形にする
                      marginLeft: '30px', // 左側のテキストとの間隔
                      border: '2px solid #ddd', // 枠線 (任意)
                    },
                  },
                } : null, // アイコン URL がなければ何も表示しない
              ],
            },
          },
        ],
      },
    },
    // Satoriの設定
    {
      width: 1200,
      height: 630, // ★★★ 高さを 630 に戻す ★★★
      loadAdditionalAsset: loadAdditionalAsset,
      fonts: [
        {
          name: 'Noto Sans JP',
          data: fontJP,
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
