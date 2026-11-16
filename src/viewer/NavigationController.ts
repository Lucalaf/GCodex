import * as THREE from 'three';
import {
  MIN_VIEW_HALF_HEIGHT,
  MAX_VIEW_HALF_HEIGHT,
  NavigationCamera,
  ProjectionMode,
} from './NavigationCamera';
import { computeFit } from './ViewportFit';

export type CameraMode = 'rotate' | 'pan';
export type CameraView =
  | 'Top'
  | 'Bottom'
  | 'Front'
  | 'Back'
  | 'Left'
  | 'Right'
  | 'Home'
  | 'Free';

export interface NavigationState {
  projection: ProjectionMode;
  cameraMode: CameraMode;
  view: CameraView;
  /** True when the camera looks straight down one of the six cube faces. */
  flat: boolean;
  /** False for the six axis presets, which are always orthographic. */
  projectionLocked: boolean;
  interacting: boolean;
}

export interface ViewCubeHit {
  faceIndex: number;
}

export interface NavigationControllerOptions {
  domElement: HTMLElement;
  /** Bounding box used for fit / preset framing. */
  bounds?: () => THREE.Box3 | null;
  /** Hit test used to route pointer input to the ViewCube HUD. */
  getViewCubeHit?: (clientX: number, clientY: number) => ViewCubeHit | null;
  /** Returns the hovered ViewCube face material index, or null. */
  getViewCubeFace?: (clientX: number, clientY: number) => number | null;
  /** Generous hover zone covering the ViewCube and home button. */
  isViewCubeZone?: (clientX: number, clientY: number) => boolean;
  onViewCubeClick?: (clientX: number, clientY: number) => void;
  onViewCubeFaceHover?: (faceIndex: number | null) => void;
  onViewCubeHover?: (hovered: boolean) => void;
  onInteractionChange?: (interacting: boolean) => void;
  onChange?: (state: NavigationState) => void;
}

interface Transition {
  active: boolean;
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  distance: number;
  halfHeight: number;
}

const HOME_DIRECTION = new THREE.Vector3(0.8, -1.0, 0.85).normalize();
const HOME_CAMERA_DISTANCE = 260;

/** Orthographic engineering views; perspective is never used for these. */
const AXIS_VIEWS: CameraView[] = ['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom'];
const MIN_DISTANCE = 2;
const MAX_DISTANCE = 8000;
const ORBIT_SPEED = 0.0065;
const DOUBLE_MIDDLE_MS = 320;
const CUBE_DRAG_THRESHOLD_PX = 4;

/**
 * Fusion 360 style navigation with the gSender feature set layered on top:
 * orbit / pan / cursor-anchored zoom, projection switching, animated view
 * presets, fit-to-model, keyboard navigation and ViewCube routing.
 *
 * Mouse mapping (Fusion 360):
 *  - LMB drag                orbit (or pan in pan mode)
 *  - Shift + LMB drag        pan (or orbit in pan mode)
 *  - MMB drag                pan; Shift + MMB orbit
 *  - Double middle click     home isometric view
 *  - RMB drag                orbit; Shift + RMB pan
 *  - Wheel                   zoom anchored at the cursor
 */
export class NavigationController {
  readonly navCamera: NavigationCamera;
  readonly domElement: HTMLElement;

  private options: NavigationControllerOptions;
  private pivot = new THREE.Vector3(40, 40, 0);
  private mode: CameraMode = 'rotate';
  private projection: ProjectionMode = 'perspective';
  private view: CameraView = 'Home';
  private interacting = false;
  private keyboardEnabled = false;
  private hovered = false;

  private pointerMode: 'none' | 'pan' | 'orbit' | 'cube' = 'none';
  private lastPointerX = 0;
  private lastPointerY = 0;
  private cubeDownX = 0;
  private cubeDownY = 0;
  private cubeDragged = false;
  private lastMiddleDownTime = 0;
  private hoveredFace: number | null = null;

