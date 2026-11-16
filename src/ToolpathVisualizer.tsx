import { useState, useEffect, useRef, useCallback, CSSProperties, ReactNode } from 'react';
import * as THREE from 'three';
import { GcodeUnit, ParsedToolpath } from './gcodeParser';
import {
  NavigationController,
  ViewCubeHit,
} from './viewer/NavigationController';

export type VisualizerViewMode = 'toolpath' | 'shaded';
export type StockMaterialPreset = 'aluminum' | 'wood' | 'plastic' | 'wax';

interface ToolpathVisualizerProps {
  toolpath: ParsedToolpath | null;
  ackedLines: number;
  wpos: { x: number; y: number; z: number };
  /**
   * Work-coordinate offset. The scene is drawn in work coordinates, so when the
   * operator sets an axis zero the tool must NOT jump in world space — the
   * stock, grid and toolpath move to the new work origin instead.
   */
  wco: { x: number; y: number; z: number };
  /**
   * Machine/connection controls (port selector, Refresh, Connect, Sim) rendered
   * in the viewport's own header. Owned by App so the viewport stays a pure
   * presentation component.
   */
  headerActions?: ReactNode;
}

interface MaterialPalette {
  label: string;
  topUncut: [number, number, number];
  milledBright: [number, number, number];
  milledDeep: [number, number, number];
  sideWall: number;
  roughness: number;
  metalness: number;
}

const MATERIAL_PALETTES: Record<StockMaterialPreset, MaterialPalette> = {
  aluminum: {
    label: '6061 Aluminum',
    topUncut: [0.32, 0.39, 0.48],
    milledBright: [0.82, 0.87, 0.94],
    milledDeep: [0.54, 0.63, 0.74],
    sideWall: 0x334155,
    roughness: 0.35,
    metalness: 0.28,
  },
  wood: {
    label: 'Hardwood / MDF',
    topUncut: [0.62, 0.43, 0.25],
    milledBright: [0.86, 0.70, 0.47],
    milledDeep: [0.52, 0.35, 0.18],
    sideWall: 0x784f2b,
    roughness: 0.72,
    metalness: 0.05,
  },
  plastic: {
    label: 'HDPE / Delrin',
    topUncut: [0.18, 0.22, 0.28],
    milledBright: [0.58, 0.66, 0.76],
    milledDeep: [0.35, 0.42, 0.52],
    sideWall: 0x1e293b,
    roughness: 0.48,
    metalness: 0.08,
  },
  wax: {
    label: 'Machinist Wax',
    topUncut: [0.10, 0.28, 0.58],
    milledBright: [0.28, 0.68, 0.95],
    milledDeep: [0.14, 0.44, 0.76],
    sideWall: 0x1e3a8a,
    roughness: 0.40,
    metalness: 0.10,
  },
};

/** Grid pitch in world units (mm) and the label used in the HUD. */
const GRID_UNITS: Record<GcodeUnit, { pitch: number; label: string }> = {
  mm: { pitch: 10, label: '10 mm' },
  in: { pitch: 25.4, label: '1 in' },
};

/**
 * World radius the worktable grid spans. The base is deliberately larger than
 * the old 150 mm half-span so the table reads as a surface rather than a
 * patch, while the cap keeps line density legible on large jobs.
 */
const GRID_BASE_EXTENT = 320;
const GRID_MAX_EXTENT = 700;

/**
 * Gap between the stock underside and the worktable grid, in mm. The two are
 * otherwise coplanar, and a hair of clearance keeps them from z-fighting when
 * the bed is viewed from below.
 */
const GRID_BED_CLEARANCE = 0.1;

interface GridRefs {
  major: THREE.LineSegments[];
  minor: THREE.LineSegments | null;
  axes: THREE.LineSegments | null;
  xBadge: THREE.Sprite | null;
  yBadge: THREE.Sprite | null;
}

/**
 * Builds the XY worktable grid: fine minor lines, a darker major line every
 * fifth division, the two dashed axes, and X / Y badges at the extreme ends of
 * the grid. Pitch follows the project units; extent follows the loaded job.
 *
 * `bedZ` is the height of the machine bed. The grid is drawn there — under the
 * stock — rather than at the work origin, where it would otherwise be a sheet
 * of lines lying across the top of the part. The offset is baked into the
 * geometry and the badge positions instead of being applied to the parent
 * group, because the per-frame badge projection treats sprite positions as
 * world coordinates.
 */
function buildWorktableGrid(
  halfExtent: number,
  unit: GcodeUnit,
  bedZ = 0
): { group: THREE.Group; refs: GridRefs } {
  const { pitch } = GRID_UNITS[unit];
  const group = new THREE.Group();
  group.name = 'WorktableGrid';

  const majorCount = Math.max(4, Math.ceil(halfExtent / pitch));
  const half = majorCount * pitch;

  // --- Minor lines every pitch/5, but never denser than ~12 mm on screen --
  // A 10 mm grid over a 400 mm table would be 80 divisions a side; subdividing
  // that five ways turns into visual noise, so subdivisions are dropped when
  // the pitch is already fine.
  const subdivisions = pitch >= 10 ? 1 : 5;
  const minor: number[] = [];
  const minorStep = pitch / subdivisions;
  const minorLimit = Math.round(half / minorStep);
  for (let i = -minorLimit; i <= minorLimit; i++) {
    if (subdivisions > 1 && i % subdivisions === 0) continue;
    if (subdivisions === 1 && i % 5 === 0) continue; // accent every 5th line
    const v = i * minorStep;
    minor.push(v, -half, bedZ, v, half, bedZ);
    minor.push(-half, v, bedZ, half, v, bedZ);
  }
  const minorGeom = new THREE.BufferGeometry();
  minorGeom.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(minor), 3)
  );
  const minorSegments = new THREE.LineSegments(
    minorGeom,
    new THREE.LineBasicMaterial({
      color: 0x25324a,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    })
  );
  group.add(minorSegments);

  // --- Major lines every pitch -------------------------------------------
  const major: number[] = [];
  for (let i = -majorCount; i <= majorCount; i++) {
    const v = i * pitch;
    major.push(v, -half, bedZ, v, half, bedZ);
    major.push(-half, v, bedZ, half, v, bedZ);
  }
  const majorGeom = new THREE.BufferGeometry();
  majorGeom.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(major), 3)
  );
  const majorSegments = new THREE.LineSegments(
    majorGeom,
    new THREE.LineBasicMaterial({
      color: 0x3f5370,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    })
  );
  group.add(majorSegments);

  // --- X / Y axes through the work origin --------------------------------
  // Drawn just above the grid plane so they win against the grid lines when
  // both are edge-on, but below the stock so the part occludes them.
  const axisPositions = new Float32Array([
    -half, 0, bedZ + 0.06, half, 0, bedZ + 0.06, // X
    0, -half, bedZ + 0.06, 0, half, bedZ + 0.06, // Y
  ]);
  const axisColors = new Float32Array([
    0.55, 0.2, 0.2, 0.85, 0.32, 0.32, 0.13, 0.5, 0.28, 0.25, 0.78, 0.42,
  ]);
  const axisGeom = new THREE.BufferGeometry();
  axisGeom.setAttribute(
    'position',
    new THREE.BufferAttribute(axisPositions, 3)
  );
  axisGeom.setAttribute('color', new THREE.BufferAttribute(axisColors, 3));
  const axes = new THREE.LineSegments(
    axisGeom,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
    })
  );
  axes.renderOrder = 3;
  group.add(axes);

  // --- X / Y badges pinned to the far ends of each axis -------------------
  const makeBadge = (text: string, colorHex: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.beginPath();
    ctx.arc(64, 64, 56, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colorHex;
    ctx.beginPath();
    ctx.arc(64, 64, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(64, 64, 50, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 68px "Inter", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillText(text, 64, 67);

    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        transparent: true,
      })
    );
    sprite.renderOrder = 9;
    return sprite;
  };

  const xBadge = makeBadge('X', '#ef4444');
  const yBadge = makeBadge('Y', '#22c55e');
  xBadge.position.set(half, 0, bedZ + 1.5);
  yBadge.position.set(0, half, bedZ + 1.5);
  // Remember where each badge belongs so the per-frame viewport clamping can
  // restore it before re-projecting, instead of drifting frame after frame.
  xBadge.userData.homePosition = xBadge.position.clone();
  yBadge.userData.homePosition = yBadge.position.clone();
  group.add(xBadge, yBadge);

  // The unit readout is an HTML chip on the viewport HUD rather than a world
  // sprite, so it stays readable regardless of zoom or orbit.

  return {
    group,
    refs: {
      major: [majorSegments],
      minor: minorSegments,
      axes,
      xBadge,
      yBadge,
    },
  };
}

function disposeGroup(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
    if (object instanceof THREE.Sprite) {
      if (object.material.map) object.material.map.dispose();
      object.material.dispose();
    }
  });
}

