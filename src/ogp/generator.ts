import satori from 'satori';
// Resvg をインポート
import { Resvg, initWasm } from '@resvg/resvg-wasm'; // @resvg/resvg-wasm を使用
// WASM モジュールを直接インポート (wrangler.jsonc の rules で処理)
import wasmModule from '../vender/resvg.wasm';

// --- リソース読み込みとキャッシュ ---
let fontSansCache: ArrayBuffer | null = null; // Noto Sans JP (通常テキスト用)
let fontSerifCache: ArrayBuffer | null = null; // Noto Serif JP (引用文用)
let fontLogoCache: ArrayBuffer | null = null; // Inter (ロゴ用)
let wasmInitialized = false;

const FONT_SANS_KEY = 'assets/NotoSansJP-Regular.ttf';
const FONT_SERIF_KEY = 'assets/NotoSerifJP-Regular.ttf'; // ★★★ 明朝体フォントキー ★★★
const FONT_LOGO_KEY = 'assets/Inter_28pt-Regular.ttf'; // ★★★ ロゴ用フォントキー ★★★

// ★★★ 3つのフォントを読み込むように修正 ★★★
async function loadResources(r2Bucket: R2Bucket): Promise<{ fontSans: ArrayBuffer; fontSerif: ArrayBuffer; fontLogo: ArrayBuffer }> {
  // Noto Sans JP
  if (!fontSansCache) {
    console.log(`Fetching font from R2: ${FONT_SANS_KEY}`);
    const fontObject = await r2Bucket.get(FONT_SANS_KEY);
    if (!fontObject) throw new Error(`Font file not found in R2: ${FONT_SANS_KEY}`);
    fontSansCache = await fontObject.arrayBuffer();
    console.log('Noto Sans JP data loaded and cached.');
  }

  // Noto Serif JP
  if (!fontSerifCache) {
    console.log(`Fetching font from R2: ${FONT_SERIF_KEY}`);
    const fontObject = await r2Bucket.get(FONT_SERIF_KEY);
    if (!fontObject) throw new Error(`Font file not found in R2: ${FONT_SERIF_KEY}`);
    fontSerifCache = await fontObject.arrayBuffer();
    console.log('Noto Serif JP data loaded and cached.');
  }

  // Inter
  if (!fontLogoCache) {
    console.log(`Fetching font from R2: ${FONT_LOGO_KEY}`);
    const fontObject = await r2Bucket.get(FONT_LOGO_KEY);
    if (!fontObject) throw new Error(`Font file not found in R2: ${FONT_LOGO_KEY}`);
    fontLogoCache = await fontObject.arrayBuffer();
    console.log('Inter font data loaded and cached.');
  }

  if (!fontSansCache || !fontSerifCache || !fontLogoCache) {
    throw new Error('Failed to load font resources from cache.');
  }

  return { fontSans: fontSansCache, fontSerif: fontSerifCache, fontLogo: fontLogoCache };
}

// --- Twemoji 関連ヘルパー (変更なし) ---
const UNKNOWN_EMOJI_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="#CCC"><rect width="36" height="36"/></svg>`;

function getIconCode(text: string): string {
  const codePoint = text.codePointAt(0);
  if (codePoint) return codePoint.toString(16);
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
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch Twemoji SVG: ${response.statusText}`);
    emojiSvg = await response.text();
  } catch (e) {
    console.error(`Error fetching Twemoji for ${text} (${code}):`, e);
    emojiSvg = UNKNOWN_EMOJI_SVG;
  }
  return `data:image/svg+xml;base64,${btoa(emojiSvg)}`;
}

/**
 * 指定されたURLからメタデータ(タイトル、著者名、著者アイコンURL)を抽出する
 * (変更なし)
 */
