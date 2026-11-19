import { describe, expect, it } from 'vitest';
import { usMove } from '../../../scripts/lib/usMove';

const rows: Array<[string, number, number, number, number]> = [
  ['2026-11-12', 0, 0, 0, 100], // 週四
  ['2026-11-13', 0, 0, 0, 102], // 週五
  ['2026-11-16', 0, 0, 0, 101], // 週一
];

describe('usMove（台股開盤前看得到的美股）', () => {
  it('台股週一：用美國週五的漲跌（台股上一個交易日是週五）', () => {
    expect(usMove(rows, '2026-11-13', '2026-11-16')).toBeCloseTo(Math.log(102 / 100));
  });
  it('台股週二：用美國週一', () => {
    expect(usMove(rows, '2026-11-16', '2026-11-17')).toBeCloseTo(Math.log(101 / 102));
  });
  it('晚上存檔時（美國當天還沒收盤）：不知道 → NaN', () => {
    expect(usMove(rows, '2026-11-17', '9999-12-31')).toBeNaN();
  });
  it('早上存檔時（美國前一天已經收盤）：用它', () => {
    expect(usMove(rows, '2026-11-16', '9999-12-31')).toBeCloseTo(Math.log(101 / 102));
  });
});