/**
 * Creates a crisp CanvasTexture for each face of the Fusion 360 interactive ViewCube.
 * Matches Autodesk Fusion 360 light-grey body with dark bold text, chamfer outlines,
 * and soft blue hover highlighting.
 */
function createViewCubeFaceTexture(label: string, highlight = false): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // Background face fill (Light grey CAD style like Fusion 360)
  ctx.fillStyle = highlight ? '#bfdbfe' : '#e5e7eb';
  ctx.fillRect(0, 0, 256, 256);

  // Inner face square
  const pad = 24;
  ctx.fillStyle = highlight ? '#93c5fd' : '#f1f5f9';
  ctx.fillRect(pad, pad, 256 - pad * 2, 256 - pad * 2);

  // Border outline and chamfer lines
  ctx.strokeStyle = highlight ? '#3b82f6' : '#94a3b8';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, 253, 253);
  ctx.strokeRect(pad, pad, 256 - pad * 2, 256 - pad * 2);

  // Corner chamfer guide lines
  ctx.beginPath();
  ctx.moveTo(0, pad); ctx.lineTo(256, pad);
  ctx.moveTo(0, 256 - pad); ctx.lineTo(256, 256 - pad);
  ctx.moveTo(pad, 0); ctx.lineTo(pad, 256);
  ctx.moveTo(256 - pad, 0); ctx.lineTo(256 - pad, 256);
  ctx.stroke();

  // Face label text (Crisp dark charcoal / graphite)
  ctx.fillStyle = highlight ? '#1d4ed8' : '#1e293b';
  ctx.font = 'bold 44px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 128, 128);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

/**
 * Vertical extent of the stock block for a project. `topZ` is the uncut top
 * surface (the work origin for most jobs); `bottomZ` is the underside, which is
 * where the machine bed sits.
 *
 * The shaded stock mesh and the worktable grid both derive their Z from here so
 * the grid can never drift away from the bottom of the part.
 */
function computeStockZRange(
  toolpath: ParsedToolpath | null
): { topZ: number; bottomZ: number } | null {
  if (!toolpath || toolpath.segments.length === 0) return null;

  const cb = toolpath.cutBounds;

  let highestXYCutZ = -Infinity;
  for (const seg of toolpath.segments) {
    if (!seg.rapid && (seg.start.x !== seg.end.x || seg.start.y !== seg.end.y)) {
      const maxSegZ = Math.max(seg.start.z, seg.end.z);
      if (maxSegZ > highestXYCutZ) highestXYCutZ = maxSegZ;
    }
  }
  if (!Number.isFinite(highestXYCutZ)) highestXYCutZ = cb.max.z;

  if (cb.min.z < -0.01) {
    return { topZ: 0.0, bottomZ: Math.min(cb.min.z - 2.0, -2.5) };
  }
  return {
    topZ: Math.max(1.0, highestXYCutZ),
    bottomZ: Math.min(-2.0, cb.min.z - 2.0),
  };
}

/**
 * Generates a clean, CAD-grade 3D machined stock mesh from the .nc toolpath.
 * Uses dual-grid boundary vertex snapping (snapping grid vertices near the cut edge directly onto
 * the exact analytical tool radius curve) plus crisp vertical wall normals and flat floor normals,
 * completely eliminating heightmap staircase / sawtooth spikes on curved and angled cuts.
 */
