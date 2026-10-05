<!--
	要件#37 追補a(backlog 224・AC-37-追a)のテスト用ホスト。

	`src/routes/+page.svelte` が VideoViewer を置く形を最小で写す:
	- `doc`     = `windowState.currentDocument`。Explorer で同じファイルをもう一度クリック
	              すると `openForDisplay → windowState.setDocument(doc)` が**同じ uri の
	              新しいオブジェクト**を入れる(値は同じ・参照が変わる)
	- `display` = `videoDisplay`($derived.by)。`doc` が差し替わるたびに `{ uri, src }` を
	              組み立て直す ―― 文字列は同じまま、オブジェクトだけが新しくなる
	- `<VideoViewer uri={display.uri} src={display.src} />` = +page.svelte と同じ渡し方
	  (メンバー式なので子の prop getter は `display` を読む=`display` の更新で子の
	  `$effect(() => { void src; … })` が再実行される。`{#key src}` は文字列を比べるので
	  `<video>` は作り直されない=backlog 224 の経路そのもの)

	`reopen()` が「同じファイルをもう一度開く」操作に相当する。
	テスト専用。アプリのコードからは参照しない。
-->
<script lang="ts">
	import VideoViewer from '../VideoViewer.svelte';

	let { uri, src }: { uri: string; src: string } = $props();

	/**
	 * `windowState.currentDocument` 相当。開き直しで同じ uri の新しいオブジェクトになる。
	 * 初期値だけを prop から取るのが意図(文書は一度入ったら `reopen()` で差し替える)。
	 */
	// svelte-ignore state_referenced_locally
	let doc = $state<{ uri: string }>({ uri });

	/** `videoDisplay` 相当。`doc` が差し替わるたびに新しいオブジェクトを返す。 */
	let display = $derived.by(() => ({ uri: doc.uri, src }));

	/** Explorer で同じファイルをもう一度クリックしたときの `setDocument` と同じ形。 */
	export function reopen(): void {
		doc = { uri: doc.uri };
	}
</script>

<VideoViewer uri={display.uri} src={display.src} />
