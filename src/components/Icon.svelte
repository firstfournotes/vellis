<!--
	アイコン 1 つ(要件#56 契約 5・判断 (i))。字形は持たない: `+page.svelte` の sprite に
	モック(docs/review/ui-mock.html)から写した symbol があり、ここは名前で参照するだけ。
	名前はモックの id から先頭の「i-」を除いたもの(例 `x`・`chev-d`)。

	線は文字の色(currentColor)で描くので、置いた先の `color` がそのままアイコンの色になる。
	読み上げには出さない(ボタンの名前は aria-label か文言が持つ)。
-->
<script lang="ts">
	let { name, size = 16 }: { name: string; size?: number } = $props();
</script>

<svg
	class="ui-icon"
	viewBox="0 0 24 24"
	width={size}
	height={size}
	aria-hidden="true"
	fill="none"
	stroke="currentColor"
	stroke-width="1.7"
	stroke-linecap="round"
	stroke-linejoin="round"><use href={`#i-${name}`} /></svg
>

<style>
	.ui-icon {
		display: block;
		flex: none;
		overflow: visible;
	}
</style>
