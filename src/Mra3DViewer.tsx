import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';

const DIMS = { x: 128, y: 128, z: 128 };

export interface StructureInfo {
  abbr: string;
  name: string;
  color: [number, number, number];
  function: string;
  clinical: string;
}

interface Mra3DViewerProps {
  labelData: Uint16Array | null;
  structures: Record<string, StructureInfo>;
  selectedId: number | null;
  overlayAlpha: number;
  onSelect: (id: number) => void;
  onHover: (hit: { id: number; x: number; y: number } | null) => void;
}

interface VoxelPoint {
  x: number;
  y: number;
  z: number;
  id: number;
}

interface ProjectedPoint {
  sx: number;
  sy: number;
  rz: number;
  radius: number;
  id: number;
}

type Mat3 = [number, number, number, number, number, number, number, number, number];

// 3x3 行列の乗算 (A * B)
function mulMat3(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

// 数値誤差による歪みを防ぐ正規直交化
function orthonormalize(m: Mat3): Mat3 {
  const len0 = Math.hypot(m[0], m[1], m[2]) || 1;
  const r0x = m[0] / len0, r0y = m[1] / len0, r0z = m[2] / len0;

  const dot01 = r0x * m[3] + r0y * m[4] + r0z * m[5];
  let r1x = m[3] - dot01 * r0x;
  let r1y = m[4] - dot01 * r0y;
  let r1z = m[5] - dot01 * r0z;
  const len1 = Math.hypot(r1x, r1y, r1z) || 1;
  r1x /= len1; r1y /= len1; r1z /= len1;

  // 外積 r0 × r1 で第3行を厳密に算出
  const r2x = r0y * r1z - r0z * r1y;
  const r2y = r0z * r1x - r0x * r1z;
  const r2z = r0x * r1y - r0y * r1x;

  return [r0x, r0y, r0z, r1x, r1y, r1z, r2x, r2y, r2z];
}

// 画面基準の回転行列（右ドラッグで手前が右へ、下ドラッグで手前が下へ動く）
function makeScreenRot(dxAngle: number, dyAngle: number): Mat3 {
  const cy = Math.cos(dxAngle), sy = Math.sin(dxAngle);
  const cx = Math.cos(dyAngle), sx = Math.sin(dyAngle);
  const ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rx: Mat3 = [1, 0, 0, 0, cx, sx, 0, -sx, cx];
  return mulMat3(rx, ry);
}

// プリセット視点の回転行列
const PRESET_MATRICES: Record<string, Mat3> = {
  // 軸位 (Axial: 上=前頭, 下=後頭, 左=右半球, 右=左半球, 手前=脳底/Willis輪)
  axial: [1, 0, 0, 0, 0, -1, 0, 1, 0],
  // 正面 (AP: 上=頭頂, 下=脳底, 手前=前頭)
  ap: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  // 左側面 (手前=左半球, 左=前頭, 右=後頭)
  left: [0, 0, -1, 0, 1, 0, 1, 0, 0],
  // 右側面 (手前=右半球, 右=前頭, 左=後頭)
  right: [0, 0, 1, 0, 1, 0, -1, 0, 0],
  // 上面 (頭頂から見下ろし: 手前=頭頂, 下=前頭)
  top: [1, 0, 0, 0, 0, 1, 0, -1, 0],
};

const DEFAULT_ZOOM = 1.05;

export default function Mra3DViewer({
  labelData,
  structures,
  selectedId,
  overlayAlpha,
  onSelect,
  onHover,
}: Mra3DViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const projectedVesselsRef = useRef<ProjectedPoint[]>([]);

  // 回転行列・ズーム倍率（デフォルトは軸位投影）
  const viewRef = useRef<{ mat: Mat3; zoom: number }>({
    mat: [...PRESET_MATRICES.axial] as Mat3,
    zoom: DEFAULT_ZOOM,
  });
  const rafRef = useRef<number | null>(null);
  const [showBrainGhost, setShowBrainGhost] = useState<boolean>(true);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef({
    lastX: 0,
    lastY: 0,
    startDist: 0,
    startZoom: DEFAULT_ZOOM,
    moved: false,
  });

  // 1. labelData から全14動脈ボクセル(901〜914)と脳輪郭ゴースト点群を抽出
  const { vesselPoints, ghostPoints } = useMemo(() => {
    const vessels: VoxelPoint[] = [];
    const ghosts: Array<{ x: number; y: number; z: number }> = [];
    if (!labelData) return { vesselPoints: vessels, ghostPoints: ghosts };

    const cx = 64;
    const cy = 64;
    const cz = 46;

    for (let x = 0; x < DIMS.x; x++) {
      for (let y = 0; y < DIMS.y; y++) {
        for (let z = 0; z < DIMS.z; z++) {
          const idx = z + y * DIMS.z + x * DIMS.z * DIMS.y;
          const id = labelData[idx];
          if (id >= 901 && id <= 914) {
            vessels.push({ x: x - cx, y: -(z - cz), z: y - cy, id });
          } else if (
            x % 6 === 0 &&
            y % 6 === 0 &&
            z % 6 === 0 &&
            ((id >= 101 && id <= 130) || (id >= 701 && id <= 726) || (id >= 600 && id <= 699))
          ) {
            const xm = x > 0 ? labelData[z + y * DIMS.z + (x - 1) * DIMS.z * DIMS.y] : 0;
            const xp = x < DIMS.x - 1 ? labelData[z + y * DIMS.z + (x + 1) * DIMS.z * DIMS.y] : 0;
            const zm = z > 0 ? labelData[z - 1 + y * DIMS.z + x * DIMS.z * DIMS.y] : 0;
            const zp = z < DIMS.z - 1 ? labelData[z + 1 + y * DIMS.z + x * DIMS.z * DIMS.y] : 0;
            if (xm === 0 || xp === 0 || zm === 0 || zp === 0) {
              ghosts.push({ x: x - cx, y: -(z - cz), z: y - cy });
            }
          }
        }
      }
    }
    return { vesselPoints: vessels, ghostPoints: ghosts };
  }, [labelData]);

  // 2. 3Dレンダリング本体
  const render3D = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 640;
    const H = 640;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    const { mat, zoom } = viewRef.current;

    const bgGrad = ctx.createRadialGradient(W / 2, H / 2, 30, W / 2, H / 2, W * 0.65);
    bgGrad.addColorStop(0, '#0b1018');
    bgGrad.addColorStop(1, '#000000');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    const fov = 310;
    const camDist = 175;
    const baseScale = (3.1 * zoom) / 2.2;

    const project = (px: number, py: number, pz: number) => {
      const rx = mat[0] * px + mat[1] * py + mat[2] * pz;
      const ry = mat[3] * px + mat[4] * py + mat[5] * pz;
      const rz = mat[6] * px + mat[7] * py + mat[8] * pz;

      const depth = camDist - rz;
      if (depth <= 10) return null;
      const persp = fov / depth;
      return {
        sx: W / 2 + rx * persp * baseScale,
        sy: H / 2 + ry * persp * baseScale,
        rz,
        persp,
      };
    };

    // 脳輪郭ゴースト
    if (showBrainGhost && ghostPoints.length > 0) {
      ctx.fillStyle = 'rgba(130, 170, 210, 0.16)';
      for (let i = 0; i < ghostPoints.length; i++) {
        const g = ghostPoints[i];
        const p = project(g.x, g.y, g.z);
        if (!p) continue;
        const r = Math.max(1.2, 1.5 * p.persp * zoom);
        ctx.fillRect(p.sx - r * 0.5, p.sy - r * 0.5, r, r);
      }
    }

    // 血管ボクセル投影＆Zソート
    const projList: ProjectedPoint[] = [];
    for (let i = 0; i < vesselPoints.length; i++) {
      const v = vesselPoints[i];
      const p = project(v.x, v.y, v.z);
      if (!p) continue;
      const isSelected = selectedId === v.id;
      const r = (isSelected ? 3.2 : 2.3) * p.persp * (zoom * 0.72);
      projList.push({ sx: p.sx, sy: p.sy, rz: p.rz, radius: Math.max(1.5, r), id: v.id });
    }

    projList.sort((a, b) => a.rz - b.rz);
    projectedVesselsRef.current = projList;

    const hasSelection = selectedId !== null && selectedId >= 901 && selectedId <= 914;
    for (let i = 0; i < projList.length; i++) {
      const p = projList[i];
      const info = structures[String(p.id)];
      const [cr, cg, cb] = info ? info.color : [255, 255, 255];

      const depthFactor = Math.max(0.35, Math.min(1.18, 0.75 + p.rz / 75));
      const isSelected = selectedId === p.id;
      const dimFactor = hasSelection && !isSelected ? 0.35 : 1.0;

      const a = isSelected ? 1.0 : Math.max(0.2, overlayAlpha);
      const baseR = 235 * (1 - a) + cr * a;
      const baseG = 235 * (1 - a) + cg * a;
      const baseB = 235 * (1 - a) + cb * a;

      const fr = Math.min(255, Math.round(baseR * depthFactor * dimFactor));
      const fg = Math.min(255, Math.round(baseG * depthFactor * dimFactor));
      const fb = Math.min(255, Math.round(baseB * depthFactor * dimFactor));

      ctx.beginPath();
      ctx.arc(p.sx, p.sy, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${fr},${fg},${fb})`;
      ctx.fill();

      if (isSelected || p.rz > 5) {
        ctx.beginPath();
        ctx.arc(p.sx - p.radius * 0.28, p.sy - p.radius * 0.28, p.radius * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.22)';
        ctx.fill();
      }
    }

    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillText('ドラッグで360°自由回転 / タップ・クリックで血管解説', 14, H - 14);
  }, [vesselPoints, ghostPoints, showBrainGhost, selectedId, overlayAlpha, structures]);

  const scheduleRender = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      render3D();
    });
  }, [render3D]);

  useEffect(() => {
    render3D();
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [render3D]);

  // ホイール拡大縮小
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.12 : -0.12;
      viewRef.current.zoom = Math.max(0.6, Math.min(2.8, viewRef.current.zoom + delta));
      scheduleRender();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scheduleRender]);

  // ヒットテスト
  const pickVesselAt = (clientX: number, clientY: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const cx = ((clientX - rect.left) / rect.width) * canvas.width;
    const cy = ((clientY - rect.top) / rect.height) * canvas.height;

    const list = projectedVesselsRef.current;
    let bestId = 0;
    let bestDistSq = Infinity;
    const hitMargin = 14;

    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      const dx = cx - p.sx;
      const dy = cy - p.sy;
      const distSq = dx * dx + dy * dy;
      const thresh = p.radius + hitMargin;
      if (distSq <= thresh * thresh) {
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestId = p.id;
        }
        if (distSq <= (p.radius + 3) ** 2) return p.id;
      }
    }
    return bestId;
  };

  // Pointer Events（トラックボール式・画面基準の360°自由回転）
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 1) {
      setIsDragging(true);
      gestureRef.current = {
        lastX: e.clientX,
        lastY: e.clientY,
        startDist: 0,
        startZoom: viewRef.current.zoom,
        moved: false,
      };
    } else if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      gestureRef.current.startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      gestureRef.current.startZoom = viewRef.current.zoom;
      gestureRef.current.moved = true;
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gestureRef.current;

      if (pointersRef.current.size === 2) {
        const pts = Array.from(pointersRef.current.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (g.startDist > 0) {
          viewRef.current.zoom = Math.max(0.6, Math.min(2.8, g.startZoom * (dist / g.startDist)));
          scheduleRender();
        }
      } else if (pointersRef.current.size === 1) {
        const dx = e.clientX - g.lastX;
        const dy = e.clientY - g.lastY;
        if (Math.hypot(dx, dy) > 1.5) g.moved = true;

        g.lastX = e.clientX;
        g.lastY = e.clientY;

        const sensitivity = 0.011;
        const deltaMat = makeScreenRot(dx * sensitivity, dy * sensitivity);
        viewRef.current.mat = orthonormalize(mulMat3(deltaMat, viewRef.current.mat));

        onHover(null);
        scheduleRender();
      }
      return;
    }

    if (e.pointerType === 'mouse') {
      const hitId = pickVesselAt(e.clientX, e.clientY);
      if (hitId > 0) {
        onHover({ id: hitId, x: e.clientX, y: e.clientY });
      } else {
        onHover(null);
      }
    }
  };

  const handlePointerUpOrCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wasSingle = pointersRef.current.size === 1;
    pointersRef.current.delete(e.pointerId);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (wasSingle && !gestureRef.current.moved) {
      const hitId = pickVesselAt(e.clientX, e.clientY);
      if (hitId > 0) onSelect(hitId);
    }

    if (pointersRef.current.size === 1) {
      // 2本指ピンチから1本指に戻したとき、残り指の位置を基準に再セットして跳ねを防止
      const remain = Array.from(pointersRef.current.values())[0];
      gestureRef.current.lastX = remain.x;
      gestureRef.current.lastY = remain.y;
    } else if (pointersRef.current.size === 0) {
      setIsDragging(false);
    }
  };

  const setPresetView = (key: keyof typeof PRESET_MATRICES, resetZoom = false) => {
    viewRef.current.mat = [...PRESET_MATRICES[key]] as Mat3;
    if (resetZoom) viewRef.current.zoom = DEFAULT_ZOOM;
    scheduleRender();
  };

  const presets: Array<{ label: string; key: keyof typeof PRESET_MATRICES }> = [
    { label: '軸位 (Axial)', key: 'axial' },
    { label: '正面 (AP)', key: 'ap' },
    { label: '左側面', key: 'left' },
    { label: '右側面', key: 'right' },
    { label: '上面', key: 'top' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', gap: '8px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', justifyContent: 'center', width: '100%', maxWidth: '880px' }}>
        {presets.map((p) => (
          <button
            key={p.key}
            onClick={() => setPresetView(p.key)}
            style={{
              padding: '5px 9px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px',
              border: '1px solid #333', backgroundColor: '#1a1a1a', color: '#ddd', cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setShowBrainGhost((prev) => !prev)}
          style={{
            padding: '5px 9px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px',
            border: showBrainGhost ? '1px solid #00acc1' : '1px solid #333',
            backgroundColor: showBrainGhost ? '#102a30' : '#1a1a1a',
            color: showBrainGhost ? '#00e5ff' : '#888', cursor: 'pointer',
          }}
        >
          脳輪郭: {showBrainGhost ? 'ON' : 'OFF'}
        </button>
      </div>

      <div className="canvas-box-main" style={{ touchAction: 'none' }}>
        <canvas
          ref={canvasRef}
          className="mri-canvas"
          style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUpOrCancel}
          onPointerCancel={handlePointerUpOrCancel}
          onPointerLeave={() => {
            if (!isDragging) onHover(null);
          }}
        />
        <div className="zoom-controls-overlay">
          <button
            className="zoom-ctrl-btn"
            onClick={() => {
              viewRef.current.zoom = Math.max(0.6, +(viewRef.current.zoom - 0.25).toFixed(2));
              scheduleRender();
            }}
          >
            −
          </button>
          <button className="zoom-ctrl-btn" onClick={() => setPresetView('axial', true)}>
            Reset
          </button>
          <button
            className="zoom-ctrl-btn"
            onClick={() => {
              viewRef.current.zoom = Math.min(2.8, +(viewRef.current.zoom + 0.25).toFixed(2));
              scheduleRender();
            }}
          >
            ＋
          </button>
        </div>
      </div>
    </div>
  );
}