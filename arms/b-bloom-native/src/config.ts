// Gameplay tuning constants (one place to tweak the feel).

export const TOTAL_LAPS = 3;
export const NUM_CARS = 4;
export const PHYSICS_HZ = 60;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

// --- car geometry (from manifest.car.metrics) ---
export const CAR_MASS = 1420;
export const WHEEL_RADIUS = 0.34;
export const WHEEL_X = 0.83;
export const WHEEL_Z = 1.35; // front wheels at -Z (forward = -Z)
export const COM_Y = 0.46;
export const COM_Z = -0.08;

// --- suspension ---
export const SUSP_REST = 0.12 + 0.2; // ray from wheel centre + rest length
export const SUSP_TRAVEL = 0.3;
export const SUSP_K = 42000;
export const SUSP_DAMP = 3600;

// --- drivetrain (arcade) ---
export const TOP_SPEED = 250 / 3.6;      // m/s, displayed/flat-out target
export const ENGINE_VMAX = 266 / 3.6;    // engine curve asymptote (drag brings it to ~250)
export const NITRO_TOP_SPEED = 300 / 3.6;
export const ENGINE_ACCEL = 10.5;         // m/s^2 at standstill
export const NITRO_ACCEL = 9.0;           // extra m/s^2 while boosting
export const BRAKE_DECEL = 22;
export const REVERSE_SPEED = 30 / 3.6;
export const ROLL_DRAG = 0.4;             // m/s^2 coasting
export const AIR_DRAG = 0.00025;           // * v^2
export const OFFROAD_DRAG = 3.0;          // m/s^2 extra on grass/gravel
export const GEAR_TOP_KMH: number[] = [0, 58, 98, 138, 178, 220, 262];
export const IDLE_RPM = 900;
export const REDLINE_RPM = 7600;
export const SHIFT_TIME = 0.16;

// --- steering / tyres ---
export const MAX_STEER_LOW = 0.6;   // rad at low speed
export const MAX_STEER_HIGH = 0.11; // rad at top speed
export const STEER_RATE = 4.5;      // rad/s of steer input change
export const TYRE_GRIP = 1.55;      // friction coefficient (arcade > real)
export const OFFROAD_GRIP = 0.75;
export const HANDBRAKE_REAR_GRIP = 0.32;
export const DRIFT_REAR_GRIP = 0.62; // reduced rear grip while a drift is held

// --- nitro ---
export const NITRO_MAX = 1;
export const NITRO_BURN = 0.28;          // per second while active
export const NITRO_DRIFT_GAIN = 0.16;    // per second of drifting
export const NITRO_DRAFT_GAIN = 0.09;    // per second slipstreaming
export const NITRO_START = 0.25;

// --- reset ---
export const RESET_AFTER = 3.0;
