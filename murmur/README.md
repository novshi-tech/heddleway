# Murmur

トピック索引（表の名前。`docs/adr/0040`）。やりとりをトピックにまとめ、誰の番かを追う。API ゲートウェイの Worker の機能として動き
（`docs/adr/0023`）、エージェント（Claude など）が裏で読んで「いまやるべきこと」に答える。

- 計画: [docs/PLAN.md](docs/PLAN.md)（実装の順序と仮説 H1〜H7）
- 開発の約束事と構成: [CLAUDE.md](CLAUDE.md)
- 決定の記録: [docs/adr/](docs/adr/)
- 有効にする手順と接続: [docs/stand/connect.md](docs/stand/connect.md)（エージェント用スキルは同じリポジトリのプラグイン `heddleway` の `topic-index` スキル、`../plugins/heddleway`）
- シナリオ: [fixtures/](fixtures/)

```sh
npm install
npm test
npm run scenario verify all
```