function buildWatertightStockMesh(
  toolpath: ParsedToolpath | null,
  maxLineIndex: number,
  toolDiameter: number,
  materialKey: StockMaterialPreset
): THREE.Group | null {
  if (!toolpath || toolpath.segments.length === 0) return null;

  const palette = MATERIAL_PALETTES[materialKey];
  const toolRadius = Math.max(0.4, toolDiameter / 2);

  const cb = toolpath.cutBounds;
  const margin = Math.max(5.0, toolRadius * 2.2);
  const minX = cb.min.x - margin;
  const maxX = cb.max.x + margin;
  const minY = cb.min.y - margin;
  const maxY = cb.max.y + margin;

  const zRange = computeStockZRange(toolpath);
  if (!zRange) return null;
  const { topZ, bottomZ } = zRange;
  const cutDepthSpan = Math.max(0.5, topZ - bottomZ);

  const width = Math.max(10, maxX - minX);
  const depth = Math.max(10, maxY - minY);

  const aspect = width / depth;
  const baseRes = 220;
  const gridX = Math.max(110, Math.min(280, Math.round(aspect >= 1 ? baseRes : baseRes * aspect)));
  const gridY = Math.max(110, Math.min(280, Math.round(aspect <= 1 ? baseRes : baseRes / aspect)));

  const cols = gridX + 1;
  const rows = gridY + 1;
  const nVerts = cols * rows;

  const cellW = width / gridX;
  const cellH = depth / gridY;
  const cellDiag = Math.hypot(cellW, cellH);

  // Store exact 2D signed distance to nearest tool boundary and floor Z for each vertex
  const heights = new Float32Array(nVerts);
  heights.fill(topZ);
  const minSignedDist = new Float32Array(nVerts);
  minSignedDist.fill(Infinity);
  const gradX = new Float32Array(nVerts);
  const gradY = new Float32Array(nVerts);
  const snapZ = new Float32Array(nVerts);
  snapZ.fill(topZ);

  const searchPad = toolRadius + cellDiag * 1.15;
  const searchRSq = searchPad * searchPad;

  for (let s = 0; s < toolpath.segments.length; s++) {
    const seg = toolpath.segments[s];
    if (seg.rapid || seg.lineIndex > maxLineIndex) continue;
    if (seg.start.z >= topZ - 1e-4 && seg.end.z >= topZ - 1e-4) continue;

    const segMinX = Math.min(seg.start.x, seg.end.x) - searchPad;
    const segMaxX = Math.max(seg.start.x, seg.end.x) + searchPad;
    const segMinY = Math.min(seg.start.y, seg.end.y) - searchPad;
    const segMaxY = Math.max(seg.start.y, seg.end.y) + searchPad;

    const ix0 = Math.max(1, Math.floor((segMinX - minX) / cellW));
    const ix1 = Math.min(gridX - 1, Math.ceil((segMaxX - minX) / cellW));
    const iy0 = Math.max(1, Math.floor((segMinY - minY) / cellH));
    const iy1 = Math.min(gridY - 1, Math.ceil((segMaxY - minY) / cellH));

    const abx = seg.end.x - seg.start.x;
    const aby = seg.end.y - seg.start.y;
    const abLenSq = abx * abx + aby * aby;

    for (let iy = iy0; iy <= iy1; iy++) {
      const py = minY + iy * cellH;
      const rowOffset = iy * cols;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = minX + ix * cellW;

        let t = 0;
        if (abLenSq > 1e-6) {
          t = ((px - seg.start.x) * abx + (py - seg.start.y) * aby) / abLenSq;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
        }

        const cx = seg.start.x + t * abx;
        const cy = seg.start.y + t * aby;
        const dx = px - cx;
        const dy = py - cy;
        const distSq = dx * dx + dy * dy;

        if (distSq <= searchRSq) {
          const idx = rowOffset + ix;
          const dist = Math.sqrt(distSq);
          const signedDist = dist - toolRadius; // negative = inside cut, positive = outside cut
          const cutZ = Math.max(bottomZ, seg.start.z + t * (seg.end.z - seg.start.z));

          if (signedDist <= 0) {
            if (cutZ < heights[idx]) {
              heights[idx] = cutZ;
            }
          }

          // Track the closest tool envelope boundary for exact vertex snapping & outward wall normals
          if (signedDist < minSignedDist[idx]) {
            minSignedDist[idx] = signedDist;
            snapZ[idx] = cutZ;
            if (dist > 1e-5) {
              gradX[idx] = dx / dist;
              gradY[idx] = dy / dist;
            }
          }
        }
      }
    }
  }

  // Deform/snap grid vertices that sit immediately outside the cut boundary directly onto the
  // exact analytical curve (signedDist == 0). This turns jagged grid staircases into smooth curves!
  const posX = new Float32Array(nVerts);
  const posY = new Float32Array(nVerts);
  const isBoundaryLip = new Uint8Array(nVerts);

  for (let iy = 0; iy < rows; iy++) {
    const py = minY + iy * cellH;
    const rowOffset = iy * cols;
    for (let ix = 0; ix < cols; ix++) {
      const idx = rowOffset + ix;
      posX[idx] = minX + ix * cellW;
      posY[idx] = py;
    }
  }

  const maxSnapDist = cellDiag * 0.48;
  for (let iy = 1; iy < gridY; iy++) {
    const rowOffset = iy * cols;
    for (let ix = 1; ix < gridX; ix++) {
      const idx = rowOffset + ix;
      if (heights[idx] < topZ - 1e-3) continue; // Already inside cut floor

      // Check if any 4-connected or 8-connected neighbor is inside the cut
      const hasCutNeighbor =
        heights[idx - 1] < topZ - 1e-3 ||
        heights[idx + 1] < topZ - 1e-3 ||
        heights[idx - cols] < topZ - 1e-3 ||
        heights[idx + cols] < topZ - 1e-3 ||
        heights[idx - cols - 1] < topZ - 1e-3 ||
        heights[idx - cols + 1] < topZ - 1e-3 ||
        heights[idx + cols - 1] < topZ - 1e-3 ||
        heights[idx + cols + 1] < topZ - 1e-3;

      const sd = minSignedDist[idx];
      if (hasCutNeighbor && sd > 0 && sd <= maxSnapDist) {
        // Snap vertex XY directly toward the exact tool radius boundary!
        const shift = Math.min(sd, cellDiag * 0.38);
        posX[idx] -= gradX[idx] * shift;
        posY[idx] -= gradY[idx] * shift;
        isBoundaryLip[idx] = 1;
      }
    }
  }

  // Also snap the inner floor ring vertices that are very close to the boundary so the wall is vertical!
  for (let iy = 1; iy < gridY; iy++) {
    const rowOffset = iy * cols;
    for (let ix = 1; ix < gridX; ix++) {
      const idx = rowOffset + ix;
      if (heights[idx] >= topZ - 1e-3) continue; // Outside cut

      const hasTopNeighbor =
        heights[idx - 1] >= topZ - 1e-3 ||
        heights[idx + 1] >= topZ - 1e-3 ||
        heights[idx - cols] >= topZ - 1e-3 ||
        heights[idx + cols] >= topZ - 1e-3;

      const sd = minSignedDist[idx]; // negative
      if (hasTopNeighbor && sd < 0 && -sd <= cellDiag * 0.45) {
        // Pull inner floor vertex partway toward the exact tool radius curve without crossing the outer lip
        const pull = Math.min(-sd * 0.48, cellDiag * 0.25);
        posX[idx] += gradX[idx] * pull;
        posY[idx] += gradY[idx] * pull;
      }
    }
  }

  const topGeom = new THREE.BufferGeometry();
  const numQuads = gridX * gridY;
  const positions = new Float32Array(numQuads * 6 * 3);
  const normals = new Float32Array(numQuads * 6 * 3);
  const colors = new Float32Array(numQuads * 6 * 3);

  let ptr = 0;
  const pushVert = (
    vIdx: number,
    zVal: number,
    nx: number,
    ny: number,
    nz: number,
    r: number,
    g: number,
    b: number
  ) => {
    positions[ptr] = posX[vIdx];
    positions[ptr + 1] = posY[vIdx];
    positions[ptr + 2] = zVal;
    normals[ptr] = nx;
    normals[ptr + 1] = ny;
    normals[ptr + 2] = nz;
    colors[ptr] = r;
    colors[ptr + 1] = g;
    colors[ptr + 2] = b;
    ptr += 3;
  };

  const floorColor = (h: number): [number, number, number] => {
    const depthNorm = Math.min(1.0, Math.max(0.0, (topZ - h) / cutDepthSpan));
    return [
      palette.milledBright[0] + (palette.milledDeep[0] - palette.milledBright[0]) * depthNorm,
      palette.milledBright[1] + (palette.milledDeep[1] - palette.milledBright[1]) * depthNorm,
      palette.milledBright[2] + (palette.milledDeep[2] - palette.milledBright[2]) * depthNorm,
    ];
  };

  const wallColor = (h: number): [number, number, number] => {
    const [r, g, b] = floorColor(h);
    return [r * 0.88, g * 0.88, b * 0.88];
  };

  const emitTri = (iA: number, iB: number, iC: number) => {
    const hA = heights[iA];
    const hB = heights[iB];
    const hC = heights[iC];

    const uA = hA >= topZ - 1e-3;
    const uB = hB >= topZ - 1e-3;
    const uC = hC >= topZ - 1e-3;

    // Case 1: All 3 vertices are on the uncut top stock surface
    if (uA && uB && uC) {
      const [tr, tg, tb] = palette.topUncut;
      pushVert(iA, topZ, 0, 0, 1, tr, tg, tb);
      pushVert(iB, topZ, 0, 0, 1, tr, tg, tb);
      pushVert(iC, topZ, 0, 0, 1, tr, tg, tb);
      return;
    }

    // Case 2: All 3 vertices are inside the machined pocket floor
    if (!uA && !uB && !uC) {
      const maxH = Math.max(hA, hB, hC);
      const minH = Math.min(hA, hB, hC);
      let nx = 0;
      let ny = 0;
      let nz = 1;

      // If internal step between pass depths, compute smooth slope normal
      if (maxH - minH > 0.04) {
        const ux = posX[iB] - posX[iA];
        const uy = posY[iB] - posY[iA];
        const uz = hB - hA;
        const vx = posX[iC] - posX[iA];
        const vy = posY[iC] - posY[iA];
        const vz = hC - hA;
        nx = uy * vz - uz * vy;
        ny = uz * vx - ux * vz;
        nz = ux * vy - uy * vx;
        if (nz < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
      }

      const cA = floorColor(hA);
      const cB = floorColor(hB);
      const cC = floorColor(hC);
      pushVert(iA, hA, nx, ny, nz, cA[0], cA[1], cA[2]);
      pushVert(iB, hB, nx, ny, nz, cB[0], cB[1], cB[2]);
      pushVert(iC, hC, nx, ny, nz, cC[0], cC[1], cC[2]);
      return;
    }

    // Case 3: Boundary wall triangle connecting uncut top lip (u=true) and pocket floor (u=false)
    // Use the analytical radial gradient (-gradX, -gradY) as the smooth cylindrical wall normal!
    const wallVertNormal = (idx: number): [number, number, number] => {
      const gx = -gradX[idx];
      const gy = -gradY[idx];
      const gz = 0.25; // Slight upward tilt so overhead studio keylight illuminates vertical walls cleanly
      const len = Math.hypot(gx, gy, gz) || 1;
      return [gx / len, gy / len, gz / len];
    };

    const nA = wallVertNormal(iA);
    const nB = wallVertNormal(iB);
    const nC = wallVertNormal(iC);

    const wA = wallColor(uA ? snapZ[iA] : hA);
    const wB = wallColor(uB ? snapZ[iB] : hB);
    const wC = wallColor(uC ? snapZ[iC] : hC);

    pushVert(iA, hA, nA[0], nA[1], nA[2], wA[0], wA[1], wA[2]);
    pushVert(iB, hB, nB[0], nB[1], nB[2], wB[0], wB[1], wB[2]);
    pushVert(iC, hC, nC[0], nC[1], nC[2], wC[0], wC[1], wC[2]);
    void isBoundaryLip;
  };

  for (let iy = 0; iy < gridY; iy++) {
    const rowOffset = iy * cols;
    for (let ix = 0; ix < gridX; ix++) {
      const i00 = rowOffset + ix;
      const i10 = i00 + 1;
      const i01 = i00 + cols;
      const i11 = i01 + 1;

      const h00 = heights[i00];
      const h10 = heights[i10];
      const h01 = heights[i01];
      const h11 = heights[i11];

      // Choose the quad diagonal that connects vertices of the same state (top-to-top or floor-to-floor)
      if (Math.abs(h00 - h11) <= Math.abs(h10 - h01)) {
        emitTri(i00, i10, i11);
        emitTri(i00, i11, i01);
      } else {
        emitTri(i00, i10, i01);
        emitTri(i10, i11, i01);
      }
    }
  }

  topGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  topGeom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  topGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const stockGroup = new THREE.Group();

  const topMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: palette.roughness,
    metalness: palette.metalness,
    flatShading: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const topMesh = new THREE.Mesh(topGeom, topMat);
  stockGroup.add(topMesh);

  const sideMat = new THREE.MeshStandardMaterial({
    color: palette.sideWall,
    roughness: Math.min(1.0, palette.roughness + 0.15),
    metalness: palette.metalness * 0.7,
    flatShading: true,
  });

  const wallPositions: number[] = [];
  const pushQuad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number
  ) => {
    wallPositions.push(
      ax, ay, az, bx, by, bz, cx, cy, cz,
      ax, ay, az, cx, cy, cz, dx, dy, dz
    );
  };

  pushQuad(minX, minY, bottomZ, maxX, minY, bottomZ, maxX, minY, topZ, minX, minY, topZ);
  pushQuad(maxX, maxY, bottomZ, minX, maxY, bottomZ, minX, maxY, topZ, maxX, maxY, topZ);
  pushQuad(minX, maxY, bottomZ, minX, minY, bottomZ, minX, minY, topZ, minX, maxY, topZ);
  pushQuad(maxX, minY, bottomZ, maxX, maxY, bottomZ, maxX, maxY, topZ, maxX, minY, topZ);
  pushQuad(minX, maxY, bottomZ, maxX, maxY, bottomZ, maxX, minY, bottomZ, minX, minY, bottomZ);

  const wallGeom = new THREE.BufferGeometry();
  wallGeom.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(wallPositions), 3)
  );
  wallGeom.computeVertexNormals();
  const wallMesh = new THREE.Mesh(wallGeom, sideMat);
  stockGroup.add(wallMesh);

  const edgeBox = new THREE.Box3(
    new THREE.Vector3(minX, minY, bottomZ),
    new THREE.Vector3(maxX, maxY, topZ)
  );
  const edgeHelper = new THREE.Box3Helper(edgeBox, new THREE.Color('#475569'));
  stockGroup.add(edgeHelper);

  return stockGroup;
}

