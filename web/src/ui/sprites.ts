/**
 * 8×8 像素圖示。每個產業一種地形，讓世界地圖上一眼認出是哪個王國。
 * 字元對應調色盤，'.' 是透明。
 */

type Sprite = { rows: string[]; palette: Record<string, string> };

const BROWN = '#8b5a2b';

export const KINGDOMS: Record<string, { title: string; sprite: Sprite }> = {
  semi: {
    title: '半導體山脈',
    sprite: {
      rows: ['...W....', '..WWW...', '..GWG.W.', '.GGGGWWW', '.GGGGGGG', 'GGDGGGGD', 'GDDDGDDD', 'DDDDDDDD'],
      palette: { W: '#f8f9fa', G: '#9aa3b5', D: '#5b6378' },
    },
  },
  comp: {
    title: '零組件礦坑',
    sprite: {
      rows: ['...C....', '..CCC...', '.CCLCC..', '.CLCCC.C', '..CCC.CC', '...C..CC', '..DDDDD.', '.DDDDDDD'],
      palette: { C: '#74c0fc', L: '#e7f5ff', D: '#6b5444' },
    },
  },
  pc: {
    title: '電腦森林',
    sprite: {
      rows: ['...GG...', '..GGGG..', '.GGLGGG.', '.GGGGLG.', 'GGLGGGGG', '.GGGGGG.', '...BB...', '...BB...'],
      palette: { G: '#2f9e44', L: '#8ce99a', B: BROWN },
    },
  },
  oe: {
    title: '電子村',
    sprite: {
      rows: ['...RR...', '..RRRR..', '.RRRRRR.', 'RRRRRRRR', '.WWWWWW.', '.WDWWDW.', '.WWBBWW.', '.WWBBWW.'],
      palette: { R: '#4c6ef5', W: '#f1f3f5', D: '#364fc7', B: BROWN },
    },
  },
  net: {
    title: '通信高塔',
    sprite: {
      rows: ['...Y....', '..YWY...', '...S....', '..SSS...', '..SDS...', '..SSS...', '.SSSSS..', 'SSSSSSS.'],
      palette: { Y: '#ffd43b', W: '#fff9db', S: '#ced4da', D: '#495057' },
    },
  },
  opto: {
    title: '光電聖域',
    sprite: {
      rows: ['...Y....', '...Y....', 'YYYWYYY.', '.YYYYY..', '..YYY...', '.YY.YY..', 'YY...YY.', '........'],
      palette: { Y: '#ffd43b', W: '#fff9db' },
    },
  },
  mech: {
    title: '機械工坊',
    sprite: {
      rows: ['..G.G...', '.GGGGG..', 'GGG.GGG.', '.G...G..', 'GGG.GGG.', '.GGGGG..', '..G.G...', '........'],
      palette: { G: '#adb5bd' },
    },
  },
  bio: {
    title: '生技藥園',
    sprite: {
      rows: ['...BB...', '...WW...', '..W..W..', '.W.PP.W.', '.WPPPPW.', '.WPPLPW.', '..WWWW..', '........'],
      palette: { P: '#be4bdb', L: '#f3d9fa', W: '#e9ecef', B: BROWN },
    },
  },
  trad: {
    title: '傳產麥田',
    sprite: {
      rows: ['Y..Y..Y.', 'YY.YY.YY', '.Y..Y..Y', '.G..G..G', '.G..G..G', '.G..G..G', 'GGGGGGGG', 'BBBBBBBB'],
      palette: { Y: '#fcc419', G: '#82c91e', B: BROWN },
    },
  },
  plastic: {
    title: '塑化火山',
    sprite: {
      rows: ['..O.O...', '...O....', '...DD...', '..DOD...', '.DDDDD..', '.DDDDDD.', 'DDDDDDDD', 'DDDDDDDD'],
      palette: { O: '#ff922b', D: '#5c3d2e' },
    },
  },
  steel: {
    title: '鋼鐵鍛造場',
    sprite: {
      rows: ['......S.', '.....SS.', '....SS..', '...SS...', 'Y.SS....', '.YY.....', '.BY.....', 'B.......'],
      palette: { S: '#dee2e6', Y: '#fcc419', B: BROWN },
    },
  },
  ship: {
    title: '航運港',
    sprite: {
      rows: ['...W....', '...WW...', '...WWW..', '...W....', 'BBBBBBBB', '.BBBBBB.', 'AAAAAAAA', '.AA.AA.A'],
      palette: { W: '#f8f9fa', B: BROWN, A: '#4dabf7' },
    },
  },
  fin: {
    title: '金融王城',
    sprite: {
      rows: ['S.S..S.S', 'SSS..SSS', 'SSSSSSSS', 'SDSSSSDS', 'SSSSSSSS', 'SSSYYSSS', 'SSSDDSSS', 'SSSDDSSS'],
      palette: { S: '#dbe4ff', D: '#3b3b58', Y: '#ffd43b' },
    },
  },
};

/** 金幣（吸金最強的領地上方會跳動）。 */
export const COIN: Sprite = {
  rows: ['..YYYY..', '.YWWYYY.', 'YWYYYYOY', 'YWYYYYOY', 'YYYYYYOY', 'YYYYYOOY', '.YYOOOY.', '..YYYY..'],
  palette: { Y: '#ffd43b', W: '#fff9db', O: '#f59f00' },
};

/** RPG 選單游標（指向選取的領地）。 */
export const CURSOR: Sprite = {
  rows: ['W.......', 'WW......', 'WWW.....', 'WWWW....', 'WWWW....', 'WWW.....', 'WW......', 'W.......'],
  palette: { W: '#ffffff' },
};

const FALLBACK: Sprite = KINGDOMS.oe.sprite;

export function kingdomOf(industryId: string): { title: string; sprite: Sprite } {
  return KINGDOMS[industryId] ?? { title: industryId, sprite: FALLBACK };
}

/** 在 canvas 上畫出像素圖，左上角 (x, y)，每個像素 px 大小。 */
export function drawSprite(ctx: CanvasRenderingContext2D, sprite: Sprite, x: number, y: number, px: number): void {
  sprite.rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const c = sprite.palette[row[rx]];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x + rx * px), Math.round(y + ry * px), Math.ceil(px), Math.ceil(px));
    }
  });
}

const urlCache = new Map<string, string>();

/** 把產業圖示轉成 data URL，給 HTML 面板用。 */
export function spriteUrl(industryId: string): string {
  const cached = urlCache.get(industryId);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  drawSprite(ctx, kingdomOf(industryId).sprite, 0, 0, 2);
  const url = canvas.toDataURL();
  urlCache.set(industryId, url);
  return url;
}