  private transition: Transition = {
    active: false,
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    up: new THREE.Vector3(0, 0, 1),
    distance: HOME_CAMERA_DISTANCE,
    halfHeight: 100,
  };

  /** Guard so the transition snaps exactly once when it settles. */
  private transitionSettled = true;

  constructor(options: NavigationControllerOptions) {
    this.options = options;
    this.domElement = options.domElement;

    const rect = this.domElement.getBoundingClientRect();
    this.navCamera = new NavigationCamera(
      rect.width / Math.max(1, rect.height)
    );
    this.navCamera.perspective.position.set(140, -180, 150).setLength(
      HOME_CAMERA_DISTANCE
    );
    this.navCamera.perspective.up.set(0, 0, 1);
    this.navCamera.perspective.lookAt(this.pivot);
    this.navCamera.syncShared();
    this.navCamera.setViewHalfHeight(
      this.navCamera.halfHeightFromDistance(HOME_CAMERA_DISTANCE)
    );

    this.bindEvents();
    this.emit();
  }

  // ---------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------

  /** Camera to render the scene with. */
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.navCamera.camera;
  }

  getPivot(): THREE.Vector3 {
    return this.pivot;
  }

  getState(): NavigationState {
    return {
      projection: this.projection,
      cameraMode: this.mode,
      view: this.view,
      flat: this.isAlignedToFace(),
      projectionLocked: !this.canToggleProjection(),
      interacting: this.interacting,
    };
  }

  setProjection(mode: ProjectionMode): void {
    if (mode === this.projection) return;
    this.cancelTransition();
    this.navCamera.setProjection(mode, this.pivot);
    this.projection = mode;
    this.emit();
  }

  /**
   * Perspective/orthographic only applies to the Home (isometric) and free
   * orbit views. The six axis presets are flat engineering views and must stay
   * orthographic, otherwise a face seen head-on still shows converging edges.
   */
  canToggleProjection(): boolean {
    return !AXIS_VIEWS.includes(this.view);
  }

  toggleProjection(): void {
    if (!this.canToggleProjection()) return;
    this.setProjection(
      this.projection === 'perspective' ? 'orthographic' : 'perspective'
    );
  }

  setCameraMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.emit();
  }

  setKeyboardEnabled(enabled: boolean): void {
    this.keyboardEnabled = enabled;
  }

  setBoundsProvider(provider: () => THREE.Box3 | null): void {
    this.options.bounds = provider;
  }

  setViewCubeHandlers(
    handlers: Pick<
      NavigationControllerOptions,
      | 'getViewCubeHit'
      | 'isViewCubeZone'
      | 'onViewCubeClick'
      | 'onViewCubeFaceHover'
      | 'onViewCubeHover'
    >
  ): void {
    this.options = { ...this.options, ...handlers };
  }

  resize(width: number, height: number): void {
    this.navCamera.setAspect(width / Math.max(1, height));
  }

  // ---------------------------------------------------------------------
  // Frame update
  // ---------------------------------------------------------------------

  /** Advances the animated camera transition. Call once per render frame. */
  update(): void {
    if (!this.transition.active) return;

    const active = this.navCamera.camera;
    const { position, target, up, distance, halfHeight } = this.transition;

    active.position.lerp(position, 0.22);
    this.pivot.lerp(target, 0.22);
    active.up.lerp(up, 0.22).normalize();

    if (this.projection === 'orthographic') {
      const h = THREE.MathUtils.lerp(
        this.navCamera.viewHalfHeight,
        halfHeight,
        0.22
      );
      this.navCamera.setViewHalfHeight(h);
    }

    active.lookAt(this.pivot);
    this.navCamera.syncShared();

    const settled =
      active.position.distanceTo(position) < 0.05 &&
      this.pivot.distanceTo(target) < 0.05 &&
      (this.projection !== 'perspective' ||
        Math.abs(active.position.distanceTo(this.pivot) - distance) < 0.01) &&
      (this.projection !== 'orthographic' ||
        Math.abs(this.navCamera.viewHalfHeight - halfHeight) < 0.001);

    if (settled && !this.transitionSettled) {
      active.position.copy(position);
      this.pivot.copy(target);
      active.up.copy(up);
      active.lookAt(this.pivot);
      if (this.projection === 'orthographic') {
        this.navCamera.setViewHalfHeight(halfHeight);
      }
      this.navCamera.syncShared();
      this.transition.active = false;
      this.transitionSettled = true;
      this.emit();
    } else if (!settled) {
      this.transitionSettled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Primitive navigation (shared by pointer, keyboard and toolbar input)
  // ---------------------------------------------------------------------

  orbitBy(deltaX: number, deltaY: number): void {
    this.cancelTransition();
    this.setView('Free');

    const camera = this.navCamera.camera;
    const offset = new THREE.Vector3().subVectors(camera.position, this.pivot);
    const distance = Math.max(1, offset.length());

    const yaw = -deltaX * ORBIT_SPEED;
    const pitch = -deltaY * ORBIT_SPEED;

    const worldZ = new THREE.Vector3(0, 0, 1);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(worldZ, yaw);
    offset.applyQuaternion(qYaw);
    camera.up.applyQuaternion(qYaw);

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3()
      .crossVectors(forward, camera.up)
      .normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);

    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, pitch);
    offset.applyQuaternion(qPitch);
    camera.up.applyQuaternion(qPitch);
    camera.up.set(0, 0, 1);

    // Keep the camera off the poles so the up vector never degenerates.
    const norm = offset.clone().normalize();
    if (Math.abs(norm.z) > 0.998) {
      offset.z = Math.sign(offset.z) * distance * 0.998;
      const xyLen = Math.hypot(offset.x, offset.y) || 1e-4;
      const targetXY = Math.sqrt(1 - 0.998 * 0.998) * distance;
      offset.x = (offset.x / xyLen) * targetXY;
      offset.y = (offset.y / xyLen) * targetXY;
    }

    camera.position.copy(this.pivot).add(offset);
    camera.lookAt(this.pivot);
    this.navCamera.syncShared();
    this.emit();
  }

  panBy(deltaX: number, deltaY: number): void {
    this.cancelTransition();
    this.setView('Free');

    const camera = this.navCamera.camera;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3()
      .crossVectors(forward, camera.up)
      .normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const distance = Math.max(1e-3, camera.position.distanceTo(this.pivot));
    const unitsPerPixel = this.navCamera.worldUnitsPerPixel(
      distance,
      this.domElement.clientHeight
    );

    const panDelta = new THREE.Vector3()
      .addScaledVector(right, -deltaX * unitsPerPixel)
      .addScaledVector(up, deltaY * unitsPerPixel);

    camera.position.add(panDelta);
    this.pivot.add(panDelta);
    camera.lookAt(this.pivot);
    this.navCamera.syncShared();
    this.emit();
  }

  panUp(): void {
    this.panBy(0, 1 * this.panStep());
  }

  panDown(): void {
    this.panBy(0, -1 * this.panStep());
  }

  panLeft(): void {
    this.panBy(1 * this.panStep(), 0);
  }

  panRight(): void {
    this.panBy(-1 * this.panStep(), 0);
  }

  private panStep(): number {
    return Math.max(6, this.domElement.clientHeight / 45);
  }

  zoomIn(delta = 0.1): void {
    this.zoomByFactor(1 / (1 + delta * 1.2), null);
  }

  zoomOut(delta = 0.1): void {
    this.zoomByFactor(1 + delta * 1.2, null);
  }

  /** Wheel zoom anchored at the cursor. */
  zoomAtCursor(clientX: number, clientY: number, deltaY: number): void {
    const rect = this.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;

    const camera = this.navCamera.camera;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      forward,
      this.pivot
    );
    const anchor = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, anchor)) {
      anchor.copy(this.pivot);
    }

    const factor = Math.pow(1.0012, deltaY);
    this.zoomByFactor(factor, anchor);
  }

  private zoomByFactor(factor: number, anchor: THREE.Vector3 | null): void {
    this.cancelTransition();
    this.setView('Free');

    const camera = this.navCamera.camera;
    const anchorPoint = anchor ?? this.pivot;

    const currentDistance = camera.position.distanceTo(this.pivot);
    if (
      this.projection === 'perspective' &&
      ((currentDistance <= MIN_DISTANCE && factor < 1) ||
        (currentDistance >= MAX_DISTANCE && factor > 1))
    ) {
      return;
    }

    if (this.projection === 'orthographic') {
      const halfHeight = this.navCamera.viewHalfHeight;
      const next = THREE.MathUtils.clamp(
        halfHeight * factor,
        MIN_VIEW_HALF_HEIGHT,
        MAX_VIEW_HALF_HEIGHT
      );
      if (next === halfHeight) return;
      this.navCamera.setViewHalfHeight(next);

      // Orthographic zoom only changes the frustum. Shift the orbit pivot so
      // the point under the cursor stays fixed on screen.
      this.pivot.sub(anchorPoint).multiplyScalar(factor).add(anchorPoint);
      camera.lookAt(this.pivot);
      this.navCamera.syncShared();
      this.emit();
      return;
    }

    camera.position.sub(anchorPoint).multiplyScalar(factor).add(anchorPoint);
    this.pivot.sub(anchorPoint).multiplyScalar(factor).add(anchorPoint);
    camera.lookAt(this.pivot);
    this.navCamera.syncShared();
    this.emit();
  }

  // ---------------------------------------------------------------------
  // View presets and fit
  // ---------------------------------------------------------------------

  zoomFit(): void {
    const bounds = this.options.bounds?.();
    if (!bounds || bounds.isEmpty()) {
      this.animateTo(this.pivot.clone(), this.currentDirection());
      return;
    }

    const direction = this.currentDirection();
    const fit = computeFit(this.navCamera, bounds, direction);
    this.animateTo(fit.target, direction, {
      distance: fit.distance,
      halfHeight: fit.halfHeight,
    });
    this.setView('Free');
  }

  lookAtCenter(): void {
    const bounds = this.options.bounds?.();
    const center = bounds && !bounds.isEmpty()
      ? bounds.getCenter(new THREE.Vector3())
      : new THREE.Vector3(0, 0, 0);
    this.animateTo(center, this.currentDirection());
  }

  snapToView(view: Exclude<CameraView, 'Free'>): void {
    const bounds = this.options.bounds?.();
    const center =
      bounds && !bounds.isEmpty()
        ? bounds.getCenter(new THREE.Vector3())
        : this.pivot.clone();

    let direction: THREE.Vector3;
    let up: THREE.Vector3;
    switch (view) {
      case 'Top':
        direction = new THREE.Vector3(0, 0, 1);
        up = new THREE.Vector3(0, 1, 0);
        break;
      case 'Bottom':
        direction = new THREE.Vector3(0, 0, -1);
        up = new THREE.Vector3(0, -1, 0);
        break;
      case 'Front':
        direction = new THREE.Vector3(0, -1, 0);
        up = new THREE.Vector3(0, 0, 1);
        break;
      case 'Back':
        direction = new THREE.Vector3(0, 1, 0);
        up = new THREE.Vector3(0, 0, 1);
        break;
      case 'Left':
        direction = new THREE.Vector3(-1, 0, 0);
        up = new THREE.Vector3(0, 0, 1);
        break;
      case 'Right':
        direction = new THREE.Vector3(1, 0, 0);
        up = new THREE.Vector3(0, 0, 1);
        break;
      case 'Home':
      default:
        direction = HOME_DIRECTION.clone();
        up = new THREE.Vector3(0, 0, 1);
        break;
    }

    // Flat axis views are orthographic by definition; only Home keeps the
    // user's perspective/orthographic choice.
    if (AXIS_VIEWS.includes(view)) {
      this.setProjection('orthographic');
    }

    const fit =
      bounds && !bounds.isEmpty()
        ? computeFit(this.navCamera, bounds, direction)
        : null;
    const distance = fit ? fit.distance : HOME_CAMERA_DISTANCE;
    const halfHeight = fit
      ? fit.halfHeight
      : this.navCamera.halfHeightFromDistance(HOME_CAMERA_DISTANCE);

    this.animateTo(center, direction, { distance, halfHeight, up });
    this.setView(view);
  }

  /** Snaps to an arbitrary cube face / edge / corner direction. */
  snapToDirection(
    direction: THREE.Vector3,
    options: {
      up?: THREE.Vector3;
      target?: THREE.Vector3;
      distance?: number;
      halfHeight?: number;
      instant?: boolean;
    } = {}
  ): void {
    const dir = direction.clone().normalize();
    const target = options.target?.clone() ?? this.fitTarget();
    const fit = this.options.bounds?.();

    let distance = options.distance;
    let halfHeight = options.halfHeight;
    if (distance === undefined || halfHeight === undefined) {
      const computed =
        fit && !fit.isEmpty()
          ? computeFit(this.navCamera, fit, dir)
          : null;
      distance = distance ?? computed?.distance ?? HOME_CAMERA_DISTANCE;
      halfHeight =
        halfHeight ??
        computed?.halfHeight ??
        this.navCamera.halfHeightFromDistance(HOME_CAMERA_DISTANCE);
    }

    const isPureAxis =
      (Math.abs(Math.abs(dir.x) - 1) < 1e-4 &&
        Math.abs(dir.y) < 1e-4 &&
        Math.abs(dir.z) < 1e-4) ||
      (Math.abs(Math.abs(dir.y) - 1) < 1e-4 &&
        Math.abs(dir.x) < 1e-4 &&
        Math.abs(dir.z) < 1e-4) ||
      (Math.abs(Math.abs(dir.z) - 1) < 1e-4 &&
        Math.abs(dir.x) < 1e-4 &&
        Math.abs(dir.y) < 1e-4);

    if (isPureAxis) {
      if (Math.abs(Math.abs(dir.x) - 1) < 1e-4) {
        dir.set(Math.sign(dir.x), 0, 0);
      } else if (Math.abs(Math.abs(dir.y) - 1) < 1e-4) {
        dir.set(0, Math.sign(dir.y), 0);
      } else {
        dir.set(0, 0, Math.sign(dir.z));
      }
      // Clicking a ViewCube face is a flat engineering view: use orthographic
      // so the face is rendered without perspective convergence.
      this.setProjection('orthographic');
    }

    const up = options.up?.clone().normalize() ?? defaultUpFor(dir);
    this.animateTo(target, dir, { distance, halfHeight, up, instant: options.instant });
    this.setView(viewNameForDirection(dir));
  }

  /** Orbit 90 degrees onto the adjacent orthogonal face (flat-face arrows). */
  stepAdjacentFace(direction: 'top' | 'bottom' | 'left' | 'right'): void {
    const camera = this.navCamera.camera;
    const camDir = new THREE.Vector3()
      .subVectors(camera.position, this.pivot)
      .normalize();
    const forward = camDir.clone().negate();
    const right = new THREE.Vector3()
      .crossVectors(forward, camera.up)
      .normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const curNormal = snapCardinal(camDir);
    const screenUp = snapCardinal(up);
    const screenRight = snapCardinal(right);

    let nextNormal: THREE.Vector3;
    let nextUp: THREE.Vector3;
    if (direction === 'top') {
      nextNormal = screenUp.clone();
      nextUp = curNormal.clone().negate();
    } else if (direction === 'bottom') {
      nextNormal = screenUp.clone().negate();
      nextUp = curNormal.clone();
    } else if (direction === 'right') {
      nextNormal = screenRight.clone();
      nextUp = screenUp.clone();
    } else {
      nextNormal = screenRight.clone().negate();
      nextUp = screenUp.clone();
    }

    if (Math.abs(nextNormal.z) < 0.5) {
      nextUp.set(0, 0, 1);
    }

    this.snapToDirection(nextNormal, { up: nextUp, target: this.pivot.clone() });
  }

  /** True when the view direction is (near) orthogonal to a cube face. */
  isAlignedToFace(threshold = 0.985): boolean {
    const dir = this.currentDirection();
    return (
      Math.max(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)) > threshold
    );
  }

  /** Direction from the pivot toward the camera (cube orientation source). */
  currentDirection(): THREE.Vector3 {
    return new THREE.Vector3()
      .subVectors(this.navCamera.camera.position, this.pivot)
      .normalize();
  }

  // ---------------------------------------------------------------------
  // Keyboard navigation (enabled by preference, active while hovered)
  // ---------------------------------------------------------------------

  handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.keyboardEnabled || !this.hovered) return;
    if (isEditableTarget(event.target)) return;

    const rotateStep = 0.1;
    const zoomStep = 0.1;

    switch (event.key) {
      case 'ArrowLeft':
        if (event.shiftKey) this.panLeft();
        else this.orbitBy(rotateStep / ORBIT_SPEED, 0);
        break;
      case 'ArrowRight':
        if (event.shiftKey) this.panRight();
        else this.orbitBy(-rotateStep / ORBIT_SPEED, 0);
        break;
      case 'ArrowUp':
        if (event.shiftKey) this.panUp();
        else this.orbitBy(0, rotateStep / ORBIT_SPEED);
        break;
      case 'ArrowDown':
        if (event.shiftKey) this.panDown();
        else this.orbitBy(0, -rotateStep / ORBIT_SPEED);
        break;
      case '+':
      case '=':
        this.zoomIn(zoomStep);
        break;
      case '-':
      case '_':
        this.zoomOut(zoomStep);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // ---------------------------------------------------------------------
  // Pointer input
  // ---------------------------------------------------------------------

  private onPointerDown = (event: PointerEvent): void => {
    this.domElement.setPointerCapture(event.pointerId);
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;

    // ViewCube takes priority over viewport navigation.
    if (
      event.button === 0 &&
      this.options.getViewCubeHit?.(event.clientX, event.clientY)
    ) {
      event.preventDefault();
      this.pointerMode = 'cube';
      this.cubeDownX = event.clientX;
      this.cubeDownY = event.clientY;
      this.cubeDragged = false;
      return;
    }

    if (event.button === 1) {
      event.preventDefault();
      const now = performance.now();
      if (!event.shiftKey && now - this.lastMiddleDownTime < DOUBLE_MIDDLE_MS) {
        this.lastMiddleDownTime = 0;
        this.pointerMode = 'none';
        this.snapToView('Home');
        return;
      }
      this.lastMiddleDownTime = now;
      this.pointerMode = event.shiftKey ? 'orbit' : 'pan';
    } else if (event.button === 2) {
      event.preventDefault();
      this.pointerMode = event.shiftKey ? 'pan' : 'orbit';
    } else if (event.button === 0) {
      const primaryOrbit = this.mode === 'rotate';
      this.pointerMode = event.shiftKey
        ? primaryOrbit
          ? 'pan'
          : 'orbit'
        : primaryOrbit
          ? 'orbit'
          : 'pan';
    }

    if (this.pointerMode !== 'none') {
      this.cancelTransition();
      this.setInteracting(true);
      this.updateCursor();
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    const overCube = this.options.isViewCubeZone?.(event.clientX, event.clientY);
    if (overCube !== undefined) {
      this.options.onViewCubeHover?.(overCube);
    }

    if (this.pointerMode === 'none') {
      const hit = this.options.getViewCubeFace?.(event.clientX, event.clientY);
      const faceIndex = hit ?? null;
      if (faceIndex !== this.hoveredFace) {
        this.hoveredFace = faceIndex;
        this.options.onViewCubeFaceHover?.(faceIndex);
      }
      this.updateCursor();
      return;
    }

    const dx = event.clientX - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;

    if (this.pointerMode === 'cube') {
      if (
        Math.hypot(
          event.clientX - this.cubeDownX,
          event.clientY - this.cubeDownY
        ) > CUBE_DRAG_THRESHOLD_PX
      ) {
        this.cubeDragged = true;
      }
      if (this.cubeDragged) this.orbitBy(dx, dy);
      return;
    }

    // Middle button pressed mid-drag (or released) re-evaluates the mode.
    if ((event.buttons & 4) !== 0) {
      this.pointerMode = event.shiftKey ? 'orbit' : 'pan';
    }

    if (this.pointerMode === 'pan') {
      this.panBy(dx, dy);
    } else if (this.pointerMode === 'orbit') {
      this.orbitBy(dx, dy);
    }
    this.updateCursor();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.domElement.hasPointerCapture(event.pointerId)) {
      this.domElement.releasePointerCapture(event.pointerId);
    }

    if (this.pointerMode === 'cube' && !this.cubeDragged) {
      this.options.onViewCubeClick?.(event.clientX, event.clientY);
    }

    this.pointerMode = 'none';
    this.setInteracting(false);
    this.updateCursor();
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (event.shiftKey) {
      // Shift + wheel pans vertically, matching gSender's wheel modifiers.
      this.panBy(event.deltaY, 0);
      return;
    }
    this.zoomAtCursor(event.clientX, event.clientY, event.deltaY);
  };

  private onPointerEnter = (): void => {
    this.hovered = true;
  };

  private onPointerLeave = (): void => {
    this.hovered = false;
    this.options.onViewCubeHover?.(false);
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private bindEvents(): void {
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointermove', this.onPointerMove);
    this.domElement.addEventListener('pointerup', this.onPointerUp);
    this.domElement.addEventListener('pointercancel', this.onPointerUp);
    this.domElement.addEventListener('pointerenter', this.onPointerEnter);
    this.domElement.addEventListener('pointerleave', this.onPointerLeave);
    this.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.domElement.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.handleKeyDown);
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('pointercancel', this.onPointerUp);
    this.domElement.removeEventListener('pointerenter', this.onPointerEnter);
    this.domElement.removeEventListener('pointerleave', this.onPointerLeave);
    this.domElement.removeEventListener('wheel', this.onWheel);
    this.domElement.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.handleKeyDown);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private fitTarget(): THREE.Vector3 {
    const bounds = this.options.bounds?.();
    if (!bounds || bounds.isEmpty()) return this.pivot.clone();
    return bounds.getCenter(new THREE.Vector3());
  }

  private animateTo(
    target: THREE.Vector3,
    direction: THREE.Vector3,
    options: {
      distance?: number;
      halfHeight?: number;
      up?: THREE.Vector3;
      instant?: boolean;
    } = {}
  ): void {
    const camera = this.navCamera.camera;
    const dir = direction.clone().normalize();
    const distance =
      options.distance ??
      (this.projection === 'perspective'
        ? Math.max(MIN_DISTANCE, camera.position.distanceTo(this.pivot))
        : this.navCamera.distanceFromHalfHeight(
            this.navCamera.viewHalfHeight
          ));
    const halfHeight =
      options.halfHeight ??
      this.navCamera.halfHeightFromDistance(distance);

    this.transition.position.copy(target).addScaledVector(dir, distance);
    this.transition.target.copy(target);
    this.transition.up.copy(options.up ?? new THREE.Vector3(0, 0, 1));
    this.transition.distance = distance;
    this.transition.halfHeight = halfHeight;
    this.transition.active = true;
    this.transitionSettled = false;

    if (options.instant) {
      camera.position.copy(this.transition.position);
      camera.up.copy(this.transition.up);
      this.pivot.copy(target);
      camera.lookAt(this.pivot);
      this.navCamera.setViewHalfHeight(halfHeight);
      this.navCamera.syncShared();
      this.transition.active = false;
      this.transitionSettled = true;
      this.emit();
    }
  }

  private cancelTransition(): void {
    this.transition.active = false;
    this.transitionSettled = true;
  }

  private setView(view: CameraView): void {
    if (this.view === view) return;
    this.view = view;
    this.emit();
  }

  private setInteracting(interacting: boolean): void {
    if (this.interacting === interacting) return;
    this.interacting = interacting;
    this.options.onInteractionChange?.(interacting);
    this.emit();
  }

  private updateCursor(): void {
    if (this.pointerMode === 'pan') {
      this.domElement.style.cursor = 'move';
    } else if (this.pointerMode === 'orbit' || this.pointerMode === 'cube') {
      this.domElement.style.cursor = 'grabbing';
    } else if (this.hoveredFace !== null) {
      this.domElement.style.cursor = 'pointer';
    } else {
      this.domElement.style.cursor = 'grab';
    }
  }

  private lastEmittedKey = '';

  private emit(): void {
    const state = this.getState();
    // Pan / orbit emit on every pointer move; skip React updates unless the
    // observable state actually changed.
    const key = `${state.projection}|${state.cameraMode}|${state.view}|${state.flat}|${state.projectionLocked}|${state.interacting}`;
    if (key === this.lastEmittedKey) return;
    this.lastEmittedKey = key;
    this.options.onChange?.(state);
  }
}