export default function ToolpathVisualizer({
  toolpath,
  ackedLines,
  wpos,
  wco,
  headerActions,
}: ToolpathVisualizerProps) {
  const [viewMode, setViewMode] = useState<VisualizerViewMode>('shaded');
  const [showGrid, setShowGrid] = useState<boolean>(true);
  // Live carve is always on: the stock mesh carves progressively as lines are
  // acknowledged, and shows the full final part once the job completes. The
  // former "Final Part / Live Carve" toggle is gone, so there is no manual
  // switch to keep in sync with job state.
  const liveCarveSim = true;
  // Material and cutter diameter are fixed presets now that their selectors
  // were removed from the header.
  const stockMaterial: StockMaterialPreset = 'aluminum';
  const toolDia = 3.175;
  const [isCubeFlat, setIsCubeFlat] = useState<boolean>(false);
  const [isCubeHovered, setIsCubeHovered] = useState<boolean>(false);
  // Height of the viewport in CSS pixels, used for the HUD corner markers.


  const mountRef = useRef<HTMLDivElement>(null);
  const isCubeFlatRef = useRef<boolean>(false);
  const isCubeHoveredRef = useRef<boolean>(false);

  const navRef = useRef<NavigationController | null>(null);
  const cubeHitTestRef = useRef<
    ((clientX: number, clientY: number) => ViewCubeHit | null) | null
  >(null);
  const cubeFaceTestRef = useRef<
    ((clientX: number, clientY: number) => number | null) | null
  >(null);
  const cubeClickHandlerRef = useRef<
    ((clientX: number, clientY: number) => void) | null
  >(null);
  const cubeZoneTestRef = useRef<
    ((clientX: number, clientY: number) => boolean) | null
  >(null);
  const hoveredFaceHandlerRef = useRef<(faceIndex: number | null) => void>(
    () => {}
  );
  const cubeHoverHandlerRef = useRef<(hovered: boolean) => void>(() => {});

  const sceneRef = useRef<THREE.Scene | null>(null);
  const pivotRef = useRef<THREE.Vector3>(new THREE.Vector3(40, 40, 0));
  const cutterGroupRef = useRef<THREE.Group | null>(null);
  const pivotMarkerRef = useRef<THREE.Mesh | null>(null);
  const originDotRef = useRef<THREE.Mesh | null>(null);
  const gridGroupRef = useRef<THREE.Group | null>(null);
  const gridRefsRef = useRef<GridRefs | null>(null);
  const targetWposRef = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });
  const wcoRef = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });
  const toolpathRef = useRef<ParsedToolpath | null>(null);

  const colorAttrRef = useRef<THREE.BufferAttribute | null>(null);
  const segmentMetaRef = useRef<Array<{ rapid: boolean; lineIndex: number }>>([]);
  const toolpathMeshRef = useRef<THREE.LineSegments | null>(null);
  const boundsBoxRef = useRef<THREE.LineSegments | null>(null);
  const shadedModelGroupRef = useRef<THREE.Group | null>(null);
  useEffect(() => {
    targetWposRef.current = wpos;
  }, [wpos]);

  // Keep the work-coordinate offset on hand for plotting the cutter.
  //
  // Grbl reports MPos = WPos + WCO. A "Set X0" only changes what work zero
  // means; the physical position is untouched. The scene is therefore laid out
  // in fixed machine space and never translated: the model, grid and job stay
  // exactly where they are, and only the DRO readout rebases to 0.
  useEffect(() => {
    wcoRef.current = {
      x: Number.isFinite(wco.x) ? wco.x : 0,
      y: Number.isFinite(wco.y) ? wco.y : 0,
      z: Number.isFinite(wco.z) ? wco.z : 0,
    };
  }, [wco.x, wco.y, wco.z]);

  useEffect(() => {
    toolpathRef.current = toolpath;
  }, [toolpath]);

  // Initialize Three.js WebGL scene, Z-up camera, Fusion 360 ViewCube HUD, and Navigation Controller
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#090d16');
    sceneRef.current = scene;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.autoClear = false; // Required for rendering the ViewCube HUD overlay in top-right corner
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.cursor = 'grab';
    container.appendChild(renderer.domElement);

    // ---------------------------------------------------------------------
    // Navigation: Fusion 360 orbit / pan / zoom + projection switching,
    // animated view presets and fit-to-model. The ViewCube HUD below feeds
    // its hit tests into this controller.
    // ---------------------------------------------------------------------
    const nav = new NavigationController({
      domElement: renderer.domElement,
      getViewCubeHit: (x, y) =>
        cubeHitTestRef.current ? cubeHitTestRef.current(x, y) : null,
      getViewCubeFace: (x, y) =>
        cubeFaceTestRef.current ? cubeFaceTestRef.current(x, y) : null,
      isViewCubeZone: (x, y) =>
        cubeZoneTestRef.current ? cubeZoneTestRef.current(x, y) : false,
      onViewCubeClick: (x, y) => {
        cubeClickHandlerRef.current?.(x, y);
      },
      onViewCubeFaceHover: (faceIndex) => hoveredFaceHandlerRef.current(faceIndex),
      onViewCubeHover: (hovered) => cubeHoverHandlerRef.current(hovered),
      onInteractionChange: (interacting) => {
        // Show the orbit pivot while the user drags, as in the previous build.
        if (pivotMarkerRef.current) {
          (pivotMarkerRef.current.material as THREE.MeshBasicMaterial).opacity =
            interacting ? 0.85 : 0.0;
        }
      },
      onChange: (state) => {
        // Only the flat-face state drives UI now that the toolbar is gone.
        if (state.flat !== isCubeFlatRef.current) {
          isCubeFlatRef.current = state.flat;
          setIsCubeFlat(state.flat);
        }
      },
    });
    navRef.current = nav;
    nav.setBoundsProvider(() => {
      const activePath = toolpathRef.current;
      if (!activePath || activePath.segments.length === 0) return null;
      // Use the full rapid-inclusive bounds: the shaded stock mesh and the
      // clearance moves extend past the cutting envelope, and framing only the
      // cut region clips them out of the preset views.
      return new THREE.Box3(
        new THREE.Vector3(
          activePath.bounds.min.x,
          activePath.bounds.min.y,
          activePath.bounds.min.z
        ),
        new THREE.Vector3(
          activePath.bounds.max.x,
          activePath.bounds.max.y,
          activePath.bounds.max.z
        )
      );
    });

    // Studio multi-directional lighting
    const hemiLight = new THREE.HemisphereLight(0xf8fafc, 0x334155, 0.85);
    hemiLight.position.set(0, 0, 300);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
    keyLight.position.set(160, -220, 260);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.65);
    fillLight.position.set(-180, 190, 150);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xe2e8f0, 0.45);
    rimLight.position.set(20, 220, -160);
    scene.add(rimLight);

    // ---------------------------------------------------------------------
    // XY worktable grid. The pitch follows the loaded program's units
    // (10 mm or 1 in), and the grid spans a large area so it still reads as a
    // worktable when zoomed out on a big machine.
    // ---------------------------------------------------------------------
    const gridGroup = new THREE.Group();

    // Origin (0,0,0) center ring marker
    const originDotGeom = new THREE.SphereGeometry(1.3, 16, 16);
    const originDotMat = new THREE.MeshBasicMaterial({ color: 0xf8fafc, depthTest: false });
    const originDot = new THREE.Mesh(originDotGeom, originDotMat);
    originDot.renderOrder = 5;
    originDotRef.current = originDot;
    gridGroup.add(originDot);

    scene.add(gridGroup);
    gridGroupRef.current = gridGroup;

    // Pivot Center Indicator
    const pivotGeom = new THREE.SphereGeometry(1.4, 16, 16);
    const pivotMat = new THREE.MeshBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0.0,
      depthTest: false,
    });
    const pivotMarker = new THREE.Mesh(pivotGeom, pivotMat);
    pivotMarker.position.copy(pivotRef.current);
    pivotMarkerRef.current = pivotMarker;
    scene.add(pivotMarker);

    // 3D Cutter Toolhead Group
    const cutterGroup = new THREE.Group();

    const coneGeom = new THREE.ConeGeometry(3.2, 12, 24);
    coneGeom.rotateX(-Math.PI / 2);
    coneGeom.translate(0, 0, 6);
    const coneMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      metalness: 0.4,
      roughness: 0.3,
      emissive: 0x78350f,
      emissiveIntensity: 0.35,
    });
    cutterGroup.add(new THREE.Mesh(coneGeom, coneMat));

    const shankGeom = new THREE.CylinderGeometry(2.2, 2.2, 14, 20);
    shankGeom.rotateX(Math.PI / 2);
    shankGeom.translate(0, 0, 19);
    const shankMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      metalness: 0.6,
      roughness: 0.3,
    });
    cutterGroup.add(new THREE.Mesh(shankGeom, shankMat));

    const ringGeom = new THREE.RingGeometry(4.0, 5.2, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      side: THREE.DoubleSide,
    });
    const ringMesh = new THREE.Mesh(ringGeom, ringMat);
    ringMesh.position.z = 0.2;
    cutterGroup.add(ringMesh);

    // The cutter is plotted in machine coordinates in the scene root. Keeping
    // it outside the work frame means re-zeroing an axis moves the grid / stock
    // / job but never the tool, and avoids a lerp overshoot while both the
    // frame offset and the work position change in the same update.
    scene.add(cutterGroup);
    cutterGroupRef.current = cutterGroup;

    // =========================================================================
    // Fusion 360 Interactive 3D ViewCube Scene (Top-Right Corner Viewport)
    // =========================================================================
    const CUBE_VP_SIZE = 132; // px (larger, matching reference image)
    const CUBE_VP_MARGIN = 16; // px margin from top/right edge
    const hudScene = new THREE.Scene();
    const hudCamera = new THREE.OrthographicCamera(-1.9, 1.9, 1.9, -1.9, 0.1, 20);

    // BoxGeometry material order: 0:+X (RIGHT), 1:-X (LEFT), 2:+Y (BACK), 3:-Y (FRONT), 4:+Z (TOP), 5:-Z (BOTTOM)
    const faceLabels = ['RIGHT', 'LEFT', 'BACK', 'FRONT', 'TOP', 'BOTTOM'];
    const normalTextures = faceLabels.map((lbl) => createViewCubeFaceTexture(lbl, false));
    const hoverTextures = faceLabels.map((lbl) => createViewCubeFaceTexture(lbl, true));

    // Rotate +Y (BACK), +X (RIGHT), -X (LEFT) textures so text reads upright when Z is up
    const orientFaceTexture = (tex: THREE.CanvasTexture, faceIndex: number) => {
      tex.center.set(0.5, 0.5);
      if (faceIndex === 0) tex.rotation = Math.PI / 2; // RIGHT (+X)
      else if (faceIndex === 1) tex.rotation = -Math.PI / 2; // LEFT (-X)
      else if (faceIndex === 2) tex.rotation = Math.PI; // BACK (+Y)
      else if (faceIndex === 3) tex.rotation = 0; // FRONT (-Y)
      else if (faceIndex === 4) tex.rotation = 0; // TOP (+Z)
      else if (faceIndex === 5) tex.rotation = 0; // BOTTOM (-Z)
    };
    normalTextures.forEach(orientFaceTexture);
    hoverTextures.forEach(orientFaceTexture);

    const cubeMaterials = normalTextures.map(
      (tex) =>
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          opacity: 0.38,
        })
    );
    const viewCubeGeom = new THREE.BoxGeometry(1.72, 1.72, 1.72);
    const viewCubeMesh = new THREE.Mesh(viewCubeGeom, cubeMaterials);
    hudScene.add(viewCubeMesh);

    // Fusion 360 Corner Coordinate Axes (Red X, Blue Z) originating from front-bottom corner
    const cubeAxesGroup = new THREE.Group();
    const cornerOrigin = new THREE.Vector3(0.88, -0.88, -0.88);

    // X Axis line (Red along +X)
    const xLineGeom = new THREE.BufferGeometry().setFromPoints([
      cornerOrigin,
      new THREE.Vector3(cornerOrigin.x + 0.42, cornerOrigin.y, cornerOrigin.z),
    ]);
    const xLineMat = new THREE.LineBasicMaterial({
      color: 0xef4444,
      linewidth: 3,
      transparent: true,
      opacity: 0.45,
    });
    cubeAxesGroup.add(new THREE.Line(xLineGeom, xLineMat));

    // Z Axis line (Blue along +Z)
    const zLineGeom = new THREE.BufferGeometry().setFromPoints([
      cornerOrigin,
      new THREE.Vector3(cornerOrigin.x, cornerOrigin.y, cornerOrigin.z + 0.42),
    ]);
    const zLineMat = new THREE.LineBasicMaterial({
      color: 0x3b82f6,
      linewidth: 3,
      transparent: true,
      opacity: 0.45,
    });
    cubeAxesGroup.add(new THREE.Line(zLineGeom, zLineMat));

    // Axis letter sprites ('X' in Red, 'Z' in Blue)
    const makeMiniAxisSprite = (letter: string, color: string, pos: THREE.Vector3) => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.font = '900 48px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter, 32, 32);
      const tex = new THREE.CanvasTexture(c);
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0.45,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(pos);
      sprite.scale.set(0.32, 0.32, 1);
      return { sprite, mat };
    };

    const xBadge = makeMiniAxisSprite(
      'X',
      '#ef4444',
      new THREE.Vector3(cornerOrigin.x + 0.58, cornerOrigin.y, cornerOrigin.z)
    );
    const zBadge = makeMiniAxisSprite(
      'Z',
      '#3b82f6',
      new THREE.Vector3(cornerOrigin.x, cornerOrigin.y, cornerOrigin.z + 0.58)
    );
    cubeAxesGroup.add(xBadge.sprite);
    cubeAxesGroup.add(zBadge.sprite);
    hudScene.add(cubeAxesGroup);

    let hoveredCubeFace: number | null = null;
    const hudRaycaster = new THREE.Raycaster();

    const setCubeOpacity = (alpha: number) => {
      cubeMaterials.forEach((m) => {
        m.opacity = alpha;
      });
      xLineMat.opacity = alpha;
      zLineMat.opacity = alpha;
      xBadge.mat.opacity = alpha;
      zBadge.mat.opacity = alpha;
    };

    // Check if pointer event is inside the top-right ViewCube viewport (including margin for Home icon)
    const getViewCubeIntersection = (clientX: number, clientY: number) => {
      const rect = domEl.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;

      const vpLeft = rect.width - CUBE_VP_SIZE - CUBE_VP_MARGIN;
      const vpTop = CUBE_VP_MARGIN;

      if (
        localX < vpLeft ||
        localX > vpLeft + CUBE_VP_SIZE ||
        localY < vpTop ||
        localY > vpTop + CUBE_VP_SIZE
      ) {
        return null;
      }

      const ndcX = ((localX - vpLeft) / CUBE_VP_SIZE) * 2 - 1;
      const ndcY = -((localY - vpTop) / CUBE_VP_SIZE) * 2 + 1;

      hudRaycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), hudCamera);
      const hits = hudRaycaster.intersectObject(viewCubeMesh, false);
      return hits.length > 0 ? hits[0] : null;
    };

    const isPointerOverCubeZone = (clientX: number, clientY: number) => {
      const rect = domEl.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      // Generous hover detection bounding box covering Home button and ViewCube
      const zoneLeft = rect.width - CUBE_VP_SIZE - CUBE_VP_MARGIN - 42;
      const zoneRight = rect.width;
      const zoneTop = 0;
      const zoneBottom = CUBE_VP_SIZE + CUBE_VP_MARGIN + 24;
      return (
        localX >= zoneLeft &&
        localX <= zoneRight &&
        localY >= zoneTop &&
        localY <= zoneBottom
      );
    };

    // =========================================================================
    // ViewCube bridge — NavigationController owns all viewport input; the HUD
    // only supplies hit tests and rendering so it behaves exactly as before.
    // =========================================================================
    const domEl = renderer.domElement;

    cubeHitTestRef.current = (clientX, clientY) => {
      const hit = getViewCubeIntersection(clientX, clientY);
      return hit ? { faceIndex: hit.face ? hit.face.materialIndex : -1 } : null;
    };
    cubeFaceTestRef.current = (clientX, clientY) => {
      const hit = getViewCubeIntersection(clientX, clientY);
      return hit && hit.face ? hit.face.materialIndex : null;
    };
    cubeZoneTestRef.current = isPointerOverCubeZone;
    hoveredFaceHandlerRef.current = (faceIndex: number | null) => {
      if (faceIndex === hoveredCubeFace) return;
      if (hoveredCubeFace !== null) {
        cubeMaterials[hoveredCubeFace].map = normalTextures[hoveredCubeFace];
        cubeMaterials[hoveredCubeFace].needsUpdate = true;
      }
      if (faceIndex !== null) {
        cubeMaterials[faceIndex].map = hoverTextures[faceIndex];
        cubeMaterials[faceIndex].needsUpdate = true;
      }
      hoveredCubeFace = faceIndex;
    };
    cubeHoverHandlerRef.current = (over) => {
      if (over === isCubeHoveredRef.current) return;
      isCubeHoveredRef.current = over;
      setIsCubeHovered(over);
      setCubeOpacity(over ? 1.0 : 0.38);
    };
    cubeClickHandlerRef.current = (clientX: number, clientY: number) => {
      const hit = getViewCubeIntersection(clientX, clientY);
      if (!hit || !hit.face) return;

      const p = hit.point;
      const edgeThreshold = 0.56; // outer 22% margin snaps to edges/corners

      const dirX = Math.abs(p.x) > edgeThreshold ? Math.sign(p.x) : 0;
      const dirY = Math.abs(p.y) > edgeThreshold ? Math.sign(p.y) : 0;
      const dirZ = Math.abs(p.z) > edgeThreshold ? Math.sign(p.z) : 0;

      let snapDir: THREE.Vector3;
      let snapUp: THREE.Vector3 | undefined;

      if (dirX !== 0 || dirY !== 0 || dirZ !== 0) {
        snapDir = new THREE.Vector3(dirX, dirY, dirZ);
      } else {
        snapDir = hit.face.normal.clone();
        const ax = Math.abs(snapDir.x);
        const ay = Math.abs(snapDir.y);
        const az = Math.abs(snapDir.z);
        if (ax >= ay && ax >= az) {
          snapDir.set(Math.sign(snapDir.x), 0, 0);
          snapUp = new THREE.Vector3(0, 0, 1);
        } else if (ay >= ax && ay >= az) {
          snapDir.set(0, Math.sign(snapDir.y), 0);
          snapUp = new THREE.Vector3(0, 0, 1);
        } else {
          snapDir.set(0, 0, Math.sign(snapDir.z));
          snapUp = new THREE.Vector3(0, snapDir.z > 0 ? 1 : -1, 0);
        }
      }
      nav.snapToDirection(snapDir, { up: snapUp });
    };

    const onPointerLeave = () => {
      if (isCubeHoveredRef.current) {
        isCubeHoveredRef.current = false;
        setIsCubeHovered(false);
        setCubeOpacity(0.38);
      }
    };

    domEl.addEventListener('pointerleave', onPointerLeave);

    let animFrameId: number;
    let lastFrameTime = performance.now();
    const cutterVelocity = new THREE.Vector3();

    const animate = () => {
      animFrameId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0.001, (now - lastFrameTime) / 1000));
      lastFrameTime = now;

      // Advance animated view transitions (ViewCube snaps, presets, fit).
      nav.update();
      pivotRef.current.copy(nav.getPivot());
      pivotMarker.position.copy(pivotRef.current);

      // Critically-damped spring / frame-rate independent cutter motion toward latest Grbl WPos report
      if (cutterGroupRef.current) {
        // Plot the cutter in fixed machine coordinates: MPos = WPos + WCO.
        // The scene itself is never translated, so pressing "Set X0" only
        // rebases the DRO readout — the tool, stock and job all stay put.
        const wp = targetWposRef.current;
        const target = {
          x: wp.x + wcoRef.current.x,
          y: wp.y + wcoRef.current.y,
          z: wp.z + wcoRef.current.z,
        };
        const pos = cutterGroupRef.current.position;
        const dx = target.x - pos.x;
        const dy = target.y - pos.y;
        const dz = target.z - pos.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq < 1e-8) {
          pos.set(target.x, target.y, target.z);
          cutterVelocity.set(0, 0, 0);
        } else {
          // Smoothly track target across both 60Hz simulator updates and 5Hz hardware serial polling
          const omega = 28.0;
          const x = omega * dt;
          const exp = 1.0 / (1.0 + x + 0.48 * x * x + 0.235 * x * x * x);

          const changeX = pos.x - target.x;
          const changeY = pos.y - target.y;
          const changeZ = pos.z - target.z;

          const tempX = (cutterVelocity.x + omega * changeX) * dt;
          const tempY = (cutterVelocity.y + omega * changeY) * dt;
          const tempZ = (cutterVelocity.z + omega * changeZ) * dt;

          cutterVelocity.x = (cutterVelocity.x - omega * tempX) * exp;
          cutterVelocity.y = (cutterVelocity.y - omega * tempY) * exp;
          cutterVelocity.z = (cutterVelocity.z - omega * tempZ) * exp;

          pos.x = target.x + (changeX + tempX) * exp;
          pos.y = target.y + (changeY + tempY) * exp;
          pos.z = target.z + (changeZ + tempZ) * exp;
        }
      }

      const fullW = container.clientWidth;
      const fullH = Math.max(1, container.clientHeight);

      // Resolve the active camera every frame so projection switches take effect.
      const activeCamera = nav.camera;

      // Keep the X / Y badges and the unit readout a constant on-screen size.
      // Scaling by each sprite's own camera distance stops a badge close to the
      // eye (e.g. in a profile view) from ballooning.
      // Keep the X / Y badges a constant on-screen size and inside the view.
      //
      // Two independent problems made Y look far larger than X:
      //  1. On-screen size is governed by the sprite's *depth* along the camera
      //     view axis, not straight-line distance. X sits far to the side, so
      //     its euclidean distance was much larger than its depth and the old
      //     `dist * 0.045` scale under-sized it.
      //  2. In the default isometric view the +X end of the grid falls outside
      //     the frustum, so its badge was clipped to a sliver at the edge.
      //
      // Both badges are now sized to a fixed pixel size from their own depth,
      // and their position is clamped into the viewport so neither can be
      // clipped away when the camera crops the end of an axis.
      const gridRefs = gridRefsRef.current;
      if (gridRefs) {
        const camDir = new THREE.Vector3();
        activeCamera.getWorldDirection(camDir);

        const isPersp = activeCamera instanceof THREE.PerspectiveCamera;
        const BADGE_PX = 46;
        const viewH = Math.max(1, fullH);

        const tanHalfFov = isPersp
          ? Math.tan(THREE.MathUtils.degToRad(activeCamera.fov) / 2)
          : 0;
        const orthoHeight = isPersp
          ? 0
          : activeCamera.top - activeCamera.bottom;

        // Keep the badge fully inside the viewport: its own half-size in NDC.
        const marginX = Math.min(0.95, BADGE_PX / Math.max(1, fullW));
        const marginY = Math.min(0.95, BADGE_PX / viewH);

        const tmp = new THREE.Vector3();
        for (const sprite of [gridRefs.xBadge, gridRefs.yBadge]) {
          if (!sprite) continue;

          const home = sprite.userData.homePosition as THREE.Vector3 | undefined;
          if (home) sprite.position.copy(home);

          tmp.subVectors(sprite.position, activeCamera.position);
          const depth = tmp.dot(camDir);
          const visible = depth > 2;
          sprite.visible = visible;
          if (!visible) continue;

          // World size that covers exactly BADGE_PX on a viewH-pixel-tall view.
          const worldSize = isPersp
            ? BADGE_PX * depth * ((2 * tanHalfFov) / viewH)
            : BADGE_PX * (orthoHeight / viewH);
          sprite.scale.set(worldSize, worldSize, 1);

          // Walk the badge back along its own axis until it lands inside the
          // viewport, so a cropped axis end still gets a label sitting on its
          // axis line rather than jammed into a screen corner.
          const axisEnd = (home ?? sprite.position).clone();
          const axisDir = axisEnd.clone().normalize();
          const insetX = 1 - marginX;
          const insetY = 1 - marginY;
          const probe = new THREE.Vector3();
          let placed = false;
          for (let t = 1.0; t >= 0.05; t -= 0.05) {
            probe.copy(axisDir).multiplyScalar(axisEnd.length() * t);
            probe.z = axisEnd.z;
            probe.project(activeCamera);
            if (Math.abs(probe.x) <= insetX && Math.abs(probe.y) <= insetY) {
              probe.z = (sprite.position.clone().project(activeCamera)).z;
              sprite.position.copy(probe.unproject(activeCamera));
              placed = true;
              break;
            }
          }
          // Last resort: clamp into the viewport so the label is never lost.
          if (!placed) {
            const ndc = sprite.position.clone().project(activeCamera);
            ndc.set(
              THREE.MathUtils.clamp(ndc.x, -insetX, insetX),
              THREE.MathUtils.clamp(ndc.y, -insetY, insetY),
              ndc.z
            );
            sprite.position.copy(ndc.unproject(activeCamera));
          }
        }
      }

      // Keep the work-origin marker readable without letting it fill the
      // screen in close-up profile views.
      if (originDotRef.current) {
        const dist = activeCamera.position.distanceTo(originDotRef.current.position);
        const s = THREE.MathUtils.clamp(dist * 0.006, 0.35, 2.2);
        originDotRef.current.scale.setScalar(s);
      }

      // 1. Render Main 3D CNC Viewport
      renderer.setViewport(0, 0, fullW, fullH);
      renderer.setScissorTest(false);
      renderer.clear();
      renderer.render(scene, activeCamera);

      // 2. Render Fusion 360 ViewCube HUD in Top-Right Corner
      const camDir = new THREE.Vector3()
        .subVectors(activeCamera.position, pivotRef.current)
        .normalize();
      hudCamera.position.copy(camDir).multiplyScalar(5.0);
      hudCamera.up.copy(activeCamera.up);
      hudCamera.lookAt(0, 0, 0);

      // Flat-face detection is published by the controller via onChange.
      void isCubeFlat;

      const cubeVpX = Math.max(0, fullW - CUBE_VP_SIZE - CUBE_VP_MARGIN);
      const cubeVpY = Math.max(0, fullH - CUBE_VP_SIZE - CUBE_VP_MARGIN);
      renderer.clearDepth();
      renderer.setScissorTest(true);
      renderer.setScissor(cubeVpX, cubeVpY, CUBE_VP_SIZE, CUBE_VP_SIZE);
      renderer.setViewport(cubeVpX, cubeVpY, CUBE_VP_SIZE, CUBE_VP_SIZE);
      renderer.render(hudScene, hudCamera);
      renderer.setScissorTest(false);
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth;
      const h = Math.max(1, container.clientHeight);
      nav.resize(w, h);
      renderer.setSize(w, h, false);
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      nav.dispose();
      navRef.current = null;
      domEl.removeEventListener('pointerleave', onPointerLeave);
      renderer.dispose();
      if (container.contains(domEl)) {
        container.removeChild(domEl);
      }
    };
  }, []);

  // Smoothly snaps camera to any ViewCube Face, Edge, or Corner direction
  const snapToDirection = useCallback(
    (dir: THREE.Vector3, customUp?: THREE.Vector3) => {
      navRef.current?.snapToDirection(dir, { up: customUp });
    },
    []
  );

  // Flat-face helper arrows orbit 90 degrees onto the adjacent face.
  const stepAdjacentFace = useCallback(
    (direction: 'top' | 'bottom' | 'left' | 'right') => {
      navRef.current?.stepAdjacentFace(direction);
    },
    []
  );


  // Rebuild wireframe toolpath whenever a new G-code file is loaded
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const parent = scene;

    if (toolpathMeshRef.current) {
      parent.remove(toolpathMeshRef.current);
      toolpathMeshRef.current.geometry.dispose();
      (toolpathMeshRef.current.material as THREE.Material).dispose();
      toolpathMeshRef.current = null;
    }
    if (boundsBoxRef.current) {
      parent.remove(boundsBoxRef.current);
      boundsBoxRef.current.geometry.dispose();
      (boundsBoxRef.current.material as THREE.Material).dispose();
      boundsBoxRef.current = null;
    }

    if (!toolpath || toolpath.segments.length === 0) {
      colorAttrRef.current = null;
      segmentMetaRef.current = [];
      return;
    }

    const segCount = toolpath.segments.length;
    const positions = new Float32Array(segCount * 6);
    const colors = new Float32Array(segCount * 6);
    const meta: Array<{ rapid: boolean; lineIndex: number }> = new Array(segCount);

    for (let i = 0; i < segCount; i++) {
      const seg = toolpath.segments[i];
      const base = i * 6;
      positions[base] = seg.start.x;
      positions[base + 1] = seg.start.y;
      positions[base + 2] = seg.start.z;
      positions[base + 3] = seg.end.x;
      positions[base + 4] = seg.end.y;
      positions[base + 5] = seg.end.z;

      const r = seg.rapid ? 0.96 : 0.22;
      const g = seg.rapid ? 0.62 : 0.74;
      const b = seg.rapid ? 0.04 : 0.97;

      colors[base] = r;
      colors[base + 1] = g;
      colors[base + 2] = b;
      colors[base + 3] = r;
      colors[base + 4] = g;
      colors[base + 5] = b;

      meta[i] = { rapid: seg.rapid, lineIndex: seg.lineIndex };
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const colorAttr = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('color', colorAttr);

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });

    const lineSegments = new THREE.LineSegments(geometry, material);
    lineSegments.renderOrder = 2;
    scene.add(lineSegments);

    toolpathMeshRef.current = lineSegments;
    colorAttrRef.current = colorAttr;
    segmentMetaRef.current = meta;

    const { min, max } = toolpath.bounds;
    const box3 = new THREE.Box3(
      new THREE.Vector3(min.x, min.y, min.z),
      new THREE.Vector3(max.x, max.y, max.z)
    );
    const boxHelper = new THREE.Box3Helper(box3, new THREE.Color('#475569'));
    scene.add(boxHelper);
    boundsBoxRef.current = boxHelper;

    // Frame the freshly loaded job with an animated home isometric snap.
    snapToDirection(new THREE.Vector3(0.8, -1.0, 0.85));
  }, [toolpath, snapToDirection]);

  // Rebuild / update 3D Shaded Stock Model
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (shadedModelGroupRef.current) {
      scene.remove(shadedModelGroupRef.current);
      shadedModelGroupRef.current.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      shadedModelGroupRef.current = null;
    }

    if (toolpath && toolpath.segments.length > 0) {
      const maxLine = liveCarveSim ? ackedLines : Infinity;
      const stockGroup = buildWatertightStockMesh(
        toolpath,
        maxLine,
        toolDia,
        stockMaterial
      );
      if (stockGroup) {
        stockGroup.visible = viewMode === 'shaded';
        scene.add(stockGroup);
        shadedModelGroupRef.current = stockGroup;
      }
    }
  }, [toolpath, stockMaterial, toolDia, liveCarveSim, liveCarveSim ? ackedLines : 0]);

  useEffect(() => {
    if (toolpathMeshRef.current) {
      toolpathMeshRef.current.visible = viewMode === 'toolpath';
      const mat = toolpathMeshRef.current.material as THREE.LineBasicMaterial;
      mat.depthTest = true;
      mat.opacity = 0.95;
      mat.needsUpdate = true;
    }
    if (boundsBoxRef.current) {
      boundsBoxRef.current.visible = viewMode === 'toolpath';
    }
    if (shadedModelGroupRef.current) {
      shadedModelGroupRef.current.visible = viewMode === 'shaded';
    }
  }, [viewMode, toolpath]);

  useEffect(() => {
    if (gridGroupRef.current) {
      gridGroupRef.current.visible = showGrid;
    }
  }, [showGrid]);

  // Rebuild the worktable grid when the project (or its declared units)
  // changes, so the gradation matches the loaded file and the grid grows for
  // large jobs instead of being a fixed 300 mm square.
  const gridUnit: GcodeUnit = toolpath?.unit ?? 'mm';
  useEffect(() => {
    const scene = sceneRef.current;
    const group = gridGroupRef.current;
    if (!scene || !group) return;

    const b = toolpath?.bounds;
    const span = b
      ? Math.max(
          0,
          b.max.x - b.min.x,
          b.max.y - b.min.y,
          Math.abs(b.max.x),
          Math.abs(b.min.x),
          Math.abs(b.max.y),
          Math.abs(b.min.y)
        )
      : 0;
    const halfExtent = THREE.MathUtils.clamp(
      Math.max(GRID_BASE_EXTENT, span * 1.35),
      GRID_BASE_EXTENT,
      GRID_MAX_EXTENT
    );

    // Free the previous grid's geometries and textures before replacing it.
    const previous = [...group.children];
    group.clear();
    previous.forEach((child) => disposeGroup(child));

    // Sit the worktable at bed level — the underside of the stock block — so
    // it reads as the machine table under the part instead of lines drawn
    // across its top surface. With no job loaded there is no stock, so the
    // grid sits at the work-origin plane.
    const stockZ = computeStockZRange(toolpath);
    const bedZ = stockZ ? stockZ.bottomZ - GRID_BED_CLEARANCE : 0;

    const built = buildWorktableGrid(halfExtent, gridUnit, bedZ);
    built.group.visible = showGrid;
    // Re-parent the built children into the stable group the camera code uses.
    for (const child of [...built.group.children]) {
      group.add(child);
    }
    gridRefsRef.current = built.refs;
  }, [toolpath, gridUnit, showGrid]);

  useEffect(() => {
    const colorAttr = colorAttrRef.current;
    const meta = segmentMetaRef.current;
    if (!colorAttr || meta.length === 0) return;

    const arr = colorAttr.array as Float32Array;
    for (let i = 0; i < meta.length; i++) {
      const { rapid, lineIndex } = meta[i];
      const isCompleted = lineIndex < ackedLines;
      let r: number, g: number, b: number;

      if (isCompleted) {
        r = 0.13;
        g = 0.77;
        b = 0.37;
      } else if (rapid) {
        r = 0.96;
        g = 0.62;
        b = 0.04;
      } else {
        r = 0.22;
        g = 0.74;
        b = 0.97;
      }

      const base = i * 6;
      arr[base] = r;
      arr[base + 1] = g;
      arr[base + 2] = b;
      arr[base + 3] = r;
      arr[base + 4] = g;
      arr[base + 5] = b;
    }

    colorAttr.needsUpdate = true;
  }, [ackedLines, toolpath]);

  const dimensions = toolpath
    ? {
        dx: Math.max(0, toolpath.cutBounds.max.x - toolpath.cutBounds.min.x),
        dy: Math.max(0, toolpath.cutBounds.max.y - toolpath.cutBounds.min.y),
        dz: Math.max(0, toolpath.cutBounds.max.z - toolpath.cutBounds.min.z),
      }
    : null;

  return (
    <section style={styles.card}>
      {/* Compact Header Toolbar */}
      <div style={styles.subToolbar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={styles.viewModeGroup}>
            <button
              style={viewMode === 'toolpath' ? styles.viewBtnActive : styles.viewBtn}
              onClick={() => setViewMode('toolpath')}
              title="Show the G-code toolpath as a wireframe"
            >
              Toolpath
            </button>
            <button
              style={viewMode === 'shaded' ? styles.viewBtnActive : styles.viewBtn}
              onClick={() => setViewMode('shaded')}
              title="Shaded 3D stock simulation"
            >
              Shaded
            </button>
          </div>
          {dimensions && toolpath && toolpath.segments.length > 0 && (
            <span style={styles.boundsInfo}>
              {dimensions.dx.toFixed(1)}×{dimensions.dy.toFixed(1)}×{dimensions.dz.toFixed(1)}mm
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'nowrap', minWidth: 0 }}>
          <button
            style={{ ...(showGrid ? styles.toggleChipActive : styles.toggleChipOff), width: '88px' }}
            onClick={() => setShowGrid((v) => !v)}
            title="Show or hide the XY Worktable Grid overlay"
          >
            {showGrid ? 'Grid: ON' : 'Grid: OFF'}
          </button>

          {headerActions}
        </div>
      </div>

      <div style={styles.canvasWrapper}>
        <div ref={mountRef} style={styles.canvasContainer} />

        {/* Fusion 360 Flat-Face Adjacent Step Arrows (▲ ▼ ◀ ▶) — visible when ViewCube is aligned flat to a face */}
        {isCubeFlat && (
          <div style={styles.flatCubeArrowsContainer}>
            <button
              style={{ ...styles.flatArrowBtn, top: '8px', left: '50%', transform: 'translateX(-50%)' }}
              onClick={() => stepAdjacentFace('top')}
              title="Orbit 90° to Top Adjacent Face"
            >
              ▲
            </button>
            <button
              style={{ ...styles.flatArrowBtn, bottom: '8px', left: '50%', transform: 'translateX(-50%)' }}
              onClick={() => stepAdjacentFace('bottom')}
              title="Orbit 90° to Bottom Adjacent Face"
            >
              ▼
            </button>
            <button
              style={{ ...styles.flatArrowBtn, left: '8px', top: '50%', transform: 'translateY(-50%)' }}
              onClick={() => stepAdjacentFace('left')}
              title="Orbit 90° to Left Adjacent Face"
            >
              ◀
            </button>
            <button
              style={{ ...styles.flatArrowBtn, right: '8px', top: '50%', transform: 'translateY(-50%)' }}
              onClick={() => stepAdjacentFace('right')}
              title="Orbit 90° to Right Adjacent Face"
            >
              ▶
            </button>
          </div>
        )}

        {/* Fusion 360 ViewCube Home Control positioned at top-left of the ViewCube */}
        <div
          style={{
            ...styles.viewCubeOverlay,
            opacity: isCubeHovered ? 1.0 : 0.35,
          }}
          onPointerEnter={() => setIsCubeHovered(true)}
          onPointerLeave={() => setIsCubeHovered(false)}
        >
          <button
            style={styles.cubeHomeBtn}
            onClick={() => snapToDirection(new THREE.Vector3(0.8, -1.0, 0.85))}
            title="Home Isometric View"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#0f172a"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ display: 'block' }}
            >
              <path d="M3 10.5L12 3l9 7.5" />
              <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
              <path d="M9 21V12h6v9" fill="#0f172a" />
            </svg>
          </button>
        </div>

        {/* Live HUD Legend Overlay (Bottom-Left) */}
        {/* Grid gradation readout: follows the loaded program's units. */}
        <div style={styles.gridUnitBadge} title="Worktable grid gradation">
          <span style={{ ...styles.dot, background: '#64748b' }} /> Grid{' '}
          {GRID_UNITS[gridUnit].label}
        </div>

        <div style={styles.hudLegend}>
          <span style={styles.legendItem}>
            <span style={{ ...styles.dot, background: '#38bdf8' }} /> Cut
          </span>
          <span style={styles.legendItem}>
            <span style={{ ...styles.dot, background: '#f59e0b' }} /> Rapid
          </span>
          <span style={styles.legendItem}>
            <span style={{ ...styles.dot, background: '#22c55e' }} /> Executed
          </span>
          <span style={styles.legendItem}>
            <span style={{ ...styles.dot, background: '#fbbf24' }} /> Tip ({wpos.x.toFixed(1)}, {wpos.y.toFixed(1)}, {wpos.z.toFixed(1)})
          </span>
        </div>
      </div>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '8px',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: 0,
    boxSizing: 'border-box',
  },
  subToolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: '28px',
    marginBottom: '8px',
    flexWrap: 'wrap',
    gap: '8px',
    flexShrink: 0,
    rowGap: '6px',
  },
  viewModeGroup: {
    display: 'inline-flex',
    background: '#0f172a',
    padding: '2px',
    borderRadius: '6px',
    border: '1px solid #334155',
    gap: '2px',
  },
  viewBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '22px',
    padding: '0 10px',
    background: 'transparent',
    color: '#94a3b8',
    border: 'none',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  viewBtnActive: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '22px',
    padding: '0 10px',
    background: '#0284c7',
    color: '#ffffff',
    border: 'none',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  /** Toggle chips match the Jog panel's "Pad: ON/OFF" badge treatment. */
  toggleChipActive: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '24px',
    padding: '0 8px',
    background: 'rgba(2, 132, 199, 0.22)',
    color: '#38bdf8',
    border: '1px solid #0284c7',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  toggleChipOff: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '24px',
    padding: '0 8px',
    background: '#0f172a',
    color: '#64748b',
    border: '1px solid #334155',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  boundsInfo: {
    fontSize: '11px',
    color: '#cbd5e1',
    background: '#0f172a',
    padding: '2px 7px',
    borderRadius: '4px',
    border: '1px solid #334155',
    fontFamily: 'Consolas, Monaco, monospace',
  },
  canvasWrapper: {
    position: 'relative',
    width: '100%',
    flex: 1,
    minHeight: 0,
    borderRadius: '6px',
    overflow: 'hidden',
    border: '1px solid #334155',
    background: '#090d16',
  },
  canvasContainer: {
    width: '100%',
    height: '100%',
  },
  flatCubeArrowsContainer: {
    position: 'absolute',
    top: '6px',
    right: '6px',
    width: '152px',
    height: '152px',
    pointerEvents: 'none',
    zIndex: 6,
  },
  flatArrowBtn: {
    position: 'absolute',
    width: '18px',
    height: '18px',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(241, 245, 249, 0.95)',
    color: '#0f172a',
    border: '1px solid #94a3b8',
    borderRadius: '3px',
    fontSize: '10px',
    lineHeight: 1,
    cursor: 'pointer',
    pointerEvents: 'auto',
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
  },
  viewCubeOverlay: {
    position: 'absolute',
    top: '12px',
    right: '154px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    zIndex: 7,
    transition: 'opacity 0.2s ease-in-out',
  },
  cubeHomeBtn: {
    width: '26px',
    height: '26px',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(241, 245, 249, 0.92)',
    color: '#1e293b',
    border: '1px solid #cbd5e1',
    borderRadius: '4px',
    fontSize: '14px',
    cursor: 'pointer',
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.25)',
    transition: 'background 0.15s, transform 0.15s',
  },
  gridUnitBadge: {
    position: 'absolute',
    bottom: '8px',
    right: '10px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    background: 'rgba(15, 23, 42, 0.85)',
    padding: '4px 10px',
    borderRadius: '6px',
    border: '1px solid #334155',
    fontSize: '11px',
    color: '#cbd5e1',
    pointerEvents: 'none',
    fontFamily: 'Consolas, Monaco, monospace',
  },
  hudLegend: {
    position: 'absolute',
    bottom: '8px',
    left: '10px',
    display: 'flex',
    gap: '12px',
    background: 'rgba(15, 23, 42, 0.85)',
    padding: '4px 10px',
    borderRadius: '6px',
    border: '1px solid #334155',
    fontSize: '11px',
    color: '#cbd5e1',
    pointerEvents: 'none',
    flexWrap: 'wrap',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block',
  },
};
