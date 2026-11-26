import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import './App.css';
import Mra3DViewer from './Mra3DViewer';

const isNativeApp = Capacitor.isNativePlatform();

const DIMS = { x: 192, y: 192, z: 192 };
const VOL_SCALE = 192 / 128; // 1.5
const HALF_X = DIMS.x / 2;   // 96
// キャンバス解像度（192³ボリュームを MRI と同程度に細かく見せる）
const SLICE_RES = 768;
const ZOOM_RES = 768;
const SELECTION_FLASH_MS = 110; // 選択組織の点滅更新間隔
const LABEL_AA = 3; // マスク平面内スーパーサンプル数（辺あたり）
// 通常マスクには使わない選択ハイライト（蛍光マゼンタ）
const SELECTION_HIGHLIGHT: [number, number, number] = [255, 0, 255];
const DEFAULT_COORDS = { x: 96, y: 96, z: 81 };
const DEFAULT_TILT = 0;
const DEFAULT_TRANSPARENCY = 0.6; // 透明度60%（色の濃さ40%）。0%=色100%、100%=完全透明

// 内包・脳幹ラベルの実測 Z（アプリの voxel インデックス基準、tilt=0°）
const IC_ANAT_Z = { min: 72, max: 92, defaultZ: 81 };
const STEM_ANAT_Z = { min: 8, max: 75, defaultZ: 44 }; // 延髄〜中脳

// 拡大ビューの Y 範囲（128基準 × VOL_SCALE）
const IC_ZOOM_Y = { min: 46 * VOL_SCALE, max: 86 * VOL_SCALE };
const STEM_ZOOM_Y = { min: 38 * VOL_SCALE, max: 74 * VOL_SCALE };

function clampCoord(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** tilt により切断面が Z 方向にずれる分だけ、スライダー範囲を広げて脳幹／内包全体へ届くようにする */
function getZoomZRange(
  mode: SubViewMode,
  tiltDeg: number,
  pivotY: number
): { min: number; max: number; defaultZ: number } | null {
  const anat = mode === 'ic_zoom' ? IC_ANAT_Z : mode === 'stem_zoom' ? STEM_ANAT_Z : null;
  if (!anat) return null;
  const yWin = mode === 'ic_zoom' ? IC_ZOOM_Y : STEM_ZOOM_Y;
  const sinT = Math.sin((tiltDeg * Math.PI) / 180);
  const zShift0 = (yWin.min - pivotY) * sinT;
  const zShift1 = (yWin.max - pivotY) * sinT;
  const zShiftMin = Math.min(zShift0, zShift1);
  const zShiftMax = Math.max(zShift0, zShift1);
  // realVz = coords.z + dist*sin が解剖範囲と重なる coords.z の許容区間
  return {
    min: clampCoord(Math.floor(anat.min - zShiftMax), 0, DIMS.z - 1),
    max: clampCoord(Math.ceil(anat.max - zShiftMin), 0, DIMS.z - 1),
    defaultZ: anat.defaultZ,
  };
}

interface StructureInfo {
  abbr: string;
  name: string;
  color: [number, number, number];
  function: string;
  clinical: string;
}

type StructuresDict = Record<string, StructureInfo>;
type MriSequence = 't1' | 't2' | 'flair' | 'dwi' | 'mra';
type SubViewMode = 'ortho' | 'ic_zoom' | 'stem_zoom';

const LAYER_ITEMS = [
  { key: 'cortex', label: '大脳皮質', color: '#8e24aa' },
  { key: 'wm', label: '大脳白質', color: '#00838f' },
  { key: 'bg', label: '基底核', color: '#2e7d32' },
  { key: 'diencephalon', label: '間脳', color: '#ef6c00' },
  { key: 'limbic', label: '辺縁系', color: '#ad1457' },
  { key: 'brainstem', label: '脳幹', color: '#d84315' },
  { key: 'cerebellum', label: '小脳', color: '#00695c' },
  { key: 'ventricle', label: '脳室・槽', color: '#0277bd' },
  { key: 'artery', label: '動脈', color: '#c62828' },
  { key: 'sulci', label: '脳溝・裂', color: '#fbc02d' },
];

async function fetchGzipBin(url: string): Promise<ArrayBuffer> {
  // Android APK は AAPT により .gz が自動展開され拡張子 .gz が外れるため、展開後のパスを優先する
  const candidates =
    Capacitor.getPlatform() === 'android' && url.endsWith('.gz')
      ? [url.slice(0, -3), url]
      : url.endsWith('.gz')
        ? [url, url.slice(0, -3)]
        : [url];

  let res: Response | null = null;
  for (const candidate of candidates) {
    const r = await fetch(candidate);
    if (r.ok) {
      res = r;
      break;
    }
  }
  if (!res) throw new Error(`HTTP 404: ${url}`);

  const rawBuf = await res.arrayBuffer();
  const bytes = new Uint8Array(rawBuf);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([rawBuf]).stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }
  return rawBuf;
}

function getCategoryInfo(id: number, name?: string): { key: string; label: string; bg: string } {
  if (name) {
    if (name.includes('脳弓')) return { key: 'wm', label: '2. 大脳白質（連合線維）', bg: '#00838f' };
    if (name.includes('乳頭体')) return { key: 'diencephalon', label: '4. 間脳・視床 (Diencephalon)', bg: '#ef6c00' };
    if (name.includes('帯状回') || name.includes('海馬傍回')) {
      return { key: 'cortex', label: '1. 大脳皮質 (Cerebral Cortex)', bg: '#6a1b9a' };
    }
  }
  if (id >= 100 && id < 200) return { key: 'cortex', label: '1. 大脳皮質 (Cerebral Cortex)', bg: '#6a1b9a' };
  if (id >= 200 && id < 300) return { key: 'wm', label: '2. 大脳白質・内包詳細経路', bg: '#00838f' };
  if (id >= 300 && id < 400) return { key: 'bg', label: '3. 大脳基底核 (Basal Ganglia)', bg: '#2e7d32' };
  if (id >= 400 && id < 500) return { key: 'diencephalon', label: '4. 間脳・視床 (Diencephalon)', bg: '#ef6c00' };
  if (id >= 500 && id < 600) return { key: 'limbic', label: '5. 辺縁系 (Limbic System)', bg: '#ad1457' };
  if (id >= 600 && id < 700) return { key: 'brainstem', label: '6. 脳幹 (Brainstem)', bg: '#d84315' };
  if (id >= 700 && id < 800) return { key: 'cerebellum', label: '7. 小脳 (Cerebellum)', bg: '#00695c' };
  if (id >= 800 && id < 900) return { key: 'ventricle', label: '8. 脳室系・脳槽 (Ventricles & Cisterns)', bg: '#0277bd' };
  if (id >= 900 && id < 1000) return { key: 'artery', label: '9. 主要脳動脈 (Cerebral Arteries)', bg: '#c62828' };
  if (id >= 1000 && id < 1100) return { key: 'sulci', label: '10. 脳溝・脳裂 (Sulci & Fissures)', bg: '#fbc02d' };
  return { key: 'other', label: '神経解剖構造', bg: '#424242' };
}

function getDetailedInternalCapsuleId(baseId: number, vx: number, vy: number): number {
  const vx128 = vx / VOL_SCALE;
  const vy128 = vy / VOL_SCALE;
  if (baseId === 202) return 251;
  if (baseId === 203) return 252;
  if (baseId === 204) {
    if (vy128 >= 61.5) return 253;
    if (vy128 >= 58.5) return 254;
    if (vy128 >= 55.0) {
      return vx128 < 76.5 ? 256 : 255;
    }
    return 257;
  }
  return 0;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function colorDist(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db);
}

/** ボクセル隣接から「隣り合うラベルID」のグラフを作る */
function buildLabelAdjacency(data: Uint16Array): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (a === 0 || b === 0 || a === b) return;
    let sa = adj.get(a);
    if (!sa) {
      sa = new Set();
      adj.set(a, sa);
    }
    let sb = adj.get(b);
    if (!sb) {
      sb = new Set();
      adj.set(b, sb);
    }
    sa.add(b);
    sb.add(a);
  };

  const strideY = DIMS.z;
  const strideX = DIMS.z * DIMS.y;
  // 1ボクセルおきでも薄い構造の隣接はほぼ拾える（起動を軽く）
  const step = 1;
  for (let x = 0; x < DIMS.x - 1; x += step) {
    for (let y = 0; y < DIMS.y; y += step) {
      for (let z = 0; z < DIMS.z; z += step) {
        const i = z + y * strideY + x * strideX;
        const v = data[i] || 0;
        if (!v) continue;
        link(v, data[i + strideX] || 0);
        if (y + step < DIMS.y) link(v, data[i + strideY * step] || 0);
        if (z + step < DIMS.z) link(v, data[i + step] || 0);
      }
    }
  }
  return adj;
}

/**
 * 空間的に隣り合う組織ほど色差が大きくなるよう表示色を再割当。
 * 元JSONに同一色が多用されている問題（脳溝など）を解消する。
 */
