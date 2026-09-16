# 文字入力タスク

`phrase_set.csv` の study 1 / practice / set 1（5 フレーズ）を順番に出題する、iPhone ブラウザ向けの小さなウェブアプリです。

## 起動

リポジトリのルートでローカル HTTP サーバーを起動します。

```sh
python3 -m http.server 8000
```

同じネットワーク上の iPhone から `http://<開発マシンのIPアドレス>:8000/` を開いてください。`index.html` を `file://` で直接開く方法では CSV を読み込めません。

全フレーズに回答すると、participant ID と各フレーズの結果を含む UTF-8 CSV がダウンロードされます。
