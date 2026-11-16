use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
struct PlannedMove {
    target_x: f64,
    target_y: f64,
    target_z: f64,
    feed_mm_min: f64,
    is_jog: bool,
    ack_on_complete: bool,
}

struct VirtualGrblMachine {
    state: String, // "Idle", "Run", "Jog", "Hold:0", "Alarm:1"
    mpos_x: f64,
    mpos_y: f64,
    mpos_z: f64,
    wco_x: f64,
    wco_y: f64,
    wco_z: f64,
    is_absolute: bool, // G90 = true, G91 = false
    unit_scale: f64,   // G21 = 1.0, G20 = 25.4
    motion_mode: u8,   // 0=G0, 1=G1, 2=G2, 3=G3
    modal_feed: f64,
    spindle_rpm: f64,
    spindle_on: bool,
    ov_feed: u32,
    ov_rapid: u32,
    ov_spindle: u32,
    planner: VecDeque<PlannedMove>,
    deferred_acks: usize,
}

impl Default for VirtualGrblMachine {
    fn default() -> Self {
        Self {
            state: "Idle".to_string(),
            mpos_x: 0.0,
            mpos_y: 0.0,
            mpos_z: 0.0,
            wco_x: 0.0,
            wco_y: 0.0,
            wco_z: 0.0,
            is_absolute: true,
            unit_scale: 1.0,
            motion_mode: 0,
            modal_feed: 1200.0,
            spindle_rpm: 0.0,
            spindle_on: false,
            ov_feed: 100,
            ov_rapid: 100,
            ov_spindle: 100,
            planner: VecDeque::new(),
            deferred_acks: 0,
        }
    }
}

impl VirtualGrblMachine {
    fn format_status(&self) -> String {
        let active_feed = if self.state == "Run" || self.state == "Jog" {
            if let Some(front) = self.planner.front() {
                front.feed_mm_min * (self.ov_feed as f64 / 100.0)
            } else {
                0.0
            }
        } else {
            0.0
        };
        let active_rpm = if self.spindle_on {
            self.spindle_rpm * (self.ov_spindle as f64 / 100.0)
        } else {
            0.0
        };

        format!(
            "<{}|MPos:{:.3},{:.3},{:.3}|FS:{:.0},{:.0}|WCO:{:.3},{:.3},{:.3}|Ov:{},{},{}>",
            self.state,
            self.mpos_x,
            self.mpos_y,
            self.mpos_z,
            active_feed,
            active_rpm,
            self.wco_x,
            self.wco_y,
            self.wco_z,
            self.ov_feed,
            self.ov_rapid,
            self.ov_spindle
        )
    }

    fn planned_endpoint(&self) -> (f64, f64, f64) {
        if let Some(back) = self.planner.back() {
            (back.target_x, back.target_y, back.target_z)
        } else {
            (self.mpos_x, self.mpos_y, self.mpos_z)
        }
    }

    fn step_physics(&mut self, dt_sec: f64, resp_tx: &mpsc::Sender<String>) {
        if self.state.starts_with("Hold") || self.state.starts_with("Alarm") {
            return;
        }

        let mut remaining_dt = dt_sec;
        while remaining_dt > 1e-6 {
            let Some(front) = self.planner.front() else {
                if self.state == "Run" || self.state == "Jog" {
                    self.state = "Idle".to_string();
                }
                break;
            };

            self.state = if front.is_jog {
                "Jog".to_string()
            } else {
                "Run".to_string()
            };

            let dx = front.target_x - self.mpos_x;
            let dy = front.target_y - self.mpos_y;
            let dz = front.target_z - self.mpos_z;
            let dist = (dx * dx + dy * dy + dz * dz).sqrt();

            let speed_mm_sec =
                (front.feed_mm_min * (self.ov_feed as f64 / 100.0)).max(30.0) / 60.0;

            if dist <= 1e-5 {
                self.mpos_x = front.target_x;
                self.mpos_y = front.target_y;
                self.mpos_z = front.target_z;
                let completed = self.planner.pop_front().unwrap();
                if completed.ack_on_complete && self.deferred_acks > 0 {
                    self.deferred_acks -= 1;
                    let _ = resp_tx.send("ok".to_string());
                }
                continue;
            }

            let time_needed = dist / speed_mm_sec;
            if time_needed <= remaining_dt {
                self.mpos_x = front.target_x;
                self.mpos_y = front.target_y;
                self.mpos_z = front.target_z;
                remaining_dt -= time_needed;
                let completed = self.planner.pop_front().unwrap();
                if completed.ack_on_complete && self.deferred_acks > 0 {
                    self.deferred_acks -= 1;
                    let _ = resp_tx.send("ok".to_string());
                }
            } else {
                let step = speed_mm_sec * remaining_dt;
                let ratio = step / dist;
                self.mpos_x += dx * ratio;
                self.mpos_y += dy * ratio;
                self.mpos_z += dz * ratio;
                remaining_dt = 0.0;
            }
        }

        if self.planner.is_empty() && (self.state == "Run" || self.state == "Jog") {
            self.state = "Idle".to_string();
        }
    }

