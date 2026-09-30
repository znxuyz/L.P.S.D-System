# 台股資金攻城戰（原型）

把股票熱力圖（Voronoi Treemap）重新設計成「資金攻城戰」：產業是領地、股票是領地內的據點，
產業交界處的白色城池是待爭奪的資金據點。目前使用 **mock 行情**，資料層已抽象化，之後可以直接換成富果或證交所資料。

## 開發

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm test           # 資金流、城池、幾何與版面測試
npm run build      # 型別檢查 + 打包到 dist/
```

## 規則

| 項目 | 定義 |
|---|---|
| 領地／據點面積 | 市值（以昨收計，盤中不重新配置） |
| 據點顏色 | 漲跌幅，預設紅漲綠跌，可切換 |
| 資金流 | （今日成交佔比 − 20 日平均成交佔比）× 今日總成交額；所有產業加總為 0 |
| 城池位置 | 三個以上領地交會處（內部），或兩個領地在地圖邊緣交會處（邊境據點） |
| 占領度 | 攻城資金 ÷（各方攻城資金 + 守城兵力）；攻城資金 = max(資金流, 0) |
| 守城兵力 | 今日總成交額 × 1% × 城池規模（核心 1.6、大型 1.0、小型 0.6） |
| 攻擊深度 | 攻城資金 ÷（攻城資金 + 守城兵力），資金越大推進越深 |

攻擊與撤退只用粒子流、前線、城牆與旗幟顏色表現，不改變面積。

## 結構

```
src/
  data/       資料層：型別、MarketDataProvider 介面、mock 股票池與模擬行情
  domain/     資金流（metrics.ts）與城池占領度（castles.ts），純函式
  layout/     Voronoi 領地、城池挖空、股票區塊（battlefield.ts）
  ui/         戰場 SVG + 粒子 Canvas（battlefieldView.ts）、各資訊面板（panels.ts）
  main.ts     組裝：provider → metrics → castles → view / panels
```

接真實資料時，實作 `src/data/provider.ts` 的 `MarketDataProvider`，
把行情轉成 `src/data/types.ts` 的格式即可，UI 與領域邏輯不需要修改。
