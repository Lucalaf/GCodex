#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod simulator;
mod updater;

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, State};

/// Standard Grbl RX serial buffer size is 128 bytes (max 127 usable bytes in flight).
const GRBL_RX_BUFFER_SIZE: usize = 127;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DetectedPort {
    pub name: String,
    pub description: String,
    pub is_usb: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default)]
pub struct Coordinates {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub a: Option<f64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MachineStatus {
    pub state: String,
    pub substate: Option<u32>,
    pub mpos: Coordinates,
    pub wpos: Coordinates,
    pub wco: Coordinates,
    pub feed_rate: f64,
    pub spindle_speed: f64,
    pub ov_feed: u32,
    pub ov_rapid: u32,
    pub ov_spindle: u32,
    pub pins: String,
    pub buffer_planner: Option<u32>,
    pub buffer_rx: Option<u32>,
}

impl Default for MachineStatus {
    fn default() -> Self {
        Self {
            state: "Disconnected".to_string(),
            substate: None,
            mpos: Coordinates::default(),
            wpos: Coordinates::default(),
            wco: Coordinates::default(),
            feed_rate: 0.0,
            spindle_speed: 0.0,
            ov_feed: 100,
            ov_rapid: 100,
            ov_spindle: 100,
            pins: String::new(),
            buffer_planner: None,
            buffer_rx: None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JobProgress {
    pub file_name: String,
    pub state: String, // "Idle" | "Loaded" | "Running" | "Paused" | "Completed" | "Aborted"
    pub total_lines: usize,
    pub sent_lines: usize,
    pub acked_lines: usize,
    pub rx_bytes_used: usize,
    pub rx_bytes_max: usize,
    pub elapsed_ms: u64,
    pub last_error: Option<String>,
}

impl Default for JobProgress {
    fn default() -> Self {
        Self {
            file_name: String::new(),
            state: "Idle".to_string(),
            total_lines: 0,
            sent_lines: 0,
            acked_lines: 0,
            rx_bytes_used: 0,
            rx_bytes_max: GRBL_RX_BUFFER_SIZE,
            elapsed_ms: 0,
            last_error: None,
        }
    }
}

pub struct InFlightEntry {
    pub byte_len: usize,
    pub is_job_line: bool,
}

pub struct StreamerEngine {
    pub file_name: String,
    pub lines: Vec<String>,
    pub next_line_idx: usize,
    pub acked_lines: usize,
    pub in_flight: VecDeque<InFlightEntry>,
    pub in_flight_bytes: usize,
    pub manual_queue: VecDeque<String>,
    pub state: String,
    pub started_at: Option<Instant>,
    pub accumulated_ms: u64,
    pub last_error: Option<String>,
}

impl Default for StreamerEngine {
    fn default() -> Self {
        Self {
            file_name: String::new(),
            lines: Vec::new(),
            next_line_idx: 0,
            acked_lines: 0,
            in_flight: VecDeque::new(),
            in_flight_bytes: 0,
            manual_queue: VecDeque::new(),
            state: "Idle".to_string(),
            started_at: None,
            accumulated_ms: 0,
            last_error: None,
        }
    }
}

impl StreamerEngine {
    pub fn reset_in_flight(&mut self) {
        self.in_flight.clear();
        self.in_flight_bytes = 0;
        self.manual_queue.clear();
    }

    pub fn elapsed_ms(&self) -> u64 {
        match self.started_at {
            Some(t) if self.state == "Running" => {
                self.accumulated_ms + t.elapsed().as_millis() as u64
            }
            _ => self.accumulated_ms,
        }
    }

    pub fn snapshot(&self) -> JobProgress {
        JobProgress {
            file_name: self.file_name.clone(),
            state: self.state.clone(),
            total_lines: self.lines.len(),
            sent_lines: self.next_line_idx,
            acked_lines: self.acked_lines,
            rx_bytes_used: self.in_flight_bytes,
            rx_bytes_max: GRBL_RX_BUFFER_SIZE,
            elapsed_ms: self.elapsed_ms(),
            last_error: self.last_error.clone(),
        }
    }
}

/// Strips G-code comments (`;...` and `(...)`) and trims whitespace to save Grbl RX buffer bytes.
fn sanitize_gcode_line(raw: &str) -> Option<String> {
    let before_semi = raw.split(';').next().unwrap_or("");
    let mut out = String::with_capacity(before_semi.len());
    let mut in_paren = 0usize;

    for ch in before_semi.chars() {
        if ch == '(' {
            in_paren += 1;
        } else if ch == ')' {
            in_paren = in_paren.saturating_sub(1);
        } else if in_paren == 0 {
            out.push(ch);
        }
    }

    let trimmed = out.trim();
    if trimmed.is_empty() || trimmed == "%" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Attempts to fill the Grbl 127-byte RX buffer with as many queued commands as fit.
fn pump_streamer(streamer: &mut StreamerEngine, tx: &mpsc::Sender<Vec<u8>>) -> bool {
    let mut changed = false;

    // 1. Drain manual commands first when they fit in the RX buffer
    while let Some(front) = streamer.manual_queue.front() {
        let byte_len = front.len(); // Already includes trailing '\n'
        let fits = streamer.in_flight_bytes + byte_len <= GRBL_RX_BUFFER_SIZE
            || streamer.in_flight.is_empty();
        if !fits {
            break;
        }
        let cmd = streamer.manual_queue.pop_front().unwrap();
        if tx.send(cmd.into_bytes()).is_ok() {
            streamer.in_flight_bytes += byte_len;
            streamer.in_flight.push_back(InFlightEntry {
                byte_len,
                is_job_line: false,
            });
            changed = true;
        } else {
            break;
        }
    }

    // 2. If job is actively running, pack as many G-code lines into the 127-byte window as possible
    if streamer.state == "Running" {
        while streamer.next_line_idx < streamer.lines.len() {
            let line = &streamer.lines[streamer.next_line_idx];
            let byte_len = line.len() + 1; // +1 for '\n'
            let fits = streamer.in_flight_bytes + byte_len <= GRBL_RX_BUFFER_SIZE
                || streamer.in_flight.is_empty();
            if !fits {
                break;
            }

            let mut payload = Vec::with_capacity(byte_len);
            payload.extend_from_slice(line.as_bytes());
            payload.push(b'\n');

            if tx.send(payload).is_ok() {
                streamer.in_flight_bytes += byte_len;
                streamer.in_flight.push_back(InFlightEntry {
                    byte_len,
                    is_job_line: true,
                });
                streamer.next_line_idx += 1;
                changed = true;
            } else {
                break;
            }
        }
    }

    changed
}

fn parse_coords(val: &str) -> Option<Coordinates> {
    let nums: Vec<f64> = val
        .split(',')
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .collect();
    if nums.len() >= 3 {
        Some(Coordinates {
            x: nums[0],
            y: nums[1],
            z: nums[2],
            a: nums.get(3).copied(),
        })
    } else {
        None
    }
}

fn update_machine_status(line: &str, status: &mut MachineStatus) -> bool {
    if !line.starts_with('<') || !line.ends_with('>') {
        return false;
    }

    let inner = &line[1..line.len() - 1];
    let mut parts = inner.split('|');

    let state_part = match parts.next() {
        Some(s) if !s.is_empty() => s,
        _ => return false,
    };

    if let Some((main_state, sub)) = state_part.split_once(':') {
        status.state = main_state.to_string();
        status.substate = sub.parse::<u32>().ok();
    } else {
        status.state = state_part.to_string();
        status.substate = None;
    }

    let mut has_mpos = false;
    let mut has_wpos = false;
    status.pins.clear();

    for part in parts {
        if let Some((key, val)) = part.split_once(':') {
            match key {
                "MPos" => {
                    if let Some(c) = parse_coords(val) {
                        status.mpos = c;
                        has_mpos = true;
                    }
                }
                "WPos" => {
                    if let Some(c) = parse_coords(val) {
                        status.wpos = c;
                        has_wpos = true;
                    }
                }
                "WCO" => {
                    if let Some(c) = parse_coords(val) {
                        status.wco = c;
                    }
                }
                "FS" => {
                    let mut fs = val.split(',');
                    if let Some(f) = fs.next().and_then(|s| s.parse::<f64>().ok()) {
                        status.feed_rate = f;
                    }
                    if let Some(s) = fs.next().and_then(|s| s.parse::<f64>().ok()) {
                        status.spindle_speed = s;
                    }
                }
                "F" => {
                    if let Ok(f) = val.parse::<f64>() {
                        status.feed_rate = f;
                    }
                }
                "Ov" => {
                    let ovs: Vec<u32> = val
                        .split(',')
                        .filter_map(|s| s.parse::<u32>().ok())
                        .collect();
                    if ovs.len() == 3 {
                        status.ov_feed = ovs[0];
                        status.ov_rapid = ovs[1];
                        status.ov_spindle = ovs[2];
                    }
                }
                "Pn" => {
                    status.pins = val.to_string();
                }
                "Bf" => {
                    let mut bf = val.split(',');
                    status.buffer_planner = bf.next().and_then(|s| s.parse::<u32>().ok());
                    status.buffer_rx = bf.next().and_then(|s| s.parse::<u32>().ok());
                }
                _ => {}
            }
        }
    }

    if has_mpos && !has_wpos {
        status.wpos = Coordinates {
            x: status.mpos.x - status.wco.x,
            y: status.mpos.y - status.wco.y,
            z: status.mpos.z - status.wco.z,
            a: match (status.mpos.a, status.wco.a) {
                (Some(ma), Some(wa)) => Some(ma - wa),
                (Some(ma), None) => Some(ma),
                _ => None,
            },
        };
    } else if has_wpos && !has_mpos {
        status.mpos = Coordinates {
            x: status.wpos.x + status.wco.x,
            y: status.wpos.y + status.wco.y,
            z: status.wpos.z + status.wco.z,
            a: match (status.wpos.a, status.wco.a) {
                (Some(wa), Some(wcoa)) => Some(wa + wcoa),
                (Some(wa), None) => Some(wa),
                _ => None,
            },
        };
    }

    true
}

fn process_incoming_controller_line(
    line: &str,
    app_handle: &tauri::AppHandle,
    status_arc: &Arc<Mutex<MachineStatus>>,
    streamer_arc: &Arc<Mutex<StreamerEngine>>,
    tx_arc: &Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    last_progress_emit: &mut Instant,
) {
    if line.is_empty() {
        return;
    }

    if line.starts_with('<') && line.ends_with('>') {
        let mut status_guard = status_arc.lock().unwrap();
        if update_machine_status(line, &mut status_guard) {
            let _ = app_handle.emit("machine-status", status_guard.clone());
        }
        drop(status_guard);

        let streamer_guard = streamer_arc.lock().unwrap();
        if streamer_guard.state == "Running"
            && last_progress_emit.elapsed() >= Duration::from_millis(80)
        {
            let _ = app_handle.emit("job-progress", streamer_guard.snapshot());
            *last_progress_emit = Instant::now();
        }
    } else if line == "ok" || line.starts_with("error:") {
        let is_error = line.starts_with("error:");
        let mut emit_console = true;
        let mut snapshot_to_emit: Option<JobProgress> = None;

        {
            let mut streamer_guard = streamer_arc.lock().unwrap();
            if let Some(entry) = streamer_guard.in_flight.pop_front() {
                streamer_guard.in_flight_bytes = streamer_guard
                    .in_flight_bytes
                    .saturating_sub(entry.byte_len);

                if entry.is_job_line {
                    streamer_guard.acked_lines += 1;
                    if !is_error {
                        emit_console = false;
                    }
                }
            }

            if is_error {
                streamer_guard.last_error = Some(line.to_string());
                if streamer_guard.state == "Running" {
                    streamer_guard.accumulated_ms = streamer_guard.elapsed_ms();
                    streamer_guard.started_at = None;
                    streamer_guard.state = "Paused".to_string();
                }
            }

            if let Some(ref tx) = *tx_arc.lock().unwrap() {
                pump_streamer(&mut streamer_guard, tx);
            }

            if streamer_guard.state == "Running"
                && streamer_guard.acked_lines >= streamer_guard.lines.len()
                && streamer_guard.in_flight.is_empty()
            {
                streamer_guard.accumulated_ms = streamer_guard.elapsed_ms();
                streamer_guard.started_at = None;
                streamer_guard.state = "Completed".to_string();
                snapshot_to_emit = Some(streamer_guard.snapshot());
            } else if is_error
                || streamer_guard.in_flight.is_empty()
                || last_progress_emit.elapsed() >= Duration::from_millis(60)
            {
                snapshot_to_emit = Some(streamer_guard.snapshot());
                *last_progress_emit = Instant::now();
            }
        }

        if let Some(snap) = snapshot_to_emit {
            let _ = app_handle.emit("job-progress", snap);
        }
        if emit_console {
            let _ = app_handle.emit("serial-line", line);
        }
    } else {
        if line.starts_with("Grbl ") || line.starts_with("ALARM:") {
            let mut streamer_guard = streamer_arc.lock().unwrap();
            streamer_guard.reset_in_flight();
            if streamer_guard.state == "Running" {
                streamer_guard.accumulated_ms = streamer_guard.elapsed_ms();
                streamer_guard.started_at = None;
                streamer_guard.state = "Aborted".to_string();
            }
            let _ = app_handle.emit("job-progress", streamer_guard.snapshot());
        }
        let _ = app_handle.emit("serial-line", line);
    }
}

pub struct AppState {
    pub is_connected: Arc<AtomicBool>,
    pub is_virtual: Arc<AtomicBool>,
    pub tx_channel: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    pub machine_status: Arc<Mutex<MachineStatus>>,
    pub streamer: Arc<Mutex<StreamerEngine>>,
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<DetectedPort>, String> {
    match serialport::available_ports() {
        Ok(ports) => {
            let port_list = ports
                .into_iter()
                .map(|p| {
                    let (description, is_usb) = match p.port_type {
                        serialport::SerialPortType::UsbPort(usb_info) => {
                            let desc = usb_info
                                .product
                                .unwrap_or_else(|| "USB Serial Device".to_string());
                            (desc, true)
                        }
                        _ => ("Standard / Virtual Serial Port".to_string(), false),
                    };

                    DetectedPort {
                        name: p.port_name,
                        description,
                        is_usb,
                    }
                })
                .collect();
            Ok(port_list)
        }
        Err(e) => Err(format!("Failed to enumerate ports: {}", e)),
    }
}

#[tauri::command]
fn connect_serial(
    port_name: String,
    baud_rate: Option<u32>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if state.is_connected.load(Ordering::SeqCst) {
        return Err("A serial port is already open. Disconnect first.".to_string());
    }

    let baud = baud_rate.unwrap_or(115200);

    let port = serialport::new(&port_name, baud)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| {
            #[cfg(target_os = "linux")]
            if e.kind() == serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied) {
                return format!(
                    "Permission denied opening {}. On Linux, add your user to the serial group: sudo usermod -aG dialout,uucp $USER (then log out and back in).",
                    port_name
                );
            }
            format!("Could not open port {}: {}", port_name, e)
        })?;

    let mut port_write = port
        .try_clone()
        .map_err(|e| format!("Failed to clone serial port writer: {}", e))?;

    state.is_connected.store(true, Ordering::SeqCst);
    state.is_virtual.store(false, Ordering::SeqCst);
    let is_connected_reader = Arc::clone(&state.is_connected);

    {
        let mut status_guard = state.machine_status.lock().unwrap();
        *status_guard = MachineStatus {
            state: "Connecting".to_string(),
            ..MachineStatus::default()
        };
        let _ = app_handle.emit("machine-status", status_guard.clone());
    }

    {
        let mut streamer_guard = state.streamer.lock().unwrap();
        streamer_guard.reset_in_flight();
        let _ = app_handle.emit("job-progress", streamer_guard.snapshot());
    }

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    {
        let mut tx_guard = state.tx_channel.lock().unwrap();
        *tx_guard = Some(tx);
    }

    // Spawn Writer + Status Poller Thread
    let is_connected_writer = Arc::clone(&state.is_connected);
    thread::spawn(move || {
        let mut last_poll = Instant::now();
        let poll_interval = Duration::from_millis(200);

        while is_connected_writer.load(Ordering::SeqCst) {
            if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(20)) {
                let _ = port_write.write_all(&bytes);
                let _ = port_write.flush();
            }

            if last_poll.elapsed() >= poll_interval {
                let _ = port_write.write_all(b"?");
                let _ = port_write.flush();
                last_poll = Instant::now();
            }
        }
    });

    // Spawn Reader Thread: parses <...> status frames, handles 'ok'/'error:' for 127-byte character counting
    let status_arc = Arc::clone(&state.machine_status);
    let streamer_arc = Arc::clone(&state.streamer);
    let tx_arc = Arc::clone(&state.tx_channel);

    thread::spawn(move || {
        let mut reader = BufReader::new(port);
        let mut buffer = String::new();
        let mut last_progress_emit = Instant::now();

        while is_connected_reader.load(Ordering::SeqCst) {
            match reader.read_line(&mut buffer) {
                Ok(bytes_read) => {
                    if bytes_read > 0 {
                        let line = buffer.trim_end_matches(['\r', '\n']).to_string();
                        process_incoming_controller_line(
                            &line,
                            &app_handle,
                            &status_arc,
                            &streamer_arc,
                            &tx_arc,
                            &mut last_progress_emit,
                        );
                        buffer.clear();
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => {
                    let _ = app_handle.emit(
                        "serial-line",
                        format!("[ERROR] Serial read failure: {}", e),
                    );
                    break;
                }
            }
        }

        is_connected_reader.store(false, Ordering::SeqCst);
        {
            let mut status_guard = status_arc.lock().unwrap();
            *status_guard = MachineStatus::default();
            let _ = app_handle.emit("machine-status", status_guard.clone());
        }
        {
            let mut streamer_guard = streamer_arc.lock().unwrap();
            streamer_guard.reset_in_flight();
            if streamer_guard.state == "Running" {
                streamer_guard.accumulated_ms = streamer_guard.elapsed_ms();
                streamer_guard.started_at = None;
                streamer_guard.state = "Paused".to_string();
            }
            let _ = app_handle.emit("job-progress", streamer_guard.snapshot());
        }
        let _ = app_handle.emit("serial-disconnected", ());
    });

    Ok(())
}

#[tauri::command]
fn connect_virtual(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if state.is_connected.load(Ordering::SeqCst) {
        return Err("Already connected. Disconnect first.".to_string());
    }

    state.is_connected.store(true, Ordering::SeqCst);
    state.is_virtual.store(true, Ordering::SeqCst);

    {
        let mut status_guard = state.machine_status.lock().unwrap();
        *status_guard = MachineStatus {
            state: "Idle".to_string(),
            ..MachineStatus::default()
        };
        let _ = app_handle.emit("machine-status", status_guard.clone());
    }

    {
        let mut streamer_guard = state.streamer.lock().unwrap();
        streamer_guard.reset_in_flight();
        let _ = app_handle.emit("job-progress", streamer_guard.snapshot());
    }

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    {
        let mut tx_guard = state.tx_channel.lock().unwrap();
        *tx_guard = Some(tx);
    }

    let is_connected_sim = Arc::clone(&state.is_connected);
    let resp_rx = simulator::spawn_virtual_cnc(is_connected_sim, rx);

    let is_connected_reader = Arc::clone(&state.is_connected);
    let is_virtual_reader = Arc::clone(&state.is_virtual);
    let status_arc = Arc::clone(&state.machine_status);
    let streamer_arc = Arc::clone(&state.streamer);
    let tx_arc = Arc::clone(&state.tx_channel);

    thread::spawn(move || {
        let mut last_progress_emit = Instant::now();

        while is_connected_reader.load(Ordering::SeqCst) {
            if let Ok(line) = resp_rx.recv_timeout(Duration::from_millis(16)) {
                process_incoming_controller_line(
                    &line,
                    &app_handle,
                    &status_arc,
                    &streamer_arc,
                    &tx_arc,
                    &mut last_progress_emit,
                );
            }
        }

        is_connected_reader.store(false, Ordering::SeqCst);
        is_virtual_reader.store(false, Ordering::SeqCst);
        {
            let mut status_guard = status_arc.lock().unwrap();
            *status_guard = MachineStatus::default();
            let _ = app_handle.emit("machine-status", status_guard.clone());
        }
        {
            let mut streamer_guard = streamer_arc.lock().unwrap();
            streamer_guard.reset_in_flight();
            if streamer_guard.state == "Running" {
                streamer_guard.accumulated_ms = streamer_guard.elapsed_ms();
                streamer_guard.started_at = None;
                streamer_guard.state = "Paused".to_string();
            }
            let _ = app_handle.emit("job-progress", streamer_guard.snapshot());
        }
        let _ = app_handle.emit("serial-disconnected", ());
    });

    Ok(())
}

#[tauri::command]
fn disconnect_serial(state: State<'_, AppState>) -> Result<(), String> {
    state.is_connected.store(false, Ordering::SeqCst);
    state.is_virtual.store(false, Ordering::SeqCst);
    let mut tx_guard = state.tx_channel.lock().unwrap();
    *tx_guard = None;
    Ok(())
}

#[tauri::command]
fn send_serial_command(
    command: String,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !state.is_connected.load(Ordering::SeqCst) {
        return Err("Cannot send command: not connected".to_string());
    }

    let mut line = command.trim().to_string();
    if line.is_empty() {
        return Ok(());
    }
    if !line.ends_with('\n') {
        line.push('\n');
    }

    let tx_guard = state.tx_channel.lock().unwrap();
    if let Some(ref tx) = *tx_guard {
        let mut streamer_guard = state.streamer.lock().unwrap();
        streamer_guard.manual_queue.push_back(line);
        pump_streamer(&mut streamer_guard, tx);
        let _ = app_handle.emit("job-progress", streamer_guard.snapshot());
        Ok(())
    } else {
        Err("Command channel unavailable".to_string())
    }
}

#[tauri::command]
fn send_realtime_byte(
    byte: u8,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !state.is_connected.load(Ordering::SeqCst) {
        return Err("Cannot send realtime byte: not connected".to_string());
    }

    let tx_guard = state.tx_channel.lock().unwrap();
    if let Some(ref tx) = *tx_guard {
        // Real-time pick-off commands bypass character-counting queue completely
        tx.send(vec![byte])
            .map_err(|e| format!("Failed to queue realtime byte: {}", e))?;

        // If soft-reset (0x18), flush in-flight tracking immediately
        if byte == 0x18 {
            let mut streamer_guard = state.streamer.lock().unwrap();
            streamer_guard.reset_in_flight();
            if streamer_guard.state == "Running" || streamer_guard.state == "Paused" {
                streamer_guard.accumulated_ms = streamer_guard.elapsed_ms();
                streamer_guard.started_at = None;
                streamer_guard.state = "Aborted".to_string();
            }
            let _ = app_handle.emit("job-progress", streamer_guard.snapshot());
        } else if byte == 0x85 {
            // Jog Cancel (0x85) flushes any pending jog commands in Grbl's RX and planner buffers
            let mut streamer_guard = state.streamer.lock().unwrap();
            if streamer_guard.state != "Running" {
                streamer_guard.reset_in_flight();
                let _ = app_handle.emit("job-progress", streamer_guard.snapshot());
            }
        }
        Ok(())
    } else {
        Err("Command channel unavailable".to_string())
    }
}

#[tauri::command]
fn load_gcode_job(
    file_name: String,
    content: String,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<JobProgress, String> {
    let mut streamer_guard = state.streamer.lock().unwrap();
    if streamer_guard.state == "Running" {
        return Err("Cannot load a new file while a job is running.".to_string());
    }

    let sanitized: Vec<String> = content.lines().filter_map(sanitize_gcode_line).collect();

    if sanitized.is_empty() {
        return Err("No executable G-code lines found in file.".to_string());
    }

    streamer_guard.file_name = file_name;
    streamer_guard.lines = sanitized;
    streamer_guard.next_line_idx = 0;
    streamer_guard.acked_lines = 0;
    streamer_guard.started_at = None;
    streamer_guard.accumulated_ms = 0;
    streamer_guard.last_error = None;
    streamer_guard.state = "Loaded".to_string();

    let snap = streamer_guard.snapshot();
    let _ = app_handle.emit("job-progress", snap.clone());
    Ok(snap)
}

#[tauri::command]
fn start_gcode_job(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<JobProgress, String> {
    if !state.is_connected.load(Ordering::SeqCst) {
        return Err("Connect to a CNC controller before starting a job.".to_string());
    }

    let tx_guard = state.tx_channel.lock().unwrap();
    let tx = tx_guard
        .as_ref()
        .ok_or_else(|| "Serial transmitter unavailable".to_string())?;

    let mut streamer_guard = state.streamer.lock().unwrap();
    if streamer_guard.lines.is_empty() {
        return Err("No G-code job loaded.".to_string());
    }

    // If restarting a finished or aborted job, rewind to line 0
    if streamer_guard.state == "Completed"
        || streamer_guard.state == "Aborted"
        || streamer_guard.next_line_idx >= streamer_guard.lines.len()
    {
        streamer_guard.next_line_idx = 0;
        streamer_guard.acked_lines = 0;
        streamer_guard.accumulated_ms = 0;
        streamer_guard.last_error = None;
    }

    // If resuming from a paused state, also send Cycle Start ('~') to Grbl in case it was in Feed Hold
    if streamer_guard.state == "Paused" {
        let _ = tx.send(vec![b'~']);
    }

    streamer_guard.state = "Running".to_string();
    streamer_guard.started_at = Some(Instant::now());
    pump_streamer(&mut streamer_guard, tx);

    let snap = streamer_guard.snapshot();
    let _ = app_handle.emit("job-progress", snap.clone());
    Ok(snap)
}

#[tauri::command]
fn pause_gcode_job(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<JobProgress, String> {
    let tx_guard = state.tx_channel.lock().unwrap();
    if let Some(ref tx) = *tx_guard {
        // Send real-time Feed Hold ('!') to Grbl immediately
        let _ = tx.send(vec![b'!']);
    }

    let mut streamer_guard = state.streamer.lock().unwrap();
    if streamer_guard.state == "Running" {
        streamer_guard.accumulated_ms = streamer_guard.elapsed_ms();
        streamer_guard.started_at = None;
        streamer_guard.state = "Paused".to_string();
    }

    let snap = streamer_guard.snapshot();
    let _ = app_handle.emit("job-progress", snap.clone());
    Ok(snap)
}

#[tauri::command]
fn stop_gcode_job(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<JobProgress, String> {
    let tx_guard = state.tx_channel.lock().unwrap();
    if let Some(ref tx) = *tx_guard {
        // Send Feed Hold ('!') followed by Soft Reset (0x18) to halt motion and clear planner/RX buffers
        let _ = tx.send(vec![b'!', 0x18]);
    }

    let mut streamer_guard = state.streamer.lock().unwrap();
    streamer_guard.accumulated_ms = streamer_guard.elapsed_ms();
    streamer_guard.started_at = None;
    streamer_guard.reset_in_flight();
    streamer_guard.next_line_idx = 0;
    streamer_guard.acked_lines = 0;
    streamer_guard.state = if streamer_guard.lines.is_empty() {
        "Idle".to_string()
    } else {
        "Aborted".to_string()
    };

    let snap = streamer_guard.snapshot();
    let _ = app_handle.emit("job-progress", snap.clone());
    Ok(snap)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            updater::spawn_startup_check(app.handle().clone());
            Ok(())
        })
        .manage(AppState {
            is_connected: Arc::new(AtomicBool::new(false)),
            is_virtual: Arc::new(AtomicBool::new(false)),
            tx_channel: Arc::new(Mutex::new(None)),
            machine_status: Arc::new(Mutex::new(MachineStatus::default())),
            streamer: Arc::new(Mutex::new(StreamerEngine::default())),
        })
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            connect_serial,
            connect_virtual,
            disconnect_serial,
            send_serial_command,
            send_realtime_byte,
            load_gcode_job,
            start_gcode_job,
            pause_gcode_job,
            stop_gcode_job,
            updater::get_app_version,
            updater::check_for_update_command,
            updater::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running GCodex");
}
