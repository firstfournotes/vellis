// 要件#72 契約4: `vellis --self-check <file>` の記録スクリプト。
//
// Rust がこのファイルをそのまま `include_str!` で埋め込み(`self_check::RECORDER_JS`)、
// 点検の窓に初期化スクリプトとして入れる=ページのどのスクリプトよりも先に走る。
// vitest(src/lib/self-check-recorder.acceptance.test.ts)も同じファイルを jsdom で評価する。
//
// 純粋な記録役: Tauri のグローバルには触れない。Rust への受け渡しと描画の完了判定は
// reporter.js(点検のときだけ後ろに入る)の持ち場で、ここは `window.__vellisSelfCheck` に
//   - snapshot()     … その時点の記録(契約6 の記録部分=7 キーのプレーンな JSON)
//   - lastRecordAt() … 最後に記録した時刻(Date.now()。契約5 の「500ms 新しい記録が無い」用)
// を出すだけ。import / export を持たない classic script のまま保つこと。
(function () {
	'use strict';
	var w = window;
	if (w.__vellisSelfCheck) return;

	var record = {
		csp: [],
		resource_errors: [],
		console_errors: [],
		script_errors: [],
		rejections: [],
		dialogs: []
	};
	var lastRecordAt = Date.now();

	function push(list, item) {
		list.push(item);
		lastRecordAt = Date.now();
	}

	function str(v) {
		return v === undefined || v === null ? '' : String(v);
	}

	function isErrorLike(v) {
		if (!v || typeof v !== 'object') return false;
		if (Object.prototype.toString.call(v) === '[object Error]') return true;
		return typeof v.message === 'string' && typeof v.name === 'string';
	}

	// console.error の引数・拒否の理由を 1 つの文字列にする。
	function text(v) {
		if (typeof v === 'string') return v;
		if (isErrorLike(v)) return str(v.name) + ': ' + str(v.message);
		if (v && typeof v === 'object') {
			try {
				var json = JSON.stringify(v);
				if (json !== undefined) return json;
			} catch (_) {
				// 循環参照など: 下の String へ
			}
		}
		try {
			return String(v);
		} catch (_) {
			return Object.prototype.toString.call(v);
		}
	}

	function isElement(v) {
		return !!v && typeof v === 'object' && v.nodeType === 1 && typeof v.getAttribute === 'function';
	}

	// --- CSP 違反(document で起き、window の capture 段まで届く) ---
	w.addEventListener(
		'securitypolicyviolation',
		function (ev) {
			push(record.csp, {
				directive: str(ev.effectiveDirective || ev.violatedDirective),
				blocked_uri: str(ev.blockedURI),
				source_file: str(ev.sourceFile),
				line: Math.max(0, Math.trunc(Number(ev.lineNumber) || 0))
			});
		},
		true
	);

	// --- リソースの読み込み失敗(要素の error は泡立たないので capture 段)と未捕捉の例外 ---
	w.addEventListener(
		'error',
		function (ev) {
			var t = ev.target;
			if (isElement(t)) {
				var attr = t.getAttribute('src');
				if (attr === null) attr = t.getAttribute('href');
				push(record.resource_errors, {
					tag: str(t.tagName).toLowerCase(),
					attr: str(attr),
					resolved: str(t.currentSrc || t.src || t.href)
				});
				return;
			}
			if (t === w || t === undefined || t === null) {
				var msg = str(ev.message) || text(ev.error);
				if (ev.filename) msg += ' (' + ev.filename + ':' + str(ev.lineno) + ')';
				push(record.script_errors, msg);
			}
		},
		true
	);

	w.addEventListener(
		'unhandledrejection',
		function (ev) {
			push(record.rejections, text(ev.reason));
		},
		true
	);

	// --- console.error: 記録して元も呼ぶ ---
	var con = w.console;
	if (con) {
		var originalError = con.error;
		con.error = function () {
			var parts = [];
			for (var i = 0; i < arguments.length; i++) parts.push(text(arguments[i]));
			push(record.console_errors, parts.join(' '));
			if (typeof originalError === 'function') {
				return originalError.apply(con, arguments);
			}
		};
	}

	// --- alert / confirm / prompt: 記録だけ。ネイティブのダイアログは出さない ---
	w.alert = function (message) {
		push(record.dialogs, { kind: 'alert', message: str(message) });
	};
	w.confirm = function (message) {
		push(record.dialogs, { kind: 'confirm', message: str(message) });
		return true;
	};
	w.prompt = function (message) {
		push(record.dialogs, { kind: 'prompt', message: str(message) });
		return null;
	};

	// 本文中の vellis-asset:// の画像のうち、決着したものを数える(未決着は数えない)。
	function assetImages() {
		var loaded = 0;
		var failed = 0;
		var doc = w.document;
		var imgs = doc
			? doc.querySelectorAll('article.viewer .markdown-body img[src^="vellis-asset://"]')
			: [];
		for (var i = 0; i < imgs.length; i++) {
			var img = imgs[i];
			if (!img.complete) continue;
			if (img.naturalWidth > 0) loaded++;
			else failed++;
		}
		return { loaded: loaded, failed: failed };
	}

	function copy(list) {
		return JSON.parse(JSON.stringify(list));
	}

	w.__vellisSelfCheck = {
		snapshot: function () {
			return {
				csp: copy(record.csp),
				resource_errors: copy(record.resource_errors),
				console_errors: copy(record.console_errors),
				script_errors: copy(record.script_errors),
				rejections: copy(record.rejections),
				dialogs: copy(record.dialogs),
				asset_images: assetImages()
			};
		},
		lastRecordAt: function () {
			return lastRecordAt;
		}
	};
})();
