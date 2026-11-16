import { useState, useEffect, useRef, CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { parseGcodeToolpath, ParsedToolpath } from './gcodeParser';
import ToolpathVisualizer from './ToolpathVisualizer';

interface DetectedPort {
  name: string;
  description: string;
  is_usb: boolean;
}

interface Coordinates {
  x: number;
  y: number;
  z: number;
  a: number | null;
}

/**
 * Self-updater payloads. These mirror the `Serialize` structs in
 * `src-tauri/src/updater.rs`; field names are snake_case to match, because
 * Tauri passes the JSON through untouched.
 */
interface UpdateInfo {
  version: string;
  title: string;
  notes: string;
  html_url: string;
  /** Direct URL of the `.rpm` asset; null when the release ships none. */
  rpm_url: string | null;
  rpm_size: number | null;
}

interface UpdateProgress {
  stage: string; // "downloading" | "installing" | "done" | "error"
  percent: number; // 0-100; -1 when the stage has no measurable fraction
  message: string;
}

interface UpdateCheckResult {
  current_version: string;
  update: UpdateInfo | null;
}

interface InstallOutcome {
  installed: boolean;
  message: string;
}

interface MachineStatus {
  state: string;
  substate: number | null;
  mpos: Coordinates;
  wpos: Coordinates;
  wco: Coordinates;
  feed_rate: number;
  spindle_speed: number;
  ov_feed: number;
  ov_rapid: number;
  ov_spindle: number;
  pins: string;
  buffer_planner: number | null;
  buffer_rx: number | null;
}

interface JobProgress {
  file_name: string;
  state: string; // "Idle" | "Loaded" | "Running" | "Paused" | "Completed" | "Aborted"
  total_lines: number;
  sent_lines: number;
  acked_lines: number;
  rx_bytes_used: number;
  rx_bytes_max: number;
  elapsed_ms: number;
  last_error: string | null;
}

/**
 * Result of a single Grbl probe cycle.
 *
 * Grbl reports the trigger point in *machine* coordinates (`MPos`), so the
 * work-coordinate position is derived as `prb - wco` where needed.
 */
interface ProbeOutcome {
  ok: boolean;
  /** Machine-coordinate contact point, when the cycle reported one. */
  machine?: Coordinates;
  /** Why the cycle failed; shown to the operator. */
  reason?: string;
}

const DEFAULT_STATUS: MachineStatus = {
  state: 'Disconnected',
  substate: null,
  mpos: { x: 0, y: 0, z: 0, a: null },
  wpos: { x: 0, y: 0, z: 0, a: null },
  wco: { x: 0, y: 0, z: 0, a: null },
  feed_rate: 0,
  spindle_speed: 0,
  ov_feed: 100,
  ov_rapid: 100,
  ov_spindle: 100,
  pins: '',
  buffer_planner: null,
  buffer_rx: null,
};

const DEFAULT_JOB: JobProgress = {
  file_name: '',
  state: 'Idle',
  total_lines: 0,
  sent_lines: 0,
  acked_lines: 0,
  rx_bytes_used: 0,
  rx_bytes_max: 127,
  elapsed_ms: 0,
  last_error: null,
};

const STEP_PRESETS = [0.1, 1, 10, 50];
const GAMEPAD_DEADZONE = 0.22;

// Default flex split of the left dock: DRO / Probing / Jog Control.
// The DRO needs roughly a third of the dock to show its three axis rows plus
// the machine-control grid without scrolling; probing fits in slightly less;
// the jog pad takes the remainder.
const DEFAULT_DRO_RATIO = 0.36;
const DEFAULT_PROBE_RATIO = 0.28;

const DEMO_GCODE = `; GCodex Demo Toolpath (Spiral Pocket + Outer Contour + Helical Bore)
G21 G90 G17
G0 Z10.000
G0 X0.000 Y0.000
M3 S12000
; Outer rounded rectangle contour
G0 X10.000 Y5.000
G1 Z-2.000 F400
G1 X70.000 Y5.000 F1200
G3 X75.000 Y10.000 I0.000 J5.000
G1 X75.000 Y50.000
G3 X70.000 Y55.000 I-5.000 J0.000
G1 X10.000 Y55.000
G3 X5.000 Y50.000 I0.000 J-5.000
G1 X5.000 Y10.000
G3 X10.000 Y5.000 I5.000 J0.000
; Second pass at Z-4mm
G1 Z-4.000 F400
G1 X70.000 Y5.000 F1200
G3 X75.000 Y10.000 I0.000 J5.000
G1 X75.000 Y50.000
G3 X70.000 Y55.000 I-5.000 J0.000
G1 X10.000 Y55.000
G3 X5.000 Y50.000 I0.000 J-5.000
G1 X5.000 Y10.000
G3 X10.000 Y5.000 I5.000 J0.000
G0 Z8.000
; Center helical circular pocket
G0 X40.000 Y18.000
G1 Z0.000 F500
G2 X40.000 Y42.000 I0.000 J12.000 Z-1.500 F900
G2 X40.000 Y18.000 I0.000 J-12.000 Z-3.000
G2 X40.000 Y42.000 I0.000 J12.000 Z-4.500
G2 X40.000 Y18.000 I0.000 J-12.000 Z-4.500
G2 X40.000 Y42.000 I0.000 J12.000
G0 Z12.000
M5
G0 X0.000 Y0.000
M30
`;

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Parses a Grbl probe report: `[PRB:12.345,20.678,-1.000:1]`.
 *
 * Grbl emits this automatically after a probe cycle on builds with
 * `MESSAGE_PROBE_COORDINATES` (enabled by default), and also in the `$#`
 * parameter dump. The coordinates are machine position, and the trailing
 * flag is 1 when the cycle succeeded.
 *
 * Returns null for anything that is not a probe report.
 */
function parseProbeReport(line: string): ProbeOutcome | null {
  const match = /^\[PRB:([^:\]]+):([01])\]$/.exec(line.trim());
  if (!match) return null;

  const success = match[2] === '1';
  const nums = match[1]
    .split(',')
    .map((s) => Number.parseFloat(s.trim()));

  // A failed cycle still reports a position on some builds; only trust the
  // coordinates when the success flag is set.
  if (!success || nums.length < 3 || nums.some((n) => !Number.isFinite(n))) {
    return { ok: false, reason: 'Probe cycle reported no contact.' };
  }

  return {
    ok: true,
    machine: { x: nums[0], y: nums[1], z: nums[2], a: null },
  };
}

/** True when the controller reports the probe pin as triggered (`Pn:P`). */
function probePinTriggered(pins: string): boolean {
  return pins.toUpperCase().includes('P');
}