function assignContrastingColors(
  base: StructuresDict,
  adjacencyList: Map<number, Set<number>>[]
): StructuresDict {
  const merged = new Map<number, Set<number>>();
  const ensure = (id: number) => {
    let set = merged.get(id);
    if (!set) {
      set = new Set();
      merged.set(id, set);
    }
    return set;
  };

  for (const adj of adjacencyList) {
    for (const [a, neighbors] of adj) {
      const sa = ensure(a);
      for (const b of neighbors) {
        sa.add(b);
        ensure(b).add(a);
      }
    }
  }

  // 内包の詳細区分は手続き割当のため、互いに隣接扱いにする
  for (let i = 251; i <= 257; i++) {
    for (let j = i + 1; j <= 257; j++) {
      ensure(i).add(j);
      ensure(j).add(i);
    }
  }

  const ids = Object.keys(base)
    .map(Number)
    .sort((a, b) => (merged.get(b)?.size || 0) - (merged.get(a)?.size || 0));

  // 高彩度・中明度のパレット（選択ハイライト色は除外）
  const palette: [number, number, number][] = [];
  for (let i = 0; i < Math.max(ids.length * 3, 96); i++) {
    const h = (i * 137.508) % 360;
    // マゼンタ付近は選択点滅専用のためマスク色に使わない
    if (h > 285 && h < 330) continue;
    const s = 72 + (i % 5) * 5;
    const l = 38 + (i % 6) * 6;
    const rgb = hslToRgb(h, s, l);
    if (colorDist(rgb, SELECTION_HIGHLIGHT) < 120) continue;
    palette.push(rgb);
  }

  const assigned = new Map<number, [number, number, number]>();
  const usedPalette = new Set<number>();

  for (const id of ids) {
    const neighbors = merged.get(id) || new Set();
    let bestI = 0;
    let bestScore = -Infinity;
    for (let pi = 0; pi < palette.length; pi++) {
      const c = palette[pi];
      let minNeighbor = Infinity;
      for (const n of neighbors) {
        const nc = assigned.get(n);
        if (nc) minNeighbor = Math.min(minNeighbor, colorDist(c, nc));
      }
      if (minNeighbor === Infinity) minNeighbor = 500;
      // 未使用色を優先しつつ、隣との色差を最大化
      const score = minNeighbor - (usedPalette.has(pi) ? 55 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestI = pi;
      }
    }
    assigned.set(id, palette[bestI]);
    usedPalette.add(bestI);
  }

  const out: StructuresDict = {};
  for (const id of ids) {
    const key = String(id);
    out[key] = { ...base[key], color: assigned.get(id)! };
  }
  return out;
}