    fn execute_line(&mut self, raw_line: &str, resp_tx: &mpsc::Sender<String>) {
        let line = raw_line.trim();
        if line.is_empty() {
            let _ = resp_tx.send("ok".to_string());
            return;
        }

        // System commands
        if line == "$$" {
            let _ = resp_tx.send("$0=10 (Step pulse time, microseconds)".to_string());
            let _ = resp_tx.send("$110=4000.000 (X-axis maximum rate, mm/min)".to_string());
            let _ = resp_tx.send("$111=4000.000 (Y-axis maximum rate, mm/min)".to_string());
            let _ = resp_tx.send("$112=2000.000 (Z-axis maximum rate, mm/min)".to_string());
            let _ = resp_tx.send("ok".to_string());
            return;
        }
        if line == "$G" {
            let dist_str = if self.is_absolute { "G90" } else { "G91" };
            let unit_str = if (self.unit_scale - 1.0).abs() < 1e-3 {
                "G21"
            } else {
                "G20"
            };
            let _ = resp_tx.send(format!(
                "[GC:G{} G54 G17 {} {} G94 M5 M9 T0 F{:.0} S{:.0}]",
                self.motion_mode, dist_str, unit_str, self.modal_feed, self.spindle_rpm
            ));
            let _ = resp_tx.send("ok".to_string());
            return;
        }
        if line.eq_ignore_ascii_case("$X") {
            self.state = "Idle".to_string();
            let _ = resp_tx.send("[MSG:'$H'|'$X' to unlock]".to_string());
            let _ = resp_tx.send("ok".to_string());
            return;
        }
        if line.eq_ignore_ascii_case("$H") {
            // Safe homing: retract Z to a clearance height first, then move to
            // the home corner. A real machine must never drag the tool through
            // the work piece on the way to its limit switches.
            self.planner.clear();
            self.deferred_acks = 0;
            let clearance = 10.0_f64.max(self.mpos_z);
            self.planner.push_back(PlannedMove {
                target_x: self.mpos_x,
                target_y: self.mpos_y,
                target_z: clearance,
                feed_mm_min: 2500.0,
                is_jog: false,
                ack_on_complete: false,
            });
            // Travel in XY at clearance height, keeping Z where it is.
            self.planner.push_back(PlannedMove {
                target_x: 0.0,
                target_y: 0.0,
                target_z: clearance,
                feed_mm_min: 2500.0,
                is_jog: false,
                ack_on_complete: false,
            });
            // Only then descend Z to the home switch.
            self.planner.push_back(PlannedMove {
                target_x: 0.0,
                target_y: 0.0,
                target_z: 0.0,
                feed_mm_min: 2500.0,
                is_jog: false,
                ack_on_complete: false,
            });
            let _ = resp_tx.send("ok".to_string());
            return;
        }

        let is_jog = line.starts_with("$J=") || line.starts_with("$j=");
        let body = if is_jog { &line[3..] } else { line };

        let words = parse_gcode_words(body);
        if words.is_empty() {
            let _ = resp_tx.send("ok".to_string());
            return;
        }

        // Check for G10 L20 P1 work coordinate zeroing
        let has_g10 = words.iter().any(|&(c, v)| c == 'G' && (v - 10.0).abs() < 1e-3);
        if has_g10 {
            for &(c, v) in &words {
                match c {
                    'X' => self.wco_x = self.mpos_x - v * self.unit_scale,
                    'Y' => self.wco_y = self.mpos_y - v * self.unit_scale,
                    'Z' => self.wco_z = self.mpos_z - v * self.unit_scale,
                    _ => {}
                }
            }
            let _ = resp_tx.send("ok".to_string());
            return;
        }

        let mut local_abs = self.is_absolute;
        let mut local_scale = self.unit_scale;
        let mut local_mode = if is_jog { 1 } else { self.motion_mode };

        let mut x_word: Option<f64> = None;
        let mut y_word: Option<f64> = None;
        let mut z_word: Option<f64> = None;
        let mut i_word: f64 = 0.0;
        let mut j_word: f64 = 0.0;

        for &(c, v) in &words {
            match c {
                'G' => {
                    let g = (v * 10.0).round() as i32;
                    match g {
                        0 => local_mode = 0,
                        10 => local_mode = 1,
                        20 => local_mode = 2,
                        30 => local_mode = 3,
                        200 => local_scale = 25.4,
                        210 => local_scale = 1.0,
                        900 => local_abs = true,
                        910 => local_abs = false,
                        _ => {}
                    }
                }
                'M' => {
                    let m = v.round() as i32;
                    match m {
                        3 | 4 => self.spindle_on = true,
                        5 | 30 => self.spindle_on = false,
                        _ => {}
                    }
                }
                'F' => {
                    if v > 0.0 {
                        self.modal_feed = v * local_scale;
                    }
                }
                'S' => {
                    self.spindle_rpm = v.max(0.0);
                }
                'X' => x_word = Some(v),
                'Y' => y_word = Some(v),
                'Z' => z_word = Some(v),
                'I' => i_word = v,
                'J' => j_word = v,
                _ => {}
            }
        }

        if !is_jog {
            self.is_absolute = local_abs;
            self.unit_scale = local_scale;
            self.motion_mode = local_mode;
        }

        if x_word.is_some() || y_word.is_some() || z_word.is_some() {
            let (start_x, start_y, start_z) = self.planned_endpoint();

            let next_x = match x_word {
                Some(v) => {
                    if local_abs {
                        v * local_scale + self.wco_x
                    } else {
                        start_x + v * local_scale
                    }
                }
                None => start_x,
            };
            let next_y = match y_word {
                Some(v) => {
                    if local_abs {
                        v * local_scale + self.wco_y
                    } else {
                        start_y + v * local_scale
                    }
                }
                None => start_y,
            };
            let next_z = match z_word {
                Some(v) => {
                    if local_abs {
                        v * local_scale + self.wco_z
                    } else {
                        start_z + v * local_scale
                    }
                }
                None => start_z,
            };

            let move_feed = if local_mode == 0 && !is_jog {
                3500.0
            } else {
                self.modal_feed.max(60.0)
            };

            // Count logical G-code blocks in planner (each block has ack_on_complete = true on its final segment)
            let planned_blocks = self.planner.iter().filter(|m| m.ack_on_complete).count();

            if (local_mode == 2 || local_mode == 3) && !is_jog {
                // Subdivide G2/G3 arc into smooth segments for the virtual physics engine
                let is_cw = local_mode == 2;
                let cx = start_x + i_word * local_scale;
                let cy = start_y + j_word * local_scale;
                let radius = ((start_x - cx).powi(2) + (start_y - cy).powi(2)).sqrt();

                if radius > 1e-4 {
                    let start_ang = (start_y - cy).atan2(start_x - cx);
                    let end_ang = (next_y - cy).atan2(next_x - cx);
                    let mut sweep = end_ang - start_ang;
                    if is_cw {
                        if sweep >= -1e-6 {
                            sweep -= std::f64::consts::TAU;
                        }
                    } else if sweep <= 1e-6 {
                        sweep += std::f64::consts::TAU;
                    }
                    let steps = 24usize;
                    for s in 1..=steps {
                        let t = s as f64 / steps as f64;
                        let ang = start_ang + sweep * t;
                        let (tx, ty, tz) = if s == steps {
                            (next_x, next_y, next_z)
                        } else {
                            (
                                cx + ang.cos() * radius,
                                cy + ang.sin() * radius,
                                start_z + (next_z - start_z) * t,
                            )
                        };
                        self.planner.push_back(PlannedMove {
                            target_x: tx,
                            target_y: ty,
                            target_z: tz,
                            feed_mm_min: move_feed,
                            is_jog: false,
                            ack_on_complete: s == steps,
                        });
                    }
                } else {
                    self.planner.push_back(PlannedMove {
                        target_x: next_x,
                        target_y: next_y,
                        target_z: next_z,
                        feed_mm_min: move_feed,
                        is_jog: false,
                        ack_on_complete: true,
                    });
                }
            } else {
                self.planner.push_back(PlannedMove {
                    target_x: next_x,
                    target_y: next_y,
                    target_z: next_z,
                    feed_mm_min: move_feed,
                    is_jog,
                    ack_on_complete: true,
                });
            }

            // Simulate Grbl's 15-block lookahead planner: acknowledge immediately while planner has room,
            // otherwise defer 'ok' until a logical G-code block finishes executing so the 127B streamer paces realistically!
            if planned_blocks < 8 {
                let _ = resp_tx.send("ok".to_string());
            } else {
                self.deferred_acks += 1;
            }
        } else {
            let _ = resp_tx.send("ok".to_string());
        }
    }
}

