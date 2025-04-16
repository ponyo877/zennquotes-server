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
const FONT_SERIF_KEY = 'assets/NotoSerifJP-Regular.ttf';
const FONT_LOGO_KEY = 'assets/Inter_28pt-Regular.ttf';

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
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json" nonce=".+?">(.+?)<\/script>/);
    if (!nextDataMatch || !nextDataMatch[1]) throw new Error('Could not find __NEXT_DATA__ script tag.');
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

// ★★★ フォントサイズ計算ヘルパー (最終調整版) ★★★
function calculateFontSize(textLength: number): number {
  const maxLength = 200; // 引用文の最大文字数
  const minLengthThreshold = 50; // この文字数以下なら最大サイズ
  const maxLengthThreshold = 150; // この文字数以上なら最小サイズ
  const maxFontSize = 64;
  const minFontSize = 32;

  if (textLength <= minLengthThreshold) {
    return maxFontSize;
  }
  if (textLength >= maxLengthThreshold) {
    return minFontSize;
  }

  // 50文字から150文字の間で線形補間
  const ratio = (textLength - minLengthThreshold) / (maxLengthThreshold - minLengthThreshold);
  const fontSize = maxFontSize - ratio * (maxFontSize - minFontSize);

  return Math.round(fontSize); // 整数に丸める
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
  const { fontSans, fontSerif, fontLogo } = await loadResources(r2Bucket);

  // WASM の初期化 (初回のみ実行)
  if (!wasmInitialized) {
    console.log('Initializing Resvg WASM...');
    await initWasm(wasmModule);
    wasmInitialized = true;
    console.log('Resvg WASM initialized.');
  }

  // ★★★ 引用文の文字数に基づいてフォントサイズを計算 ★★★
  const quoteFontSize = calculateFontSize(quote.length);
  console.log(`Quote length: ${quote.length}, Calculated font size: ${quoteFontSize}`);

  // SatoriでSVGを生成
  const svg = await satori(
    {
      type: 'div', // 全体コンテナ
      props: {
        style: {
          display: 'flex',
          width: 1200,
          height: 630,
          backgroundColor: '#f0f8ff',
        },
        children: [
          {
            type: 'div', // 枠線用コンテナ
            props: {
              style: {
                display: 'flex',
                width: '100%',
                height: '100%',
                backgroundImage: 'linear-gradient(to right, #3EA8FF, #9B7BE4)',
                borderRadius: '10px',
                padding: '25px',
                boxSizing: 'border-box',
              },
              children: [
                {
                  type: 'div', // 内側コンテナ
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      width: '100%',
                      height: '100%',
                      padding: '40px',
                      backgroundColor: '#ffffff',
                      borderRadius: '5px',
                      boxSizing: 'border-box',
                    },
                    children: [
                      // --- 上部: 引用エリア ---
                      {
                        type: 'div', // 引用文コンテナ
                        props: {
                          style: {
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'center',
                            alignItems: 'center',
                            flexGrow: 1,
                            overflow: 'hidden', // ★★★ overflow を再追加 ★★★
                            maxHeight: '400px', // ★★★ 最大高さを設定 ★★★
                          },
                          children: [
                            // ★★★ 開始クォーテーション (コンテナでラップ) ★★★
                            {
                              type: 'div', // コンテナ追加
                              props: {
                                style: {
                                  height: `${quoteFontSize * 3 * 0.45}px`, // ★★★ 1.5 -> 5 に戻し、高さを再計算 ★★★
                                  overflow: 'hidden', // はみ出した部分を隠す
                                  display: 'flex', // 中身をflex配置 (垂直位置調整のため)
                                  alignItems: 'flex-start', // 上揃え
                                  alignSelf: 'flex-start', // 右寄せ
                                  marginBottom: '-10px', // 位置調整
                                  marginLeft: '5%', // 右端からのマージン調整
                                },
                                children: [
                                  {
                                    type: 'div', // 元のクォーテーション要素
                                    props: {
                                      style: {
                                        fontSize: `${quoteFontSize * 3}px`, // ★★★ 1.5 -> 5 に戻す ★★★
                                        color: '#a0aec0',
                                        lineHeight: 1, // コンテナ内で詰める
                                        fontFamily: '"Noto Serif JP"',
                                        opacity: 0.8,
                                      },
                                      children: '“',
                                    },
                                  },
                                ],
                              },
                            },
                            // 引用文テキスト
                            {
                              type: 'div',
                              props: {
                                style: {
                                  fontSize: `${quoteFontSize}px`,
                                  fontWeight: 'bold',
                                  color: '#000000', // 元の色に戻す
                                  lineHeight: 1.7,
                                  textAlign: 'center',
                                  fontFamily: '"Noto Serif JP"',
                                  maxWidth: '90%', // 横幅制限
                                  margin: '0 20px', // 左右マージン
                                },
                                children: quote,
                              },
                            },
                            // ★★★ 終了クォーテーション (コンテナでラップ) ★★★
                            {
                              type: 'div', // コンテナ追加
                              props: {
                                style: {
                                  height: `${quoteFontSize * 3 * 0.45}px`, // ★★★ 1.5 -> 5 に戻し、高さを再計算 ★★★
                                  overflow: 'hidden', // はみ出した部分を隠す
                                  display: 'flex', // 中身をflex配置
                                  alignItems: 'flex-start', // 上揃え
                                  alignSelf: 'flex-end', // 右寄せ
                                  marginTop: '-10px', // 位置調整
                                  marginRight: '5%', // 右端からのマージン調整
                                },
                                children: [
                                  {
                                    type: 'div', // 元のクォーテーション要素
                                    props: {
                                      style: {
                                        fontSize: `${quoteFontSize * 3}px`, // ★★★ 1.5 -> 5 に戻す ★★★
                                        color: '#a0aec0',
                                        lineHeight: 1, // コンテナ内で詰める
                                        fontFamily: '"Noto Serif JP"',
                                        opacity: 0.8,
                                      },
                                      children: '”',
                                    },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                      },
                      // --- 下部: 著者情報 & ロゴエリア (変更なし) ---
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-end',
                            width: '100%',
                            marginTop: '30px', // 上の要素とのマージン
                            flexShrink: 0, // ★★★ 縮まないように設定 ★★★
                            fontFamily: '"Noto Sans JP"',
                          },
                          children: [
                            // 左側: 著者情報
                            {
                              type: 'div',
                              props: {
                                style: { display: 'flex', alignItems: 'center' },
                                children: [
                                  authorAvatarUrl ? {
                                    type: 'img',
                                    props: {
                                      src: authorAvatarUrl,
                                      style: { width: '48px', height: '48px', borderRadius: '50%', marginRight: '15px', border: '1px solid #eee' },
                                    },
                                  } : null,
                                  {
                                    type: 'div',
                                    props: {
                                      style: { display: 'flex', flexDirection: 'column' },
                                      children: [
                                        {
                                          type: 'div',
                                          props: { style: { fontSize: '24px', fontWeight: 'bold', color: '#2d3748', lineHeight: 1.3 }, children: author },
                                        },
                                        {
                                          type: 'div',
                                          props: { style: { fontSize: '20px', color: '#718096', lineHeight: 1.3 }, children: title },
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
                                style: { display: 'flex', alignItems: 'center', fontFamily: '"Inter"' },
                                children: [
                                  {
                                    type: 'img',
                                    props: {
                                      // src: '/assets/icon-34.png', // 元のパス - Satori はローカルパスを解決できません
                                      src: 'https://zennq-img.folks-chat.com/assets/icon-34.png', // CDN からのパス
                                      alt: 'zennquotes logo',
                                      style: {
                                        height: '30px',
                                        marginRight: '8px',
                                        objectFit: 'contain'
                                      }
                                    },
                                  },
                                  {
                                    type: 'div',
                                    props: { style: { fontSize: '24px', fontWeight: '600', color: '#4a5568' }, children: 'zennquotes' },
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
        ],
      },
    },
    // Satoriの設定 (変更なし)
    {
      width: 1200,
      height: 630,
      loadAdditionalAsset: loadAdditionalAsset,
      fonts: [
        { name: 'Noto Sans JP', data: fontSans, weight: 400, style: 'normal' },
        { name: 'Noto Serif JP', data: fontSerif, weight: 400, style: 'normal' },
        { name: 'Noto Serif JP', data: fontSerif, weight: 700, style: 'normal' },
        { name: 'Inter', data: fontLogo, weight: 400, style: 'normal' },
        { name: 'Inter', data: fontLogo, weight: 600, style: 'normal' },
      ],
    }
  );

  // ResvgでPNGに変換
  const resvg = new Resvg(svg, {});
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return pngBuffer;
}