function snapCardinal(v: THREE.Vector3): THREE.Vector3 {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(v.x), 0, 0);
  if (ay >= ax && ay >= az) return new THREE.Vector3(0, Math.sign(v.y), 0);
  return new THREE.Vector3(0, 0, Math.sign(v.z));
}

function defaultUpFor(direction: THREE.Vector3): THREE.Vector3 {
  const isPureX =
    Math.abs(Math.abs(direction.x) - 1) < 1e-4 &&
    Math.abs(direction.y) < 1e-4 &&
    Math.abs(direction.z) < 1e-4;
  const isPureY =
    Math.abs(Math.abs(direction.y) - 1) < 1e-4 &&
    Math.abs(direction.x) < 1e-4 &&
    Math.abs(direction.z) < 1e-4;
  const isPureZ =
    Math.abs(Math.abs(direction.z) - 1) < 1e-4 &&
    Math.abs(direction.x) < 1e-4 &&
    Math.abs(direction.y) < 1e-4;

  if (isPureZ) {
    return new THREE.Vector3(0, direction.z > 0 ? 1 : -1, 0);
  }
  void isPureX;
  void isPureY;
  return new THREE.Vector3(0, 0, 1);
}

function viewNameForDirection(direction: THREE.Vector3): CameraView {
  const eps = 1e-4;
  if (Math.abs(direction.z - 1) < eps) return 'Top';
  if (Math.abs(direction.z + 1) < eps) return 'Bottom';
  if (Math.abs(direction.y + 1) < eps) return 'Front';
  if (Math.abs(direction.y - 1) < eps) return 'Back';
  if (Math.abs(direction.x + 1) < eps) return 'Left';
  if (Math.abs(direction.x - 1) < eps) return 'Right';
  if (direction.distanceTo(HOME_DIRECTION) < 0.01) return 'Home';
  return 'Free';
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}
