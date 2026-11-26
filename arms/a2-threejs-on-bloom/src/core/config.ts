// Central gameplay tuning. All units SI (m, s, m/s) unless suffixed.
export const KMH = 1 / 3.6;

export const RACE = {
  laps: 3,
  countdownSeconds: 3,
  physicsHz: 120,
  autoResetSeconds: 3,
  resultsDelay: 2.5,
};

export const CAR = {
  mass: 1420,
  wheelbase: 2.7,
  /** Collision circles along the car's local Z axis (front, middle, rear) */
  circleOffsets: [-1.42, 0, 1.42] as const,
  circleRadius: 1.0,
  topSpeed: 250 * KMH,
  nitroTopSpeed: 300 * KMH,
  engineAccel: 11.5, // m/s^2 at standstill
  nitroAccel: 12.0, // extra m/s^2 while boosting
  brakeDecel: 20,
  reverseAccel: 7,
  reverseMax: 12,
  engineBraking: 1.2,
  rollingDrag: 0.25,
  handbrakeDecel: 5.5,
  latAccelMax: 17, // m/s^2 grip limit on asphalt (~1.7 g, arcade)
  maxSteerLow: 0.6, // rad at standstill
  steerFalloff: 16, // m/s, speed where steering halves
  minSteer: 0.045,
  gripYawRate: 11, // how fast yaw rate follows target when gripping
  lateralGrip: 9, // lateral velocity decay rate (1/s)
  driftLateralGrip: 1.5, // how fast the velocity swings towards the nose in a drift (1/s)
  driftYawRate: 10, // yaw-rate response in a drift
  driftSlipNeutral: 0.2, // target drift angle (rad) with neutral steering
  driftSlipMax: 0.7, // ... steering fully into the drift (~40 deg)
  driftSlipHandbrake: 0.42, // ... minimum while the handbrake is held
  driftSlipGain: 5, // yaw correction per rad of drift-angle error
  driftSpeedKeep: 0.4, // share of scrubbed lateral speed fed back into forward speed
  driftDrag: 2.2, // m/s^2 extra drag while sliding
  offroadGrip: 0.6,
  offroadDrag: 3.0, // m/s^2 (manifest suggested_rolling_drag)
  offroadDragQuad: 0.012,
  gravity: 9.81,
  gears: [0, 62, 102, 142, 184, 228, 292].map((k) => k * KMH), // gear upper bounds (index = gear)
  shiftTime: 0.16,
  idleRpm: 900,
  redline: 7600,
};

export const NITRO = {
  burnPerSecond: 1 / 3.2, // full bar lasts ~3.2 s
  minToStart: 0.12,
  driftFillPerSecond: 0.24,
  draftFillPerSecond: 0.16,
  draftDistance: 24,
  draftLateral: 3.2,
  aiPassiveFill: 0.035,
};

export const WALL = {
  restitution: 0.18,
  friction: 0.12,
  angularScale: 0.45,
};