fn parse_gcode_words(s: &str) -> Vec<(char, f64)> {
    let mut words = Vec::new();
    let mut chars = s.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch.is_ascii_alphabetic() {
            let letter = ch.to_ascii_uppercase();
            while let Some(&p) = chars.peek() {
                if p == ' ' || p == '\t' {
                    chars.next();
                } else {
                    break;
                }
            }
            let mut num_str = String::new();
            while let Some(&p) = chars.peek() {
                if p.is_ascii_digit() || p == '.' || p == '-' || p == '+' {
                    num_str.push(p);
                    chars.next();
                } else {
                    break;
                }
            }
            if let Ok(val) = num_str.parse::<f64>() {
                words.push((letter, val));
            }
        }
    }
    words
}

/// Spawns the Virtual Grbl 1.1h Simulator threads (60Hz physics + command processor + 5Hz '?' status poller).
pub fn spawn_virtual_cnc(
    is_connected: Arc<AtomicBool>,
    cmd_rx: mpsc::Receiver<Vec<u8>>,
) -> mpsc::Receiver<String> {
    let (resp_tx, resp_rx) = mpsc::channel::<String>();

    thread::spawn(move || {
        let mut machine = VirtualGrblMachine::default();
        let mut line_buf = String::new();
        let mut last_tick = Instant::now();
        let mut last_status = Instant::now();

        // Emit Grbl 1.1h welcome banner on connect
        let _ = resp_tx.send("Grbl 1.1h ['$' for help] (Virtual CNC Simulator)".to_string());
        let _ = resp_tx.send(machine.format_status());

        while is_connected.load(Ordering::SeqCst) {
            // Drain incoming bytes from streamer/UI
            while let Ok(bytes) = cmd_rx.try_recv() {
                for b in bytes {
                    match b {
                        b'?' => {
                            let _ = resp_tx.send(machine.format_status());
                        }
                        b'!' => {
                            if machine.state == "Run" || machine.state == "Jog" {
                                machine.state = "Hold:0".to_string();
                            }
                        }
                        b'~' => {
                            if machine.state.starts_with("Hold") {
                                machine.state = if machine.planner.is_empty() {
                                    "Idle".to_string()
                                } else {
                                    "Run".to_string()
                                };
                            }
                        }
                        0x85 => {
                            // Real-time Jog Cancel: flush all planned jog moves immediately
                            machine.planner.retain(|m| !m.is_jog);
                            if machine.planner.is_empty() {
                                machine.state = "Idle".to_string();
                                machine.deferred_acks = 0;
                            }
                        }
                        0x18 => {
                            // Soft-reset (^X)
                            machine.planner.clear();
                            machine.deferred_acks = 0;
                            machine.spindle_on = false;
                            machine.state = "Idle".to_string();
                            line_buf.clear();
                            let _ = resp_tx.send(
                                "Grbl 1.1h ['$' for help] (Virtual Soft Reset)".to_string(),
                            );
                        }
                        0x90 => machine.ov_feed = 100,
                        0x91 => machine.ov_feed = (machine.ov_feed + 10).min(200),
                        0x92 => machine.ov_feed = machine.ov_feed.saturating_sub(10).max(10),
                        b'\n' | b'\r' => {
                            if !line_buf.is_empty() {
                                let cmd_line = std::mem::take(&mut line_buf);
                                machine.execute_line(&cmd_line, &resp_tx);
                            }
                        }
                        _ => {
                            if b.is_ascii() && !b.is_ascii_control() {
                                line_buf.push(b as char);
                            }
                        }
                    }
                }
            }

            // Step high-rate virtual motion physics
            let dt = last_tick.elapsed().as_secs_f64();
            last_tick = Instant::now();
            let was_moving = machine.state == "Run" || machine.state == "Jog";
            machine.step_physics(dt, &resp_tx);
            let is_moving = machine.state == "Run" || machine.state == "Jog";

            // Emit 60Hz status reports while moving for silky-smooth 3D tool animation, or 10Hz when idle
            let status_interval = if is_moving || was_moving {
                Duration::from_millis(16)
            } else {
                Duration::from_millis(100)
            };
            if last_status.elapsed() >= status_interval {
                let _ = resp_tx.send(machine.format_status());
                last_status = Instant::now();
            }

            thread::sleep(Duration::from_millis(8));
        }
    });

    resp_rx
}
