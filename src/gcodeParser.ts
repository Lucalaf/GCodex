export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface ToolpathSegment {
  start: Point3D;
  end: Point3D;
  rapid: boolean;
  lineIndex: number;
}

/** Unit of the source G-code file, as declared by G20 / G21. */
export type GcodeUnit = 'mm' | 'in';

export interface ParsedToolpath {
  segments: ToolpathSegment[];
  bounds: {
    min: Point3D;
    max: Point3D;
  };
  cutBounds: {
    min: Point3D;
    max: Point3D;
  };
  /** Declared program unit; defaults to millimetres when the file is silent. */
  unit: GcodeUnit;
  rapidCount: number;
  cutCount: number;
}

function stripComments(raw: string): string {
  const semiIdx = raw.indexOf(';');
  const base = semiIdx >= 0 ? raw.slice(0, semiIdx) : raw;
  let out = '';
  let depth = 0;
  for (let i = 0; i < base.length; i++) {
    const ch = base[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out.trim();
}

export function parseGcodeToolpath(content: string): ParsedToolpath {
  const lines = content.split(/\r?\n/);
  const segments: ToolpathSegment[] = [];

  let curX = 0;
  let curY = 0;
  let curZ = 0;

  let motionMode: 0 | 1 | 2 | 3 = 0; // G0, G1, G2, G3
  let isAbsolute = true; // G90 = true, G91 = false
  let unitScale = 1.0; // G21 = 1.0 (mm), G20 = 25.4 (inches -> mm)
  // Remember which unit the file actually declares so the 3D grid can use the
  // matching gradation. G21 is the default when the program never says.
  let declaredUnit: GcodeUnit = 'mm';

  const min: Point3D = { x: Infinity, y: Infinity, z: Infinity };
  const max: Point3D = { x: -Infinity, y: -Infinity, z: -Infinity };
  const cutMin: Point3D = { x: Infinity, y: Infinity, z: Infinity };
  const cutMax: Point3D = { x: -Infinity, y: -Infinity, z: -Infinity };

  const expandBounds = (p: Point3D, isCut = false) => {
    if (p.x < min.x) min.x = p.x;
    if (p.y < min.y) min.y = p.y;
    if (p.z < min.z) min.z = p.z;
    if (p.x > max.x) max.x = p.x;
    if (p.y > max.y) max.y = p.y;
    if (p.z > max.z) max.z = p.z;
    if (isCut) {
      if (p.x < cutMin.x) cutMin.x = p.x;
      if (p.y < cutMin.y) cutMin.y = p.y;
      if (p.z < cutMin.z) cutMin.z = p.z;
      if (p.x > cutMax.x) cutMax.x = p.x;
      if (p.y > cutMax.y) cutMax.y = p.y;
      if (p.z > cutMax.z) cutMax.z = p.z;
    }
  };

  let rapidCount = 0;
  let cutCount = 0;
  let execLineIdx = 0;

  const tokenRegex = /([A-Za-z])([+-]?\d*\.?\d+)/g;

  for (let i = 0; i < lines.length; i++) {
    const clean = stripComments(lines[i]);
    if (!clean || clean === '%') continue;

    const currentLineIdx = execLineIdx++;

    let hasCoordWord = false;
    let xVal: number | undefined;
    let yVal: number | undefined;
    let zVal: number | undefined;
    let iVal = 0;
    let jVal = 0;
    let rVal: number | undefined;

    tokenRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(clean)) !== null) {
      const letter = match[1].toUpperCase();
      const val = parseFloat(match[2]);
      if (Number.isNaN(val)) continue;

      if (letter === 'G') {
        const gCode = Math.round(val * 10) / 10;
        if (gCode === 0) motionMode = 0;
        else if (gCode === 1) motionMode = 1;
        else if (gCode === 2) motionMode = 2;
        else if (gCode === 3) motionMode = 3;
        else if (gCode === 90) isAbsolute = true;
        else if (gCode === 91) isAbsolute = false;
        else if (gCode === 20) {
          unitScale = 25.4;
          declaredUnit = 'in';
        } else if (gCode === 21) {
          unitScale = 1.0;
          declaredUnit = 'mm';
        }
      } else if (letter === 'X') {
        xVal = val * unitScale;
        hasCoordWord = true;
      } else if (letter === 'Y') {
        yVal = val * unitScale;
        hasCoordWord = true;
      } else if (letter === 'Z') {
        zVal = val * unitScale;
        hasCoordWord = true;
      } else if (letter === 'I') {
        iVal = val * unitScale;
      } else if (letter === 'J') {
        jVal = val * unitScale;
      } else if (letter === 'R') {
        rVal = val * unitScale;
      }
    }

    if (!hasCoordWord) continue;

    const nextX =
      xVal !== undefined ? (isAbsolute ? xVal : curX + xVal) : curX;
    const nextY =
      yVal !== undefined ? (isAbsolute ? yVal : curY + yVal) : curY;
    const nextZ =
      zVal !== undefined ? (isAbsolute ? zVal : curZ + zVal) : curZ;

    if (nextX === curX && nextY === curY && nextZ === curZ && motionMode <= 1) {
      continue;
    }

    const startPt: Point3D = { x: curX, y: curY, z: curZ };
    const endPt: Point3D = { x: nextX, y: nextY, z: nextZ };
    // Always expand overall bounds with startPt, but only expand cutBounds on actual cutting endpoints
    // (avoiding expanding cutBounds.max.z with the G0 clearance Z where a G1 plunge starts!)
    expandBounds(startPt, false);

    if (motionMode === 0 || motionMode === 1) {
      const isRapid = motionMode === 0;
      segments.push({
        start: startPt,
        end: endPt,
        rapid: isRapid,
        lineIndex: currentLineIdx,
      });
      if (isRapid) rapidCount++;
      else cutCount++;
      expandBounds(endPt, !isRapid);
    } else if (motionMode === 2 || motionMode === 3) {
      // G2 (CW) or G3 (CCW) XY-plane helical/planar arc interpolation
      const isCW = motionMode === 2;
      let cx = curX + iVal;
      let cy = curY + jVal;

      if (rVal !== undefined && iVal === 0 && jVal === 0) {
        const dx = nextX - curX;
        const dy = nextY - curY;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) {
          const h = Math.sqrt(Math.max(0, rVal * rVal - (d * d) / 4));
          const sign = (isCW ? -1 : 1) * (rVal >= 0 ? 1 : -1);
          cx = curX + dx / 2 - (sign * h * dy) / d;
          cy = curY + dy / 2 + (sign * h * dx) / d;
        }
      }

      const radius = Math.hypot(curX - cx, curY - cy);
      if (radius < 1e-5) {
        segments.push({
          start: startPt,
          end: endPt,
          rapid: false,
          lineIndex: currentLineIdx,
        });
        cutCount++;
        expandBounds(endPt, true);
      } else {
        const startAngle = Math.atan2(curY - cy, curX - cx);
        let endAngle = Math.atan2(nextY - cy, nextX - cx);
        let sweep = endAngle - startAngle;

        if (isCW) {
          if (sweep >= -1e-6) sweep -= Math.PI * 2;
        } else {
          if (sweep <= 1e-6) sweep += Math.PI * 2;
        }

        const arcSteps = Math.max(8, Math.min(48, Math.ceil(Math.abs(sweep) / (Math.PI / 18))));
        let prevPt = startPt;

        for (let s = 1; s <= arcSteps; s++) {
          const t = s / arcSteps;
          const angle = startAngle + sweep * t;
          const pt: Point3D =
            s === arcSteps
              ? endPt
              : {
                  x: cx + Math.cos(angle) * radius,
                  y: cy + Math.sin(angle) * radius,
                  z: curZ + (nextZ - curZ) * t,
                };
          segments.push({
            start: prevPt,
            end: pt,
            rapid: false,
            lineIndex: currentLineIdx,
          });
          cutCount++;
          expandBounds(pt, true);
          prevPt = pt;
        }
      }
    }

    curX = nextX;
    curY = nextY;
    curZ = nextZ;
  }

  if (segments.length === 0) {
    min.x = 0;
    min.y = 0;
    min.z = 0;
    max.x = 0;
    max.y = 0;
    max.z = 0;
  }

  if (cutCount === 0) {
    cutMin.x = min.x;
    cutMin.y = min.y;
    cutMin.z = min.z;
    cutMax.x = max.x;
    cutMax.y = max.y;
    cutMax.z = max.z;
  }

  return {
    segments,
    bounds: { min, max },
    cutBounds: { min: cutMin, max: cutMax },
    unit: declaredUnit,
    rapidCount,
    cutCount,
  };
}

