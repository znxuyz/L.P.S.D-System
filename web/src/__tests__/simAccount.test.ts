import { describe, expect, it } from 'vitest';
import { hashCode, normalizeCode, verifyCode } from '../data/simAccount';

describe('模擬盤開通碼', () => {
  const salt = 'abc123';
  const code = 'LPLC-ABCD-EFGH-JKMN-PQRS';
  // sha256('abc123LPLCABCDEFGHJKMNPQRS')，和 scripts/sim-code.mjs 的算法相同
  const id = '31f2bbb10ff449114570d7ce73ec47718ed538add6805fcc9d4473f21fccf43d';

  it('不分大小寫、忽略空白與連字號', () => {
    expect(normalizeCode(' lplc-abcd efgh-jkmn-pqrs ')).toBe('LPLCABCDEFGHJKMNPQRS');
  });

  it('和產生開通碼的腳本用同樣的雜湊', async () => {
    expect(await hashCode(code, salt)).toBe(id);
    expect(await verifyCode('lplc abcd efgh jkmn pqrs', { salt, codes: [{ id, label: 'A' }] })).toEqual({ id, label: 'A' });
    expect(await verifyCode('LPLC-ABCD-EFGH-JKMN-PQRT', { salt, codes: [{ id, label: 'A' }] })).toBeNull();
  });
});
