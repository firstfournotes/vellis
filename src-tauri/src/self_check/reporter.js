// 要件#72 契約5: `vellis --self-check <file>` の完了判定と Rust への受け渡し。
//
// 点検のときだけ、recorder.js の後ろに初期化スクリプトとして入る(通常の起動には入らない)。
// Rust は先頭に `window.__vellisSelfCheckConfig = {quiet_ms, poll_ms, event}` を足して埋め込む。
//
// 完了 = 本文(article.viewer .markdown-body)が描画され、Mermaid の処理が終わり、本文の
// <img> がすべて決着し、そのあと quiet_ms 新しい記録が無い時点。完了したら記録を
// Tauri の event(`event`)で 1 回だけ送る。30 秒の時間切れは Rust が持ち、
// `window.__vellisSelfCheckReport('timeout')` を eval してその時点の記録を送らせる。
(function () {
	'use strict';
	var w = window;
	if (w.__vellisSelfCheckReport) return;
	var cfg = w.__vellisSelfCheckConfig || {};
	var QUIET_MS = cfg.quiet_ms || 500;
	var POLL_MS = cfg.poll_ms || 100;
	var EVENT = cfg.event;
	var sent = false; // 送っている途中か送り終えた
	var delivered = false; // 送り終えた
	var settledAt = 0;

	function settled() {
		var doc = w.document;
		var body = doc && doc.querySelector('article.viewer .markdown-body');
		if (!body || body.childElementCount === 0) return false;
		if (body.querySelector('.vellis-mermaid:not(.vellis-mermaid-rendered)')) return false;
		var imgs = body.querySelectorAll('img');
		for (var i = 0; i < imgs.length; i++) {
			if (!imgs[i].complete) return false;
		}
		return true;
	}

	function send(status) {
		var recorder = w.__vellisSelfCheck;
		var internals = w.__TAURI_INTERNALS__;
		if (sent || !recorder || !internals || !EVENT) return;
		sent = true;
		var payload = { status: status, snapshot: recorder.snapshot() };
		Promise.resolve(internals.invoke('plugin:event|emit', { event: EVENT, payload: payload })).then(
			function () {
				delivered = true;
			},
			function () {
				// 送れなかったら次の機会(ポーリング・時間切れ)にもう一度
				sent = false;
			}
		);
	}

	w.__vellisSelfCheckReport = function (status) {
		send(status === 'done' ? 'done' : 'timeout');
	};

	function tick() {
		if (delivered) return;
		setTimeout(tick, POLL_MS);
		if (sent) return;
		var now = Date.now();
		if (settled()) {
			if (!settledAt) settledAt = now;
			var recorder = w.__vellisSelfCheck;
			var last = recorder ? recorder.lastRecordAt() : 0;
			if (now - Math.max(settledAt, last) >= QUIET_MS) {
				send('done');
			}
		} else {
			settledAt = 0;
		}
	}
	setTimeout(tick, POLL_MS);
})();
