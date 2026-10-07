# 自己点検: CSP 違反を仕込んだ文書(要件72 AC-72-8 (2))

`vellis --self-check fixtures/self-check/csp-violation.md` で `csp` が 1 件以上になり、
`scripts/self-check-judge.mjs` が不合格(終了コード 1)を返すことを /verify で確かめる。

## 外部 `https://` の画像(`img-src` に https: は無い)

![external image](https://example.com/vellis-self-check/does-not-exist.png)

## 相対パスの画像(こちらは許可された `vellis-asset://` 経路。違反にならない対照)

![Vellis Logo](../images/logo.png)
