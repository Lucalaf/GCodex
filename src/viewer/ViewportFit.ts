import * as THREE from 'three';
import { NavigationCamera } from './NavigationCamera';

export interface FitResult {
  target: THREE.Vector3;
  /** Distance from target for a perspective fit. */
  distance: number;
  /** Half height of the visible world for an orthographic fit. */
  halfHeight: number;
  /** Bounding radius, useful for clamping animations. */
  radius: number;
}

const DEFAULT_MARGIN = 1.25;

/**
 * Frames a bounding box as seen from `direction`.
 *
 * Fitting the bounding sphere leaves flat parts tiny in profile views, so the
 * eight corners are projected onto the screen axes instead. For perspective,
 * the required distance is solved per corner (a corner closer to the eye
 * magnifies more), which is the exact condition for "everything visible".
 */
export function computeFit(
  camera: NavigationCamera,
  bounds: THREE.Box3,
  direction: THREE.Vector3,
  margin: number = DEFAULT_MARGIN
): FitResult {
  const target = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(0.5, size.length() / 2);
  const aspect = Math.max(0.1, camera.aspect);

  const dir = direction.clone().normalize();
  const forward = dir.clone().negate();
  const right = new THREE.Vector3()
    .crossVectors(forward, new THREE.Vector3(0, 0, 1))
    .normalize();
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tanH = tanV * aspect;

  let halfWidth = 0;
  let halfHeight = 0;
  let distance = 0;
  const corner = new THREE.Vector3();
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        corner.set(x, y, z).sub(target);
        const sx = Math.abs(corner.dot(right));
        const sy = Math.abs(corner.dot(up));
        // Positive when the corner sits on the camera side of the centre.
        const sd = corner.dot(dir);
        halfWidth = Math.max(halfWidth, sx);
        halfHeight = Math.max(halfHeight, sy);
        // Eye must be far enough back that this corner still fits both axes.
        distance = Math.max(
          distance,
          sd + sx / tanH,
          sd + sy / tanV
        );
      }
    }
  }

  distance = Math.max(1e-3, distance * margin);

  // Orthographic framing uses the raw projected extents; the "distance" is
  // irrelevant there beyond keeping the eye outside the model.
  const viewHalfHeight = Math.max(halfHeight, halfWidth / (aspect || 1)) * margin;

  return { target, distance, halfHeight: viewHalfHeight, radius };
}

/** Applies a computed fit to the camera along the given direction. */
export function applyFit(
  camera: NavigationCamera,
  fit: FitResult,
  direction: THREE.Vector3,
  up?: THREE.Vector3
): void {
  const cameraObject = camera.camera;
  if (up) cameraObject.up.copy(up);
  cameraObject.position
    .copy(fit.target)
    .addScaledVector(direction.clone().normalize(), fit.distance);
  cameraObject.lookAt(fit.target);
  if (camera.projection === 'orthographic') {
    camera.setViewHalfHeight(fit.halfHeight);
  }
  camera.syncShared();
}
