import React, { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import Mra3DViewer from './Mra3DViewer';

const DIMS = { x: 192, y: 192, z: 192 };
const VOL_SCALE = 192 / 128; // 1.5
const HALF_X = DIMS.x / 2;   // 96
const SLICE_RES = 384;       // 通常3断面の描画解像度（重ければ 256）
const ZOOM_RES = 576;        // 内包・脳幹拡大ビューの描画解像度
const DEFAULT_COORDS = { x: 96, y: 96, z: 81 };
const DEFAULT_TILT = 0;
const DEFAULT_TRANSPARENCY = 0.6; // 透明度60%（色の濃さ40%）。0%=色100%、100%=完全透明

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
type MobileViewTab = 'axial' | 'coronal' | 'sagittal' | 'ic_zoom' | 'stem_zoom';

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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
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
  const [mobileTab, setMobileTab] = useState<MobileViewTab>('axial');
  const [isLayerMenuOpen, setIsLayerMenuOpen] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // キャンバス拡大率(1.0〜4.0)とパン位置
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const [rawMriData, setRawMriData] = useState<Uint8Array | null>(null);
  const [labelData, setLabelData] = useState<Uint16Array | null>(null);
  const [stemMicroData, setStemMicroData] = useState<Uint16Array | null>(null);
  const [sulciData, setSulciData] = useState<Uint16Array | null>(null);
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
      .then((data: StructuresDict) => setStructures(data))
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

  // MRIシーケンス読込
  useEffect(() => {
    const fileName = `brain_${mriSeq}.bin.gz`;
    fetchGzipBin(`/${fileName}`)
      .then((buf) => setRawMriData(new Uint8Array(buf)))
      .catch((err) => console.error(`${fileName} 読込失敗:`, err));

    if (mriSeq === 'mra' && (mobileTab === 'ic_zoom' || mobileTab === 'stem_zoom')) {
      setMobileTab('axial');
    }
  }, [mriSeq, mobileTab]);

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

  const isLayerVisible = useCallback(
    (id: number) => {
      if (id === 0) return false;
      return !!visibleLayers[getCategoryInfo(id, structures[String(id)]?.name).key];
    },
    [visibleLayers, structures]
  );

  const blendMraPixel = (mriVal: number, lId: number): [number, number, number] => {
    if (lId >= 900 && lId < 1000 && structures[String(lId)] && mriVal > 35) {
      const [cr, cg, cb] = structures[String(lId)].color;
      const a = overlayAlpha;
      return [
        Math.round(mriVal * (1 - a) + cr * (mriVal / 255) * a),
        Math.round(mriVal * (1 - a) + cg * (mriVal / 255) * a),
        Math.round(mriVal * (1 - a) + cb * (mriVal / 255) * a),
      ];
    }
    return [mriVal, mriVal, mriVal];
  };

  const activeZoomMode: SubViewMode =
    subViewMode !== 'ortho'
      ? subViewMode
      : mobileTab === 'ic_zoom' || mobileTab === 'stem_zoom'
      ? mobileTab
      : 'ortho';

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
        const vIdx = getVoxelIdx(fx, realVy, realVz);

        let targetId = 0;
        if (activeZoomMode === 'ic_zoom') {
          const baseId = labelData[vIdx] || 0;
          if (baseId >= 202 && baseId <= 204) {
            targetId = getDetailedInternalCapsuleId(baseId, fx, realVy);
          }
        } else if (activeZoomMode === 'stem_zoom' && stemMicroData) {
          const microId = stemMicroData[vIdx] || 0;
          if (microId >= 601 && microId <= 635) {
            targetId = microId;
          }
        }

        if (fx >= HALF_X && targetId > 0 && structures[String(targetId)]) {
          const [cr, cg, cb] = structures[String(targetId)].color;
          const a = overlayAlpha * 0.85;
          d[pIdx] = Math.round(mriVal * (1 - a) + cr * a);
          d[pIdx + 1] = Math.round(mriVal * (1 - a) + cg * a);
          d[pIdx + 2] = Math.round(mriVal * (1 - a) + cb * a);
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
            const vIdx = getVoxelIdx(fx, vy, vz);
            const lId = labelData[vIdx] || 0;
            const sId = sulciData ? sulciData[vIdx] || 0 : 0;

            if (fx >= HALF_X && visibleLayers.sulci && sId > 0 && structures[String(sId)]) {
              const [sr, sg, sb] = structures[String(sId)].color;
              const a = overlayAlpha;
              d[pIdx] = Math.round(mriVal * (1 - a) + sr * a);
              d[pIdx + 1] = Math.round(mriVal * (1 - a) + sg * a);
              d[pIdx + 2] = Math.round(mriVal * (1 - a) + sb * a);
              d[pIdx + 3] = 255;
            } else if (fx >= HALF_X && lId > 0 && isLayerVisible(lId) && structures[String(lId)]) {
              const [cr, cg, cb] = structures[String(lId)].color;
              const a = overlayAlpha;
              d[pIdx] = Math.round(mriVal * (1 - a) + cr * a);
              d[pIdx + 1] = Math.round(mriVal * (1 - a) + cg * a);
              d[pIdx + 2] = Math.round(mriVal * (1 - a) + cb * a);
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
            const vIdx = getVoxelIdx(fx, coords.y, fz);
            const lId = labelData[vIdx] || 0;
            const sId = sulciData ? sulciData[vIdx] || 0 : 0;

            if (fx >= HALF_X && visibleLayers.sulci && sId > 0 && structures[String(sId)]) {
              const [sr, sg, sb] = structures[String(sId)].color;
              const a = overlayAlpha;
              d[pIdx] = Math.round(mriVal * (1 - a) + sr * a);
              d[pIdx + 1] = Math.round(mriVal * (1 - a) + sg * a);
              d[pIdx + 2] = Math.round(mriVal * (1 - a) + sb * a);
              d[pIdx + 3] = 255;
            } else if (fx >= HALF_X && lId > 0 && isLayerVisible(lId) && structures[String(lId)]) {
              const [cr, cg, cb] = structures[String(lId)].color;
              const a = overlayAlpha;
              d[pIdx] = Math.round(mriVal * (1 - a) + cr * a);
              d[pIdx + 1] = Math.round(mriVal * (1 - a) + cg * a);
              d[pIdx + 2] = Math.round(mriVal * (1 - a) + cb * a);
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
            const vIdx = getVoxelIdx(coords.x, fy, fz);
            const lId = labelData[vIdx] || 0;
            const sId = sulciData ? sulciData[vIdx] || 0 : 0;

            if (coords.x >= HALF_X && visibleLayers.sulci && sId > 0 && structures[String(sId)]) {
              const [sr, sg, sb] = structures[String(sId)].color;
              const a = overlayAlpha;
              d[pIdx] = Math.round(mriVal * (1 - a) + sr * a);
              d[pIdx + 1] = Math.round(mriVal * (1 - a) + sg * a);
              d[pIdx + 2] = Math.round(mriVal * (1 - a) + sb * a);
              d[pIdx + 3] = 255;
            } else if (coords.x >= HALF_X && lId > 0 && isLayerVisible(lId) && structures[String(lId)]) {
              const [cr, cg, cb] = structures[String(lId)].color;
              const a = overlayAlpha;
              d[pIdx] = Math.round(mriVal * (1 - a) + cr * a);
              d[pIdx + 1] = Math.round(mriVal * (1 - a) + cg * a);
              d[pIdx + 2] = Math.round(mriVal * (1 - a) + cb * a);
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
    mobileTab,
    visibleLayers.sulci,
    isLayerVisible,
    renderZoomView,
    sampleMriTrilinear,
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
      setCoords((prev) => ({ ...prev, z: Math.max(0, Math.min(DIMS.z - 1, prev.z + step)) }));
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
  }, [mriSeq, subViewMode, mobileTab]);

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
      }
    } else {
      setHoveredStructure(null);
    }
  };

  const handleMobileTabChange = (tab: MobileViewTab) => {
    setMobileTab(tab);
    resetZoom();
    if (tab === 'ic_zoom' || tab === 'stem_zoom') {
      setSubViewMode(tab);
    } else {
      setSubViewMode('ortho');
    }
  };

  const setAllLayers = (value: boolean) => {
    const next: Record<string, boolean> = {};
    LAYER_ITEMS.forEach((item) => {
      next[item.key] = value;
    });
    setVisibleLayers(next);
  };

  const handleReset = () => {
    setCoords(DEFAULT_COORDS);
    setTiltAngle(DEFAULT_TILT);
    setActivePreset('AC-PC');
    setSubViewMode('ortho');
    setMobileTab('axial');
    resetZoom();
    setSelectedStructure(null);
  };

  const applyPreset = (preset: 'AC-PC' | 'CC line' | 'RBL' | 'OML') => {
    setActivePreset(preset);
    switch (preset) {
      case 'AC-PC':
        setTiltAngle(0);
        setCoords((prev) => ({ ...prev, z: 81 }));
        break;
      case 'CC line':
        setTiltAngle(-5);
        setCoords((prev) => ({ ...prev, z: 78 }));
        break;
      case 'RBL':
        setTiltAngle(-15);
        setCoords((prev) => ({ ...prev, z: 69 }));
        break;
      case 'OML':
        setTiltAngle(-20);
        setCoords((prev) => ({ ...prev, z: 63 }));
        break;
    }
  };

  const stepCoord = (axis: 'x' | 'y' | 'z', delta: number) => {
    setCoords((prev) => ({
      ...prev,
      [axis]: Math.max(0, Math.min(DIMS[axis] - 1, prev[axis] + delta)),
    }));
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

  return (
    <div className="atlas-app">
      {/* ヘッダー */}
      <header className="atlas-header">
        <div className="header-left">
          <h1 className="app-title">
            3D Brain MRI Atlas <span className="app-subtitle">209 Structures</span>
          </h1>

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
            <div className="layer-bar-desktop">
              <span style={{ fontSize: '10px', color: '#888' }}>表示層:</span>
              {LAYER_ITEMS.map((item) => (
                <button
                  key={item.key}
                  onClick={() =>
                    setVisibleLayers((prev) => ({ ...prev, [item.key]: !prev[item.key] }))
                  }
                  style={{
                    padding: '2px 6px',
                    fontSize: '11px',
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
                表示層フィルタ ▾
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
            <span style={{ color: '#aaa' }}>透明度:</span>
            <input
              type="range"
              min="0.0"
              max="1.0"
              step="0.05"
              value={transparency}
              onChange={(e) => setTransparency(parseFloat(e.target.value))}
              style={{ width: '75px', cursor: 'pointer' }}
            />
            <span style={{ width: '32px', color: '#888' }}>{Math.round(transparency * 100)}%</span>
          </div>

          <div className="coord-badge">
            {mriSeq === 'mra' ? '3D-TOF MRA' : `X:${coords.x} Y:${coords.y} Z:${coords.z}`}
          </div>

          <button
            onClick={toggleLandscapeFullscreen}
            style={{
              padding: '4px 8px',
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
        </div>
      </header>

      {/* スマホ専用：ビュー切替タブ（MRA時は3D単体表示のため非表示） */}
      {mriSeq !== 'mra' && (
        <div className="mobile-view-tabs">
          {[
            { id: 'axial' as const, label: '軸位断' },
            { id: 'coronal' as const, label: '冠状断' },
            { id: 'sagittal' as const, label: '矢状断' },
            { id: 'ic_zoom' as const, label: '内包拡大' },
            { id: 'stem_zoom' as const, label: '脳幹拡大' },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => handleMobileTabChange(t.id)}
              className={`mobile-tab-btn ${mobileTab === t.id ? 'active' : ''}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* スマホ専用：タップした構造の表示バー */}
      <div className="mobile-touch-readout">
        {activeStructureDisplay ? (
          <>
            <span
              style={{
                fontWeight: 'bold',
                color: '#ffeb3b',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {activeStructureDisplay.info.name}
            </span>
            <span
              style={{
                fontSize: '10px',
                padding: '2px 6px',
                borderRadius: '3px',
                backgroundColor: getCategoryInfo(
                  activeStructureDisplay.id,
                  activeStructureDisplay.info.name
                ).bg,
                color: activeStructureDisplay.id >= 1000 ? '#000' : '#fff',
                flexShrink: 0,
                marginLeft: '8px',
              }}
            >
              {activeStructureDisplay.info.abbr}
            </span>
          </>
        ) : (
          <span style={{ color: '#777' }}>着色側をタップで解説表示 / 2本指ピンチで拡大</span>
        )}
      </div>

      {/* メイン領域 */}
      <div className="atlas-main">
        {/* 第1ペイン: メイン軸位断 または 3DインタラクティブMRA */}
        <div className={`pane-primary ${mriSeq !== 'mra' && mobileTab !== 'axial' ? 'mobile-hidden' : ''}`}>
          <div
            className="desktop-only-header"
            style={{
              width: '100%',
              maxWidth: '880px',
              marginBottom: '6px',
              fontSize: '13px',
              fontWeight: 'bold',
              color: '#00e5ff',
            }}
          >
            {mriSeq === 'mra' ? (
              <span>3D-TOF MRA インタラクティブ3D血管モデル（ドラッグで回転・クリックで解説）</span>
            ) : (
              <>
                軸位断 (Axial: Z = {coords.z}){' '}
                {tiltAngle !== 0 && (
                  <span style={{ color: '#ffeb3b', fontSize: '12px', marginLeft: '6px' }}>
                    [{activePreset} 傾斜: {tiltAngle}°]
                  </span>
                )}
                <span
                  style={{ fontSize: '11px', color: '#777', fontWeight: 'normal', marginLeft: '10px' }}
                >
                  ホイールでZ移動 / 左: 生MRI ↔ 右: アトラス
                </span>
              </>
            )}
          </div>

          {mriSeq === 'mra' ? (
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
          ) : (
            <div className="canvas-box-main">
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
              {renderZoomOverlayButtons()}
            </div>
          )}
        </div>

        {/* 第2ペイン: サブ2断面 または 内包・脳幹拡大図 */}
        <div className={`pane-secondary ${mobileTab === 'axial' ? 'mobile-hidden' : ''}`}>
          {mriSeq !== 'mra' && (
            <div className="submode-tabs desktop-only-header">
              {[
                { mode: 'ortho' as const, label: '標準 (冠状・矢状)' },
                { mode: 'ic_zoom' as const, label: '内包 局在拡大' },
                { mode: 'stem_zoom' as const, label: '脳幹 微細拡大' },
              ].map((tab) => (
                <button
                  key={tab.mode}
                  onClick={() => {
                    setSubViewMode(tab.mode);
                    resetZoom();
                  }}
                  className={`submode-btn ${subViewMode === tab.mode ? 'active' : ''}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {activeZoomMode === 'ortho' || mriSeq === 'mra' ? (
            <>
              <div
                className={mobileTab !== 'coronal' ? 'mobile-hidden' : ''}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}
              >
                <div
                  className="desktop-only-header"
                  style={{ fontSize: '12px', color: '#4caf50', marginBottom: '4px', width: '100%', maxWidth: '460px' }}
                >
                  {mriSeq === 'mra' ? '3D-TOF MRA 正面投影 (AP MIP)' : `冠状断 (Coronal: Y = ${coords.y})`}
                </div>
                <div className="canvas-box-sub">
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

              <div
                className={mobileTab !== 'sagittal' ? 'mobile-hidden' : ''}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: '100%',
                  marginTop: '4px',
                }}
              >
                <div
                  className="desktop-only-header"
                  style={{ fontSize: '12px', color: '#ff9800', marginBottom: '4px', width: '100%', maxWidth: '460px' }}
                >
                  {mriSeq === 'mra' ? '3D-TOF MRA 側面投影 (Lateral MIP)' : `矢状断 (Sagittal: X = ${coords.x})`}
                </div>
                <div className="canvas-box-sub">
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
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', gap: '8px' }}>
              <div
                className="desktop-only-header"
                style={{ width: '100%', maxWidth: '520px', fontSize: '13px', fontWeight: 'bold', color: '#00e5ff' }}
              >
                {activeZoomMode === 'ic_zoom'
                  ? `内包 詳細伝導路・体部位局在 (Z = ${coords.z} / 傾斜: ${tiltAngle}°)`
                  : `脳幹 微細神経核・伝導路 (Z = ${coords.z} / 傾斜: ${tiltAngle}°)`}
              </div>

              {activeZoomMode === 'stem_zoom' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', width: '100%', maxWidth: '520px', gap: '5px' }}>
                  {[
                    { label: '中脳上丘(66)', z: 66 },
                    { label: '中脳下丘(60)', z: 60 },
                    { label: '橋中部(51)', z: 51 },
                    { label: '橋下部(44)', z: 44 },
                    { label: '延髄上部(32)', z: 32 },
                    { label: '延髄下部(23)', z: 23 },
                  ].map((b) => (
                    <button
                      key={b.z}
                      onClick={() => setCoords((prev) => ({ ...prev, z: b.z }))}
                      style={{
                        padding: '5px 2px',
                        fontSize: '10px',
                        borderRadius: '4px',
                        border: coords.z === b.z ? '1px solid #00e5ff' : '1px solid #333',
                        backgroundColor: coords.z === b.z ? '#004d40' : '#1a1a1a',
                        color: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="canvas-box-zoom">
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
          )}
        </div>

        {/* スマホ専用：画像直下の親指スライス送りバー */}
        {mriSeq !== 'mra' && (
          <div className="mobile-z-stepper">
            {mobileTab === 'coronal' ? (
              <div className="stepper-row">
                <span style={{ fontSize: '11px', color: '#4caf50', width: '48px' }}>Y: {coords.y}</span>
                <button className="step-btn" onClick={() => stepCoord('y', -1)}>
                  −
                </button>
                <input
                  type="range"
                  min="0"
                  max={DIMS.y - 1}
                  value={coords.y}
                  onChange={(e) => setCoords((prev) => ({ ...prev, y: parseInt(e.target.value, 10) }))}
                  style={{ flex: 1 }}
                />
                <button className="step-btn" onClick={() => stepCoord('y', 1)}>
                  ＋
                </button>
              </div>
            ) : mobileTab === 'sagittal' ? (
              <div className="stepper-row">
                <span style={{ fontSize: '11px', color: '#ff9800', width: '48px' }}>X: {coords.x}</span>
                <button className="step-btn" onClick={() => stepCoord('x', -1)}>
                  −
                </button>
                <input
                  type="range"
                  min="0"
                  max={DIMS.x - 1}
                  value={coords.x}
                  onChange={(e) => setCoords((prev) => ({ ...prev, x: parseInt(e.target.value, 10) }))}
                  style={{ flex: 1 }}
                />
                <button className="step-btn" onClick={() => stepCoord('x', 1)}>
                  ＋
                </button>
              </div>
            ) : (
              <div className="stepper-row">
                <span style={{ fontSize: '11px', color: '#00e5ff', width: '48px' }}>Z: {coords.z}</span>
                <button className="step-btn" onClick={() => stepCoord('z', -1)}>
                  −
                </button>
                <input
                  type="range"
                  min="0"
                  max={DIMS.z - 1}
                  value={coords.z}
                  onChange={(e) => setCoords((prev) => ({ ...prev, z: parseInt(e.target.value, 10) }))}
                  style={{ flex: 1 }}
                />
                <button className="step-btn" onClick={() => stepCoord('z', 1)}>
                  ＋
                </button>
              </div>
            )}
          </div>
        )}

        {/* 第3ペイン: 操作パネル ＆ 臨床神経解剖インスペクター */}
        <aside className="pane-inspector">
          {mriSeq !== 'mra' ? (
            <div className="control-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#00e5ff' }}>
                  断面・基準線コントロール
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

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                  <span style={{ color: '#aaa' }}>Axial (Z / 頭尾):</span>
                  <span style={{ color: '#fff', fontWeight: 'bold' }}>{coords.z}</span>
                </div>
                <div className="stepper-row">
                  <button className="step-btn" onClick={() => stepCoord('z', -1)}>
                    −
                  </button>
                  <input
                    type="range"
                    min="0"
                    max={DIMS.z - 1}
                    value={coords.z}
                    onChange={(e) => setCoords((prev) => ({ ...prev, z: parseInt(e.target.value, 10) }))}
                    style={{ flex: 1, cursor: 'pointer' }}
                  />
                  <button className="step-btn" onClick={() => stepCoord('z', 1)}>
                    ＋
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                  <span style={{ color: '#4caf50' }}>Coronal (Y / 回転中心):</span>
                  <span style={{ color: '#fff', fontWeight: 'bold' }}>{coords.y}</span>
                </div>
                <div className="stepper-row">
                  <button className="step-btn" onClick={() => stepCoord('y', -1)}>
                    −
                  </button>
                  <input
                    type="range"
                    min="0"
                    max={DIMS.y - 1}
                    value={coords.y}
                    onChange={(e) => setCoords((prev) => ({ ...prev, y: parseInt(e.target.value, 10) }))}
                    style={{ flex: 1, cursor: 'pointer' }}
                  />
                  <button className="step-btn" onClick={() => stepCoord('y', 1)}>
                    ＋
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                  <span style={{ color: '#ff9800' }}>Sagittal (X / 左右):</span>
                  <span style={{ color: '#fff', fontWeight: 'bold' }}>{coords.x}</span>
                </div>
                <div className="stepper-row">
                  <button className="step-btn" onClick={() => stepCoord('x', -1)}>
                    −
                  </button>
                  <input
                    type="range"
                    min="0"
                    max={DIMS.x - 1}
                    value={coords.x}
                    onChange={(e) => setCoords((prev) => ({ ...prev, x: parseInt(e.target.value, 10) }))}
                    style={{ flex: 1, cursor: 'pointer' }}
                  />
                  <button className="step-btn" onClick={() => stepCoord('x', 1)}>
                    ＋
                  </button>
                </div>
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

          {/* 臨床神経解剖インスペクター */}
          <div style={{ borderTop: '1px solid #222', paddingTop: '12px' }}>
            <h2 style={{ fontSize: '13px', color: '#777', margin: '0 0 10px 0' }}>
              臨床神経解剖インスペクター
            </h2>
            {selectedStructure ? (
              <div>
                <div
                  style={{
                    display: 'inline-block',
                    fontSize: '11px',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    backgroundColor: getCategoryInfo(
                      selectedStructure.id,
                      selectedStructure.info.name
                    ).bg,
                    color: selectedStructure.id >= 1000 ? '#000' : '#fff',
                    fontWeight: 'bold',
                    marginBottom: '8px',
                  }}
                >
                  {getCategoryInfo(selectedStructure.id, selectedStructure.info.name).label}
                </div>
                <h3 style={{ fontSize: '16px', margin: '4px 0 8px 0', color: '#fff' }}>
                  {selectedStructure.info.name}
                </h3>
                <div style={{ fontSize: '11px', color: '#888', marginBottom: '12px' }}>
                  略称: <strong style={{ color: '#ccc' }}>{selectedStructure.info.abbr}</strong> | ID:{' '}
                  {selectedStructure.id}
                </div>
                <div style={{ borderTop: '1px solid #222', paddingTop: '10px', marginBottom: '10px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#00bcd4', marginBottom: '4px' }}>
                    【機能解剖・生理機能】
                  </div>
                  <div style={{ fontSize: '12px', lineHeight: '1.6', color: '#ddd' }}>
                    {selectedStructure.info.function}
                  </div>
                </div>
                <div style={{ borderTop: '1px solid #222', paddingTop: '10px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#ff7043', marginBottom: '4px' }}>
                    【臨床症状・リハビリテーション評価】
                  </div>
                  <div
                    style={{
                      fontSize: '12px',
                      lineHeight: '1.6',
                      color: '#eee',
                      backgroundColor: '#161616',
                      padding: '10px',
                      borderRadius: '6px',
                      borderLeft: '3px solid #ff7043',
                    }}
                  >
                    {selectedStructure.info.clinical}
                  </div>
                </div>
              </div>
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
                領域・拡大経路・脳溝ラインをタップ（クリック）すると、臨床機能・責任病巣解説が表示されます。
              </div>
            )}
          </div>
        </aside>
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