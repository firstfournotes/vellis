<script lang="ts">
	import {
		AmbientLight,
		Box3,
		Color,
		DirectionalLight,
		Group,
		HemisphereLight,
		PerspectiveCamera,
		Scene,
		WebGLRenderer,
		type Object3D,
	} from 'three';
	import { listen } from '$lib/events';
	import { applyCameraDelta, cameraPosition, type CameraState } from '$lib/model-camera';
	import { parseModel } from '$lib/model-viewing';
	import { spaceMouseToCameraDelta, type SpaceMouseAxes } from '$lib/spacemouse';

	let {
		uri,
		src,
	}: {
		/** 表示中のファイルの絶対 URI(file: / ssh:)。パースの形式判定と表示名に使う。 */
		uri: string;
		/**
		 * モデル本体を取りにいく `vellis-asset:` URI(`renderForDisplay` が組み立て、
		 * 変更のたび版数が付く)。この文字列が変わったら読み直す。
		 */
		src: string;
	} = $props();

	/**
	 * 読み込む上限(要件#23 ⑥)。スキャン由来の STL は 100MB 級があり、
	 * パースは WebView のメインスレッドを塞ぐ。上限を超えたファイルは黙って
	 * 固まるのではなくメッセージにして返す — 表示できないことが分かるほうが、
	 * 数十秒無反応になるより良い(判断は実装側 = docs/3d-model-viewing.md §3 のリスク項)。
	 */
	const MAX_BYTES = 256 * 1024 * 1024;

	/** 視野角(deg)。初期カメラの距離もこの値から決まる。 */
	const FOV = 45;

	/** 1px ドラッグあたりの回転量(rad)。1画面ぶきのドラッグでおよそ半周する。 */
	const ROTATE_PER_PIXEL = 0.008;

	/** ホイール 1 単位あたりのズーム係数の指数。手前へ回すと寄る。 */
	const ZOOM_PER_WHEEL = 0.0015;

	/** 初期視点の振り(rad)。旧 yaw/pitch 仕様と同じ「斜め上前方」の見え方。 */
	const INITIAL_YAW = 0.6;
	const INITIAL_PITCH = 0.4;

	type LoadState =
		| { kind: 'loading' }
		| { kind: 'ready'; triangleCount: number }
		| { kind: 'error'; message: string };

	let stage = $state<HTMLDivElement | null>(null);
	let load = $state<LoadState>({ kind: 'loading' });

	let fileName = $derived(uri.slice(uri.lastIndexOf('/') + 1));

	// --- three.js 側の可変物 ------------------------------------------------
	// Svelte の $state には載せない: 毎フレーム触る対象をリアクティブにしても
	// 得がなく、描画は `requestRender` が明示的に回す(常時 rAF は回さない)。
	let renderer: WebGLRenderer | null = null;
	let scene: Scene | null = null;
	let camera: PerspectiveCamera | null = null;
	let modelRoot: Group | null = null;
	let renderPending = false;

	/** 現在のカメラ状態。マウスも SpaceMouse(要件#24)もここへデルタを書く。 */
	let cameraState: CameraState = { target: [0, 0, 0], distance: 10, orientation: [0, 0, 0, 1] };
	/** 初期カメラ(「視点をリセット」で戻る先)。 */
	let initialCameraState: CameraState = cameraState;
	/** モデルの代表寸法。パン量とクリップ面の基準。 */
	let modelRadius = 1;

	/** 描画を1フレーム後に1回だけ回す。連続した状態変化をまとめる。 */
	function requestRender(): void {
		if (renderPending || !renderer || !scene || !camera) return;
		renderPending = true;
		requestAnimationFrame(() => {
			renderPending = false;
			if (!renderer || !scene || !camera) return;
			renderer.render(scene, camera);
		});
	}

	/**
	 * カメラ状態(VM)を three.js のカメラへ写す。写像はこの1箇所だけ。
	 *
	 * `orientation` は three.js の既定カメラと同じ規約(−Z 視・up +Y)なので
	 * `camera.quaternion` へそのまま入る。`lookAt` は使わない — ロール(要件#26)は
	 * 「どちらが上か」ごと姿勢に含まれており、lookAt は up を +Y へ引き戻して
	 * それを捨ててしまう。
	 */
	function syncCamera(): void {
		if (!camera) return;
		const [x, y, z] = cameraPosition(cameraState);
		camera.position.set(x, y, z);
		camera.quaternion.set(...cameraState.orientation);
		camera.near = Math.max(cameraState.distance / 1000, modelRadius / 1000, 1e-4);
		camera.far = cameraState.distance + modelRadius * 20;
		camera.updateProjectionMatrix();
		requestRender();
	}

	/** マウス・(要件#24 では SpaceMouse)からのデルタを適用する唯一の入口。 */
	function applyDelta(delta: Parameters<typeof applyCameraDelta>[1]): void {
		cameraState = applyCameraDelta(cameraState, delta);
		syncCamera();
	}

	/** three.js の入れ物を1度だけ組む(ライティングは固定・モデルだけ差し替える)。 */
	function ensureScene(host: HTMLDivElement): void {
		if (renderer) return;
		// 背景は描かない(alpha)。テーマ追従は canvas の CSS 背景に任せる —
		// クリア色をテーマから読むより、テーマ切替に自動で追いつく(要件#16 ⑤と同じ考え)。
		renderer = new WebGLRenderer({ antialias: true, alpha: true });
		renderer.setPixelRatio(window.devicePixelRatio);
		renderer.setClearAlpha(0);
		host.appendChild(renderer.domElement);

		scene = new Scene();
		scene.background = null;
		// 天空光 + 前方からの主光 + 環境光。CAD ビューアの常識的な既定で、
		// 単色マテリアルでも面の向きが読める明るさにしてある。
		scene.add(new HemisphereLight(new Color(0xffffff), new Color(0x444450), 1.6));
		const key = new DirectionalLight(0xffffff, 1.8);
		key.position.set(1, 1.5, 1);
		scene.add(key);
		const fill = new DirectionalLight(0xffffff, 0.6);
		fill.position.set(-1, -0.5, -1);
		scene.add(fill);
		scene.add(new AmbientLight(0xffffff, 0.5));

		modelRoot = new Group();
		scene.add(modelRoot);

		camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);
		resize();
	}

	/** 描画面をコンテナの大きさに合わせる。 */
	function resize(): void {
		if (!renderer || !camera || !stage) return;
		const width = Math.max(stage.clientWidth, 1);
		const height = Math.max(stage.clientHeight, 1);
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		requestRender();
	}

	/** バウンディングボックス全体が画面に収まるカメラ状態(初期視点)。 */
	function frameBounds(bounds: { min: [number, number, number]; max: [number, number, number] }) {
		const center: [number, number, number] = [
			(bounds.min[0] + bounds.max[0]) / 2,
			(bounds.min[1] + bounds.max[1]) / 2,
			(bounds.min[2] + bounds.max[2]) / 2,
		];
		const radius =
			Math.max(
				Math.hypot(
					bounds.max[0] - bounds.min[0],
					bounds.max[1] - bounds.min[1],
					bounds.max[2] - bounds.min[2],
				) / 2,
				1e-6,
			) || 1;
		modelRadius = radius;
		// 半径ぶんの球が視野に収まる距離に、少し余裕(1.4倍)を持たせる。
		const distance = (radius / Math.sin((FOV * Math.PI) / 360)) * 1.4;
		// 斜め上前方から見下ろす向き。真正面より立体が分かりやすい。正面(単位姿勢)
		// から画面縦軸に INITIAL_YAW・横軸に −INITIAL_PITCH(上へ回り込む向き)。
		const front: CameraState = { target: center, distance, orientation: [0, 0, 0, 1] };
		return applyCameraDelta(applyCameraDelta(front, { rotateY: INITIAL_YAW }), {
			rotateX: -INITIAL_PITCH,
		});
	}

	/** 前のモデルを外して GPU 資源を解放する(ファイル切替・変更再読込のたび)。 */
	function disposeModel(): void {
		if (!modelRoot) return;
		for (const child of [...modelRoot.children]) {
			modelRoot.remove(child);
			child.traverse((node: Object3D) => {
				const mesh = node as { geometry?: { dispose(): void }; material?: unknown };
				mesh.geometry?.dispose();
				const material = mesh.material;
				for (const m of Array.isArray(material) ? material : [material]) {
					(m as { dispose?: () => void } | undefined)?.dispose?.();
				}
			});
		}
	}

	/**
	 * モデルを取りに行って描く。`src` が変わるたびに走る(初回表示・ファイル切替・
	 * `binary_file_changed` による版数の更新 = 要件#22 の機構)。
	 */
	async function loadModel(assetSrc: string, host: HTMLDivElement): Promise<void> {
		load = { kind: 'loading' };
		try {
			const response = await fetch(assetSrc);
			if (!response.ok) throw new Error(`読み込みに失敗しました(HTTP ${response.status})`);
			const buffer = await response.arrayBuffer();
			if (buffer.byteLength > MAX_BYTES) {
				const mb = Math.round(buffer.byteLength / (1024 * 1024));
				throw new Error(`ファイルが大きすぎます(${mb}MB。上限 256MB)`);
			}
			const model = await parseModel(uri, buffer);

			ensureScene(host);
			disposeModel();
			modelRoot?.add(model.object);

			initialCameraState = frameBounds(model.bounds);
			cameraState = initialCameraState;
			resize();
			syncCamera();
			load = { kind: 'ready', triangleCount: model.triangleCount };
		} catch (error) {
			disposeModel();
			load = {
				kind: 'error',
				message: error instanceof Error ? error.message : 'モデルを表示できませんでした',
			};
		}
	}

	// --- マウス操作(要件#23): イベント → デルタ → VM の一方向 --------------
	// 左ドラッグ=回転・右ドラッグ=パン・ホイール=ズーム。ボタンごとの意味づけは
	// ここだけが持ち、動きの合成は `applyCameraDelta` に任せる。
	let drag: { pointerId: number; mode: 'rotate' | 'pan'; x: number; y: number } | null = null;

	function onPointerDown(event: PointerEvent): void {
		if (load.kind !== 'ready') return;
		const mode = event.button === 0 ? 'rotate' : event.button === 2 ? 'pan' : null;
		if (mode === null) return;
		drag = { pointerId: event.pointerId, mode, x: event.clientX, y: event.clientY };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		event.preventDefault();
	}

	function onPointerMove(event: PointerEvent): void {
		if (!drag || drag.pointerId !== event.pointerId) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		drag = { ...drag, x: event.clientX, y: event.clientY };
		if (drag.mode === 'rotate') {
			// トラックボール(要件#26): 横ドラッグ = 画面縦軸回り・縦ドラッグ =
			// 画面横軸回り。どちらも負符号なのは「モデルを掴んで転がす」向き —
			// 右へ引けばモデルの右面が手前に来る(= カメラは左へ回り込む)。
			// 見た目の向きは旧ターンテーブル(yaw:-dx・pitch:+dy)と同じ。
			applyDelta({ rotateY: -dx * ROTATE_PER_PIXEL, rotateX: -dy * ROTATE_PER_PIXEL });
			return;
		}
		// パンは「掴んだ点が指について来る」量。画面 1px が world で何単位かは
		// 距離と視野角で決まる(target を逆向きに動かすとモデルが指に付いてくる)。
		const height = Math.max(stage?.clientHeight ?? 1, 1);
		const unitsPerPixel =
			(2 * cameraState.distance * Math.tan((FOV * Math.PI) / 360)) / height;
		applyDelta({ panX: -dx * unitsPerPixel, panY: dy * unitsPerPixel });
	}

	function onPointerUp(event: PointerEvent): void {
		if (!drag || drag.pointerId !== event.pointerId) return;
		const host = event.currentTarget as HTMLElement;
		if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
		drag = null;
	}

	function onWheel(event: WheelEvent): void {
		if (load.kind !== 'ready') return;
		event.preventDefault();
		applyDelta({ zoom: Math.exp(event.deltaY * ZOOM_PER_WHEEL) });
	}

	// --- SpaceMouse 操作(要件#24): Rust の HID 読み → イベント → 同じ VM ------
	// 軸の割り当てと不感帯・感度は `spacemouse.ts` が持ち、ここは「表示中だけ
	// 聞く」「パン量を今の距離に合わせる」の 2 点だけを足す。

	/** フル倒し 1 イベントで画面高の何割ぶんパンするか。 */
	const SPACEMOUSE_PAN_SCREEN_FRACTION = 0.015;

	function onSpaceMouseInput(axes: SpaceMouseAxes): void {
		if (load.kind !== 'ready') return;
		// パンだけは world 単位なので、マウスのドラッグと同じ考えで
		// 「今見えている高さ」から換算する(寄っているときは細かく動く)。
		const visibleHeight = 2 * cameraState.distance * Math.tan((FOV * Math.PI) / 360);
		applyDelta(
			spaceMouseToCameraDelta(axes, {
				panSensitivity: visibleHeight * SPACEMOUSE_PAN_SCREEN_FRACTION,
			}),
		);
	}

	// 購読はこのコンポーネントが生きている間だけ = 3D を表示していないときの
	// デバイス操作はカメラに届かない(他のビューアへ切り替えれば解除される)。
	$effect(() => {
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void listen<SpaceMouseAxes>('spacemouse_input', (event) => onSpaceMouseInput(event.payload))
			.then((off) => {
				if (disposed) off();
				else unlisten = off;
			})
			.catch(() => {
				// イベント購読に失敗しても 3D 表示自体は使える(マウス操作は生きている)。
			});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	function resetView(): void {
		cameraState = initialCameraState;
		syncCamera();
	}

	// `src` が変わるたび読み直す。表示中のファイルがディスク上で変わったときも
	// 版数付きの新しい src が降ってくるので、この1本で変更追従になる(要件#22)。
	$effect(() => {
		const assetSrc = src;
		const host = stage;
		if (!host) return;
		void loadModel(assetSrc, host);
	});

	// 表示領域の伸縮に追従する(Explorer の幅変更・ウインドウリサイズ)。
	$effect(() => {
		const host = stage;
		if (!host) return;
		const observer = new ResizeObserver(() => resize());
		observer.observe(host);
		return () => observer.disconnect();
	});

	// ウインドウを閉じる / 別のビューアへ切り替わるときに GPU 資源を返す。
	$effect(() => {
		return () => {
			disposeModel();
			renderer?.dispose();
			renderer?.domElement.remove();
			renderer = null;
			scene = null;
			camera = null;
			modelRoot = null;
		};
	});
</script>

<!--
	要件#23: STL / 3MF は 3D シーンとして見せる。本体バイトは文書ペイロードには
	載らず、`vellis-asset:` から fetch する(要件#16 の画像と同じ流儀)。
	マーク・部分選択コピーは 3D に意味がないので置かない(ImageViewer と同じ整理)。
-->
<article class="model-viewer">
	<header class="model-toolbar">
		<button
			type="button"
			class="toolbar-button"
			title="初期の視点に戻す"
			onclick={resetView}
			disabled={load.kind !== 'ready'}
		>
			視点をリセット
		</button>
		<span class="model-name" title={uri}>{fileName}</span>
		{#if load.kind === 'ready'}
			<span class="model-stats">{load.triangleCount.toLocaleString()} 三角形</span>
		{/if}
	</header>

	<!--
		操作面。右ドラッグをパンに使うので、コンテキストメニューは抑止する
		(抑止しないと押した瞬間にメニューが出てドラッグが途切れる)。
	-->
	<div
		class="model-stage"
		bind:this={stage}
		role="application"
		aria-label="3D モデル表示({fileName})。左ドラッグで回転・右ドラッグでパン・ホイールでズーム"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		onwheel={onWheel}
		oncontextmenu={(e) => e.preventDefault()}
	>
		{#if load.kind === 'loading'}
			<p class="model-message">読み込み中…({fileName})</p>
		{:else if load.kind === 'error'}
			<p class="model-message">{load.message}</p>
		{/if}
	</div>
</article>

<style>
	.model-viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		background-color: var(--color-bg-primary);
	}

	.model-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
		padding: 6px 12px;
		background-color: var(--color-bg-primary);
		border-bottom: 1px solid var(--color-border);
	}

	.toolbar-button {
		font-size: 12px;
		padding: 4px 10px;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		background-color: var(--color-bg-secondary);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.toolbar-button:hover:not(:disabled) {
		background-color: var(--color-bg-hover);
	}

	.toolbar-button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.model-name {
		font-size: 12px;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.model-stats {
		margin-left: auto;
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	/*
	 * 描画面。canvas 自体は透明で描くので、背景はここのテーマ色がそのまま出る
	 * (テーマ切替に追従する)。`touch-action: none` はドラッグ中に WebView が
	 * スクロール/ズームのジェスチャを横取りしないため。
	 */
	.model-stage {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
		background-color: var(--color-bg-primary);
		touch-action: none;
	}

	.model-stage :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
	}

	.model-message {
		margin: auto;
		font-size: 13px;
		color: var(--color-text-secondary);
	}
</style>
