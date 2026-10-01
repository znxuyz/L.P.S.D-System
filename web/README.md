# 台股資金攻城戰（原型）

L.P.L.C.-System 的第一個視覺化模組。把股票熱力圖（Voronoi Treemap）重新設計成「資金攻城戰」：
產業是圍在外圈的領地，股票是領地內的據點，中央是中立戰場，各產業把資金往中間的城池推進。目前使用 **mock 行情**，資料層已抽象化，之後可以直接換成富果或證交所資料。

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
| 版面 | 中央戰場是和地圖等比例的橢圓（20% 面積）；外圈依市值切成扇形，從正上方順時針排列 |
| 城池位置 | 正中央 1 座核心城池（所有產業都能進攻）、內圈 4 座大型城池（面向約三個產業）、外圈 7 座小型據點（面向兩個相鄰產業） |
| 占領度 | 攻城資金 ÷（各方攻城資金 + 守城兵力）；攻城資金 = max(資金流, 0) |
| 守城兵力 | 今日總成交額 × 1% × 城池規模（核心 1.6、大型 1.0、小型 0.6） |
| 攻擊深度 | 攻城資金 ÷（攻城資金 + 守城兵力），資金越大推進越深 |

攻擊與撤退只用粒子流、前線、城牆與旗幟顏色表現，不改變面積。

## 結構

```
src/
  data/       資料層：型別、MarketDataProvider 介面、mock 股票池與模擬行情
  domain/     資金流（metrics.ts）與城池占領度（castles.ts），純函式
  layout/     外圈扇形領地、中央戰場與城池、個股 Voronoi 區塊（battlefield.ts）
  ui/         戰場 SVG + 粒子 Canvas（battlefieldView.ts）、各資訊面板（panels.ts）
  main.ts     組裝：provider → metrics → castles → view / panels
```

接真實資料時，實作 `src/data/provider.ts` 的 `MarketDataProvider`，
把行情轉成 `src/data/types.ts` 的格式即可，UI 與領域邏輯不需要修改。