export default function App() {
  const [ports, setPorts] = useState<DetectedPort[]>([]);
  const [selectedPort, setSelectedPort] = useState<string>('');
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isVirtual, setIsVirtual] = useState<boolean>(false);
  const [status, setStatus] = useState<MachineStatus>(DEFAULT_STATUS);
  const [job, setJob] = useState<JobProgress>(DEFAULT_JOB);
  const [toolpath, setToolpath] = useState<ParsedToolpath | null>(null);
  const [consoleLog, setConsoleLog] = useState<string[]>([]);
  const [cmdInput, setCmdInput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Jogging state & modes
  const [jogMode, setJogMode] = useState<'step' | 'continuous'>('step');
  const [xyStep, setXyStep] = useState<number>(10);
  const [zStep, setZStep] = useState<number>(1);
  const [jogFeed, setJogFeed] = useState<number>(1500);
  const [activeJogVector, setActiveJogVector] = useState<{ dx: number; dy: number; dz: number } | null>(null);
  const [gamepadName, setGamepadName] = useState<string | null>(null);
  const [gamepadJogEnabled, setGamepadJogEnabled] = useState<boolean>(false);

  const consoleEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Refs for low-latency continuous jogging & keyboard/gamepad loops
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const pointerVectorRef = useRef<{ dx: number; dy: number; dz: number } | null>(null);
  const continuousTimerRef = useRef<number | null>(null);
  const wasContinuousActiveRef = useRef<boolean>(false);
  const prevGpButtonsRef = useRef<boolean[]>([]);
  const gpStickPrevDirRef = useRef<{ dx: number; dy: number; dz: number }>({ dx: 0, dy: 0, dz: 0 });

  // Live machine state for multi-step motion sequences (see handleHome).
  // Status arrives at 5 Hz on real hardware, so sequences must read the ref
  // rather than a value captured when the handler was created.
  const statusRef = useRef<MachineStatus>(DEFAULT_STATUS);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const homingRef = useRef<boolean>(false);
  const [isHoming, setIsHoming] = useState<boolean>(false);

  // ---------------------------------------------------------------------
  // Touch-plate probing
  // ---------------------------------------------------------------------
  // A flat plate of known thickness T is laid on the stock. The tool is
  // driven down slowly until it touches the plate, and the work origin is
  // then set to T at the contact point — i.e. the plate's top face is where
  // the probe triggered, and the stock surface sits T below it.
  const [probePlateThickness, setProbePlateThickness] = useState<number>(10);
  const [probeFeed, setProbeFeed] = useState<number>(100);
  const [probeMaxTravel, setProbeMaxTravel] = useState<number>(25);
  const [probeRetract, setProbeRetract] = useState<number>(5);
  const [isProbing, setIsProbing] = useState<boolean>(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const probeBusyRef = useRef<boolean>(false);
  // Resolver for the in-flight probe cycle, settled by the serial-line
  // listener when a `[PRB:]` frame or a probe ALARM arrives.
  const probeWaiterRef = useRef<((res: ProbeOutcome) => void) | null>(null);

  // DaVinci Resolve-style Resizable Dock Layout State
  const [leftDockWidth, setLeftDockWidth] = useState<number>(365);
  const [droRatio, setDroRatio] = useState<number>(DEFAULT_DRO_RATIO);
  const [probeRatio, setProbeRatio] = useState<number>(DEFAULT_PROBE_RATIO);
  const [viewportRatio, setViewportRatio] = useState<number>(0.64);
  const [bottomLeftRatio, setBottomLeftRatio] = useState<number>(0.48);
  // Collapsing the top bars lets the 3D viewport grow to the very top of the
  // window. The viewport toolbar always stays visible so the toggle (and the
  // connection controls it hosts) can never be collapsed away.
  const [topBarsCollapsed, setTopBarsCollapsed] = useState<boolean>(false);
  const [activeSplitter, setActiveSplitter] = useState<string | null>(null);
  const [hoveredSplitter, setHoveredSplitter] = useState<string | null>(null);

  // --- Self-updater -------------------------------------------------------
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState<boolean>(false);
  const [updateDismissed, setUpdateDismissed] = useState<boolean>(false);
  const [updateInstalled, setUpdateInstalled] = useState<boolean>(false);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const leftDockRef = useRef<HTMLDivElement>(null);
  const rightDockRef = useRef<HTMLDivElement>(null);
  const bottomDockRef = useRef<HTMLDivElement>(null);

  const startSplitterDrag = (
    splitterId: 'main-col' | 'left-row' | 'left-probe-row' | 'right-row' | 'bottom-col',
    e: React.PointerEvent
  ) => {
    e.preventDefault();
    setActiveSplitter(splitterId);
    const cursor = splitterId === 'main-col' || splitterId === 'bottom-col' ? 'col-resize' : 'row-resize';
    document.body.style.cursor = cursor;
    document.body.style.userSelect = 'none';

    const onPointerMove = (moveEv: PointerEvent) => {
      if (splitterId === 'main-col' && workspaceRef.current) {
        const rect = workspaceRef.current.getBoundingClientRect();
        const newW = Math.max(270, Math.min(rect.width - 420, moveEv.clientX - rect.left));
        setLeftDockWidth(newW);
      } else if (splitterId === 'left-row' && leftDockRef.current) {
        const rect = leftDockRef.current.getBoundingClientRect();
        const ratio = (moveEv.clientY - rect.top) / Math.max(1, rect.height);
        setDroRatio(Math.max(0.2, Math.min(0.75, ratio)));
      } else if (splitterId === 'left-probe-row' && leftDockRef.current) {
        // Lower bound of the probe pane keeps its header, readout and action
        // button on screen; upper bound leaves the DRO usable above it.
        const rect = leftDockRef.current.getBoundingClientRect();
        const ratio = (moveEv.clientY - rect.top) / Math.max(1, rect.height);
        setProbeRatio(Math.max(0.2, Math.min(0.8, ratio)));
      } else if (splitterId === 'right-row' && rightDockRef.current) {
        const rect = rightDockRef.current.getBoundingClientRect();
        const ratio = (moveEv.clientY - rect.top) / Math.max(1, rect.height);
        setViewportRatio(Math.max(0.22, Math.min(1, ratio)));
      } else if (splitterId === 'bottom-col' && bottomDockRef.current) {
        const rect = bottomDockRef.current.getBoundingClientRect();
        const ratio = (moveEv.clientX - rect.left) / Math.max(1, rect.width);
        setBottomLeftRatio(Math.max(0.25, Math.min(0.75, ratio)));
      }
    };

    const onPointerUp = () => {
      setActiveSplitter(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const isJobRunning = job.state === 'Running';

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [consoleLog]);

  useEffect(() => {
    let unlistenLine: (() => void) | undefined;
    let unlistenDisc: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenJob: (() => void) | undefined;
    let unlistenUpdate: (() => void) | undefined;
    let unlistenUpdateProgress: (() => void) | undefined;

    const setupListeners = async () => {
      unlistenLine = await listen<string>('serial-line', (event) => {
        setConsoleLog((prev) => [...prev.slice(-199), event.payload]);

        // Settle an in-flight probe as soon as Grbl reports the trigger point
        // or rejects the cycle. ALARM:4/5 (probe faults) arrive on this same
        // channel and would otherwise leave the sequence waiting for a PRB
        // frame that never comes.
        const waiter = probeWaiterRef.current;
        if (waiter) {
          const report = parseProbeReport(event.payload);
          if (report) {
            probeWaiterRef.current = null;
            waiter(report);
          } else if (/^ALARM:[45]\b/.test(event.payload.trim())) {
            probeWaiterRef.current = null;
            waiter({
              ok: false,
              reason:
                event.payload.trim() === 'ALARM:4'
                  ? 'Probe was already triggered before the cycle started. Check the clip is not shorted to the tool.'
                  : 'Probe did not contact within the maximum travel.',
            });
          }
        }
      });

      unlistenStatus = await listen<MachineStatus>('machine-status', (event) => {
        setStatus(event.payload);
      });

      unlistenJob = await listen<JobProgress>('job-progress', (event) => {
        setJob(event.payload);
      });

      unlistenDisc = await listen('serial-disconnected', () => {
        setIsConnected(false);
        setIsVirtual(false);
        setStatus(DEFAULT_STATUS);
        setConsoleLog((prev) => [...prev, '[DISCONNECTED] Controller connection closed']);
      });

      // The Rust updater runs its GitHub check on a background thread at
      // startup and pushes the result here, so the window opens instantly
      // whether or not the machine is online.
      unlistenUpdate = await listen<UpdateInfo>('update-available', (event) => {
        setUpdateInfo(event.payload);
        setUpdateDismissed(false);
        setUpdateError(null);
      });

      unlistenUpdateProgress = await listen<UpdateProgress>('update-progress', (event) => {
        const p = event.payload;
        setUpdateProgress(p);
        if (p.stage === 'error') {
          setUpdateError(p.message);
          setIsInstallingUpdate(false);
        } else if (p.stage === 'done') {
          setIsInstallingUpdate(false);
        }
      });

      // Read the app's own version so the modal can show "current -> new".
      try {
        setAppVersion(await invoke<string>('get_app_version'));
      } catch {
        // Cosmetic only; never block startup on it.
      }
    };

    setupListeners();
    scanPorts();

    return () => {
      if (unlistenLine) unlistenLine();
      if (unlistenStatus) unlistenStatus();
      if (unlistenJob) unlistenJob();
      if (unlistenDisc) unlistenDisc();
      if (unlistenUpdate) unlistenUpdate();
      if (unlistenUpdateProgress) unlistenUpdateProgress();
    };
  }, []);

  const handleInstallUpdate = async () => {
    if (!updateInfo?.rpm_url) {
      setUpdateError('This release does not include an RPM package.');
      return;
    }
    setUpdateError(null);
    setIsInstallingUpdate(true);
    setUpdateProgress({ stage: 'downloading', percent: 0, message: 'Starting download…' });
    try {
      const outcome = await invoke<InstallOutcome>('install_update', {
        rpmUrl: updateInfo.rpm_url,
        rpmSize: updateInfo.rpm_size,
      });
      if (!outcome.installed) {
        setUpdateError(outcome.message);
      }
      setUpdateInstalled(outcome.installed);
    } catch (err) {
      setUpdateError(String(err));
    } finally {
      setIsInstallingUpdate(false);
    }
  };

  // Ask the backend to re-check by hand (the version badge in the modal).
  const handleCheckForUpdates = async () => {
    setUpdateError(null);
    try {
      const result = await invoke<UpdateCheckResult>('check_for_update_command');
      setAppVersion(result.current_version);
      if (result.update) {
        setUpdateInfo(result.update);
        setUpdateDismissed(false);
      } else {
        setUpdateProgress({
          stage: 'done',
          percent: 100,
          message: `You are up to date (v${result.current_version}).`,
        });
      }
    } catch (err) {
      setUpdateError(String(err));
    }
  };

  const scanPorts = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const availablePorts = await invoke<DetectedPort[]>('list_serial_ports');
      setPorts(availablePorts);
      if (availablePorts.length > 0 && !selectedPort) {
        setSelectedPort(availablePorts[0].name);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleConnection = async () => {
    setError(null);
    if (isConnected) {
      try {
        await invoke('disconnect_serial');
        setIsConnected(false);
        setIsVirtual(false);
        setStatus(DEFAULT_STATUS);
      } catch (err) {
        setError(String(err));
      }
    } else {
      if (!selectedPort) return;
      try {
        await invoke('connect_serial', {
          portName: selectedPort,
          baudRate: 115200,
        });
        setIsConnected(true);
        setIsVirtual(false);
        setConsoleLog((prev) => [...prev, `[CONNECTED] Opened ${selectedPort} at 115200 baud`]);
      } catch (err) {
        setError(String(err));
      }
    }
  };

  const handleToggleVirtualCnc = async () => {
    setError(null);
    if (isConnected && isVirtual) {
      try {
        await invoke('disconnect_serial');
        setIsConnected(false);
        setIsVirtual(false);
        setStatus(DEFAULT_STATUS);
      } catch (err) {
        setError(String(err));
      }
    } else {
      try {
        if (isConnected) {
          await invoke('disconnect_serial');
        }
        await invoke('connect_virtual');
        setIsConnected(true);
        setIsVirtual(true);
        setConsoleLog((prev) => [
          ...prev,
          '[SIMULATION] Connected to built-in Grbl 1.1h Simulator',
        ]);
      } catch (err) {
        setError(String(err));
      }
    }
  };

  const sendGcodeCommand = async (cmd: string, silent = false) => {
    if (!isConnected) return;
    try {
      await invoke('send_serial_command', { command: cmd });
      if (!silent) {
        setConsoleLog((prev) => [...prev.slice(-199), `> ${cmd}`]);
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const sendRealtimeByte = async (byte: number, label?: string) => {
    if (!isConnected) return;
    try {
      await invoke('send_realtime_byte', { byte });
      if (label) {
        setConsoleLog((prev) => [...prev.slice(-199), `> [RT] ${label}`]);
      }
    } catch (err) {
      setError(String(err));
    }
  };

  // Sends a single discrete step jog command
  const sendStepJog = (dx: number, dy: number, dz: number, customFeed?: number) => {
    if (!isConnected || isJobRunning) return;
    const parts: string[] = [];
    if (dx !== 0) parts.push(`X${(dx * xyStep).toFixed(3)}`);
    if (dy !== 0) parts.push(`Y${(dy * xyStep).toFixed(3)}`);
    if (dz !== 0) parts.push(`Z${(dz * zStep).toFixed(3)}`);
    if (parts.length === 0) return;

    const feed = Math.max(10, Math.round(customFeed ?? jogFeed));
    const jogCmd = `$J=G21G91 ${parts.join(' ')} F${feed}`;
    sendGcodeCommand(jogCmd);
  };

  // Sends a short lookahead slice for smooth continuous hold-to-jog motion
  const sendContinuousSlice = (dx: number, dy: number, dz: number, feedMultiplier = 1.0) => {
    if (!isConnected || isJobRunning) return;
    const effectiveFeed = Math.max(25, Math.round(jogFeed * feedMultiplier));
    // Calculate distance covered in ~85ms at effectiveFeed (in mm/sec * 0.085s)
    const distMm = Math.max(0.2, (effectiveFeed / 60) * 0.085);
    const mag = Math.hypot(dx, dy, dz) || 1;

    const parts: string[] = [];
    if (Math.abs(dx) > 0.01) parts.push(`X${((dx / mag) * distMm).toFixed(3)}`);
    if (Math.abs(dy) > 0.01) parts.push(`Y${((dy / mag) * distMm).toFixed(3)}`);
    if (Math.abs(dz) > 0.01) parts.push(`Z${((dz / mag) * distMm).toFixed(3)}`);
    if (parts.length === 0) return;

    const jogCmd = `$J=G21G91 ${parts.join(' ')} F${effectiveFeed}`;
    sendGcodeCommand(jogCmd, true);
  };

  const stopContinuousJog = () => {
    if (continuousTimerRef.current !== null) {
      window.clearInterval(continuousTimerRef.current);
      continuousTimerRef.current = null;
    }
    wasContinuousActiveRef.current = false;
    setActiveJogVector(null);
    if (isConnected) {
      sendRealtimeByte(0x85); // Immediate Grbl Jog Cancel (0x85)
    }
  };

  const startOrUpdateContinuousJog = (dx: number, dy: number, dz: number, feedMultiplier = 1.0) => {
    if (!isConnected || isJobRunning) return;
    if (dx === 0 && dy === 0 && dz === 0) {
      stopContinuousJog();
      return;
    }

    wasContinuousActiveRef.current = true;
    setActiveJogVector({ dx: Math.sign(dx), dy: Math.sign(dy), dz: Math.sign(dz) });

    if (continuousTimerRef.current === null) {
      // Fire initial slice immediately, then replenish every 65ms while held
      sendContinuousSlice(dx, dy, dz, feedMultiplier);
      continuousTimerRef.current = window.setInterval(() => {
        const ptr = pointerVectorRef.current;
        if (ptr) {
          sendContinuousSlice(ptr.dx, ptr.dy, ptr.dz, 1.0);
          return;
        }
        // Compute combined vector from currently held keys
        const keys = pressedKeysRef.current;
        let kDx = 0;
        let kDy = 0;
        let kDz = 0;
        if (keys.has('ArrowLeft')) kDx -= 1;
        if (keys.has('ArrowRight')) kDx += 1;
        if (keys.has('ArrowUp')) kDy += 1;
        if (keys.has('ArrowDown')) kDy -= 1;
        if (keys.has('PageUp')) kDz += 1;
        if (keys.has('PageDown')) kDz -= 1;

        if (kDx !== 0 || kDy !== 0 || kDz !== 0) {
          sendContinuousSlice(kDx, kDy, kDz, 1.0);
        } else {
          stopContinuousJog();
        }
      }, 65);
    }
  };

  // Pointer handlers for UI Jog Pad buttons (supports both Step and Continuous Hold-to-Jog)
  const handleJogPadPointerDown = (dx: number, dy: number, dz: number) => {
    if (!isConnected || isJobRunning) return;
    if (jogMode === 'step') {
      setActiveJogVector({ dx, dy, dz });
      sendStepJog(dx, dy, dz);
      setTimeout(() => setActiveJogVector(null), 150);
    } else {
      pointerVectorRef.current = { dx, dy, dz };
      startOrUpdateContinuousJog(dx, dy, dz, 1.0);
    }
  };

  const handleJogPadPointerUp = () => {
    if (pointerVectorRef.current !== null) {
      pointerVectorRef.current = null;
      stopContinuousJog();
    }
  };

  // Global Keyboard Shortcuts & Hold-to-Jog Listener
  useEffect(() => {
    const isInputFocused = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const computeKeyVector = () => {
      const keys = pressedKeysRef.current;
      let dx = 0;
      let dy = 0;
      let dz = 0;
      if (keys.has('ArrowLeft')) dx -= 1;
      if (keys.has('ArrowRight')) dx += 1;
      if (keys.has('ArrowUp')) dy += 1;
      if (keys.has('ArrowDown')) dy -= 1;
      if (keys.has('PageUp')) dz += 1;
      if (keys.has('PageDown')) dz -= 1;
      return { dx, dy, dz };
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isInputFocused(e.target)) return;

      // The 3D viewport claims arrow / +/- keys for navigation when its
      // "Keys" toggle is on and the pointer is over the canvas. It calls
      // preventDefault, which lets us skip the jog bindings here.
      if (e.defaultPrevented) return;

      // Global emergency / machine shortcuts
      if (e.code === 'Escape') {
        e.preventDefault();
        pressedKeysRef.current.clear();
        pointerVectorRef.current = null;
        stopContinuousJog();
        sendRealtimeByte(0x85, 'Jog Cancel (Esc)');
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        sendRealtimeByte(0x21, 'Feed Hold (Space)');
        return;
      }

      // Step size quick presets: 1, 2, 3, 4
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === '1') { setXyStep(0.1); return; }
        if (e.key === '2') { setXyStep(1); return; }
        if (e.key === '3') { setXyStep(10); return; }
        if (e.key === '4') { setXyStep(50); return; }
        if (e.key.toLowerCase() === 'j') {
          setJogMode((prev) => (prev === 'step' ? 'continuous' : 'step'));
          return;
        }
      }

      // Keyboard jogging is always available; typing in inputs is excluded
      // above, and the viewport can claim the arrows by calling preventDefault.
      if (!isConnected || isJobRunning) return;

      const jogKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'];
      if (!jogKeys.includes(e.code)) return;

      e.preventDefault();
      // Ignore OS key-repeat events; we manage our own timing
      if (e.repeat) return;

      pressedKeysRef.current.add(e.code);
      const { dx, dy, dz } = computeKeyVector();

      // Holding Shift temporarily forces Continuous Hold-to-Jog even in Step mode
      const useContinuous = jogMode === 'continuous' || e.shiftKey;
      if (useContinuous) {
        startOrUpdateContinuousJog(dx, dy, dz, 1.0);
      } else {
        setActiveJogVector({ dx, dy, dz });
        sendStepJog(dx, dy, dz);
        setTimeout(() => setActiveJogVector(null), 140);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const jogKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'];
      if (!jogKeys.includes(e.code)) return;

      pressedKeysRef.current.delete(e.code);
      const { dx, dy, dz } = computeKeyVector();

      if (dx === 0 && dy === 0 && dz === 0) {
        stopContinuousJog();
      } else if (wasContinuousActiveRef.current) {
        setActiveJogVector({ dx, dy, dz });
      }
    };

    const onWindowBlur = () => {
      pressedKeysRef.current.clear();
      pointerVectorRef.current = null;
      stopContinuousJog();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [isConnected, isJobRunning, jogMode, xyStep, zStep, jogFeed]);

  // HTML5 Gamepad Polling Loop (Left Stick = XY, Right Stick Y = Z, D-Pad = Step Jog, B/R1 = Stop)
  useEffect(() => {
    const onGpConnect = (e: GamepadEvent) => setGamepadName(e.gamepad.id);
    const onGpDisconnect = () => {
      setGamepadName(null);
      stopContinuousJog();
    };

    window.addEventListener('gamepadconnected', onGpConnect);
    window.addEventListener('gamepaddisconnected', onGpDisconnect);

    let gpInterval = window.setInterval(() => {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = gamepads.find((g) => g && g.connected) || null;
      if (!gp) {
        if (gamepadName !== null) setGamepadName(null);
        return;
      }
      if (gamepadName !== gp.id) {
        setGamepadName(gp.id);
      }

      if (!gamepadJogEnabled || !isConnected || isJobRunning) return;

      const btns = gp.buttons.map((b) => b.pressed);
      const prevBtns = prevGpButtonsRef.current;

      // Button 1 (B / Circle) or Button 5 (RB): Immediate Jog Cancel
      if ((btns[1] && !prevBtns[1]) || (btns[5] && !prevBtns[5])) {
        stopContinuousJog();
        sendRealtimeByte(0x85, 'Gamepad Jog Cancel');
      }

      // D-Pad discrete step jogging on button press edge (12=Up, 13=Down, 14=Left, 15=Right)
      if (btns[12] && !prevBtns[12]) sendStepJog(0, 1, 0);
      if (btns[13] && !prevBtns[13]) sendStepJog(0, -1, 0);
      if (btns[14] && !prevBtns[14]) sendStepJog(-1, 0, 0);
      if (btns[15] && !prevBtns[15]) sendStepJog(1, 0, 0);

      // Left Bumper (LB = 4): Z- step, Right Trigger (RT = 7) / Left Trigger (LT = 6)
      prevGpButtonsRef.current = btns;

      // In Step Mode, the sticks perform incremental step moves per stick deflection edge
      if (jogMode === 'step') {
        const rawX = gp.axes[0] ?? 0;
        const rawY = gp.axes[1] ?? 0;
        const rawZAxis = gp.axes.length > 3 ? (gp.axes[3] ?? 0) : 0;

        const dirX = Math.abs(rawX) > GAMEPAD_DEADZONE ? Math.sign(rawX) : 0;
        const dirY = Math.abs(rawY) > GAMEPAD_DEADZONE ? -Math.sign(rawY) : 0;
        const dirZ = Math.abs(rawZAxis) > GAMEPAD_DEADZONE ? -Math.sign(rawZAxis) : 0;

        // Track stick deflection to trigger only once per push (edge-triggered)
        const prevDir = gpStickPrevDirRef.current;
        if (dirX !== 0 && prevDir.dx === 0) sendStepJog(dirX, 0, 0);
        if (dirY !== 0 && prevDir.dy === 0) sendStepJog(0, dirY, 0);
        if (dirZ !== 0 && prevDir.dz === 0) sendStepJog(0, 0, dirZ);

        gpStickPrevDirRef.current = { dx: dirX, dy: dirY, dz: dirZ };
        return;
      }

      // Reset stick prev dir in continuous jog mode
      gpStickPrevDirRef.current = { dx: 0, dy: 0, dz: 0 };

      // In Jog (Continuous) Mode: Analog sticks for proportional continuous jogging
      // Axis 0: Left Stick X (-left / +right)
      // Axis 1: Left Stick Y (-up / +down)
      const rawX = gp.axes[0] ?? 0;
      const rawY = gp.axes[1] ?? 0;
      const cncX = Math.abs(rawX) > GAMEPAD_DEADZONE ? rawX : 0;
      const cncY = Math.abs(rawY) > GAMEPAD_DEADZONE ? -rawY : 0;

      // Right Stick Y for Z:
      const rawZAxis = gp.axes.length > 3 ? (gp.axes[3] ?? 0) : 0;
      const cncZ = Math.abs(rawZAxis) > GAMEPAD_DEADZONE ? -rawZAxis : 0;

      if (cncX !== 0 || cncY !== 0 || cncZ !== 0) {
        const deflection = Math.min(1.0, Math.hypot(cncX, cncY, cncZ));
        wasContinuousActiveRef.current = true;
        setActiveJogVector({
          dx: Math.sign(cncX),
          dy: Math.sign(cncY),
          dz: Math.sign(cncZ),
        });
        sendContinuousSlice(cncX, cncY, cncZ, deflection);
      } else if (
        wasContinuousActiveRef.current &&
        pressedKeysRef.current.size === 0 &&
        pointerVectorRef.current === null
      ) {
        stopContinuousJog();
      }
    }, 75);

    return () => {
      window.removeEventListener('gamepadconnected', onGpConnect);
      window.removeEventListener('gamepaddisconnected', onGpDisconnect);
      window.clearInterval(gpInterval);
    };
  }, [gamepadJogEnabled, isConnected, isJobRunning, gamepadName, jogMode, xyStep, zStep, jogFeed]);

  const handleSendCommand = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!cmdInput.trim() || !isConnected) return;
    const trimmed = cmdInput.trim();
    setCmdInput('');
    await sendGcodeCommand(trimmed);
  };

  const loadGcodeIntoApp = async (fileName: string, content: string) => {
    setError(null);
    try {
      const parsed = parseGcodeToolpath(content);
      setToolpath(parsed);

      const loaded = await invoke<JobProgress>('load_gcode_job', {
        fileName,
        content,
      });
      setJob(loaded);
      setConsoleLog((prev) => [
        ...prev.slice(-199),
        `[FILE] Loaded "${loaded.file_name}" (${loaded.total_lines} lines, ${parsed.segments.length} 3D segments)`,
      ]);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      await loadGcodeIntoApp(file.name, content);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleLoadDemo = async () => {
    await loadGcodeIntoApp('demo_pocket_contour.nc', DEMO_GCODE);
  };

  const handleStartJob = async () => {
    setError(null);
    try {
      const res = await invoke<JobProgress>('start_gcode_job');
      setJob(res);
      setConsoleLog((prev) => [...prev.slice(-199), `[JOB] Streaming "${res.file_name}"...`]);
    } catch (err) {
      setError(String(err));
    }
  };

  const handlePauseJob = async () => {
    setError(null);
    try {
      const res = await invoke<JobProgress>('pause_gcode_job');
      setJob(res);
      setConsoleLog((prev) => [...prev.slice(-199), '[JOB] Paused (Feed Hold sent)']);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleStopJob = async () => {
    setError(null);
    try {
      const res = await invoke<JobProgress>('stop_gcode_job');
      setJob(res);
      setConsoleLog((prev) => [...prev.slice(-199), '[JOB] Aborted & buffers flushed']);
    } catch (err) {
      setError(String(err));
    }
  };

  // Sets the work origin for one axis at the tool's current position. This
  // only redefines coordinates — the axis does not physically move.
  const setAxisZero = (axis: 'X' | 'Y' | 'Z') => {
    if (isJobRunning) return;
    sendGcodeCommand(`G10 L20 P1 ${axis}0`);
  };

  // Retracts Z to the highest Z height in the loaded .nc file (or safe clearance height) before moving to X0 Y0
  const safeClearanceZ =
    toolpath && toolpath.segments.length > 0 && Number.isFinite(toolpath.bounds.max.z)
      ? Math.max(toolpath.bounds.max.z, status.wpos.z, 5.0)
      : Math.max(status.wpos.z, 10.0);

  const handleGoXY0 = async () => {
    if (!isConnected || isJobRunning) return;
    const zStr = safeClearanceZ.toFixed(3);
    await sendGcodeCommand(`G21 G90 G0 Z${zStr}`);
    await sendGcodeCommand('G90 G0 X0 Y0');
  };

  /**
   * Rapids Z to the work origin at the current XY. Unlike Go XY0 this is a
   * deliberate plunge into the workpiece, so it does not retract first — the
   * tool goes straight to Z0 and the operator is expected to have clearance.
   */
  const handleGoZ0 = async () => {
    if (!isConnected || isJobRunning) return;
    await sendGcodeCommand('G21 G90 G0 Z0');
  };

  // ---------------------------------------------------------------------
  // Safe homing sequence
  // ---------------------------------------------------------------------
  // A grbl `$H` moves every axis to its own limit switch, and on many machines
  // Z homes downward or the axes move in an interleaved order. That means the
  // tool can drag through the work piece or the fixture on the way home.
  //
  // This sequence guarantees Z is clear before any XY travel:
  //   1. Raise Z to the retraction height (work coordinates, absolute mm).
  //   2. Wait for Z to actually reach that height and the machine to go idle.
  //   3. Only then run the homing cycle.
  //
  // G90/G21 are re-asserted so the retract is absolute millimetres regardless
  // of whatever modal state (G91 incremental, G20 inches) the last job left
  // behind. The height itself is the same `safeClearanceZ` the Go XY0 button
  // uses, so both paths retract to a consistent height.
  const RETRACT_TIMEOUT_MS = 60_000;

  /**
   * Resolves true once the machine reports Idle *and* Z is at (or above) the
   * requested height. Checking position as well as state avoids the race where
   * status still reads Idle for a moment after the move is queued.
   */
  const waitForRetract = (
    targetZ: number,
    timeoutMs: number
  ): Promise<boolean> =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      const tolerance = 0.25;
      const tick = () => {
        const s = statusRef.current;
        const stateName = (s.state ?? '').toUpperCase();
        const idle = stateName === 'IDLE' || stateName === '';
        const atHeight =
          Number.isFinite(s.wpos.z) && s.wpos.z >= targetZ - tolerance;
        if (idle && atHeight) return resolve(true);
        if (Date.now() - startedAt > timeoutMs) return resolve(false);
        window.setTimeout(tick, 100);
      };
      // Give the controller a moment to leave Idle before the first sample.
      window.setTimeout(tick, 250);
    });

  const handleHome = async () => {
    if (!isConnected || isJobRunning || homingRef.current) return;

    homingRef.current = true;
    setIsHoming(true);
    setError(null);

    try {
      // 1. Retract Z to the configured clearance height.
      const retractZ = safeClearanceZ.toFixed(3);
      setConsoleLog((prev) => [
        ...prev.slice(-199),
        `[SAFETY] Retracting Z to ${retractZ} mm before homing...`,
      ]);
      await sendGcodeCommand(`G21 G90 G0 Z${retractZ}`);

      // 2. Wait for the retract to physically finish.
      const retracted = await waitForRetract(safeClearanceZ, RETRACT_TIMEOUT_MS);
      if (!retracted) {
        setError(
          'Homing aborted: machine did not reach the Z retraction height in time. Clear the tool path and press Home again.'
        );
        return;
      }

      // 3. Z is clear — now it is safe to home all axes.
      setConsoleLog((prev) => [
        ...prev.slice(-199),
        '[SAFETY] Z clear — starting homing cycle ($H).',
      ]);
      await sendGcodeCommand('$H');
    } catch (err) {
      setError(String(err));
    } finally {
      homingRef.current = false;
      setIsHoming(false);
    }
  };

  // ---------------------------------------------------------------------
  // Touch-plate Z probe
  // ---------------------------------------------------------------------
  // Drives a single G38.2 probe toward -Z until the plate is contacted, then
  // sets the work origin so the tool reads plate thickness T at the contact
  // point. Because the trigger is the plate's *top* face and the stock
  // surface is T below it:
  //     tool must read  Z = T  at the trigger
  //     G10 L20 P1 Z{T}  →  WCO_z = MPos_z − T
  // After this, Z0 sits exactly on the stock surface.
  //
  // The tool path is retracted clear first and the whole sequence aborts on
  // any fault, so a failed probe never leaves the machine buried in the part.
  const PROBE_TIMEOUT_MS = 60_000;

  /** Resolves when Grbl reports the probe trigger, or fails after `timeoutMs`. */
  const waitForProbeReport = (timeoutMs: number): Promise<ProbeOutcome> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: ProbeOutcome) => {
        if (settled) return;
        settled = true;
        probeWaiterRef.current = null;
        resolve(outcome);
      };

      probeWaiterRef.current = finish;
      window.setTimeout(
        () =>
          finish({
            ok: false,
            reason: 'Timed out waiting for the probe report. The controller may not be reporting probe coordinates.',
          }),
        timeoutMs
      );
    });

  /** Waits until the machine reports Idle, so the probe starts from rest. */
  const waitForIdle = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      const tick = () => {
        const stateName = (statusRef.current.state ?? '').toUpperCase();
        if (stateName === 'IDLE' || stateName === '') return resolve(true);
        if (Date.now() - startedAt > timeoutMs) return resolve(false);
        window.setTimeout(tick, 100);
      };
      tick();
    });

  const handleProbeZ = async () => {
    if (!isConnected || isVirtual || isJobRunning || probeBusyRef.current) return;

    // A probe only means something if the clip is wired to the probe input;
    // without the pin the cycle would drive the tool into the plate blind.
    if (probePinTriggered(status.pins)) {
      setError(
        'Probe input already triggered — the plate is shorted to the tool. Clear the contact and try again.'
      );
      return;
    }

    if (!Number.isFinite(probePlateThickness) || probePlateThickness <= 0) {
      setError('Enter the touch plate thickness before probing.');
      return;
    }

    probeBusyRef.current = true;
    setIsProbing(true);
    setProbeResult(null);
    setError(null);

    let report: ProbeOutcome | null = null;

    try {
      // 1. Retract to the same clearance height the Home and Go XY0 paths use.
      const retractZ = safeClearanceZ.toFixed(3);
      setConsoleLog((prev) => [
        ...prev.slice(-199),
        `[PROBE] Retracting Z to ${retractZ} mm before probing...`,
      ]);
      await sendGcodeCommand(`G21 G90 G0 Z${retractZ}`);

      if (!(await waitForIdle(PROBE_TIMEOUT_MS))) {
        setError('Probe aborted: machine did not settle to Idle after the retract.');
        return;
      }

      // 2. Slow probe toward -Z. G38.2 is the erroring variant, so a missed
      //    contact raises ALARM:5 instead of running on silently.
      const travel = probeMaxTravel.toFixed(3);
      setConsoleLog((prev) => [
        ...prev.slice(-199),
        `[PROBE] Contacting plate (G38.2 Z-${travel})...`,
      ]);

      const reportPromise = waitForProbeReport(PROBE_TIMEOUT_MS);
      await sendGcodeCommand(
        `G21 G91 G38.2 Z-${travel} F${Math.max(10, Math.round(probeFeed))}`
      );
      report = await reportPromise;

      if (!report.ok || !report.machine) {
        setError(`Probe failed: ${report.reason ?? 'no contact reported.'}`);
        return;
      }

      // 3. Lift off the plate before redefining the origin, so the tool is not
      //    resting on the plate while coordinates are rebased.
      const lift = Math.max(0.5, probeRetract);
      await sendGcodeCommand(`G21 G91 G0 Z${lift.toFixed(3)}`);
      await waitForIdle(PROBE_TIMEOUT_MS);

      // 4. Set the work origin. Restore absolute mode first — the probe and
      //    lift above ran in G91, and leaving the parser incremental would
      //    corrupt the next job.
      const thickness = probePlateThickness.toFixed(3);
      await sendGcodeCommand('G21 G90');
      await sendGcodeCommand(`G10 L20 P1 Z${thickness}`);

      const contactWorkZ = report.machine.z - statusRef.current.wco.z;
      setProbeResult(
        `Contact at MPos Z ${report.machine.z.toFixed(3)} (work Z ${contactWorkZ.toFixed(3)}); ` +
          `plate ${thickness} mm → Z0 set on the stock surface.`
      );
      setConsoleLog((prev) => [
        ...prev.slice(-199),
        `[PROBE] Zeroed Z at plate contact (thickness ${thickness} mm).`,
      ]);
    } catch (err) {
      setError(String(err));
    } finally {
      probeWaiterRef.current = null;
      probeBusyRef.current = false;
      setIsProbing(false);
    }
  };

  const getStateBadgeStyle = (stateName: string): CSSProperties => {
    const upper = stateName.toUpperCase();
    if (upper === 'IDLE') return { background: '#065f46', color: '#34d399', borderColor: '#059669' };
    if (upper === 'RUN' || upper === 'JOG') return { background: '#1e3a8a', color: '#60a5fa', borderColor: '#2563eb' };
    if (upper === 'HOLD' || upper === 'DOOR') return { background: '#78350f', color: '#fbbf24', borderColor: '#d97706' };
    if (upper === 'ALARM') return { background: '#7f1d1d', color: '#fca5a5', borderColor: '#dc2626' };
    if (upper === 'HOME' || upper === 'CHECK') return { background: '#4c1d95', color: '#c4b5fd', borderColor: '#7c3aed' };
    return { background: '#1e293b', color: '#94a3b8', borderColor: '#475569' };
  };

  const isDirActive = (dx: number, dy: number, dz: number) =>
    activeJogVector !== null &&
    activeJogVector.dx === dx &&
    activeJogVector.dy === dy &&
    activeJogVector.dz === dz;

  const completionPct =
    job.total_lines > 0 ? Math.min(100, (job.acked_lines / job.total_lines) * 100) : 0;
  const rxFillPct = Math.min(100, (job.rx_bytes_used / job.rx_bytes_max) * 100);

  /**
   * Machine connection cluster (port selector, Refresh, Connect, Sim) rendered
   * in the 3D viewport's own header. Kept here because it owns all the Tauri
   * IPC state; the viewport just renders it in its toolbar.
   */
  const connectionControls = (
    <div style={styles.viewportHeaderActions}>
      <select
        style={styles.viewportPortSelect}
        value={selectedPort}
        onChange={(e) => setSelectedPort(e.target.value)}
        disabled={isConnected || ports.length === 0}
        title="Hardware serial port"
      >
        {ports.length === 0 ? (
          <option value="">No serial ports detected</option>
        ) : (
          ports.map((port) => (
            <option key={port.name} value={port.name}>
              {port.name} — {port.description} {port.is_usb ? '(USB)' : ''}
            </option>
          ))
        )}
      </select>

      <button
        onClick={scanPorts}
        disabled={isConnected || isLoading}
        style={{
          ...styles.buttonSecondary,
          height: '26px',
          width: '68px',
          opacity: isConnected || isLoading ? 0.5 : 1,
          cursor: isConnected || isLoading ? 'not-allowed' : 'pointer',
        }}
        title="Rescan for hardware serial ports"
      >
        {isLoading ? '...' : '↻ Refresh'}
      </button>

      <button
        disabled={(!selectedPort && !isConnected) || isVirtual}
        style={{
          ...styles.buttonAction,
          height: '26px',
          width: '92px',
          backgroundColor: isConnected && !isVirtual ? '#dc2626' : '#334155',
          borderColor: isConnected && !isVirtual ? '#ef4444' : '#475569',
          color: isVirtual ? '#64748b' : '#ffffff',
          opacity: (!selectedPort && !isConnected) || isVirtual ? 0.5 : 1,
          cursor: (!selectedPort && !isConnected) || isVirtual ? 'not-allowed' : 'pointer',
        }}
        onClick={handleToggleConnection}
        title={
          isVirtual
            ? 'Hardware connection unavailable while the simulator is active — turn Sim off first'
            : isConnected
              ? 'Close the serial connection'
              : 'Open the selected hardware serial port'
        }
      >
        {isConnected && !isVirtual ? 'Disconnect' : 'Connect'}
      </button>

      <button
        disabled={isConnected && !isVirtual}
        style={{
          ...(isConnected && isVirtual ? styles.toggleChipActive : styles.toggleChipOff),
          width: '88px',
          opacity: isConnected && !isVirtual ? 0.5 : 1,
          cursor: isConnected && !isVirtual ? 'not-allowed' : 'pointer',
        }}
        onClick={handleToggleVirtualCnc}
        title={
          isConnected && !isVirtual
            ? 'Simulator unavailable while a hardware port is connected — disconnect first'
            : 'Toggle built-in Grbl 1.1h Simulation mode'
        }
      >
        {isConnected && isVirtual ? 'Sim: ON' : 'Sim: OFF'}
      </button>

      <button
        onClick={() => setTopBarsCollapsed((v) => !v)}
        style={{
          ...styles.buttonSecondary,
          height: '26px',
          width: '30px',
          padding: 0,
          fontSize: '13px',
        }}
        title={
          topBarsCollapsed
            ? 'Show the title bar and machine control strip'
            : 'Hide the title bar and machine control strip to give the 3D viewport the full window height'
        }
        aria-label={topBarsCollapsed ? 'Show top bars' : 'Hide top bars'}
      >
        {topBarsCollapsed ? '▾' : '▴'}
      </button>
    </div>
  );

  const getSplitterStyle = (id: string, isVertical: boolean): CSSProperties => {
    const isHot = activeSplitter === id || hoveredSplitter === id;
    return isVertical
      ? {
          width: '8px',
          flexShrink: 0,
          cursor: 'col-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isHot ? 'rgba(56, 189, 248, 0.14)' : 'transparent',
          transition: 'background-color 0.12s ease',
          zIndex: 15,
          userSelect: 'none',
        }
      : {
          height: '8px',
          flexShrink: 0,
          cursor: 'row-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isHot ? 'rgba(56, 189, 248, 0.14)' : 'transparent',
          transition: 'background-color 0.12s ease',
          zIndex: 15,
          userSelect: 'none',
        };
  };

  const getSplitterGripStyle = (id: string, isVertical: boolean): CSSProperties => {
    const isHot = activeSplitter === id || hoveredSplitter === id;
    return isVertical
      ? {
          width: '2px',
          height: isHot ? '46px' : '28px',
          borderRadius: '2px',
          backgroundColor: isHot ? '#38bdf8' : '#334155',
          boxShadow: isHot ? '0 0 8px rgba(56, 189, 248, 0.8)' : 'none',
          transition: 'all 0.12s ease',
        }
      : {
          height: '2px',
          width: isHot ? '46px' : '28px',
          borderRadius: '2px',
          backgroundColor: isHot ? '#38bdf8' : '#334155',
          boxShadow: isHot ? '0 0 8px rgba(56, 189, 248, 0.8)' : 'none',
          transition: 'all 0.12s ease',
        };
  };

  return (
    <div style={styles.container}>
      {/* Top Header — hidden when the top bars are collapsed */}
      {!topBarsCollapsed && (
      <>
      <header style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
          <h1 style={styles.title}>GCodex</h1>
          <button
            onClick={handleCheckForUpdates}
            style={styles.versionChip}
            title="Check GitHub for a newer release"
          >
            v{appVersion || '0.1.0'}
            {updateInfo && !updateInstalled ? ' • update available' : ''}
          </button>
          {status.state !== 'Disconnected' && (
            <span
              style={{
                ...styles.statePill,
                ...getStateBadgeStyle(status.state),
              }}
            >
              {status.state.toUpperCase()}
              {status.substate !== null ? `:${status.substate}` : ''}
            </span>
          )}
          {status.pins && (
            <span style={styles.pinBadge} title="Active Hardware Input Pins (XYZ Limits / Probe / Door)">
              PINS: {status.pins}
            </span>
          )}
        </div>
      </header>
      </>
      )}

      {error && <div style={styles.errorBanner}>{error}</div>}

      {/* DaVinci Resolve-style Resizable Docked Workspace */}
      <div ref={workspaceRef} style={styles.workspaceDock}>
        {/* Left Dock Column: DRO + Jog Controls */}
        <div
          ref={leftDockRef}
          style={{
            ...styles.leftDock,
            width: `${leftDockWidth}px`,
          }}
        >
          {/* Top-Left Pane: Digital Readout (DRO) */}
          <section
            style={{
              ...styles.dockPane,
              flex: `${droRatio} 1 0%`,
              minHeight: '150px',
            }}
          >
            <div style={styles.cardHeaderRow}>
              <h3 style={styles.sectionHeading}>DRO</h3>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  disabled={!isConnected || isJobRunning}
                  style={styles.goXy0Btn}
                  onClick={handleGoXY0}
                  title={`Retract Z to ${safeClearanceZ.toFixed(1)}mm then rapid to X0 Y0`}
                >
                  Go XY0
                </button>
                <button
                  disabled={!isConnected || isJobRunning}
                  style={styles.goXy0Btn}
                  onClick={handleGoZ0}
                  title="Rapid Z to the work origin (X and Y do not move)"
                >
                  Go Z0
                </button>
              </div>
            </div>

            <div style={styles.paneScrollBody}>
              {(['x', 'y', 'z'] as const).map((axis) => {
                const axisUpper = axis.toUpperCase() as 'X' | 'Y' | 'Z';
                const wVal = status.wpos[axis];
                const mVal = status.mpos[axis];
                const axisColors: Record<'X' | 'Y' | 'Z', string> = {
                  X: '#ef4444',
                  Y: '#22c55e',
                  Z: '#3b82f6',
                };

                return (
                  <div key={axis} style={styles.droRow}>
                    <div style={{ ...styles.axisLabel, borderLeft: `4px solid ${axisColors[axisUpper]}` }}>
                      {axisUpper}
                    </div>
                    <div style={styles.coordBox}>
                      <div style={styles.wposText}>{wVal.toFixed(3)} <span style={styles.unitText}>mm</span></div>
                      <div style={styles.mposText}>MPos: {mVal.toFixed(3)}</div>
                    </div>
                    <button
                      disabled={!isConnected || isJobRunning}
                      style={styles.zeroAxisBtn}
                      onClick={() => setAxisZero(axisUpper)}
                      title={`Set the work origin for ${axisUpper} at the tool's current position (no motion)`}
                    >
                      Set {axisUpper}0
                    </button>
                  </div>
                );
              })}

              {/* Machine Quick Controls & Real-Time Override Buttons */}
              <div style={styles.droControlGrid}>
                <button
                  disabled={!isConnected || isJobRunning || isHoming}
                  style={styles.droControlBtn}
                  onClick={handleHome}
                  title="Retract Z to the clearance height, then run the homing cycle ($H)"
                >
                  {isHoming ? 'Homing…' : 'Home'}
                </button>
                <button
                  disabled={!isConnected}
                  style={styles.droControlBtn}
                  onClick={() => sendGcodeCommand('$X')}
                  title="Kill Alarm Lock ($X)"
                >
                  Unlock
                </button>
                <button
                  disabled={!isConnected}
                  style={styles.droControlBtn}
                  onClick={() => sendRealtimeByte(0x21, 'Feed Hold (!)')}
                  title="Feed Hold (!) — Shortcut: Spacebar"
                >
                  Hold
                </button>
                <button
                  disabled={!isConnected}
                  style={styles.droControlBtn}
                  onClick={() => sendRealtimeByte(0x7e, 'Cycle Start (~)')}
                  title="Cycle Start / Resume (~)"
                >
                  Resume
                </button>
                <button
                  disabled={!isConnected}
                  style={styles.droControlBtn}
                  onClick={() => sendRealtimeByte(0x18, 'Soft Reset (0x18)')}
                  title="Soft Reset (Ctrl+X / 0x18)"
                >
                  Reset
                </button>
              </div>
            </div>
          </section>

          {/* Horizontal Splitter: DRO <-> Probing */}
          <div
            style={getSplitterStyle('left-row', false)}
            onPointerDown={(e) => startSplitterDrag('left-row', e)}
            onDoubleClick={() => {
              setDroRatio(DEFAULT_DRO_RATIO);
              setProbeRatio(DEFAULT_PROBE_RATIO);
            }}
            onMouseEnter={() => setHoveredSplitter('left-row')}
            onMouseLeave={() => setHoveredSplitter(null)}
            title="Drag to resize DRO / Probing panels (Double-click to reset)"
          >
            <div style={getSplitterGripStyle('left-row', false)} />
          </div>

          {/* Left-Middle Pane: Touch Plate Probing */}
          <section
            style={{
              ...styles.dockPane,
              flex: `${probeRatio} 1 0%`,
              minHeight: '118px',
            }}
          >
            <div style={styles.cardHeaderRow}>
              <h3 style={styles.sectionHeading}>Probing</h3>
              {/* Continuity indicator — Pn:P means the plate is touching the tool. */}
              <span
                style={{
                  ...styles.continuityPill,
                  ...(probePinTriggered(status.pins)
                    ? styles.continuityOn
                    : styles.continuityOff),
                }}
                title="Electrical continuity between the touch plate and the tool (Grbl probe pin)"
              >
                <span
                  style={{
                    ...styles.continuityDot,
                    backgroundColor: probePinTriggered(status.pins) ? '#34d399' : '#475569',
                    boxShadow: probePinTriggered(status.pins)
                      ? '0 0 6px rgba(52, 211, 153, 0.9)'
                      : 'none',
                  }}
                />
                {probePinTriggered(status.pins) ? 'CONTACT' : 'OPEN'}
              </span>
            </div>

            <div style={styles.paneScrollBody}>
              <div style={styles.probeFieldRow}>
                <label style={styles.probeLabel} htmlFor="probe-thickness">
                  Plate thickness
                </label>
                <div style={styles.probeInputWrap}>
                  <input
                    id="probe-thickness"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={probePlateThickness}
                    onChange={(e) => setProbePlateThickness(Number(e.target.value))}
                    disabled={isProbing}
                    style={styles.probeInput}
                  />
                  <span style={styles.probeUnit}>mm</span>
                </div>
              </div>

              <div style={styles.probeFieldRow}>
                <label style={styles.probeLabel} htmlFor="probe-feed">
                  Probe feed
                </label>
                <div style={styles.probeInputWrap}>
                  <input
                    id="probe-feed"
                    type="number"
                    min={10}
                    step={10}
                    value={probeFeed}
                    onChange={(e) => setProbeFeed(Number(e.target.value))}
                    disabled={isProbing}
                    style={styles.probeInput}
                  />
                  <span style={styles.probeUnit}>mm/min</span>
                </div>
              </div>

              <div style={styles.probeFieldRow}>
                <label style={styles.probeLabel} htmlFor="probe-travel">
                  Max travel
                </label>
                <div style={styles.probeInputWrap}>
                  <input
                    id="probe-travel"
                    type="number"
                    min={1}
                    step={1}
                    value={probeMaxTravel}
                    onChange={(e) => setProbeMaxTravel(Number(e.target.value))}
                    disabled={isProbing}
                    style={styles.probeInput}
                  />
                  <span style={styles.probeUnit}>mm</span>
                </div>
              </div>

              <div style={styles.probeFieldRow}>
                <label style={styles.probeLabel} htmlFor="probe-retract">
                  Retract after
                </label>
                <div style={styles.probeInputWrap}>
                  <input
                    id="probe-retract"
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={probeRetract}
                    onChange={(e) => setProbeRetract(Number(e.target.value))}
                    disabled={isProbing}
                    style={styles.probeInput}
                  />
                  <span style={styles.probeUnit}>mm</span>
                </div>
              </div>

              <button
                disabled={!isConnected || isVirtual || isJobRunning || isProbing}
                style={{
                  ...styles.probeRunBtn,
                  opacity: !isConnected || isVirtual || isJobRunning || isProbing ? 0.45 : 1,
                  cursor:
                    !isConnected || isVirtual || isJobRunning || isProbing
                      ? 'not-allowed'
                      : 'pointer',
                }}
                onClick={handleProbeZ}
                title={
                  isVirtual
                    ? 'Probing requires real hardware — the Virtual CNC has no probe input.'
                    : 'Retract, probe down onto the plate with G38.2, then set Z0 to the stock surface'
                }
              >
                {isProbing ? 'Probing…' : 'Probe Z → Zero'}
              </button>

              {isVirtual && (
                <div style={styles.probeHint}>
                  Virtual CNC has no probe input. Connect hardware to probe.
                </div>
              )}

              {probeResult && <div style={styles.probeResult}>{probeResult}</div>}
            </div>
          </section>

          {/* Horizontal Splitter: Probing <-> Jog Control */}
          <div
            style={getSplitterStyle('left-probe-row', false)}
            onPointerDown={(e) => startSplitterDrag('left-probe-row', e)}
            onDoubleClick={() => {
              setDroRatio(DEFAULT_DRO_RATIO);
              setProbeRatio(DEFAULT_PROBE_RATIO);
            }}
            onMouseEnter={() => setHoveredSplitter('left-probe-row')}
            onMouseLeave={() => setHoveredSplitter(null)}
            title="Drag to resize Probing / Jog Control panels (Double-click to reset)"
          >
            <div style={getSplitterGripStyle('left-probe-row', false)} />
          </div>

          {/* Bottom-Left Pane: Jogging Panel */}
          <section
            style={{
              ...styles.dockPane,
              flex: `${Math.max(0.15, 1 - droRatio - probeRatio)} 1 0%`,
              minHeight: '220px',
            }}
            onPointerUp={handleJogPadPointerUp}
            onPointerLeave={handleJogPadPointerUp}
          >
            <div style={styles.cardHeaderRow}>
              <h3 style={styles.sectionHeading}>Jog Control</h3>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <button
                  style={gamepadJogEnabled ? styles.kbBadgeActive : styles.kbBadgeOff}
                  onClick={() => {
                    if (gamepadJogEnabled) stopContinuousJog();
                    setGamepadJogEnabled((v) => !v);
                  }}
                  title={gamepadName ? `Controller connected (${gamepadName}). Click to toggle Gamepad Jogging.` : 'No gamepad detected. Connect a gamepad and click to toggle.'}
                >
                  Pad: {gamepadJogEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>

            <div style={styles.paneScrollBody}>
              {/* Step vs Jog Mode Toggle Bar */}
              <div style={styles.modeSwitchRow}>
                <button
                  style={jogMode === 'step' ? styles.modeBtnActive : styles.modeBtn}
                  onClick={() => {
                    stopContinuousJog();
                    setJogMode('step');
                  }}
                >
                  Step Mode
                </button>
                <button
                  style={jogMode === 'continuous' ? styles.modeBtnActive : styles.modeBtn}
                  onClick={() => setJogMode('continuous')}
                >
                  Jog
                </button>
              </div>

              <div style={styles.jogPadWrapper}>
                <div style={styles.xyGrid}>
                  <button
                    disabled={!isConnected || isJobRunning}
                    style={isDirActive(-1, 1, 0) ? styles.jogBtnHighlight : styles.jogBtn}
                    onPointerDown={() => handleJogPadPointerDown(-1, 1, 0)}
                  >
                    ↖
                  </button>
                  <button
                    disabled={!isConnected || isJobRunning}
                    style={isDirActive(0, 1, 0) ? styles.jogBtnHighlight : styles.jogBtnPrimary}
                    onPointerDown={() => handleJogPadPointerDown(0, 1, 0)}
                  >
                    +Y ▲
                  </button>
                  <button
                    disabled={!isConnected || isJobRunning}
                    style={isDirActive(1, 1, 0) ? styles.jogBtnHighlight : styles.jogBtn}
                    onPointerDown={() => handleJogPadPointerDown(1, 1, 0)}
                  >
                    ↗
                  </button>

                  <button
                    disabled={!isConnected || isJobRunning}
                    style={isDirActive(-1, 0, 0) ? styles.jogBtnHighlight : styles.jogBtnPrimary}
                    onPointerDown={() => handleJogPadPointerDown(-1, 0, 0)}
                  >
                    ◀ -X
                  </button>
                  <button
                    disabled={!isConnected}
                    style={{ ...styles.jogBtn, background: '#7f1d1d', borderColor: '#dc2626', fontSize: '11px', color: '#fca5a5' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      pressedKeysRef.current.clear();
                      pointerVectorRef.current = null;
                      stopContinuousJog();
                      sendRealtimeByte(0x85, 'Jog Cancel (STOP)');
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      pressedKeysRef.current.clear();
                      pointerVectorRef.current = null;
                      stopContinuousJog();
                      sendRealtimeByte(0x85, 'Jog Cancel (STOP)');
                    }}
                    title="Jog Cancel (0x85) — Shortcut: Escape"
                  >
                    STOP
                  </button>
                  <button
                    disabled={!isConnected || isJobRunning}
                    style={isDirActive(1, 0, 0) ? styles.jogBtnHighlight : styles.jogBtnPrimary}
                    onPointerDown={() => handleJogPadPointerDown(1, 0, 0)}
                  >
                    +X ▶
                  </button>

                  <button
                    disabled={!isConnected || isJobRunning}
                    style={isDirActive(-1, -1, 0) ? styles.jogBtnHighlight : styles.jogBtn}
                    onPointerDown={() => handleJogPadPointerDown(-1, -1, 0)}
                  >
                    ↙
                  </button>
                  <button
                    disabled={!isConnected || isJobRunning}
                    style={isDirActive(0, -1, 0) ? styles.jogBtnHighlight : styles.jogBtnPrimary}
                    onPointerDown={() => handleJogPadPointerDown(0, -1, 0)}
                  >
                    -Y ▼
                  </button>
                  <button
                    disabled={!isConnected || isJobRunning}
                    style={isDirActive(1, -1, 0) ? styles.jogBtnHighlight : styles.jogBtn}
                    onPointerDown={() => handleJogPadPointerDown(1, -1, 0)}
                  >
                    ↘
                  </button>
                </div>

                <div style={styles.zColumn}>
                  <button
                    disabled={!isConnected || isJobRunning}
                    style={{
                      ...(isDirActive(0, 0, 1) ? styles.jogBtnHighlight : styles.jogBtnPrimary),
                      flex: 1,
                    }}
                    onPointerDown={() => handleJogPadPointerDown(0, 0, 1)}
                  >
                    +Z ▲
                    <div style={styles.subHint}>PgUp</div>
                  </button>
                  <button
                    disabled={!isConnected || isJobRunning}
                    style={{
                      ...(isDirActive(0, 0, -1) ? styles.jogBtnHighlight : styles.jogBtnPrimary),
                      flex: 1,
                    }}
                    onPointerDown={() => handleJogPadPointerDown(0, 0, -1)}
                  >
                    -Z ▼
                    <div style={styles.subHint}>PgDn</div>
                  </button>
                </div>
              </div>

              <div style={styles.stepSettings}>
                <div style={styles.stepRow}>
                  <span style={styles.stepLabel}>XY Step (Keys 1–4):</span>
                  <div style={styles.presetGroup}>
                    {STEP_PRESETS.map((val) => (
                      <button
                        key={val}
                        style={xyStep === val ? styles.presetActive : styles.presetBtn}
                        onClick={() => setXyStep(val)}
                      >
                        {val}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={styles.stepRow}>
                  <span style={styles.stepLabel}>Z Step (mm):</span>
                  <div style={styles.presetGroup}>
                    {STEP_PRESETS.map((val) => (
                      <button
                        key={val}
                        style={zStep === val ? styles.presetActive : styles.presetBtn}
                        onClick={() => setZStep(val)}
                      >
                        {val}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={styles.stepRow}>
                  <span style={styles.stepLabel}>Feed (mm/min):</span>
                  <input
                    type="number"
                    value={jogFeed}
                    min={10}
                    max={20000}
                    step={100}
                    onChange={(e) => setJogFeed(Number(e.target.value) || 100)}
                    style={styles.feedInput}
                  />
                </div>

                <div style={styles.shortcutHintBox}>
                  <strong>Shortcuts:</strong> Arrows = XY · PgUp/PgDn = Z · Hold <strong>Shift</strong> = Continuous · <strong>J</strong> = Mode · <strong>Esc</strong> = Stop
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Vertical Splitter: Left Dock <-> Right Dock */}
        <div
          style={getSplitterStyle('main-col', true)}
          onPointerDown={(e) => startSplitterDrag('main-col', e)}
          onDoubleClick={() => setLeftDockWidth(365)}
          onMouseEnter={() => setHoveredSplitter('main-col')}
          onMouseLeave={() => setHoveredSplitter(null)}
          title="Drag to resize Left Dock / 3D Viewport width (Double-click to reset)"
        >
          <div style={getSplitterGripStyle('main-col', true)} />
        </div>

        {/* Right Dock Column: 3D Toolpath Visualizer (Top) + Streamer & Console (Bottom) */}
        <div ref={rightDockRef} style={styles.rightDock}>
          {/* Top-Right Pane: 3D WebGL Toolpath Visualizer */}
          <div
            style={{
              flex: `${viewportRatio} 1 0%`,
              minHeight: 0,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <ToolpathVisualizer
              toolpath={toolpath}
              ackedLines={job.acked_lines}
              wpos={status.wpos}
              wco={status.wco}
              headerActions={connectionControls}
            />
          </div>

          {/* Horizontal Splitter: 3D Viewport <-> Bottom Deck */}
          <div
            style={getSplitterStyle('right-row', false)}
            onPointerDown={(e) => startSplitterDrag('right-row', e)}
            onDoubleClick={() => setViewportRatio(0.64)}
            onMouseEnter={() => setHoveredSplitter('right-row')}
            onMouseLeave={() => setHoveredSplitter(null)}
            title="Drag to resize 3D Viewport height (Double-click to reset)"
          >
            <div style={getSplitterGripStyle('right-row', false)} />
          </div>

          {/* Bottom-Right Sub-Dock: G-Code Job Streamer (Left) + Serial Console (Right) */}
          <div
            ref={bottomDockRef}
            style={{
              flex: `${1 - viewportRatio} 1 0%`,
              minHeight: 0,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'row',
              overflow: 'hidden',
            }}
          >
            {/* G-code Job Streamer Pane */}
            <section
              style={{
                ...styles.dockPane,
                flex: `${bottomLeftRatio} 1 0%`,
                minWidth: '240px',
              }}
            >
              <div style={styles.cardHeaderRow}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <h3 style={styles.sectionHeading}>G-Code Job Streamer (127B)</h3>
                  <span style={styles.jobBadge}>{job.state.toUpperCase()}</span>
                </div>

                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".nc,.gcode,.ngc,.tap,.txt"
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                  />
                  <button
                    disabled={isJobRunning}
                    style={styles.buttonSecondary}
                    onClick={handleLoadDemo}
                  >
                    Demo .NC
                  </button>
                  <button
                    disabled={isJobRunning}
                    style={{ ...styles.buttonSecondary, background: '#0284c7', borderColor: '#38bdf8' }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Open File...
                  </button>
                </div>
              </div>

              <div style={styles.paneScrollBody}>
                {/* File Info & Progress Bar */}
                <div style={styles.jobMetaRow}>
                  <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                    {job.file_name || 'No file loaded'}
                  </span>
                  <span>
                    Lines: <strong>{job.acked_lines}</strong> / {job.total_lines} ({completionPct.toFixed(1)}%)
                  </span>
                  <span>
                    Elapsed: <strong>{formatDuration(job.elapsed_ms)}</strong>
                  </span>
                </div>

                <div style={styles.progressTrack}>
                  <div
                    style={{
                      ...styles.progressFill,
                      width: `${completionPct}%`,
                    }}
                  />
                </div>

                {/* Grbl 127-Byte RX Buffer Utilization Meter */}
                <div style={{ ...styles.jobMetaRow, marginTop: '8px' }}>
                  <span>Grbl RX Buffer In-Flight:</span>
                  <span style={{ fontFamily: 'monospace', color: '#38bdf8' }}>
                    {job.rx_bytes_used} / {job.rx_bytes_max} B ({job.sent_lines - job.acked_lines} queued)
                  </span>
                </div>
                <div style={styles.rxTrack}>
                  <div
                    style={{
                      ...styles.rxFill,
                      width: `${rxFillPct}%`,
                      backgroundColor: rxFillPct > 85 ? '#f59e0b' : '#10b981',
                    }}
                  />
                </div>

                {job.last_error && (
                  <div style={styles.errorBox}>Last G-code Error: {job.last_error}</div>
                )}

                {/* Job Action Buttons */}
                <div style={styles.jobActions}>
                  <button
                    disabled={!isConnected || job.total_lines === 0 || isJobRunning}
                    style={{
                      ...styles.jobBtn,
                      background: '#059669',
                      opacity: !isConnected || job.total_lines === 0 || isJobRunning ? 0.5 : 1,
                    }}
                    onClick={handleStartJob}
                  >
                    {job.state === 'Paused' ? '▶ Resume' : '▶ Start Job'}
                  </button>

                  <button
                    disabled={!isConnected || !isJobRunning}
                    style={{
                      ...styles.jobBtn,
                      background: '#d97706',
                      opacity: !isConnected || !isJobRunning ? 0.5 : 1,
                    }}
                    onClick={handlePauseJob}
                  >
                    ⏸ Pause
                  </button>

                  <button
                    disabled={!isConnected || (job.state !== 'Running' && job.state !== 'Paused')}
                    style={{
                      ...styles.jobBtn,
                      background: '#dc2626',
                      opacity: !isConnected || (job.state !== 'Running' && job.state !== 'Paused') ? 0.5 : 1,
                    }}
                    onClick={handleStopJob}
                  >
                    ⏹ Stop
                  </button>
                </div>
              </div>
            </section>

            {/* Vertical Splitter: Job Streamer <-> Serial Console */}
            <div
              style={getSplitterStyle('bottom-col', true)}
              onPointerDown={(e) => startSplitterDrag('bottom-col', e)}
              onDoubleClick={() => setBottomLeftRatio(0.48)}
              onMouseEnter={() => setHoveredSplitter('bottom-col')}
              onMouseLeave={() => setHoveredSplitter(null)}
              title="Drag to resize Job Streamer / Serial Console width (Double-click to reset)"
            >
              <div style={getSplitterGripStyle('bottom-col', true)} />
            </div>

            {/* Serial Console Pane */}
            <section
              style={{
                ...styles.dockPane,
                flex: `${1 - bottomLeftRatio} 1 0%`,
                minWidth: '240px',
              }}
            >
              <div style={styles.cardHeaderRow}>
                <h3 style={styles.sectionHeading}>Serial Console</h3>
                <button style={styles.clearBtn} onClick={() => setConsoleLog([])}>Clear</button>
              </div>

              <div style={styles.consoleBox}>
                {consoleLog.length === 0 ? (
                  <span style={{ color: '#64748b' }}>Awaiting G-code responses...</span>
                ) : (
                  consoleLog.map((line, idx) => (
                    <div
                      key={idx}
                      style={{
                        color: line.startsWith('>')
                          ? '#38bdf8'
                          : line.startsWith('error:') || line.startsWith('ALARM:') || line.startsWith('[ERROR]')
                          ? '#f87171'
                          : line.startsWith('[JOB]') || line.startsWith('[FILE]')
                          ? '#c084fc'
                          : line === 'ok'
                          ? '#4ade80'
                          : '#f1f5f9',
                      }}
                    >
                      {line}
                    </div>
                  ))
                )}
                <div ref={consoleEndRef} />
              </div>

              <form onSubmit={handleSendCommand} style={styles.inputRow}>
                <input
                  type="text"
                  placeholder={isConnected ? "Send G-code ($$, $G, G0 X0 Y0)..." : "Connect to send commands"}
                  value={cmdInput}
                  onChange={(e) => setCmdInput(e.target.value)}
                  disabled={!isConnected}
                  style={styles.textInput}
                />
                <button
                  type="submit"
                  disabled={!isConnected || !cmdInput.trim()}
                  style={styles.buttonSend}
                >
                  Send
                </button>
              </form>
            </section>
          </div>
        </div>
      </div>

      {/* Update prompt. The Rust backend checks GitHub on startup and emits
          `update-available`; nothing is downloaded until the user accepts. */}
      {updateInfo && !updateDismissed && (
        <div style={styles.updateOverlay} role="dialog" aria-modal="true">
          <div style={styles.updatePanel}>
            <div style={styles.updateHeader}>
              <span style={styles.updateTitle}>
                {updateInstalled ? 'Update installed' : 'Update available'}
              </span>
              <button
                onClick={() => setUpdateDismissed(true)}
                style={styles.updateClose}
                aria-label="Dismiss"
                disabled={isInstallingUpdate}
              >
                ✕
              </button>
            </div>

            <p style={styles.updateBody}>
              {updateInstalled ? (
                <>
                  GCodex v{updateInfo.version} is installed. Restart the app to use it.
                </>
              ) : (
                <>
                  GCodex <strong>v{updateInfo.version}</strong> is available
                  {appVersion ? ` — you have v${appVersion}.` : '.'}
                </>
              )}
            </p>

            {updateInfo.notes && !updateInstalled && (
              <pre style={styles.updateNotes}>{updateInfo.notes}</pre>
            )}

            {updateProgress && (
              <div style={styles.updateProgressRow}>
                <div style={styles.updateBarTrack}>
                  <div
                    style={{
                      ...styles.updateBarFill,
                      width: `${Math.max(0, Math.min(100, updateProgress.percent))}%`,
                    }}
                  />
                </div>
                <span style={styles.updateProgressText}>{updateProgress.message}</span>
              </div>
            )}

            {updateError && <div style={styles.updateError}>{updateError}</div>}

            <div style={styles.updateActions}>
              {!updateInstalled && (
                <button
                  onClick={handleInstallUpdate}
                  disabled={isInstallingUpdate || !updateInfo.rpm_url}
                  style={{
                    ...styles.updatePrimary,
                    opacity: isInstallingUpdate || !updateInfo.rpm_url ? 0.5 : 1,
                    cursor: isInstallingUpdate || !updateInfo.rpm_url ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isInstallingUpdate ? 'Installing…' : 'Download and install'}
                </button>
              )}
              <button
                onClick={() => setUpdateDismissed(true)}
                style={styles.updateSecondary}
                disabled={isInstallingUpdate}
              >
                {updateInstalled ? 'Close' : 'Later'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    width: '100vw',
    height: '100vh',
    padding: '8px 12px',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    color: '#e2e8f0',
    backgroundColor: '#090d16',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    gap: '6px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 0,
    borderBottom: '1px solid #1e293b',
    paddingBottom: '6px',
    flexWrap: 'nowrap',
    gap: '10px',
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: '20px',
    letterSpacing: '-0.5px',
    color: '#38bdf8',
  },
  statePill: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '106px',
    height: '24px',
    fontSize: '11px',
    fontWeight: 700,
    padding: '0 10px',
    borderRadius: '6px',
    border: '1px solid #475569',
    letterSpacing: '0.5px',
    boxSizing: 'border-box',
  },
  pinBadge: {
    fontSize: '11px',
    fontWeight: 700,
    background: '#7f1d1d',
    color: '#fca5a5',
    padding: '3px 8px',
    borderRadius: '4px',
    border: '1px solid #dc2626',
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
  errorBanner: {
    marginBottom: '6px',
    padding: '6px 12px',
    background: '#451a1a',
    border: '1px solid #7f1d1d',
    color: '#fca5a5',
    borderRadius: '6px',
    fontSize: '12px',
    flexShrink: 0,
  },
  viewportHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'nowrap',
    minWidth: 0,
  },
  viewportPortSelect: {
    height: '26px',
    minWidth: '150px',
    maxWidth: '240px',
    padding: '0 8px',
    borderRadius: '5px',
    border: '1px solid #475569',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '11px',
    fontWeight: 600,
    outline: 'none',
    cursor: 'pointer',
    boxSizing: 'border-box',
    textOverflow: 'ellipsis',
  },
  workspaceDock: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  leftDock: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    minWidth: '270px',
    minHeight: 0,
    overflow: 'hidden',
  },
  rightDock: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  dockPane: {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '8px',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
  },
  paneScrollBody: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '2px',
  },
  cardHeaderRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
    flexShrink: 0,
  },
  sectionHeading: {
    margin: 0,
    fontSize: '11px',
    fontWeight: 700,
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.6px',
  },
  select: {
    flex: 1,
    padding: '5px 10px',
    borderRadius: '6px',
    background: '#0f172a',
    color: '#f8fafc',
    border: '1px solid #475569',
    fontSize: '12px',
    outline: 'none',
    minWidth: 0,
  },
  buttonAction: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '28px',
    padding: '0 12px',
    borderRadius: '6px',
    color: '#ffffff',
    border: '1px solid transparent',
    fontWeight: 600,
    fontSize: '12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    flexShrink: 0,
  },
  buttonSecondary: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '28px',
    padding: '0 10px',
    borderRadius: '6px',
    background: '#334155',
    color: '#f8fafc',
    border: '1px solid #475569',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    flexShrink: 0,
  },
  errorBox: {
    marginTop: '8px',
    padding: '6px 10px',
    background: '#451a1a',
    border: '1px solid #7f1d1d',
    color: '#fca5a5',
    borderRadius: '6px',
    fontSize: '11px',
  },
  droRow: {
    display: 'flex',
    alignItems: 'center',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '6px',
    padding: '6px 10px',
    marginBottom: '6px',
    gap: '10px',
  },
  axisLabel: {
    fontSize: '17px',
    fontWeight: 800,
    paddingLeft: '8px',
    width: '26px',
    color: '#f8fafc',
  },
  coordBox: {
    flex: 1,
    textAlign: 'right',
    paddingRight: '6px',
    fontFamily: 'Consolas, Monaco, monospace',
  },
  wposText: {
    fontSize: '18px',
    fontWeight: 700,
    color: '#38bdf8',
    lineHeight: '1.15',
  },
  unitText: {
    fontSize: '11px',
    color: '#64748b',
    fontWeight: 400,
  },
  mposText: {
    fontSize: '10px',
    color: '#64748b',
  },
  zeroAxisBtn: {
    padding: '5px 8px',
    background: '#334155',
    color: '#e2e8f0',
    border: '1px solid #475569',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  goXy0Btn: {
    padding: '8px 18px',
    minHeight: '34px',
    background: '#0284c7',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '13px',
    fontWeight: 700,
    letterSpacing: '0.2px',
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  droControlGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '5px',
    marginTop: '10px',
    paddingTop: '9px',
    borderTop: '1px solid #334155',
  },
  droControlBtn: {
    padding: '5px 4px',
    background: '#0f172a',
    color: '#e2e8f0',
    border: '1px solid #475569',
    borderRadius: '5px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  continuityPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '22px',
    padding: '0 9px',
    borderRadius: '11px',
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.5px',
    border: '1px solid',
    boxSizing: 'border-box',
  },
  continuityOn: {
    background: 'rgba(6, 95, 70, 0.55)',
    color: '#34d399',
    borderColor: '#059669',
  },
  continuityOff: {
    background: '#0f172a',
    color: '#64748b',
    borderColor: '#334155',
  },
  continuityDot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  probeFieldRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    marginBottom: '5px',
  },
  probeLabel: {
    fontSize: '11px',
    color: '#94a3b8',
    whiteSpace: 'nowrap',
  },
  probeInputWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    flexShrink: 0,
  },
  probeInput: {
    width: '72px',
    padding: '3px 8px',
    background: '#0f172a',
    color: '#f8fafc',
    border: '1px solid #475569',
    borderRadius: '4px',
    fontSize: '11px',
    textAlign: 'right',
    fontFamily: 'Consolas, Monaco, monospace',
    boxSizing: 'border-box',
  },
  probeUnit: {
    fontSize: '9px',
    color: '#64748b',
    width: '44px',
  },
  probeRunBtn: {
    width: '100%',
    marginTop: '6px',
    padding: '7px 10px',
    background: '#0284c7',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 700,
    letterSpacing: '0.2px',
    boxSizing: 'border-box',
  },
  probeHint: {
    marginTop: '6px',
    fontSize: '10px',
    color: '#fbbf24',
    lineHeight: '1.35',
  },
  probeResult: {
    marginTop: '6px',
    padding: '5px 8px',
    background: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: '4px',
    fontSize: '10px',
    color: '#94a3b8',
    lineHeight: '1.4',
    fontFamily: 'Consolas, Monaco, monospace',
  },
  kbBadgeActive: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '80px',
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
  kbBadgeOff: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '80px',
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
  jogCancelBtn: {
    padding: '3px 8px',
    background: '#7f1d1d',
    color: '#fca5a5',
    border: '1px solid #dc2626',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  modeSwitchRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '6px',
    marginBottom: '8px',
    background: '#0f172a',
    padding: '3px',
    borderRadius: '6px',
    border: '1px solid #334155',
  },
  modeBtn: {
    padding: '5px 8px',
    background: 'transparent',
    color: '#94a3b8',
    border: 'none',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  modeBtnActive: {
    padding: '5px 8px',
    background: '#0284c7',
    color: '#ffffff',
    border: 'none',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  jogPadWrapper: {
    display: 'flex',
    gap: '10px',
    marginBottom: '10px',
    userSelect: 'none',
  },
  xyGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '5px',
    flex: 3,
  },
  zColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    flex: 1,
  },
  jogBtn: {
    padding: '10px 0',
    background: '#0f172a',
    color: '#94a3b8',
    border: '1px solid #334155',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  jogBtnPrimary: {
    padding: '10px 0',
    background: '#334155',
    color: '#f8fafc',
    border: '1px solid #475569',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  jogBtnHighlight: {
    padding: '10px 0',
    background: '#0284c7',
    color: '#ffffff',
    border: '1px solid #38bdf8',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: '0 0 10px rgba(56, 189, 248, 0.4)',
  },
  subHint: {
    fontSize: '9px',
    color: '#94a3b8',
    fontWeight: 400,
    marginTop: '2px',
  },
  stepSettings: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    borderTop: '1px solid #334155',
    paddingTop: '8px',
  },
  stepRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stepLabel: {
    fontSize: '11px',
    color: '#94a3b8',
  },
  presetGroup: {
    display: 'flex',
    gap: '4px',
  },
  presetBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '34px',
    height: '24px',
    padding: '0 6px',
    background: '#0f172a',
    color: '#94a3b8',
    border: '1px solid #334155',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  presetActive: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '34px',
    height: '24px',
    padding: '0 6px',
    background: '#0284c7',
    color: '#ffffff',
    border: '1px solid #38bdf8',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  feedInput: {
    width: '85px',
    padding: '3px 8px',
    background: '#0f172a',
    color: '#f8fafc',
    border: '1px solid #475569',
    borderRadius: '4px',
    fontSize: '11px',
    textAlign: 'right',
  },
  shortcutHintBox: {
    marginTop: '2px',
    padding: '5px 8px',
    background: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: '4px',
    fontSize: '10px',
    color: '#64748b',
    lineHeight: '1.35',
  },
  jobBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '76px',
    height: '20px',
    fontSize: '10px',
    fontWeight: 700,
    background: '#0f172a',
    color: '#38bdf8',
    padding: '0 8px',
    borderRadius: '4px',
    border: '1px solid #334155',
    boxSizing: 'border-box',
  },
  jobMetaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '11px',
    color: '#94a3b8',
    marginBottom: '5px',
    flexWrap: 'wrap',
    gap: '4px',
  },
  progressTrack: {
    width: '100%',
    height: '7px',
    background: '#0f172a',
    borderRadius: '4px',
    overflow: 'hidden',
    border: '1px solid #334155',
  },
  progressFill: {
    height: '100%',
    background: '#38bdf8',
    transition: 'width 0.15s ease',
  },
  rxTrack: {
    width: '100%',
    height: '5px',
    background: '#0f172a',
    borderRadius: '3px',
    overflow: 'hidden',
    border: '1px solid #334155',
  },
  rxFill: {
    height: '100%',
    transition: 'width 0.1s ease',
  },
  jobActions: {
    display: 'flex',
    gap: '8px',
    marginTop: '10px',
  },
  jobBtn: {
    flex: 1,
    padding: '7px 10px',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '11px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  clearBtn: {
    background: 'transparent',
    border: 'none',
    color: '#64748b',
    fontSize: '11px',
    cursor: 'pointer',
    textDecoration: 'underline',
  },
  consoleBox: {
    background: '#090d16',
    border: '1px solid #1e293b',
    borderRadius: '6px',
    flex: 1,
    minHeight: '60px',
    overflowY: 'auto',
    padding: '8px 10px',
    fontFamily: 'Consolas, Monaco, monospace',
    fontSize: '11px',
    lineHeight: '1.5',
    marginBottom: '8px',
  },
  inputRow: {
    display: 'flex',
    gap: '6px',
    flexShrink: 0,
  },
  textInput: {
    flex: 1,
    padding: '6px 10px',
    borderRadius: '6px',
    background: '#0f172a',
    color: '#f8fafc',
    border: '1px solid #475569',
    fontFamily: 'monospace',
    fontSize: '12px',
    outline: 'none',
    minWidth: 0,
  },
  buttonSend: {
    padding: '6px 14px',
    borderRadius: '6px',
    background: '#0284c7',
    color: '#ffffff',
    border: 'none',
    fontWeight: 600,
    fontSize: '12px',
    cursor: 'pointer',
  },

  // --- Self-updater modal -------------------------------------------------
  updateOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(2, 6, 23, 0.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  updatePanel: {
    width: '460px',
    maxWidth: 'calc(100vw - 48px)',
    background: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: '8px',
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.65)',
    padding: '18px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  updateHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  },
  updateTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#f1f5f9',
  },
  updateClose: {
    background: 'transparent',
    border: 'none',
    color: '#64748b',
    fontSize: '14px',
    cursor: 'pointer',
    padding: '2px 6px',
    lineHeight: 1,
  },
  updateBody: {
    margin: 0,
    fontSize: '12px',
    lineHeight: '1.6',
    color: '#94a3b8',
  },
  updateNotes: {
    margin: 0,
    padding: '8px 10px',
    background: '#090d16',
    border: '1px solid #1e293b',
    borderRadius: '6px',
    fontSize: '11px',
    lineHeight: '1.5',
    color: '#cbd5e1',
    fontFamily: 'Consolas, Monaco, monospace',
    maxHeight: '160px',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
  },
  updateProgressRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
  },
  updateBarTrack: {
    height: '6px',
    background: '#1e293b',
    borderRadius: '3px',
    overflow: 'hidden',
  },
  updateBarFill: {
    height: '100%',
    background: '#38bdf8',
    transition: 'width 200ms linear',
  },
  updateProgressText: {
    fontSize: '11px',
    color: '#64748b',
  },
  updateError: {
    padding: '7px 10px',
    background: '#451a1a',
    border: '1px solid #7f1d1d',
    color: '#fca5a5',
    borderRadius: '6px',
    fontSize: '11px',
    lineHeight: '1.45',
  },
  updateActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '2px',
  },
  updatePrimary: {
    padding: '7px 14px',
    background: '#0284c7',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  updateSecondary: {
    padding: '7px 14px',
    background: '#334155',
    color: '#e2e8f0',
    border: '1px solid #475569',
    borderRadius: '6px',
    fontSize: '12px',
    cursor: 'pointer',
  },
};
