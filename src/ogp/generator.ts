import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

// TODO: フォントデータを読み込む (例: Noto Sans JP)
// const fontData = fs.readFileSync('./assets/NotoSansJP-Regular.otf');

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
    // ここでは簡単な正規表現の例 (堅牢性は低い)
    const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"\s*\/?>/i);
    // Zennの記事では description に著者名が入っていることが多い
    const authorMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"\s*\/?>/i);

    let title = titleMatch ? titleMatch[1] : 'タイトル不明';
    let author = authorMatch ? authorMatch[1] : '著者不明';

    // zenn:description が存在すればそちらを優先 (より確実な著者名)
    const zennDescMatch = html.match(/<meta\s+name="zenn:description"\s+content="([^"]+)"\s*\/?>/i);
    if (zennDescMatch) {
      author = zennDescMatch[1];
    }

    // HTMLエンティティをデコードする必要がある場合がある
    // 例: import { decode } from 'html-entities';
    // title = decode(title);
    // author = decode(author);

    // XSS対策: 簡単なサニタイズ (より堅牢なライブラリ推奨)
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
 * @param fontData フォントファイルの ArrayBuffer
 * @returns PNG画像のUint8Array
 */
export async function generateOgpImage(
  quote: string,
  title: string,
  author: string,
  fontData: ArrayBuffer // フォントデータを引数で受け取る
): Promise<Uint8Array> {

  // SatoriでSVGを生成
  const svg = await satori(
    // JSXライクな構文でテンプレートを記述
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between', // 上下に要素を配置
          width: 1200,
          height: 630,
          padding: '60px', // パディング調整
          backgroundColor: '#f8f8f8', // 背景色変更
          border: '1px solid #e0e0e0', // 枠線調整
          borderRadius: '10px', // 角丸
          fontFamily: '"Noto Sans JP"', // フォント名を指定
        },
        children: [
          // 上部: 引用文
          {
            type: 'div',
            props: {
              style: {
                fontSize: '48px', // フォントサイズ調整
                color: '#333', // 文字色調整
                lineHeight: 1.6, // 行間調整
                marginBottom: '40px', // マージン調整
                // テキストの折り返しや省略設定
                overflow: 'hidden',
                display: '-webkit-box',
                webkitBoxOrient: 'vertical',
                webkitLineClamp: 5, // 最大5行まで表示
              },
              children: `“${quote}”`, // 引用符で囲む
            },
          },
          // 下部: タイトルと著者
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end', // 右寄せ
                borderTop: '1px solid #eee', // 区切り線
                paddingTop: '30px', // 区切り線とのスペース
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '40px', // フォントサイズ調整
                      fontWeight: 'bold',
                      color: '#111', // 文字色調整
                      marginBottom: '15px', // マージン調整
                      // 長いタイトル用の省略設定
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
                      fontSize: '32px', // フォントサイズ調整
                      color: '#666', // 文字色調整
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
          name: 'Noto Sans JP', // JSX内のfontFamilyと一致させる
          data: fontData, // 読み込んだフォントデータ
          weight: 400,
          style: 'normal',
        },
        // 必要に応じて他のウェイトやスタイルも追加
        // { name: 'Noto Sans JP', data: fontBoldData, weight: 700, style: 'normal' },
      ],
    }
  );

  // ResvgでPNGに変換
  const resvg = new Resvg(svg, {
    // Resvgの設定 (必要に応じて)
    // fitTo: {
    //   mode: 'width',
    //   value: 1200,
    // },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return pngBuffer;
}
