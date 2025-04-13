// .ttf ファイルを ArrayBuffer としてインポートできるようにする型定義
declare module '*.ttf' {
  const content: ArrayBuffer;
  export default content;
}

// Cloudflare Bindings の型定義 (必要に応じて拡張)
// wrangler.jsonc で設定したバインディングをここに記述すると
// c.env からアクセスする際に型補完が効くようになります。
// (index.ts 内の Bindings 型定義と重複しますが、
//  グローバルな型定義としてこちらにも記述しておくと便利な場合があります)
// interface CloudflareEnv {
//   R2_BUCKET: R2Bucket;
//   D1_DB: D1Database;
// }