export default function App() {
  const axialCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const coronalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sagittalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mraAxialLabelMapRef = useRef<Uint16Array>(new Uint16Array(DIMS.x * DIMS.y));

  // タッチのピンチズーム＆パン管理用Ref
  const touchStateRef = useRef<{
    mode: 'none' | 'pan' | 'pinch';
    startDist: number;
    startScale: number;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
    moved: boolean;
  }>({
    mode: 'none',
    startDist: 0,
    startScale: 1,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    moved: false,
  });

  const [mriSeq, setMriSeq] = useState<MriSequence>('t1');
  const [subViewMode, setSubViewMode] = useState<SubViewMode>('ortho');
  const [isLayerMenuOpen, setIsLayerMenuOpen] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // キャンバス拡大率(1.0〜4.0)とパン位置
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const [rawMriData, setRawMriData] = useState<Uint8Array | null>(null);
  const [labelData, setLabelData] = useState<Uint16Array | null>(null);
  const [stemMicroData, setStemMicroData] = useState<Uint16Array | null>(null);
  const [sulciData, setSulciData] = useState<Uint16Array | null>(null);
  const [structuresRaw, setStructuresRaw] = useState<StructuresDict>({});
  const [structures, setStructures] = useState<StructuresDict>({});

  const [coords, setCoords] = useState<{ x: number; y: number; z: number }>(DEFAULT_COORDS);
  // transparency: 0.0(不透明・色100%) 〜 1.0(完全透明・色0%)
  const [transparency, setTransparency] = useState<number>(DEFAULT_TRANSPARENCY);
  const overlayAlpha = 1 - transparency;

  const [tiltAngle, setTiltAngle] = useState<number>(DEFAULT_TILT);
  const [activePreset, setActivePreset] = useState<string>('AC-PC');

  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({
    cortex: true,
    wm: true,
    bg: true,
    diencephalon: true,
    limbic: true,
    brainstem: true,
    cerebellum: true,
    ventricle: true,
    artery: true,
    sulci: true,
  });

  const [hoveredStructure, setHoveredStructure] = useState<{
    id: number;
    info: StructureInfo;
    x: number;
    y: number;
  } | null>(null);
  const [selectedStructure, setSelectedStructure] = useState<{
    id: number;
    info: StructureInfo;
  } | null>(null);
  // 選択中組織の点滅（0=通常色寄り, 1=ハイライト最大）
  const [selectionPulse, setSelectionPulse] = useState<number>(1);
  // スマホのみ: 軸位断／拡大図タップで冠状・矢状の位置に説明パネルを表示
  const [inlineInspectorOpen, setInlineInspectorOpen] = useState<boolean>(false);
  // PC/タブレットはクラシック配置、スマホ横画面だけコンパクト3断面
  const [compactViewer, setCompactViewer] = useState<boolean>(false);

  // ネイティブアプリ（iOS/Android）起動時はステータスバーを非表示にして横画面領域を最大化
  useEffect(() => {
    if (!isNativeApp) return;
    StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
    StatusBar.hide().catch(() => {});
  }, []);

  // スマホ向けコンパクトレイアウト判定（CSS の media と揃える）
  useEffect(() => {
    const mq = window.matchMedia(
      '(max-height: 520px), (max-width: 960px) and (max-height: 620px)'
    );
    const sync = () => {
      const compact = mq.matches;
      setCompactViewer(compact);
      if (!compact) setInlineInspectorOpen(false);
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // MRA 切替時はインライン説明パネルを閉じる
  useEffect(() => {
    if (mriSeq === 'mra') {
      setInlineInspectorOpen(false);
    }
  }, [mriSeq]);

  // 選択中の組織を点滅させて、小さい画面でもどこを選んだか分かるようにする
  useEffect(() => {
    if (!selectedStructure) {
      setSelectionPulse(1);
      return;
    }
    const started = performance.now();
    const timer = window.setInterval(() => {
      const t = (performance.now() - started) / 1000;
      // 約 1.2Hz のオン／オフ（グラデーションなし）
      setSelectionPulse(Math.sin(t * Math.PI * 2 * 1.2) >= 0 ? 1 : 0);
    }, SELECTION_FLASH_MS);
    return () => window.clearInterval(timer);
  }, [selectedStructure?.id]);

  // フルスクリーン状態の監視
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleLandscapeFullscreen = async () => {
    const orient = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
      unlock?: () => void;
    };
    try {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
        await orient?.lock?.('landscape').catch(() => {});
      } else {
        orient?.unlock?.();
        await document.exitFullscreen();
      }
    } catch {
      // iOSなどFullscreen API非対応端末では何もしない
    }
  };

  // 構造辞書＆ラベルボリューム初期読込（.bin.gz 自動解凍）
  useEffect(() => {
    fetch('/structures_u16.json')
      .then((res) => res.json())
      .then((data: StructuresDict) => {
        setStructuresRaw(data);
        setStructures(data); // 隣接グラフ算出前の仮表示
      })
      .catch((err) => console.error('structures_u16.json 読込失敗:', err));

    fetchGzipBin('/brain_label_u16.bin.gz')
      .then((buf) => setLabelData(new Uint16Array(buf)))
      .catch((err) => console.error('brain_label_u16.bin.gz 読込失敗:', err));

    fetchGzipBin('/brain_stem_micro_u16.bin.gz')
      .then((buf) => setStemMicroData(new Uint16Array(buf)))
      .catch((err) => console.error('brain_stem_micro_u16.bin.gz 読込失敗:', err));

    fetchGzipBin('/brain_sulci_u16.bin.gz')
      .then((buf) => setSulciData(new Uint16Array(buf)))
      .catch((err) => console.error('brain_sulci_u16.bin.gz 読込失敗:', err));
  }, []);

  // 隣り合う組織の色が似ないよう、空間隣接に基づいて表示色を再割当
  useEffect(() => {
    if (!structuresRaw || Object.keys(structuresRaw).length === 0 || !labelData) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const adjacencyList: Map<number, Set<number>>[] = [buildLabelAdjacency(labelData)];
      if (stemMicroData) adjacencyList.push(buildLabelAdjacency(stemMicroData));
      if (sulciData) adjacencyList.push(buildLabelAdjacency(sulciData));
      if (cancelled) return;
      setStructures(assignContrastingColors(structuresRaw, adjacencyList));
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [structuresRaw, labelData, stemMicroData, sulciData]);

  // MRIシーケンス読込
  useEffect(() => {
    const fileName = `brain_${mriSeq}.bin.gz`;
    fetchGzipBin(`/${fileName}`)
      .then((buf) => setRawMriData(new Uint8Array(buf)))
      .catch((err) => console.error(`${fileName} 読込失敗:`, err));
  }, [mriSeq]);

  const resetZoom = () => {
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const adjustZoom = (delta: number) => {
    setZoomScale((prev) => {
      const next = Math.max(1, Math.min(4, Math.round((prev + delta) * 10) / 10));
      if (next === 1) setPanOffset({ x: 0, y: 0 });
      return next;
    });
  };

  // タッチによるピンチズーム＆拡大中パン制御
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      touchStateRef.current = {
        mode: 'pinch',
        startDist: dist,
        startScale: zoomScale,
        startX: 0,
        startY: 0,
        startPanX: panOffset.x,
        startPanY: panOffset.y,
        moved: true,
      };
    } else if (e.touches.length === 1 && zoomScale > 1) {
      touchStateRef.current = {
        mode: 'pan',
        startDist: 0,
        startScale: zoomScale,
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        startPanX: panOffset.x,
        startPanY: panOffset.y,
        moved: false,
      };
    } else {
      touchStateRef.current.mode = 'none';
      touchStateRef.current.moved = false;
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const st = touchStateRef.current;
    if (st.mode === 'pinch' && e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (st.startDist > 0) {
        const rawScale = st.startScale * (dist / st.startDist);
        if (rawScale <= 1.05) {
          setZoomScale(1);
          setPanOffset({ x: 0, y: 0 });
        } else {
          setZoomScale(Math.min(4, rawScale));
        }
      }
    } else if (st.mode === 'pan' && e.touches.length === 1 && zoomScale > 1) {
      const dx = e.touches[0].clientX - st.startX;
      const dy = e.touches[0].clientY - st.startY;
      if (Math.hypot(dx, dy) > 5) st.moved = true;
      const maxPan = 220 * (zoomScale - 1);
      setPanOffset({
        x: Math.max(-maxPan, Math.min(maxPan, st.startPanX + dx)),
        y: Math.max(-maxPan, Math.min(maxPan, st.startPanY + dy)),
      });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 0) {
      touchStateRef.current.mode = 'none';
    }
  };

  const getVoxelIdx = (vx: number, vy: number, vz: number) => {
    const cx = Math.max(0, Math.min(DIMS.x - 1, Math.round(vx)));
    const cy = Math.max(0, Math.min(DIMS.y - 1, Math.round(vy)));
    const cz = Math.max(0, Math.min(DIMS.z - 1, Math.round(vz)));
    return cz + cy * DIMS.z + cx * DIMS.z * DIMS.y;
  };

  const sampleMriTrilinear = useCallback(
    (fx: number, fy: number, fz: number): number => {
      if (!rawMriData) return 0;
      if (fx < 0 || fx >= DIMS.x || fy < 0 || fy >= DIMS.y || fz < 0 || fz >= DIMS.z) return 0;
      const x0 = Math.max(0, Math.min(DIMS.x - 1, Math.floor(fx)));
      const x1 = Math.min(DIMS.x - 1, x0 + 1);
      const y0 = Math.max(0, Math.min(DIMS.y - 1, Math.floor(fy)));
      const y1 = Math.min(DIMS.y - 1, y0 + 1);
      const z0 = Math.max(0, Math.min(DIMS.z - 1, Math.floor(fz)));
      const z1 = Math.min(DIMS.z - 1, z0 + 1);
      const dx = fx - x0;
      const dy = fy - y0;
      const dz = fz - z0;

      const c000 = rawMriData[z0 + y0 * DIMS.z + x0 * DIMS.z * DIMS.y] || 0;
      const c100 = rawMriData[z0 + y0 * DIMS.z + x1 * DIMS.z * DIMS.y] || 0;
      const c010 = rawMriData[z0 + y1 * DIMS.z + x0 * DIMS.z * DIMS.y] || 0;
      const c110 = rawMriData[z0 + y1 * DIMS.z + x1 * DIMS.z * DIMS.y] || 0;
      const c001 = rawMriData[z1 + y0 * DIMS.z + x0 * DIMS.z * DIMS.y] || 0;
      const c101 = rawMriData[z1 + y0 * DIMS.z + x1 * DIMS.z * DIMS.y] || 0;
      const c011 = rawMriData[z1 + y1 * DIMS.z + x0 * DIMS.z * DIMS.y] || 0;
      const c111 = rawMriData[z1 + y1 * DIMS.z + x1 * DIMS.z * DIMS.y] || 0;

      const c00 = c000 * (1 - dx) + c100 * dx;
      const c10 = c010 * (1 - dx) + c110 * dx;
      const c01 = c001 * (1 - dx) + c101 * dx;
      const c11 = c011 * (1 - dx) + c111 * dx;

      const c0 = c00 * (1 - dy) + c10 * dy;
      const c1 = c01 * (1 - dy) + c11 * dy;

      return c0 * (1 - dz) + c1 * dz;
    },
    [rawMriData]
  );

  /**
   * マスクを MRI の三線形に近い見た目にする。
   * データは 192³ のままなので、断面内で約1ボクセル幅をスーパーサンプルし、
   * 階段状の境界を MRI と同程度の滑らかさに近づける。
   * u / v は断面内の直交方向（ボクセル単位の単位ベクトル）。
   */
  const sampleLabelHiRes = useCallback(
    (
      data: Uint16Array | null | undefined,
      fx: number,
      fy: number,
      fz: number,
      ux: number,
      uy: number,
      uz: number,
      vx: number,
      vy: number,
      vz: number
    ): { id: number; coverage: number } => {
      if (!data) return { id: 0, coverage: 0 };
      if (fx < 0 || fx >= DIMS.x || fy < 0 || fy >= DIMS.y || fz < 0 || fz >= DIMS.z) {
        return { id: 0, coverage: 0 };
      }
      const nearestId = data[getVoxelIdx(fx, fy, fz)] || 0;
      if (nearestId === 0) return { id: 0, coverage: 0 };

      const n = LABEL_AA;
      const inv = 1 / n;
      let hits = 0;
      for (let i = 0; i < n; i++) {
        const a = (i + 0.5) * inv - 0.5; // -0.5 … 0.5 ボクセル
        for (let j = 0; j < n; j++) {
          const b = (j + 0.5) * inv - 0.5;
          const sx = fx + ux * a + vx * b;
          const sy = fy + uy * a + vy * b;
          const sz = fz + uz * a + vz * b;
          if ((data[getVoxelIdx(sx, sy, sz)] || 0) === nearestId) hits++;
        }
      }

      // 三線形インジケータ（MRI補間に相当するサブボクセル境界）
      const x0 = Math.max(0, Math.min(DIMS.x - 1, Math.floor(fx)));
      const x1 = Math.min(DIMS.x - 1, x0 + 1);
      const y0 = Math.max(0, Math.min(DIMS.y - 1, Math.floor(fy)));
      const y1 = Math.min(DIMS.y - 1, y0 + 1);
      const z0 = Math.max(0, Math.min(DIMS.z - 1, Math.floor(fz)));
      const z1 = Math.min(DIMS.z - 1, z0 + 1);
      const dx = fx - x0;
      const dy = fy - y0;
      const dz = fz - z0;
      const strideY = DIMS.z;
      const strideX = DIMS.z * DIMS.y;
      let soft = 0;
      const add = (x: number, y: number, z: number, w: number) => {
        if (w > 0 && (data[z + y * strideY + x * strideX] || 0) === nearestId) soft += w;
      };
      add(x0, y0, z0, (1 - dx) * (1 - dy) * (1 - dz));
      add(x1, y0, z0, dx * (1 - dy) * (1 - dz));
      add(x0, y1, z0, (1 - dx) * dy * (1 - dz));
      add(x1, y1, z0, dx * dy * (1 - dz));
      add(x0, y0, z1, (1 - dx) * (1 - dy) * dz);
      add(x1, y0, z1, dx * (1 - dy) * dz);
      add(x0, y1, z1, (1 - dx) * dy * dz);
      add(x1, y1, z1, dx * dy * dz);

      // 平面内AAで階段を抑え、ソフトでピクセル境界を MRI っぽくする
      let coverage = 0.65 * (hits / (n * n)) + 0.35 * soft;
      coverage = coverage * coverage * (3 - 2 * coverage); // smoothstep
      return { id: nearestId, coverage: Math.min(1, coverage * 1.08) };
    },
    []
  );

  const isLayerVisible = useCallback(
    (id: number) => {
      if (id === 0) return false;
      return !!visibleLayers[getCategoryInfo(id, structures[String(id)]?.name).key];
    },
    [visibleLayers, structures]
  );

  // マスク色と MRI を合成。選択中は点滅ハイライト
  const blendOverlayColor = useCallback(
    (
      mriVal: number,
      structureId: number,
      color: [number, number, number],
      coverage: number,
      baseAlpha = overlayAlpha
    ): [number, number, number] => {
      if (coverage <= 0.02) return [mriVal, mriVal, mriVal];
      let a = baseAlpha * coverage;
      let cr = color[0];
      let cg = color[1];
      let cb = color[2];
      if (selectedStructure?.id === structureId) {
        // 蛍光マゼンタのオン／オフ点滅（中間のグラデーションなし）
        if (selectionPulse < 0.5) {
          // オフ時は通常マスク色のまま
        } else {
          cr = SELECTION_HIGHLIGHT[0];
          cg = SELECTION_HIGHLIGHT[1];
          cb = SELECTION_HIGHLIGHT[2];
          a = Math.min(1, coverage * 0.95);
        }
      }
      return [
        Math.round(mriVal * (1 - a) + cr * a),
        Math.round(mriVal * (1 - a) + cg * a),
        Math.round(mriVal * (1 - a) + cb * a),
      ];
    },
    [overlayAlpha, selectedStructure?.id, selectionPulse]
  );

  const blendMraPixel = (mriVal: number, lId: number): [number, number, number] => {
    if (lId >= 900 && lId < 1000 && structures[String(lId)] && mriVal > 35) {
      const [cr, cg, cb] = structures[String(lId)].color;
      return blendOverlayColor(mriVal, lId, [cr, cg, cb], 1, overlayAlpha * (mriVal / 255));
    }
    return [mriVal, mriVal, mriVal];
  };

  const activeZoomMode: SubViewMode = subViewMode;

  // 内包・脳幹 拡大ビュー描画
  const renderZoomView = useCallback(() => {
    if (!zoomCanvasRef.current || !rawMriData || !labelData || activeZoomMode === 'ortho') return;
    const canvas = zoomCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = ZOOM_RES;
    const H = ZOOM_RES;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const imgData = ctx.createImageData(W, H);
    const d = imgData.data;

    const xMin = (activeZoomMode === 'ic_zoom' ? 58 : 46) * VOL_SCALE;
    const xMax = (activeZoomMode === 'ic_zoom' ? 98 : 82) * VOL_SCALE;
    const yMin = (activeZoomMode === 'ic_zoom' ? 46 : 38) * VOL_SCALE;
    const yMax = (activeZoomMode === 'ic_zoom' ? 86 : 74) * VOL_SCALE;

    const tiltRad = (tiltAngle * Math.PI) / 180;
    const cosTilt = Math.cos(tiltRad);
    const sinTilt = Math.sin(tiltRad);

    for (let py = 0; py < H; py++) {
      const planeY = yMax - (py / H) * (yMax - yMin);
      const distFromPivot = planeY - coords.y;
      const realVy = coords.y + distFromPivot * cosTilt;
      const realVz = coords.z + distFromPivot * sinTilt;

      for (let px = 0; px < W; px++) {
        const fx = xMin + (px / W) * (xMax - xMin);
        const pIdx = (py * W + px) * 4;

        if (realVy < 0 || realVy >= DIMS.y || realVz < 0 || realVz >= DIMS.z) {
          d[pIdx] = d[pIdx + 1] = d[pIdx + 2] = 0;
          d[pIdx + 3] = 255;
          continue;
        }

        const mriVal = Math.round(sampleMriTrilinear(fx, realVy, realVz));

        let targetId = 0;
        let coverage = 1;
        // 拡大断面: X × 傾きY（軸位断と同じ）
        if (activeZoomMode === 'ic_zoom') {
          const soft = sampleLabelHiRes(
            labelData, fx, realVy, realVz,
            1, 0, 0,
            0, cosTilt, sinTilt
          );
          if (soft.id >= 202 && soft.id <= 204) {
            targetId = getDetailedInternalCapsuleId(soft.id, fx, realVy);
            coverage = soft.coverage;
          }
        } else if (activeZoomMode === 'stem_zoom' && stemMicroData) {
          const soft = sampleLabelHiRes(
            stemMicroData, fx, realVy, realVz,
            1, 0, 0,
            0, cosTilt, sinTilt
          );
          if (soft.id >= 601 && soft.id <= 635) {
            targetId = soft.id;
            coverage = soft.coverage;
          }
        }

        if (fx >= HALF_X && targetId > 0 && structures[String(targetId)]) {
          const color = structures[String(targetId)].color as [number, number, number];
          const [r, g, b] = blendOverlayColor(mriVal, targetId, color, coverage, overlayAlpha * 0.85);
          d[pIdx] = r;
          d[pIdx + 1] = g;
          d[pIdx + 2] = b;
          d[pIdx + 3] = 255;
        } else {
          d[pIdx] = d[pIdx + 1] = d[pIdx + 2] = mriVal;
          d[pIdx + 3] = 255;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }, [
    rawMriData,
    labelData,
    stemMicroData,
    activeZoomMode,
    coords.y,
    coords.z,
    tiltAngle,
    overlayAlpha,
    structures,
    sampleMriTrilinear,
    sampleLabelHiRes,
    blendOverlayColor,
  ]);

  // 3断面（Axial / Coronal / Sagittal）＆ MRA 2D MIP 描画
  const renderViews = useCallback(() => {
    if (!rawMriData || !labelData) return;

    if (mriSeq === 'mra') {
      if (axialCanvasRef.current) {
        const canvas = axialCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          canvas.width = DIMS.x;
          canvas.height = DIMS.y;
          const imgData = ctx.createImageData(DIMS.x, DIMS.y);
          const d = imgData.data;
          const labelMap = mraAxialLabelMapRef.current;
          labelMap.fill(0);
          for (let py = 0; py < DIMS.y; py++) {
            const vy = DIMS.y - 1 - py;
            for (let px = 0; px < DIMS.x; px++) {
              const vx = px;
              let maxVal = 0;
              let bestLid = 0;
              for (let vz = 8; vz < DIMS.z - 15; vz++) {
                const vIdx = getVoxelIdx(vx, vy, vz);
                const val = rawMriData[vIdx] || 0;
                const lId = labelData[vIdx] || 0;
                if (val > maxVal) maxVal = val;
                if (lId >= 900 && lId < 1000 && val > 70) bestLid = lId;
              }
              labelMap[py * DIMS.x + px] = bestLid;
              const [r, g, b] = blendMraPixel(maxVal, bestLid);
              const pIdx = (py * DIMS.x + px) * 4;
              d[pIdx] = r;
              d[pIdx + 1] = g;
              d[pIdx + 2] = b;
              d[pIdx + 3] = 255;
            }
          }
          ctx.putImageData(imgData, 0, 0);
        }
      }
      if (coronalCanvasRef.current) {
        const canvas = coronalCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          canvas.width = DIMS.x;
          canvas.height = DIMS.z;
          const imgData = ctx.createImageData(DIMS.x, DIMS.z);
          const d = imgData.data;
          for (let pz = 0; pz < DIMS.z; pz++) {
            const vz = DIMS.z - 1 - pz;
            for (let px = 0; px < DIMS.x; px++) {
              const vx = px;
              let maxVal = 0;
              let bestLid = 0;
              for (let vy = 15; vy < DIMS.y - 15; vy++) {
                const vIdx = getVoxelIdx(vx, vy, vz);
                const val = rawMriData[vIdx] || 0;
                const lId = labelData[vIdx] || 0;
                if (val > maxVal) maxVal = val;
                if (lId >= 900 && lId < 1000 && val > 70) bestLid = lId;
              }
              const [r, g, b] = blendMraPixel(maxVal, bestLid);
              const pIdx = (pz * DIMS.x + px) * 4;
              d[pIdx] = r;
              d[pIdx + 1] = g;
              d[pIdx + 2] = b;
              d[pIdx + 3] = 255;
            }
          }
          ctx.putImageData(imgData, 0, 0);
        }
      }
      if (sagittalCanvasRef.current) {
        const canvas = sagittalCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          canvas.width = DIMS.y;
          canvas.height = DIMS.z;
          const imgData = ctx.createImageData(DIMS.y, DIMS.z);
          const d = imgData.data;
          for (let pz = 0; pz < DIMS.z; pz++) {
            const vz = DIMS.z - 1 - pz;
            for (let py = 0; py < DIMS.y; py++) {
              const vy = DIMS.y - 1 - py;
              let maxVal = 0;
              let bestLid = 0;
              for (let vx = 22; vx < DIMS.x - 22; vx++) {
                const vIdx = getVoxelIdx(vx, vy, vz);
                const val = rawMriData[vIdx] || 0;
                const lId = labelData[vIdx] || 0;
                if (val > maxVal) maxVal = val;
                if (lId >= 900 && lId < 1000 && val > 70) bestLid = lId;
              }
              const [r, g, b] = blendMraPixel(maxVal, bestLid);
              const pIdx = (pz * DIMS.y + py) * 4;
              d[pIdx] = r;
              d[pIdx + 1] = g;
              d[pIdx + 2] = b;
              d[pIdx + 3] = 255;
            }
          }
          ctx.putImageData(imgData, 0, 0);
        }
      }
      return;
    }

    const tiltRad = (tiltAngle * Math.PI) / 180;
    const cosTilt = Math.cos(tiltRad);
    const sinTilt = Math.sin(tiltRad);
    const tanTilt = Math.tan(tiltRad);

    // 1. Axial（軸位断・高解像度・Trilinear補間）
    if (axialCanvasRef.current) {
      const canvas = axialCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const W = SLICE_RES;
        const H = SLICE_RES;
        if (canvas.width !== W || canvas.height !== H) {
          canvas.width = W;
          canvas.height = H;
        }
        const imgData = ctx.createImageData(W, H);
        const d = imgData.data;

        for (let py = 0; py < H; py++) {
          const planeY = DIMS.y - 1 - ((py + 0.5) / H) * DIMS.y;
          const distFromPivot = planeY - coords.y;
          const vy = coords.y + distFromPivot * cosTilt;
          const vz = coords.z + distFromPivot * sinTilt;

          for (let px = 0; px < W; px++) {
            const fx = ((px + 0.5) / W) * DIMS.x;
            const pIdx = (py * W + px) * 4;
            if (vy < 0 || vy >= DIMS.y || vz < 0 || vz >= DIMS.z) {
              d[pIdx] = d[pIdx + 1] = d[pIdx + 2] = 0;
              d[pIdx + 3] = 255;
              continue;
            }
            const mriVal = Math.round(sampleMriTrilinear(fx, vy, vz));
            // 軸位断（傾斜）: X × 傾きY方向
            const labelSoft = sampleLabelHiRes(
              labelData, fx, vy, vz,
              1, 0, 0,
              0, cosTilt, sinTilt
            );
            const sulciSoft = sampleLabelHiRes(
              sulciData, fx, vy, vz,
              1, 0, 0,
              0, cosTilt, sinTilt
            );

            if (
              fx >= HALF_X &&
              visibleLayers.sulci &&
              sulciSoft.id > 0 &&
              structures[String(sulciSoft.id)]
            ) {
              const color = structures[String(sulciSoft.id)].color as [number, number, number];
              const [r, g, b] = blendOverlayColor(mriVal, sulciSoft.id, color, sulciSoft.coverage);
              d[pIdx] = r;
              d[pIdx + 1] = g;
              d[pIdx + 2] = b;
              d[pIdx + 3] = 255;
            } else if (
              fx >= HALF_X &&
              labelSoft.id > 0 &&
              isLayerVisible(labelSoft.id) &&
              structures[String(labelSoft.id)]
            ) {
              const color = structures[String(labelSoft.id)].color as [number, number, number];
              const [r, g, b] = blendOverlayColor(mriVal, labelSoft.id, color, labelSoft.coverage);
              d[pIdx] = r;
              d[pIdx + 1] = g;
              d[pIdx + 2] = b;
              d[pIdx + 3] = 255;
            } else {
              d[pIdx] = d[pIdx + 1] = d[pIdx + 2] = mriVal;
              d[pIdx + 3] = 255;
            }
          }
        }
        ctx.putImageData(imgData, 0, 0);

        const cx = ((coords.x + 0.5) / DIMS.x) * W;
        const cy = ((DIMS.y - 1 - coords.y + 0.5) / DIMS.y) * H;
        ctx.setLineDash([]);
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = 'rgba(255, 152, 0, 0.95)';
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, H);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(76, 175, 80, 0.95)';
        ctx.beginPath();
        ctx.moveTo(0, cy);
        ctx.lineTo(W, cy);
        ctx.stroke();
      }
    }

    if (activeZoomMode !== 'ortho') {
      renderZoomView();
    }

    // 2. Coronal（冠状断・高解像度・Trilinear補間）
    if (coronalCanvasRef.current) {
      const canvas = coronalCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const W = SLICE_RES;
        const H = SLICE_RES;
        if (canvas.width !== W || canvas.height !== H) {
          canvas.width = W;
          canvas.height = H;
        }
        const imgData = ctx.createImageData(W, H);
        const d = imgData.data;

        for (let pz = 0; pz < H; pz++) {
          const fz = DIMS.z - 1 - ((pz + 0.5) / H) * DIMS.z;
          for (let px = 0; px < W; px++) {
            const fx = ((px + 0.5) / W) * DIMS.x;
            const pIdx = (pz * W + px) * 4;
            const mriVal = Math.round(sampleMriTrilinear(fx, coords.y, fz));
            // 冠状断: X × Z
            const labelSoft = sampleLabelHiRes(
              labelData, fx, coords.y, fz,
              1, 0, 0,
              0, 0, 1
            );
            const sulciSoft = sampleLabelHiRes(
              sulciData, fx, coords.y, fz,
              1, 0, 0,
              0, 0, 1
            );

            if (
              fx >= HALF_X &&
              visibleLayers.sulci &&
              sulciSoft.id > 0 &&
              structures[String(sulciSoft.id)]
            ) {
              const color = structures[String(sulciSoft.id)].color as [number, number, number];
              const [r, g, b] = blendOverlayColor(mriVal, sulciSoft.id, color, sulciSoft.coverage);
              d[pIdx] = r;
              d[pIdx + 1] = g;
              d[pIdx + 2] = b;
              d[pIdx + 3] = 255;
            } else if (
              fx >= HALF_X &&
              labelSoft.id > 0 &&
              isLayerVisible(labelSoft.id) &&
              structures[String(labelSoft.id)]
            ) {
              const color = structures[String(labelSoft.id)].color as [number, number, number];
              const [r, g, b] = blendOverlayColor(mriVal, labelSoft.id, color, labelSoft.coverage);
              d[pIdx] = r;
              d[pIdx + 1] = g;
              d[pIdx + 2] = b;
              d[pIdx + 3] = 255;
            } else {
              d[pIdx] = d[pIdx + 1] = d[pIdx + 2] = mriVal;
              d[pIdx + 3] = 255;
            }
          }
        }
        ctx.putImageData(imgData, 0, 0);

        const cx = ((coords.x + 0.5) / DIMS.x) * W;
        const cz = ((DIMS.z - 1 - coords.z + 0.5) / DIMS.z) * H;
        ctx.setLineDash([]);
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = 'rgba(255, 152, 0, 0.95)';
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, H);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(41, 182, 246, 0.95)';
        ctx.beginPath();
        ctx.moveTo(0, cz);
        ctx.lineTo(W, cz);
        ctx.stroke();
      }
    }

    // 3. Sagittal（矢状断・高解像度・Trilinear補間）
    if (sagittalCanvasRef.current) {
      const canvas = sagittalCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const W = SLICE_RES;
        const H = SLICE_RES;
        if (canvas.width !== W || canvas.height !== H) {
          canvas.width = W;
          canvas.height = H;
        }
        const imgData = ctx.createImageData(W, H);
        const d = imgData.data;

        for (let pz = 0; pz < H; pz++) {
          const fz = DIMS.z - 1 - ((pz + 0.5) / H) * DIMS.z;
          for (let py = 0; py < W; py++) {
            const fy = DIMS.y - 1 - ((py + 0.5) / W) * DIMS.y;
            const pIdx = (pz * W + py) * 4;
            const mriVal = Math.round(sampleMriTrilinear(coords.x, fy, fz));
            // 矢状断: Y × Z
            const labelSoft = sampleLabelHiRes(
              labelData, coords.x, fy, fz,
              0, 1, 0,
              0, 0, 1
            );
            const sulciSoft = sampleLabelHiRes(
              sulciData, coords.x, fy, fz,
              0, 1, 0,
              0, 0, 1
            );

            if (
              coords.x >= HALF_X &&
              visibleLayers.sulci &&
              sulciSoft.id > 0 &&
              structures[String(sulciSoft.id)]
            ) {
              const color = structures[String(sulciSoft.id)].color as [number, number, number];
              const [r, g, b] = blendOverlayColor(mriVal, sulciSoft.id, color, sulciSoft.coverage);
              d[pIdx] = r;
              d[pIdx + 1] = g;
              d[pIdx + 2] = b;
              d[pIdx + 3] = 255;
            } else if (
              coords.x >= HALF_X &&
              labelSoft.id > 0 &&
              isLayerVisible(labelSoft.id) &&
              structures[String(labelSoft.id)]
            ) {
              const color = structures[String(labelSoft.id)].color as [number, number, number];
              const [r, g, b] = blendOverlayColor(mriVal, labelSoft.id, color, labelSoft.coverage);
              d[pIdx] = r;
              d[pIdx + 1] = g;
              d[pIdx + 2] = b;
              d[pIdx + 3] = 255;
            } else {
              d[pIdx] = d[pIdx + 1] = d[pIdx + 2] = mriVal;
              d[pIdx + 3] = 255;
            }
          }
        }
        ctx.putImageData(imgData, 0, 0);

        const cy = ((DIMS.y - 1 - coords.y + 0.5) / DIMS.y) * W;
        const cz = ((DIMS.z - 1 - coords.z + 0.5) / DIMS.z) * H;
        ctx.setLineDash([]);
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = 'rgba(76, 175, 80, 0.95)';
        ctx.beginPath();
        ctx.moveTo(cy, 0);
        ctx.lineTo(cy, H);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(41, 182, 246, 0.95)';
        ctx.beginPath();
        ctx.moveTo(0, cz);
        ctx.lineTo(W, cz);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 235, 59, 0.95)';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        for (let py = 0; py < W; py++) {
          const vy = DIMS.y - 1 - ((py + 0.5) / W) * DIMS.y;
          const lineVz = coords.z + (vy - coords.y) * tanTilt;
          const linePz = ((DIMS.z - 1 - lineVz + 0.5) / DIMS.z) * H;
          if (py === 0) ctx.moveTo(py, linePz);
          else ctx.lineTo(py, linePz);
        }
        ctx.stroke();
      }
    }
  }, [
    rawMriData,
    labelData,
    sulciData,
    structures,
    coords,
    overlayAlpha,
    tiltAngle,
    mriSeq,
    activeZoomMode,
    visibleLayers.sulci,
    isLayerVisible,
    renderZoomView,
    sampleMriTrilinear,
    sampleLabelHiRes,
    blendOverlayColor,
  ]);

  useEffect(() => {
    renderViews();
  }, [renderViews]);

  // PCマウスホイール操作
  useEffect(() => {
    const axialEl = axialCanvasRef.current;
    const coronalEl = coronalCanvasRef.current;
    const sagittalEl = sagittalCanvasRef.current;
    const zoomEl = zoomCanvasRef.current;

    const handleZWheel = (e: WheelEvent) => {
      if (mriSeq === 'mra') return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 1 : -1;
      setCoords((prev) => {
        const zRange = getZoomZRange(subViewMode, tiltAngle, prev.y);
        const zMin = zRange?.min ?? 0;
        const zMax = zRange?.max ?? DIMS.z - 1;
        return {
          ...prev,
          z: clampCoord(prev.z + step, zMin, zMax),
        };
      });
    };

    const handleCoronalWheel = (e: WheelEvent) => {
      if (mriSeq === 'mra') return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 1 : -1;
      setCoords((prev) => ({ ...prev, y: Math.max(0, Math.min(DIMS.y - 1, prev.y + step)) }));
    };

    const handleSagittalWheel = (e: WheelEvent) => {
      if (mriSeq === 'mra') return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 1 : -1;
      setCoords((prev) => ({ ...prev, x: Math.max(0, Math.min(DIMS.x - 1, prev.x + step)) }));
    };

    if (axialEl) axialEl.addEventListener('wheel', handleZWheel, { passive: false });
    if (zoomEl) zoomEl.addEventListener('wheel', handleZWheel, { passive: false });
    if (coronalEl) coronalEl.addEventListener('wheel', handleCoronalWheel, { passive: false });
    if (sagittalEl) sagittalEl.addEventListener('wheel', handleSagittalWheel, { passive: false });

    return () => {
      if (axialEl) axialEl.removeEventListener('wheel', handleZWheel);
      if (zoomEl) zoomEl.removeEventListener('wheel', handleZWheel);
      if (coronalEl) coronalEl.removeEventListener('wheel', handleCoronalWheel);
      if (sagittalEl) sagittalEl.removeEventListener('wheel', handleSagittalWheel);
    };
  }, [mriSeq, subViewMode, tiltAngle]);

  // 軸位断：マウスホバー＆クリック・スマホタップ対応
  const inspectAxialPointer = (e: React.PointerEvent<HTMLCanvasElement>, selectOnHit: boolean) => {
    if (!labelData || !axialCanvasRef.current) return;
    if (e.pointerType !== 'mouse' && !selectOnHit) return;
    if (touchStateRef.current.moved) return;

    const rect = axialCanvasRef.current.getBoundingClientRect();
    const px = Math.floor(((e.clientX - rect.left) / rect.width) * DIMS.x);
    const py = Math.floor(((e.clientY - rect.top) / rect.height) * DIMS.y);

    if (px < 0 || px >= DIMS.x || py < 0 || py >= DIMS.y) {
      setHoveredStructure(null);
      return;
    }

    if (mriSeq === 'mra') {
      const lId = mraAxialLabelMapRef.current[py * DIMS.x + px] || 0;
      if (lId > 0 && structures[String(lId)]) {
        const hit = { id: lId, info: structures[String(lId)] };
        setHoveredStructure({ ...hit, x: e.clientX, y: e.clientY });
        if (selectOnHit) setSelectedStructure(hit);
      } else {
        setHoveredStructure(null);
      }
      return;
    }

    const pivotPy = DIMS.y - 1 - coords.y;
    const distFromPivot = pivotPy - py;
    const tiltRad = (tiltAngle * Math.PI) / 180;
    const vy = coords.y + distFromPivot * Math.cos(tiltRad);
    const vz = coords.z + distFromPivot * Math.sin(tiltRad);

    if (selectOnHit && e.pointerType === 'mouse') {
      console.log(`[${px}, ${Math.round(vy)}, ${Math.round(vz)}], // クリック点 (192基準)`);
    }

    const vIdx = getVoxelIdx(px, vy, vz);
    let foundId = 0;
    if (visibleLayers.sulci && sulciData && (sulciData[vIdx] || 0) > 0) {
      foundId = sulciData[vIdx];
    } else {
      const lId = labelData[vIdx] || 0;
      if (lId > 0 && isLayerVisible(lId)) foundId = lId;
    }

    if (foundId > 0 && structures[String(foundId)]) {
      const hit = { id: foundId, info: structures[String(foundId)] };
      setHoveredStructure({ ...hit, x: e.clientX, y: e.clientY });
      if (selectOnHit) {
        setSelectedStructure(hit);
        // スマホのみインライン説明。PC/タブレットは右ペインの説明を使う
        if (compactViewer) setInlineInspectorOpen(true);
      }
    } else {
      setHoveredStructure(null);
    }
  };

  // 拡大ビュー：マウスホバー＆クリック・スマホタップ対応
  const inspectZoomPointer = (e: React.PointerEvent<HTMLCanvasElement>, selectOnHit: boolean) => {
    if (!labelData || !zoomCanvasRef.current) return;
    if (e.pointerType !== 'mouse' && !selectOnHit) return;
    if (touchStateRef.current.moved) return;

    const rect = zoomCanvasRef.current.getBoundingClientRect();
    const xMin = (activeZoomMode === 'ic_zoom' ? 58 : 46) * VOL_SCALE;
    const xMax = (activeZoomMode === 'ic_zoom' ? 98 : 82) * VOL_SCALE;
    const yMin = (activeZoomMode === 'ic_zoom' ? 46 : 38) * VOL_SCALE;
    const yMax = (activeZoomMode === 'ic_zoom' ? 86 : 74) * VOL_SCALE;

    const fx = xMin + ((e.clientX - rect.left) / rect.width) * (xMax - xMin);
    const planeY = yMax - ((e.clientY - rect.top) / rect.height) * (yMax - yMin);

    const tiltRad = (tiltAngle * Math.PI) / 180;
    const distFromPivot = planeY - coords.y;
    const realVy = coords.y + distFromPivot * Math.cos(tiltRad);
    const realVz = coords.z + distFromPivot * Math.sin(tiltRad);

    if (fx < HALF_X || realVy < 0 || realVy >= DIMS.y || realVz < 0 || realVz >= DIMS.z) {
      setHoveredStructure(null);
      return;
    }

    const vIdx = getVoxelIdx(fx, realVy, realVz);
    let targetId = 0;
    if (activeZoomMode === 'ic_zoom') {
      const baseId = labelData[vIdx] || 0;
      if (baseId >= 202 && baseId <= 204) targetId = getDetailedInternalCapsuleId(baseId, fx, realVy);
    } else if (activeZoomMode === 'stem_zoom' && stemMicroData) {
      const microId = stemMicroData[vIdx] || 0;
      if (microId >= 601 && microId <= 635) targetId = microId;
    }

    if (targetId > 0 && structures[String(targetId)]) {
      const hit = { id: targetId, info: structures[String(targetId)] };
      setHoveredStructure({ ...hit, x: e.clientX, y: e.clientY });
      if (selectOnHit) {
        setSelectedStructure(hit);
        if (compactViewer) setInlineInspectorOpen(true);
      }
    } else {
      setHoveredStructure(null);
    }
  };

  const setAllLayers = (value: boolean) => {
    const next: Record<string, boolean> = {};
    LAYER_ITEMS.forEach((item) => {
      next[item.key] = value;
    });
    setVisibleLayers(next);
  };

  const enterSubViewMode = (mode: SubViewMode) => {
    setSubViewMode(mode);
    resetZoom();
    setInlineInspectorOpen(false);
    setCoords((prev) => {
      const zRange = getZoomZRange(mode, tiltAngle, prev.y);
      if (!zRange) return prev;
      return { ...prev, z: zRange.defaultZ };
    });
  };

  // 傾斜角や Y が変わったら、拡大モード中の Z を届く範囲内へクランプ
  useEffect(() => {
    const zRange = getZoomZRange(subViewMode, tiltAngle, coords.y);
    if (!zRange) return;
    setCoords((prev) => {
      const nextZ = clampCoord(prev.z, zRange.min, zRange.max);
      return nextZ === prev.z ? prev : { ...prev, z: nextZ };
    });
  }, [subViewMode, tiltAngle, coords.y]);

  const handleReset = () => {
    setCoords(DEFAULT_COORDS);
    setTiltAngle(DEFAULT_TILT);
    setActivePreset('AC-PC');
    setSubViewMode('ortho');
    resetZoom();
    setSelectedStructure(null);
    setInlineInspectorOpen(false);
  };

  const renderStructureInspectorBody = (structure: { id: number; info: StructureInfo }) => {
    const category = getCategoryInfo(structure.id, structure.info.name);
    return (
      <>
        <div
          className="inspector-category-badge"
          style={{
            backgroundColor: category.bg,
            color: structure.id >= 1000 ? '#000' : '#fff',
          }}
        >
          {category.label}
        </div>
        <h3 className="inspector-structure-name">{structure.info.name}</h3>
        <div className="inspector-meta">
          略称: <strong>{structure.info.abbr}</strong> | ID: {structure.id}
        </div>
        <div className="inspector-section">
          <div className="inspector-section-title" style={{ color: '#00bcd4' }}>
            【機能解剖・生理機能】
          </div>
          <div className="inspector-section-body">{structure.info.function}</div>
        </div>
        <div className="inspector-section">
          <div className="inspector-section-title" style={{ color: '#ff7043' }}>
            【臨床症状・リハビリテーション評価】
          </div>
          <div className="inspector-clinical">{structure.info.clinical}</div>
        </div>
      </>
    );
  };

  const applyPreset = (preset: 'AC-PC' | 'CC line' | 'RBL' | 'OML') => {
    setActivePreset(preset);
    let nextZ = coords.z;
    let nextTilt = tiltAngle;
    switch (preset) {
      case 'AC-PC':
        nextTilt = 0;
        nextZ = 81;
        break;
      case 'CC line':
        nextTilt = -5;
        nextZ = 78;
        break;
      case 'RBL':
        nextTilt = -15;
        nextZ = 69;
        break;
      case 'OML':
        nextTilt = -20;
        nextZ = 63;
        break;
    }
    setTiltAngle(nextTilt);
    setCoords((prev) => {
      const zRange = getZoomZRange(subViewMode, nextTilt, prev.y);
      return {
        ...prev,
        z: zRange ? clampCoord(nextZ, zRange.min, zRange.max) : nextZ,
      };
    });
  };

  const stepCoord = (axis: 'x' | 'y' | 'z', delta: number) => {
    setCoords((prev) => {
      let min = 0;
      let max = DIMS[axis] - 1;
      if (axis === 'z') {
        const zRange = getZoomZRange(subViewMode, tiltAngle, prev.y);
        if (zRange) {
          min = zRange.min;
          max = zRange.max;
        }
      }
      return {
        ...prev,
        [axis]: clampCoord(prev[axis] + delta, min, max),
      };
    });
  };

  // 1倍時は縦スクロールを許可(pan-y)、拡大中はパン移動を優先(none)
  const canvasInteractiveStyle: React.CSSProperties = {
    transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`,
    touchAction: zoomScale > 1.05 ? 'none' : 'pan-y',
  };

  const renderZoomOverlayButtons = () => (
    <div className="zoom-controls-overlay">
      <button className="zoom-ctrl-btn" onClick={() => adjustZoom(-0.5)} aria-label="縮小">
        −
      </button>
      <button className="zoom-ctrl-btn" onClick={resetZoom}>
        {zoomScale.toFixed(1)}x
      </button>
      <button className="zoom-ctrl-btn" onClick={() => adjustZoom(0.5)} aria-label="拡大">
        ＋
      </button>
    </div>
  );

  const activeStructureDisplay = hoveredStructure || selectedStructure;

  const renderSliceBar = (axis: 'x' | 'y' | 'z', accentColor: string) => {
    const zRange = axis === 'z' ? getZoomZRange(subViewMode, tiltAngle, coords.y) : null;
    const min = zRange?.min ?? 0;
    const max = zRange?.max ?? DIMS[axis] - 1;
    const value = clampCoord(coords[axis], min, max);
    return (
      <div className="slice-bar">
        <button
          className="slice-step-btn"
          onClick={() => stepCoord(axis, -1)}
          aria-label={`${axis.toUpperCase()} -1`}
        >
          −
        </button>
        <input
          type="range"
          className="slice-range"
          min={min}
          max={max}
          value={value}
          onChange={(e) =>
            setCoords((prev) => ({
              ...prev,
              [axis]: clampCoord(parseInt(e.target.value, 10), min, max),
            }))
          }
          style={{ accentColor }}
        />
        <button
          className="slice-step-btn"
          onClick={() => stepCoord(axis, 1)}
          aria-label={`${axis.toUpperCase()} +1`}
        >
          ＋
        </button>
      </div>
    );
  };

  return (
    <div className="atlas-app">
      {/* ファーストビュー（1画面に収まるヘッダー＋画像領域） */}
      <div className="atlas-workspace">
        {/* スリム1行ヘッダー */}
        <header className="atlas-header">
          <div className="header-left">
            <h1 className="app-title">Brain MRI Atlas</h1>

            <div className="seq-group">
              {(['t1', 't2', 'flair', 'dwi', 'mra'] as const).map((seq) => (
                <button
                  key={seq}
                  onClick={() => setMriSeq(seq)}
                  className={`seq-btn ${mriSeq === seq ? 'active' : ''}`}
                >
                  {seq}
                </button>
              ))}
            </div>

            {mriSeq !== 'mra' && (
              <div className="mode-group">
                {[
                  { mode: 'ortho' as const, label: '標準' },
                  { mode: 'ic_zoom' as const, label: '内包拡大' },
                  { mode: 'stem_zoom' as const, label: '脳幹拡大' },
                ].map((tab) => (
                  <button
                    key={tab.mode}
                    onClick={() => enterSubViewMode(tab.mode)}
                    className={`mode-btn ${subViewMode === tab.mode ? 'active' : ''}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            )}

            {mriSeq !== 'mra' && (
              <div className="layer-bar-desktop">
                {LAYER_ITEMS.map((item) => (
                  <button
                    key={item.key}
                    onClick={() =>
                      setVisibleLayers((prev) => ({ ...prev, [item.key]: !prev[item.key] }))
                    }
                    style={{
                      padding: '2px 5px',
                      fontSize: '10px',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      border: visibleLayers[item.key] ? `1px solid ${item.color}` : '1px solid #444',
                      backgroundColor: visibleLayers[item.key] ? item.color : '#222',
                      color: visibleLayers[item.key] ? (item.key === 'sulci' ? '#000' : '#fff') : '#777',
                      fontWeight: visibleLayers[item.key] ? 'bold' : 'normal',
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}

            {mriSeq !== 'mra' && (
              <div className="layer-popover-wrapper">
                <button
                  className="layer-popover-btn"
                  onClick={() => setIsLayerMenuOpen((prev) => !prev)}
                >
                  表示層 ▾
                </button>
                {isLayerMenuOpen && (
                  <div className="layer-popover-panel">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontSize: '13px', color: '#00e5ff' }}>表示レイヤー選択</strong>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          onClick={() => setAllLayers(true)}
                          style={{
                            fontSize: '11px',
                            padding: '3px 8px',
                            background: '#263238',
                            color: '#fff',
                            border: '1px solid #455a64',
                            borderRadius: '4px',
                          }}
                        >
                          全ON
                        </button>
                        <button
                          onClick={() => setAllLayers(false)}
                          style={{
                            fontSize: '11px',
                            padding: '3px 8px',
                            background: '#263238',
                            color: '#fff',
                            border: '1px solid #455a64',
                            borderRadius: '4px',
                          }}
                        >
                          全OFF
                        </button>
                        <button
                          onClick={() => setIsLayerMenuOpen(false)}
                          style={{
                            fontSize: '11px',
                            padding: '3px 8px',
                            background: '#b71c1c',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '4px',
                          }}
                        >
                          閉じる
                        </button>
                      </div>
                    </div>
                    <div className="layer-popover-grid">
                      {LAYER_ITEMS.map((item) => (
                        <button
                          key={item.key}
                          onClick={() =>
                            setVisibleLayers((prev) => ({ ...prev, [item.key]: !prev[item.key] }))
                          }
                          style={{
                            padding: '8px 10px',
                            fontSize: '12px',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            textAlign: 'left',
                            border: visibleLayers[item.key]
                              ? `1px solid ${item.color}`
                              : '1px solid #333',
                            backgroundColor: visibleLayers[item.key] ? item.color : '#222',
                            color: visibleLayers[item.key]
                              ? item.key === 'sulci'
                                ? '#000'
                                : '#fff'
                              : '#888',
                            fontWeight: 'bold',
                          }}
                        >
                          {visibleLayers[item.key] ? '✓ ' : ' '}
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="header-right">
            <div className="alpha-control">
              <span className="alpha-label">透明度</span>
              <input
                type="range"
                min="0.0"
                max="1.0"
                step="0.05"
                value={transparency}
                onChange={(e) => setTransparency(parseFloat(e.target.value))}
                className="alpha-range"
              />
              <span className="alpha-value">{Math.round(transparency * 100)}%</span>
            </div>

            {!isNativeApp && (
              <button
                onClick={toggleLandscapeFullscreen}
                style={{
                  padding: '3px 7px',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  borderRadius: '4px',
                  border: isFullscreen ? '1px solid #00e5ff' : '1px solid #444',
                  backgroundColor: isFullscreen ? '#004d40' : '#222',
                  color: isFullscreen ? '#00e5ff' : '#ddd',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {isFullscreen ? '全画面解除' : '横全画面'}
              </button>
            )}
          </div>
        </header>

        {/* メイン領域 */}
        <div className="atlas-main">
          <div className="viewer-stage">
            {mriSeq === 'mra' ? (
              <div className="mra-grid">
                <div className="slice-column">
                  <div className="slice-label" style={{ color: '#00e5ff' }}>
                    3D-TOF MRA
                  </div>
                  <div className="slice-stage">
                    <div className="slice-canvas-box">
                      <Mra3DViewer
                        labelData={labelData}
                        structures={structures}
                        selectedId={selectedStructure?.id ?? null}
                        overlayAlpha={overlayAlpha}
                        onSelect={(id) => {
                          if (structures[String(id)]) {
                            setSelectedStructure({ id, info: structures[String(id)] });
                          }
                        }}
                        onHover={(hit) => {
                          if (hit && structures[String(hit.id)]) {
                            setHoveredStructure({
                              id: hit.id,
                              info: structures[String(hit.id)],
                              x: hit.x,
                              y: hit.y,
                            });
                          } else {
                            setHoveredStructure(null);
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="slice-column">
                  <div className="slice-label" style={{ color: '#4caf50' }}>
                    正面投影 (AP MIP)
                  </div>
                  <div className="slice-stage">
                    <div className="slice-canvas-box">
                      <canvas
                        ref={coronalCanvasRef}
                        className="mri-canvas"
                        style={canvasInteractiveStyle}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                      />
                      {renderZoomOverlayButtons()}
                    </div>
                  </div>
                </div>

                <div className="slice-column">
                  <div className="slice-label" style={{ color: '#ff9800' }}>
                    側面投影 (Lateral MIP)
                  </div>
                  <div className="slice-stage">
                    <div className="slice-canvas-box">
                      <canvas
                        ref={sagittalCanvasRef}
                        className="mri-canvas"
                        style={canvasInteractiveStyle}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                      />
                      {renderZoomOverlayButtons()}
                    </div>
                  </div>
                </div>
              </div>
            ) : activeZoomMode === 'ortho' ? (
              /* PC/タブレット: 大軸位断＋冠状/矢状縦積み。スマホ: 3断面横並び＋インライン説明 */
              <div
                className={`ortho-grid${
                  compactViewer && inlineInspectorOpen && selectedStructure ? ' is-detail' : ''
                }`}
              >
                <div className="slice-column">
                  <div className="slice-label" style={{ color: '#00e5ff' }}>
                    <span>軸位断 (Z: {coords.z})</span>
                    {tiltAngle !== 0 && (
                      <span className="tilt-tag">
                        {activePreset} {tiltAngle}°
                      </span>
                    )}
                  </div>
                  <div className="slice-stage">
                    <div className="slice-canvas-box">
                      <canvas
                        ref={axialCanvasRef}
                        className="mri-canvas"
                        style={canvasInteractiveStyle}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                        onPointerMove={(e) => inspectAxialPointer(e, false)}
                        onPointerUp={(e) => inspectAxialPointer(e, true)}
                        onPointerLeave={() => setHoveredStructure(null)}
                      />
                      {activeStructureDisplay && !(compactViewer && inlineInspectorOpen) && (
                        <div className="structure-chip">
                          {activeStructureDisplay.info.name}
                        </div>
                      )}
                      {renderZoomOverlayButtons()}
                    </div>
                  </div>
                  {renderSliceBar('z', '#00e5ff')}
                </div>

                <div
                  className={`slice-column${
                    compactViewer && inlineInspectorOpen && selectedStructure ? ' is-hidden' : ''
                  }`}
                >
                  <div className="slice-label" style={{ color: '#4caf50' }}>
                    <span>冠状断 (Y: {coords.y})</span>
                  </div>
                  <div className="slice-stage">
                    <div className="slice-canvas-box">
                      <canvas
                        ref={coronalCanvasRef}
                        className="mri-canvas"
                        style={canvasInteractiveStyle}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                      />
                      {renderZoomOverlayButtons()}
                    </div>
                  </div>
                  {renderSliceBar('y', '#4caf50')}
                </div>

                <div
                  className={`slice-column${
                    compactViewer && inlineInspectorOpen && selectedStructure ? ' is-hidden' : ''
                  }`}
                >
                  <div className="slice-label" style={{ color: '#ff9800' }}>
                    <span>矢状断 (X: {coords.x})</span>
                  </div>
                  <div className="slice-stage">
                    <div className="slice-canvas-box">
                      <canvas
                        ref={sagittalCanvasRef}
                        className="mri-canvas"
                        style={canvasInteractiveStyle}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                      />
                      {renderZoomOverlayButtons()}
                    </div>
                  </div>
                  {renderSliceBar('x', '#ff9800')}
                </div>

                {compactViewer && inlineInspectorOpen && selectedStructure && (
                  <div className="ortho-detail-panel">
                    <div className="ortho-detail-header">
                      <span className="ortho-detail-title">臨床神経解剖インスペクター</span>
                      <button
                        type="button"
                        className="ortho-detail-close"
                        aria-label="説明を閉じて3断面表示に戻る"
                        onClick={() => setInlineInspectorOpen(false)}
                      >
                        ×
                      </button>
                    </div>
                    <div className="ortho-detail-body">
                      {renderStructureInspectorBody(selectedStructure)}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* 内包拡大・脳幹拡大: PCは大軸位＋拡大、スマホは横並び＋インライン説明 */
              <div
                className={`zoom-grid${
                  compactViewer && inlineInspectorOpen && selectedStructure ? ' is-detail' : ''
                }`}
              >
                <div className="slice-column">
                  <div className="slice-label" style={{ color: '#00e5ff' }}>
                    <span>軸位断 (Z: {coords.z})</span>
                    {tiltAngle !== 0 && (
                      <span className="tilt-tag">
                        {activePreset} {tiltAngle}°
                      </span>
                    )}
                  </div>
                  <div className="slice-stage">
                    <div className="slice-canvas-box">
                      <canvas
                        ref={axialCanvasRef}
                        className="mri-canvas"
                        style={canvasInteractiveStyle}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                        onPointerMove={(e) => inspectAxialPointer(e, false)}
                        onPointerUp={(e) => inspectAxialPointer(e, true)}
                        onPointerLeave={() => setHoveredStructure(null)}
                      />
                      {activeStructureDisplay && !(compactViewer && inlineInspectorOpen) && (
                        <div className="structure-chip">
                          {activeStructureDisplay.info.name}
                        </div>
                      )}
                      {renderZoomOverlayButtons()}
                    </div>
                  </div>
                  {renderSliceBar('z', '#00e5ff')}
                </div>

                <div className="slice-column">
                  <div className="slice-label" style={{ color: '#00e5ff' }}>
                    <span>
                      {activeZoomMode === 'ic_zoom'
                        ? `内包拡大 (Z: ${coords.z})`
                        : `脳幹微細拡大 (Z: ${coords.z})`}
                    </span>
                  </div>

                  <div className="slice-stage">
                    <div className="slice-canvas-box slice-canvas-zoom">
                      <canvas
                        ref={zoomCanvasRef}
                        className="mri-canvas"
                        style={canvasInteractiveStyle}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                        onPointerMove={(e) => inspectZoomPointer(e, false)}
                        onPointerUp={(e) => inspectZoomPointer(e, true)}
                        onPointerLeave={() => setHoveredStructure(null)}
                      />
                      {renderZoomOverlayButtons()}
                    </div>
                  </div>
                  {renderSliceBar('z', '#00e5ff')}
                </div>

                {compactViewer && inlineInspectorOpen && selectedStructure && (
                  <div className="ortho-detail-panel zoom-detail-panel">
                    <div className="ortho-detail-header">
                      <span className="ortho-detail-title">臨床神経解剖インスペクター</span>
                      <button
                        type="button"
                        className="ortho-detail-close"
                        aria-label="説明を閉じて2画面表示に戻る"
                        onClick={() => setInlineInspectorOpen(false)}
                      >
                        ×
                      </button>
                    </div>
                    <div className="ortho-detail-body">
                      {renderStructureInspectorBody(selectedStructure)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 操作パネル ＆ 臨床神経解剖インスペクター */}
          <aside className="pane-inspector">
            {mriSeq !== 'mra' ? (
              <div className="control-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#00e5ff' }}>
                    基準線・傾斜コントロール
                  </span>
                  <button
                    onClick={handleReset}
                    style={{
                      padding: '4px 10px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '1px solid #d32f2f',
                      backgroundColor: '#b71c1c',
                      color: '#fff',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                    }}
                  >
                    リセット
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '5px' }}>
                  {(['AC-PC', 'CC line', 'RBL', 'OML'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => applyPreset(p)}
                      style={{
                        padding: '6px 2px',
                        fontSize: '11px',
                        fontWeight: activePreset === p ? 'bold' : 'normal',
                        borderRadius: '4px',
                        border: '1px solid #444',
                        backgroundColor: activePreset === p ? '#0288d1' : '#222',
                        color: activePreset === p ? '#fff' : '#ccc',
                        cursor: 'pointer',
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                    <span style={{ color: '#ffeb3b' }}>傾斜角 (Tilt):</span>
                    <span style={{ color: '#ffeb3b', fontWeight: 'bold' }}>{tiltAngle}°</span>
                  </div>
                  <input
                    type="range"
                    min="-30"
                    max="30"
                    value={tiltAngle}
                    onChange={(e) => {
                      setTiltAngle(parseInt(e.target.value, 10));
                      setActivePreset('Custom');
                    }}
                    style={{ width: '100%', cursor: 'pointer' }}
                  />
                </div>
              </div>
            ) : (
              <div className="control-card">
                <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#00e5ff' }}>
                  主要脳動脈 14系統カラー凡例
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {[901, 902, 903, 904, 905, 906, 907, 908, 909, 910, 911, 912, 913, 914].map((id) => {
                    const info = structures[String(id)];
                    if (!info) return null;
                    return (
                      <div
                        key={id}
                        onClick={() => setSelectedStructure({ id, info })}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '5px 8px',
                          borderRadius: '4px',
                          backgroundColor: selectedStructure?.id === id ? '#252525' : '#1a1a1a',
                          cursor: 'pointer',
                        }}
                      >
                        <span
                          style={{
                            width: '10px',
                            height: '10px',
                            borderRadius: '50%',
                            backgroundColor: `rgb(${info.color.join(',')})`,
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ fontSize: '11px', color: '#eee' }}>{info.name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* スマホでインライン説明中のみ非表示。PC/タブレットは常に右ペインで表示 */}
            <div
              className={`inspector-dock${
                compactViewer && inlineInspectorOpen && selectedStructure ? ' is-suppressed' : ''
              }`}
            >
              <h2 style={{ fontSize: '13px', color: '#777', margin: '0 0 10px 0' }}>
                臨床神経解剖インスペクター
              </h2>
              {selectedStructure ? (
                <div>{renderStructureInspectorBody(selectedStructure)}</div>
              ) : (
                <div
                  style={{
                    color: '#555',
                    fontSize: '12px',
                    lineHeight: '1.6',
                    textAlign: 'center',
                    padding: '16px 0',
                  }}
                >
                  軸位断の着色側をタップすると解説が表示されます。
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>

      {/* PC・タブレット用フローティングツールチップ */}
      {hoveredStructure && (
        <div
          className="desktop-tooltip"
          style={{
            position: 'fixed',
            left: hoveredStructure.x + 15,
            top: hoveredStructure.y - 35,
            backgroundColor: 'rgba(20, 20, 20, 0.95)',
            border: '1px solid #444',
            padding: '8px 12px',
            borderRadius: '6px',
            pointerEvents: 'none',
            zIndex: 150,
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            maxWidth: '330px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <span
              style={{
                fontSize: '10px',
                padding: '2px 6px',
                borderRadius: '3px',
                backgroundColor: getCategoryInfo(
                  hoveredStructure.id,
                  hoveredStructure.info.name
                ).bg,
                color: hoveredStructure.id >= 1000 ? '#000' : '#fff',
                fontWeight: 'bold',
              }}
            >
              {getCategoryInfo(hoveredStructure.id, hoveredStructure.info.name).label}
            </span>
            <span style={{ fontSize: '10px', color: '#888' }}>ID: {hoveredStructure.id}</span>
          </div>
          <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#ffeb3b' }}>
            {hoveredStructure.info.name}
          </div>
        </div>
      )}
    </div>
  );
}