export async function fetchMetadata(url: string): Promise<{ title: string; author: string; authorAvatarUrl: string | null }> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch URL: ${response.statusText}`);
    const html = await response.text();

    // ★★★ __NEXT_DATA__ から JSON を抽出 ★★★
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json" nonce=".+?">(.+?)<\/script>/);
    if (!nextDataMatch || !nextDataMatch[1]) {
      throw new Error('Could not find __NEXT_DATA__ script tag.');
    }

    const nextData = JSON.parse(nextDataMatch[1]);
    const articleTitle = nextData?.props?.pageProps?.article?.title;
    const authorName = nextData?.props?.pageProps?.user?.username;
    const authorAvatar = nextData?.props?.pageProps?.user?.avatarUrl;
    if (!articleTitle || !authorName) throw new Error('Could not extract title or author from __NEXT_DATA__.');
    const sanitize = (str: string) => str.replace(/</g, '<').replace(/>/g, '>');
    return {
      title: sanitize(articleTitle),
      author: sanitize(authorName),
      authorAvatarUrl: authorAvatar || null,
    };
  } catch (error) {
    console.error('Error fetching or parsing metadata:', error);
    return { title: 'タイトル取得エラー', author: '著者取得エラー', authorAvatarUrl: null };
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
export async function generateOgpImage(
  quote: string,
  title: string,
  author: string,
  authorAvatarUrl: string | null,
  r2Bucket: R2Bucket
): Promise<Uint8Array> {
  // R2 からフォントデータを読み込む
  const { fontSans, fontSerif, fontLogo } = await loadResources(r2Bucket); // ★★★ 3つのフォントを取得 ★★★

  // WASM の初期化 (初回のみ実行)
  if (!wasmInitialized) {
    console.log('Initializing Resvg WASM...');
    await initWasm(wasmModule);
    wasmInitialized = true;
    console.log('Resvg WASM initialized.');
  }

  // SatoriでSVGを生成
  const svg = await satori(
    // ★★★ 新しいデザイン仕様に基づくテンプレート ★★★
    {
      type: 'div', // 全体コンテナ
      props: {
        style: {
          display: 'flex',
          width: 1200,
          height: 1200,
          backgroundColor: '#f0f8ff', // AliceBlue 背景
          // 枠線 (単色で代替)
          border: '10px solid #3ea8ff', // Zenn ブルーに近い色
          borderRadius: '10px',
          boxSizing: 'border-box', // border を含めてサイズ計算
        },
        children: [
          {
            type: 'div', // 内側コンテナ (パディング用)
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between', // 上下に要素を配置
                width: '100%',
                height: '100%',
                padding: '40px', // 内側のパディング
                backgroundColor: '#ffffff', // 白背景
                borderRadius: '5px', // 内側の角丸 (任意)
                boxSizing: 'border-box',
              },
              children: [
                // --- 上部: 引用エリア ---
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center', // 中央寄せ
                    },
                    children: [
                      // 左上の引用符
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '100px', // 大きなサイズ
                            color: '#cccccc', // 薄いグレー
                            position: 'absolute', // 絶対配置
                            left: '40px', // 位置調整 (パディング考慮)
                            top: '20px', // 位置調整
                            fontFamily: '"Noto Serif JP"', // 明朝体
                            lineHeight: 1,
                          },
                          children: '“',
                        },
                      },
                      // 引用文テキスト
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '38px', // 少し小さめ
                            color: '#4a5568', // ブルーグレー系
                            lineHeight: 1.7, // 行間広め
                            marginTop: '60px', // 引用符とのスペース
                            textAlign: 'center',
                            fontFamily: '"Noto Serif JP"', // 明朝体
                            // 長文対応 (高さ制限と overflow hidden)
                            maxHeight: '280px', // 高さを調整
                            overflow: 'hidden',
                          },
                          children: quote,
                        },
                      },
                      // 右下の引用符 (任意)
                      {
                        type: 'div',
                        props: {
                          style: {
                            fontSize: '100px',
                            color: '#cccccc',
                            position: 'absolute',
                            right: '40px',
                            bottom: '200px', // 下からの位置調整 (著者情報エリアの上あたり)
                            fontFamily: '"Noto Serif JP"',
                            lineHeight: 1,
                          },
                          children: '”',
                        },
                      },
                      // 罫線
                      {
                        type: 'div',
                        props: {
                          style: {
                            width: '150px',
                            height: '2px',
                            backgroundColor: '#e2e8f0', // 薄いグレー
                            marginTop: '30px', // テキストとの間隔
                          },
                        },
                      },
                    ],
                  },
                },
                // --- 下部: 著者情報 & ロゴエリア ---
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      justifyContent: 'space-between', // 両端揃え
                      alignItems: 'flex-end', // 下揃え
                      width: '100%',
                      marginTop: '30px', // 罫線との間隔
                      fontFamily: '"Noto Sans JP"', // 基本フォント
                    },
                    children: [
                      // 左側: 著者情報
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            alignItems: 'center', // 縦中央揃え
                          },
                          children: [
                            // アバター画像
                            authorAvatarUrl ? {
                              type: 'img',
                              props: {
                                src: authorAvatarUrl,
                                style: {
                                  width: '48px', // サイズ調整
                                  height: '48px',
                                  borderRadius: '50%',
                                  marginRight: '15px', // 名前との間隔
                                  border: '1px solid #eee',
                                },
                              },
                            } : null,
                            // 名前とタイトル
                            {
                              type: 'div',
                              props: {
                                style: {
                                  display: 'flex',
                                  flexDirection: 'column',
                                },
                                children: [
                                  { // 著者名
                                    type: 'div',
                                    props: {
                                      style: {
                                        fontSize: '24px', // 中サイズ
                                        fontWeight: 'bold', // 太字
                                        color: '#2d3748', // やや濃いグレー
                                        lineHeight: 1.3,
                                      },
                                      children: author,
                                    },
                                  },
                                  { // 記事タイトル
                                    type: 'div',
                                    props: {
                                      style: {
                                        fontSize: '20px', // 小サイズ
                                        color: '#718096', // 薄めのグレー
                                        lineHeight: 1.3,
                                        // 長い場合の省略表示 (任意)
                                        // maxWidth: '600px',
                                        // overflow: 'hidden',
                                        // textOverflow: 'ellipsis',
                                        // whiteSpace: 'nowrap',
                                      },
                                      children: title,
                                    },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                      },
                      // 右側: ロゴとサービス名
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            fontFamily: '"Inter"', // ロゴ用フォント
                          },
                          children: [
                            // ロゴアイコン (テキストで代替)
                            {
                              type: 'div',
                              props: {
                                style: {
                                  fontSize: '30px',
                                  fontWeight: 'bold',
                                  color: '#3ea8ff', // Zenn ブルー
                                  marginRight: '8px',
                                  // 引用符っぽく見せる (調整が必要)
                                  transform: 'scaleY(0.8) translateY(-2px)',
                                },
                                children: '❝', // または ”
                              },
                            },
                            // サービス名
                            {
                              type: 'div',
                              props: {
                                style: {
                                  fontSize: '24px',
                                  fontWeight: '600', // SemiBold
                                  color: '#4a5568',
                                },
                                children: 'zennquotes',
                              },
                            },
                          ],
                        },
                      },
                    ],
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
      height: 630, // ★★★ OGP サイズ ★★★
      loadAdditionalAsset: loadAdditionalAsset,
      fonts: [
        // ★★★ 3つのフォントを登録 ★★★
        {
          name: 'Noto Sans JP',
          data: fontSans,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'Noto Serif JP',
          data: fontSerif,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'Inter', // CSS の fontFamily と合わせる
          data: fontLogo,
          weight: 400, // Regular
          style: 'normal',
        },
        { // Inter の SemiBold も使う場合は追加
          name: 'Inter',
          data: fontLogo, // 同じファイルで代用 (必要なら Bold/SemiBold ファイルを別途用意)
          weight: 600,
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
