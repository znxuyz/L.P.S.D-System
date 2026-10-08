// 讓 Node 直接執行網頁共用的 TypeScript 模組：沒寫副檔名的相對路徑自動補上 .ts
// （網頁端用打包工具，import 可以省略副檔名；Node 不行）
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(specifier)) {
        try { return await next(specifier + '.ts', context); } catch {}
      }
      return next(specifier, context);
    }`),
  import.meta.url,
);
