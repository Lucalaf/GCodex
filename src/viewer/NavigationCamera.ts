import * as THREE from 'three';

export type ProjectionMode = 'perspective' | 'orthographic';

export const MIN_VIEW_HALF_HEIGHT = 0.05;
export const MAX_VIEW_HALF_HEIGHT = 6000;

const NEAR = 0.1;
const FAR = 20000;
const ORTHO_NEAR = -20000;
const ORTHO_FAR = 40000;

/**
 * Combined perspective / orthographic camera, modelled after gSender's
 * CombinedCamera. Both cameras always share the same position, quaternion and
 * up vector; only the projection frustum differs.
 *
 * Switching projections preserves the apparent size of the model:
 *  - perspective -> orthographic: halfHeight = distance * tan(fov / 2)
 *  - orthographic -> perspective: camera distance = halfHeight / tan(fov / 2)
 */
export class NavigationCamera {
  readonly perspective: THREE.PerspectiveCamera;
  readonly orthographic: THREE.OrthographicCamera;

  private mode: ProjectionMode = 'perspective';
  private viewHalfHeightValue = 100;
  private aspectValue: number;

  constructor(aspect = 1, fov = 45) {
    this.aspectValue = Math.max(1e-3, aspect);
    this.perspective = new THREE.PerspectiveCamera(
      fov,
      this.aspectValue,
      NEAR,
      FAR
    );
    this.orthographic = new THREE.OrthographicCamera(
      -100,
      100,
      100,
      -100,
      ORTHO_NEAR,
      ORTHO_FAR
    );
    this.applyOrthoFrustum();
    this.perspective.updateProjectionMatrix();
  }

  get projection(): ProjectionMode {
    return this.mode;
  }

  /** The camera instance that is currently active and should be rendered with. */
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.mode === 'perspective' ? this.perspective : this.orthographic;
  }

  get fov(): number {
    return this.perspective.fov;
  }

  get aspect(): number {
    return this.aspectValue;
  }

  get viewHalfHeight(): number {
    return this.viewHalfHeightValue;
  }

  setAspect(aspect: number): void {
    this.aspectValue = Math.max(1e-3, aspect);
    this.perspective.aspect = this.aspectValue;
    this.perspective.updateProjectionMatrix();
    this.applyOrthoFrustum();
  }

  /** Mirrors position / orientation from the active camera onto the other one. */
  syncShared(): void {
    const from = this.camera;
    const to =
      from === this.perspective ? this.orthographic : this.perspective;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);
    from.updateMatrixWorld();
    to.updateMatrixWorld();
  }

  setViewHalfHeight(halfHeight: number): void {
    this.viewHalfHeightValue = THREE.MathUtils.clamp(
      halfHeight,
      MIN_VIEW_HALF_HEIGHT,
      MAX_VIEW_HALF_HEIGHT
    );
    this.applyOrthoFrustum();
  }

  /** Converts the perspective distance to the equivalent orthographic half-height. */
  halfHeightFromDistance(distance: number): number {
    return (
      distance *
      Math.tan(THREE.MathUtils.degToRad(this.perspective.fov) / 2)
    );
  }

  /** Distance at which a perspective camera shows the given half height. */
  distanceFromHalfHeight(halfHeight: number): number {
    return halfHeight / Math.tan(THREE.MathUtils.degToRad(this.perspective.fov) / 2);
  }

  /**
   * World units covered by one CSS pixel at the given distance from the pivot.
   * Used for pixel-accurate panning in both projections.
   */
  worldUnitsPerPixel(distanceToPivot: number, viewportHeightPx: number): number {
    const height = Math.max(1, viewportHeightPx);
    if (this.mode === 'orthographic') {
      return (2 * this.viewHalfHeightValue) / height;
    }
    const halfFov = THREE.MathUtils.degToRad(this.perspective.fov) / 2;
    return (2 * Math.max(1e-4, distanceToPivot) * Math.tan(halfFov)) / height;
  }

  /**
   * Switches projection while keeping the view centred on `pivot` and the model
   * at the same apparent scale.
   */
  setProjection(mode: ProjectionMode, pivot: THREE.Vector3): void {
    if (mode === this.mode) return;

    const from = this.camera;
    const offset = new THREE.Vector3().subVectors(from.position, pivot);
    const distance = Math.max(1e-4, offset.length());
    const direction = offset.clone().normalize();

    this.mode = mode;
    const to = this.camera;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);

    if (mode === 'orthographic') {
      this.setViewHalfHeight(this.halfHeightFromDistance(distance));
    } else {
      const targetDistance = this.distanceFromHalfHeight(
        this.viewHalfHeightValue
      );
      to.position.copy(pivot).addScaledVector(direction, targetDistance);
      to.lookAt(pivot);
    }

    this.syncShared();
    this.updateProjectionMatrix();
  }

  updateProjectionMatrix(): void {
    this.perspective.aspect = this.aspectValue;
    this.perspective.updateProjectionMatrix();
    this.applyOrthoFrustum();
  }

  updateMatrixWorld(): void {
    this.camera.updateMatrixWorld();
  }

  private applyOrthoFrustum(): void {
    const halfHeight = this.viewHalfHeightValue;
    const halfWidth = halfHeight * this.aspectValue;
    this.orthographic.left = -halfWidth;
    this.orthographic.right = halfWidth;
    this.orthographic.top = halfHeight;
    this.orthographic.bottom = -halfHeight;
    this.orthographic.updateProjectionMatrix();
  }
}
