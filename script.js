/* ============================================================================
 * NEON RUSH 3D — script.js
 * Vanilla JS + Three.js r128 (global THREE, loaded from CDN in index.html)
 * ============================================================================
 * SECTION MAP
 *  0  Three.js availability guard
 *  1  Math helpers
 *  2  LocalStorage wrapper + settings keys
 *  3  DOM cache
 *  4  Tuning constants
 *  5  Quality presets
 *  6  Game state
 *  7  Audio engine (procedural, WebAudio)
 *  8  Three.js scene bootstrap
 *  9  Procedural textures
 * 10  World construction (road, ground, sky, buildings, streetlights, barriers)
 * 11  Vehicle factory + pools
 * 12  Input handling
 * 13  Game flow (menu / play / pause / game over / restart)
 * 14  Simulation (physics, traffic, collisions, camera)
 * 15  HUD + overlays
 * 16  Resize / context-loss / boot
 * ==========================================================================*/
(function () {
  'use strict';

  /* ==========================================================================
   * 0. THREE.JS AVAILABILITY GUARD
   * ========================================================================*/
  if (typeof THREE === 'undefined') {
    var errEl = document.getElementById('lib-error');
    if (errEl) errEl.classList.remove('hidden');
    var playBtn = document.getElementById('btn-play');
    if (playBtn) {
      playBtn.disabled = true;
      playBtn.textContent = 'OFFLINE';
    }
    // eslint-disable-next-line no-console
    console.error('[NEON RUSH 3D] Three.js failed to load. Internet connection required.');
    return;
  }

  /* ==========================================================================
   * 1. MATH HELPERS
   * ========================================================================*/
  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (min, max) => min + Math.random() * (max - min);
  const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  /** Frame-rate independent exponential smoothing. */
  const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));

  /* ==========================================================================
   * 2. PERSISTENCE
   * ========================================================================*/
  const Store = (function () {
    let usable = false;
    try {
      const probe = '__nr3d_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      usable = true;
    } catch (e) {
      usable = false; // Private mode / disabled storage / quota
    }
    const memory = Object.create(null);

    return {
      available: usable,
      get(key, fallback) {
        if (usable) {
          try {
            const raw = window.localStorage.getItem(key);
            if (raw !== null) return raw;
          } catch (e) { /* ignore, fall through to memory */ }
        }
        return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : fallback;
      },
      set(key, value) {
        memory[key] = String(value);
        if (!usable) return;
        try {
          window.localStorage.setItem(key, String(value));
        } catch (e) { /* quota exceeded — memory copy still holds */ }
      }
    };
  })();

  const KEY_BEST_SCORE = 'nr3d.bestScore';
  const KEY_BEST_DIST  = 'nr3d.bestDistance';
  const KEY_SOUND      = 'nr3d.sound';
  const KEY_QUALITY    = 'nr3d.quality';

  /* ==========================================================================
   * 3. DOM CACHE
   * ========================================================================*/
  const $ = (id) => document.getElementById(id);

  const dom = {
    canvas:        $('scene'),
    hud:           $('hud'),
    menu:          $('menu'),
    pause:         $('pause'),
    gameover:      $('gameover'),
    touch:         $('touch'),
    toast:         $('toast'),
    flash:         $('flash'),
    contextLost:   $('context-lost'),

    score:         $('score'),
    distance:      $('distance'),
    speed:         $('speed'),
    best:          $('best'),
    shieldFill:    $('shield-fill'),

    btnPlay:       $('btn-play'),
    btnSound:      $('btn-sound'),
    btnPause:      $('btn-pause'),
    btnResume:     $('btn-resume'),
    btnRestart:    $('btn-restart'),
    btnRestartP:   $('btn-restart-pause'),
    btnMenu:       $('btn-menu'),
    btnMenuP:      $('btn-menu-pause'),
    btnReload:     $('btn-reload'),

    menuBest:      $('menu-best'),
    menuBestDist:  $('menu-best-dist'),
    finalScore:    $('final-score'),
    finalDistance: $('final-distance'),
    finalBest:     $('final-best'),
    newBest:       $('new-best'),

    libError:      $('lib-error'),
    controlsHint:  $('controls-hint'),
    qualityWrap:   $('quality-buttons'),

    tLeft:         $('t-left'),
    tRight:        $('t-right'),
    tAccel:        $('t-accel'),
    tBrake:        $('t-brake')
  };/* ==========================================================================
 * 4. TUNING CONSTANTS
 * ========================================================================*/
const LANE_WIDTH     = 3.6;
const LANE_COUNT     = 4;
const ROAD_HALF      = (LANE_WIDTH * LANE_COUNT) / 2;   // 7.2
const DRIVE_LIMIT    = ROAD_HALF - 1.0;                 // 6.2
const ROAD_LENGTH    = 600;
const ROAD_TILE      = 10;                              // world units per texture tile
const ROAD_CENTER_Z  = -270;

const MAX_SPEED      = 88;      // world units / second  (≈ 317 km/h)
const ACCEL          = 27;
const BRAKE_DECEL    = 58;
const DRAG           = 8.5;
const MAX_LATERAL    = 17;

const COLLIDE_X      = 1.8;     // sum of half-widths minus forgiveness
const COLLIDE_Z      = 3.6;
const NEAR_MISS_X    = 3.9;

const RECYCLE_Z      = 22;      // recycle when an object passes the camera
const SPAWN_Z        = -320;

const BUILDING_SPAN  = 360;
const LIGHT_SPAN     = 320;

const WHEEL_RADIUS   = 0.42;
const BASE_FOV       = 62;

const CAR_POOL_SIZE      = 10;
const BUILDING_POOL_SIZE = 40;
const LIGHT_POOL_SIZE    = 16;

const CAR_COLORS = [
  0x00e5ff, 0xff2bd6, 0x45ffb0, 0xffb300,
  0xff2b55, 0x8b5cff, 0x00ffa3, 0xff6b00
];

/* ==========================================================================
 * 5. QUALITY PRESETS
 * ========================================================================*/
const QUALITY = {
  low: {
    pixelRatio: 1.0, antialias: false, shadows: false,
    fogFar: 200, buildings: 14, lights: 8, cars: 4, fovBoost: 6
  },
  medium: {
    pixelRatio: 1.5, antialias: true, shadows: false,
    fogFar: 260, buildings: 24, lights: 12, cars: 6, fovBoost: 8
  },
  high: {
    pixelRatio: 2.0, antialias: true, shadows: true,
    fogFar: 320, buildings: 34, lights: 16, cars: 8, fovBoost: 10
  }
};

/* ==========================================================================
 * 6. GAME STATE
 * ========================================================================*/
const game = {
  mode: 'menu',            // 'menu' | 'playing' | 'paused' | 'over'
  speed: 0,
  lateral: 0,
  playerX: 0,
  distance: 0,
  score: 0,
  damage: 100,
  difficulty: 1,
  elapsed: 0,
  collisionCooldown: 0,
  shake: 0,
  wheelSpin: 0,
  steerVisual: 0,
  bestScore: 0,
  bestDistance: 0,
  soundOn: true,
  quality: 'medium',
  touchUI: false
};

const input = { accel: false, brake: false, left: false, right: false };

/* ==========================================================================
 * 7. AUDIO (procedural — no external files)
 * ========================================================================*/
const SFX = (function () {
  let ctx = null;
  let master = null;
  let engineOsc = null;
  let engineGain = null;
  let engineFilter = null;
  let ready = false;

  function init() {
    if (ready) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = game.soundOn ? 0.32 : 0;
      master.connect(ctx.destination);

      engineOsc = ctx.createOscillator();
      engineOsc.type = 'sawtooth';
      engineOsc.frequency.value = 60;

      engineFilter = ctx.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.value = 750;
      engineFilter.Q.value = 4;

      engineGain = ctx.createGain();
      engineGain.gain.value = 0;

      engineOsc.connect(engineFilter);
      engineFilter.connect(engineGain);
      engineGain.connect(master);
      engineOsc.start();

      ready = true;
      return true;
    } catch (e) {
      ready = false;
      return false;
    }
  }

  return {
    unlock() {
      if (!init()) return;
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    },
    setMuted(muted) {
      if (!ready) return;
      master.gain.setTargetAtTime(muted ? 0 : 0.32, ctx.currentTime, 0.05);
    },
    /** Called every frame while playing. ratio = 0..1 */
    engine(ratio, active) {
      if (!ready) return;
      const target = active ? 0.05 + ratio * 0.09 : 0;
      engineGain.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
      engineOsc.frequency.setTargetAtTime(55 + ratio * 190, ctx.currentTime, 0.08);
      engineFilter.frequency.setTargetAtTime(500 + ratio * 1800, ctx.currentTime, 0.1);
    },
    crash() {
      if (!ready || !game.soundOn) return;
      const dur = 0.42;
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const t = i / data.length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6);
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const g = ctx.createGain();
      g.gain.value = 0.85;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1600;
      src.connect(f); f.connect(g); g.connect(master);
      src.start();
    },
    blip(freq) {
      if (!ready || !game.soundOn) return;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq || 660;
      g.gain.value = 0.0001;
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
      osc.connect(g); g.connect(master);
      osc.start();
      osc.stop(ctx.currentTime + 0.18);
    }
  };
})();/* ==========================================================================
 * 8. THREE.JS SCENE BOOTSTRAP
 * ========================================================================*/
let renderer = null;
let scene = null;
let camera = null;
let clock = null;
let rafId = 0;
let running = true;
let contextLost = false;

let keyLight = null;
let roadMesh = null;
let roadTexture = null;
let playerCar = null;
let playerWheels = [];
let playerFrontPivots = [];

const buildings = [];
const streetlights = [];
const aiCars = [];

const lookTarget = new THREE.Vector3(0, 1.7, -18);

/* ==========================================================================
 * 9. PROCEDURAL TEXTURES
 * ========================================================================*/
function makeRoadTexture() {
  const W = 256;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Asphalt base
  ctx.fillStyle = '#08080f';
  ctx.fillRect(0, 0, W, H);

  // Subtle grain
  for (let i = 0; i < 1400; i++) {
    const g = Math.floor(8 + Math.random() * 22);
    ctx.fillStyle = 'rgba(' + g + ',' + g + ',' + (g + 12) + ',0.55)';
    ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }

  // Outer neon edges (magenta)
  ctx.shadowBlur = 18;
  ctx.shadowColor = '#ff2bd6';
  ctx.fillStyle = '#ff2bd6';
  ctx.fillRect(2, 0, 5, H);
  ctx.fillRect(W - 7, 0, 5, H);

  // Lane dividers (cyan dashes)
  ctx.shadowBlur = 14;
  ctx.shadowColor = '#00e5ff';
  ctx.fillStyle = '#00e5ff';
  for (let lane = 1; lane < LANE_COUNT; lane++) {
    const x = (W / LANE_COUNT) * lane - 2;
    ctx.fillRect(x, 0, 4, H * 0.55);
  }
  ctx.shadowBlur = 0;

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, ROAD_LENGTH / ROAD_TILE);
  tex.needsUpdate = true;
  return tex;
}

function makeWindowTexture() {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, S, S);

  for (let y = 2; y < S - 4; y += 8) {
    for (let x = 2; x < S - 4; x += 8) {
      if (Math.random() < 0.55) {
        const a = 0.35 + Math.random() * 0.65;
        ctx.fillStyle = Math.random() < 0.5
          ? 'rgba(0,229,255,' + a.toFixed(2) + ')'
          : 'rgba(255,43,214,' + a.toFixed(2) + ')';
        ctx.fillRect(x, y, 4, 5);
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/* ==========================================================================
 * 10. WORLD CONSTRUCTION
 * ========================================================================*/

// Shared geometries (created once, reused by every instance)
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  road: new THREE.PlaneGeometry(ROAD_HALF * 2, ROAD_LENGTH),
  ground: new THREE.PlaneGeometry(700, 900),
  polePole: new THREE.CylinderGeometry(0.11, 0.16, 6.2, 6),
  poleLamp: new THREE.BoxGeometry(1.8, 0.18, 0.42),
  barrier: new THREE.BoxGeometry(0.4, 1.0, 1),
  barrierGlow: new THREE.BoxGeometry(0.16, 0.1, 1)
};

const MAT = {
  pole: new THREE.MeshLambertMaterial({ color: 0x1b1b30 }),
  lamp: new THREE.MeshBasicMaterial({ color: 0x8ff4ff }),
  ground: new THREE.MeshLambertMaterial({ color: 0x05050c }),
  barrier: new THREE.MeshLambertMaterial({ color: 0x121222 }),
  barrierGlow: new THREE.MeshBasicMaterial({ color: 0xff2bd6 })
};function buildScene() {
  /* ---------- Renderer ---------- */
  renderer = new THREE.WebGLRenderer({
    canvas: dom.canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false
  });
  renderer.setClearColor(0x05030f, 1);
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  /* ---------- Scene / camera ---------- */
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05030f);
  scene.fog = new THREE.Fog(0x05030f, 55, 260);

  camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.5, 900);
  camera.position.set(0, 4.9, 10.6);
  camera.lookAt(lookTarget);

  clock = new THREE.Clock();

  /* ---------- Lights (cheap: 3 total) ---------- */
  scene.add(new THREE.HemisphereLight(0x5566ff, 0x120020, 0.9));

  const ambient = new THREE.AmbientLight(0x30305a, 0.7);
  scene.add(ambient);

  keyLight = new THREE.DirectionalLight(0xbfe9ff, 0.85);
  keyLight.position.set(18, 40, 24);
  keyLight.castShadow = false;
  if (keyLight.shadow) {
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.camera.left = -30;
    keyLight.shadow.camera.right = 30;
    keyLight.shadow.camera.top = 40;
    keyLight.shadow.camera.bottom = -30;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 140;
  }
  scene.add(keyLight);
  scene.add(keyLight.target);

  // Magenta rim light for the neon vibe
  const rim = new THREE.PointLight(0xff2bd6, 1.1, 90, 2);
  rim.position.set(-14, 8, -12);
  scene.add(rim);

  /* ---------- Stars ---------- */
  const starCount = 420;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    starPos[i * 3]     = rand(-420, 420);
    starPos[i * 3 + 1] = rand(35, 190);
    starPos[i * 3 + 2] = rand(-520, 60);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: 0x9fc6ff, size: 1.8, sizeAttenuation: false,
    transparent: true, opacity: 0.85, fog: false
  }));
  scene.add(stars);

  /* ---------- Ground plane ---------- */
  const ground = new THREE.Mesh(GEO.ground, MAT.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.05, -250);
  scene.add(ground);

  /* ---------- Road ---------- */
  roadTexture = makeRoadTexture();
  roadTexture.anisotropy = Math.min(
    8,
    renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1
  );
  const roadMat = new THREE.MeshLambertMaterial({
    map: roadTexture,
    emissive: 0xffffff,
    emissiveMap: roadTexture,
    emissiveIntensity: 0.28,
    color: 0x888888
  });
  roadMesh = new THREE.Mesh(GEO.road, roadMat);
  roadMesh.rotation.x = -Math.PI / 2;
  roadMesh.position.set(0, 0, ROAD_CENTER_Z);
  scene.add(roadMesh);

  /* ---------- Barriers (static — texture motion sells the speed) ---------- */
  const barrierLength = ROAD_LENGTH;
  for (let side = -1; side <= 1; side += 2) {
    const barrier = new THREE.Mesh(GEO.barrier, MAT.barrier);
    barrier.scale.z = barrierLength;
    barrier.position.set(side * (ROAD_HALF + 0.5), 0.5, ROAD_CENTER_Z);
    scene.add(barrier);

    const glow = new THREE.Mesh(GEO.barrierGlow, MAT.barrierGlow);
    glow.scale.z = barrierLength;
    glow.position.set(side * (ROAD_HALF + 0.32), 1.02, ROAD_CENTER_Z);
    scene.add(glow);
  }

  /* ---------- Buildings pool ---------- */
  for (let i = 0; i < BUILDING_POOL_SIZE; i++) {
    const winTex = makeWindowTexture();
    winTex.repeat.set(3, 6);
    const mat = new THREE.MeshLambertMaterial({
      color: 0x0a0a16,
      emissive: 0xffffff,
      emissiveMap: winTex,
      emissiveIntensity: 0.9
    });
    const mesh = new THREE.Mesh(GEO.box, mat);
    mesh.visible = false;
    mesh.userData.windowTexture = winTex;
    scene.add(mesh);
    buildings.push(mesh);
  }

  /* ---------- Streetlight pool ---------- */
  for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
    const group = new THREE.Group();
    const side = (i % 2 === 0) ? -1 : 1;

    const pole = new THREE.Mesh(GEO.polePole, MAT.pole);
    pole.position.y = 3.1;
    group.add(pole);

    const lamp = new THREE.Mesh(GEO.poleLamp, MAT.lamp);
    lamp.position.set(-side * 0.9, 6.15, 0);
    group.add(lamp);

    group.position.set(side * (ROAD_HALF + 1.6), 0, 0);
    group.visible = false;
    scene.add(group);
    streetlights.push(group);
  }

  /* ---------- Player car ---------- */
  playerCar = createCar({ color: 0x00e5ff, glow: 0x004455, isPlayer: true });
  playerCar.position.set(0, 0, 0);
  scene.add(playerCar);

  /* ---------- AI car pool ---------- */
  for (let i = 0; i < CAR_POOL_SIZE; i++) {
    const color = CAR_COLORS[i % CAR_COLORS.length];
    const mesh = createCar({ color: color, glow: 0x110022, isPlayer: false });
    mesh.visible = false;
    scene.add(mesh);

    aiCars.push({
      mesh: mesh,
      wheels: mesh.userData.wheels,
      active: false,
      speed: 40,
      lane: 1,
      targetX: 0,
      laneTimer: 3,
      wheelSpin: 0,
      passed: false
    });
  }

  applyQuality(game.quality, true);
}/* ==========================================================================
 * 11. VEHICLE FACTORY
 * ========================================================================*/

// Shared car part geometries
const CAR_GEO = {
  body:    new THREE.BoxGeometry(1.9, 0.5, 4.2),
  skirt:   new THREE.BoxGeometry(1.72, 0.3, 4.0),
  cabin:   new THREE.BoxGeometry(1.46, 0.52, 1.9),
  nose:    new THREE.BoxGeometry(1.78, 0.2, 1.0),
  lightBar: new THREE.BoxGeometry(1.5, 0.12, 0.1),
  spoiler: new THREE.BoxGeometry(1.7, 0.08, 0.42),
  post:    new THREE.BoxGeometry(0.1, 0.28, 0.1),
  underglow: new THREE.PlaneGeometry(2.6, 4.8),
  wheel: (function () {
    const g = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.34, 12);
    g.rotateZ(Math.PI / 2); // axle along local X -> mesh.rotation.x = roll
    return g;
  })()
};

const HEADLIGHT_MAT = new THREE.MeshBasicMaterial({ color: 0xcdfaff });
const TAILLIGHT_MAT = new THREE.MeshBasicMaterial({ color: 0xff2b55 });
const WHEEL_MAT     = new THREE.MeshPhongMaterial({ color: 0x0d0d14, specular: 0x333344, shininess: 40 });

/**
 * Builds a low-poly but detailed neon sports car out of primitives.
 * Forward direction is -Z.
 */
function createCar(opts) {
  const group = new THREE.Group();
  const isPlayer = !!opts.isPlayer;

  const bodyMat = new THREE.MeshPhongMaterial({
    color: opts.color,
    specular: 0xffffff,
    shininess: 95,
    emissive: opts.glow || 0x000000,
    emissiveIntensity: 0.85
  });
  const skirtMat = new THREE.MeshPhongMaterial({
    color: 0x0b0b14, specular: 0x223344, shininess: 50
  });
  const glassMat = new THREE.MeshPhongMaterial({
    color: 0x08131f, specular: 0xaaddff, shininess: 130,
    transparent: true, opacity: 0.92
  });

  // Main body
  const body = new THREE.Mesh(CAR_GEO.body, bodyMat);
  body.position.y = 0.62;
  group.add(body);

  // Lower skirt
  const skirt = new THREE.Mesh(CAR_GEO.skirt, skirtMat);
  skirt.position.y = 0.36;
  group.add(skirt);

  // Cabin / cockpit
  const cabin = new THREE.Mesh(CAR_GEO.cabin, glassMat);
  cabin.position.set(0, 1.06, 0.15);
  group.add(cabin);

  // Nose wedge
  const nose = new THREE.Mesh(CAR_GEO.nose, bodyMat);
  nose.position.set(0, 0.5, -2.3);
  group.add(nose);

  // Headlights & taillights
  const head = new THREE.Mesh(CAR_GEO.lightBar, HEADLIGHT_MAT);
  head.position.set(0, 0.72, -2.1);
  group.add(head);

  const tail = new THREE.Mesh(CAR_GEO.lightBar, TAILLIGHT_MAT);
  tail.position.set(0, 0.76, 2.1);
  group.add(tail);

  // Spoiler
  const spoiler = new THREE.Mesh(CAR_GEO.spoiler, bodyMat);
  spoiler.position.set(0, 1.28, 1.95);
  group.add(spoiler);

  const postL = new THREE.Mesh(CAR_GEO.post, skirtMat);
  postL.position.set(-0.66, 1.14, 1.95);
  group.add(postL);

  const postR = new THREE.Mesh(CAR_GEO.post, skirtMat);
  postR.position.set(0.66, 1.14, 1.95);
  group.add(postR);

  // Wheels — front pair sits inside steering pivots
  const wheels = [];
  const frontPivots = [];
  const wheelSlots = [
    { x: -0.98, z: -1.35, front: true },
    { x:  0.98, z: -1.35, front: true },
    { x: -0.98, z:  1.35, front: false },
    { x:  0.98, z:  1.35, front: false }
  ];

  for (let i = 0; i < wheelSlots.length; i++) {
    const slot = wheelSlots[i];
    const wheel = new THREE.Mesh(CAR_GEO.wheel, WHEEL_MAT);

    if (slot.front) {
      const pivot = new THREE.Group();
      pivot.position.set(slot.x, WHEEL_RADIUS, slot.z);
      pivot.add(wheel);
      group.add(pivot);
      frontPivots.push(pivot);
    } else {
      wheel.position.set(slot.x, WHEEL_RADIUS, slot.z);
      group.add(wheel);
    }
    wheels.push(wheel);
  }

  // Player-only underglow
  if (isPlayer) {
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const glow = new THREE.Mesh(CAR_GEO.underglow, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.04;
    group.add(glow);
  }

  group.userData.wheels = wheels;
  group.userData.frontPivots = frontPivots;
  return group;
}/* ==========================================================================
 * 12. INPUT
 * ========================================================================*/
const KEY_MAP = {
  KeyW: 'accel', ArrowUp: 'accel',
  KeyS: 'brake', ArrowDown: 'brake', Space: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right'
};

function onKeyDown(e) {
  if (e.repeat) return;

  if (e.code === 'Escape' || e.code === 'KeyP') {
    e.preventDefault();
    if (game.mode === 'playing') pauseGame();
    else if (game.mode === 'paused') resumeGame();
    return;
  }

  if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    if (game.mode === 'menu' || game.mode === 'over') {
      e.preventDefault();
      startGame();
      return;
    }
  }

  const action = KEY_MAP[e.code];
  if (action) {
    e.preventDefault();
    input[action] = true;
    SFX.unlock();
  }
}

function onKeyUp(e) {
  const action = KEY_MAP[e.code];
  if (action) {
    e.preventDefault();
    input[action] = false;
  }
}

function bindHoldButton(el, prop) {
  if (!el) return;

  const press = function (e) {
    e.preventDefault();
    input[prop] = true;
    el.classList.add('active');
    SFX.unlock();
  };
  const release = function (e) {
    e.preventDefault();
    input[prop] = false;
    el.classList.remove('active');
  };

  el.addEventListener('pointerdown', press);
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
}

function bindInput() {
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp, { passive: false });

  // Release all inputs when the window loses focus
  window.addEventListener('blur', releaseAllInputs);

  bindHoldButton(dom.tLeft, 'left');
  bindHoldButton(dom.tRight, 'right');
  bindHoldButton(dom.tAccel, 'accel');
  bindHoldButton(dom.tBrake, 'brake');

  // Prevent page scrolling / pull-to-refresh over the play area
  document.addEventListener('touchmove', function (e) {
    if (e.target === dom.canvas) e.preventDefault();
  }, { passive: false });
}

function releaseAllInputs() {
  input.accel = input.brake = input.left = input.right = false;
  [dom.tLeft, dom.tRight, dom.tAccel, dom.tBrake].forEach(function (b) {
    if (b) b.classList.remove('active');
  });
}

/* ==========================================================================
 * 13. GAME FLOW
 * ========================================================================*/

function loadSettings() {
  game.bestScore = parseInt(Store.get(KEY_BEST_SCORE, '0'), 10) || 0;
  game.bestDistance = parseInt(Store.get(KEY_BEST_DIST, '0'), 10) || 0;
  game.soundOn = Store.get(KEY_SOUND, '1') === '1';

  const storedQuality = Store.get(KEY_QUALITY, '');
  if (QUALITY[storedQuality]) {
    game.quality = storedQuality;
  } else {
    // Sensible auto-default: low on very small / low-DPR-limited devices
    const dpr = window.devicePixelRatio || 1;
    const small = Math.min(window.innerWidth, window.innerHeight) < 420;
    game.quality = (dpr <= 1.5 || small) ? 'low' : (dpr >= 3 ? 'medium' : 'high');
  }

  game.touchUI = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

function applyQuality(name, initial) {
  const preset = QUALITY[name] ? name : 'medium';
  const q = QUALITY[preset];
  game.quality = preset;
  Store.set(KEY_QUALITY, preset);

  if (!renderer) return;

  const dpr = Math.min(window.devicePixelRatio || 1, q.pixelRatio);
  renderer.setPixelRatio(dpr);
  renderer.shadowMap.enabled = q.shadows;
  if (keyLight) keyLight.castShadow = q.shadows;

  if (scene && scene.fog) scene.fog.far = q.fogFar;

  // Buildings
  for (let i = 0; i < buildings.length; i++) {
    buildings[i].visible = i < q.buildings;
  }
  // Streetlights
  for (let i = 0; i < streetlights.length; i++) {
    streetlights[i].visible = i < q.lights;
  }
  // AI cars
  for (let i = 0; i < aiCars.length; i++) {
    const car = aiCars[i];
    const shouldBeActive = i < q.cars;
    if (shouldBeActive && !car.active) {
      car.active = true;
      car.mesh.visible = true;
      respawnCar(car, true);
    } else if (!shouldBeActive && car.active) {
      car.active = false;
      car.mesh.visible = false;
    }
  }

  // Refresh quality buttons in the menu
  const btns = dom.qualityWrap ? dom.qualityWrap.querySelectorAll('.qbtn') : [];
  for (let i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', btns[i].dataset.quality === preset);
  }

  if (!initial) onResize();
}

function layoutBuildings() {
  const active = QUALITY[game.quality].buildings;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (i >= active) { b.visible = false; continue; }
    b.visible = true;
    b.position.z = 20 - (i * BUILDING_SPAN) / active - rand(0, 8);
    randomizeBuilding(b);
  }
}

function randomizeBuilding(b) {
  const side = Math.random() < 0.5 ? -1 : 1;
  const width = rand(5, 13);
  const depth = rand(5, 13);
  const height = rand(14, 62);

  b.position.x = side * rand(ROAD_HALF + 7 + width * 0.5, ROAD_HALF + 34);
  b.scale.set(width, height, depth);
  b.position.y = height / 2;

  const tex = b.userData.windowTexture;
  if (tex) tex.repeat.set(Math.max(2, width / 2.6), Math.max(3, height / 5.5));

  b.rotation.y = rand(-0.12, 0.12);
}

function layoutLights() {
  const active = QUALITY[game.quality].lights;
  for (let i = 0; i < streetlights.length; i++) {
    const l = streetlights[i];
    if (i >= active) { l.visible = false; continue; }
    l.visible = true;
    l.position.z = 20 - (i * LIGHT_SPAN) / active;
  }
}

function respawnCar(car, initial) {
  const lane = randInt(0, LANE_COUNT - 1);
  const laneX = -ROAD_HALF + LANE_WIDTH * (lane + 0.5);

  car.mesh.position.x = laneX + rand(-0.35, 0.35);
  car.mesh.position.z = initial ? rand(-320, -45) : SPAWN_Z - rand(0, 150);
  car.mesh.rotation.set(0, 0, 0);

  car.lane = lane;
  car.targetX = car.mesh.position.x;
  car.laneTimer = rand(2.5, 6.5);
  car.passed = false;
  car.wheelSpin = 0;

  const difficultyBoost = 0.9 + 0.12 * (game.difficulty - 1);
  const isRival = Math.random() < 0.35;
  car.speed = isRival
    ? rand(60, 78) * difficultyBoost
    : rand(26, 56);
}function resetWorld() {
  game.speed = 0;
  game.lateral = 0;
  game.playerX = 0;
  game.distance = 0;
  game.score = 0;
  game.damage = 100;
  game.difficulty = 1;
  game.elapsed = 0;
  game.collisionCooldown = 0;
  game.shake = 0;
  game.wheelSpin = 0;
  game.steerVisual = 0;

  releaseAllInputs();

  if (playerCar) {
    playerCar.position.set(0, 0, 0);
    playerCar.rotation.set(0, 0, 0);
  }
  for (let i = 0; i < playerWheels.length; i++) playerWheels[i].rotation.x = 0;
  for (let i = 0; i < playerFrontPivots.length; i++) playerFrontPivots[i].rotation.y = 0;

  layoutBuildings();
  layoutLights();

  const activeCars = QUALITY[game.quality].cars;
  for (let i = 0; i < aiCars.length; i++) {
    const car = aiCars[i];
    if (i < activeCars) {
      car.active = true;
      car.mesh.visible = true;
      respawnCar(car, true);
    } else {
      car.active = false;
      car.mesh.visible = false;
    }
  }

  if (camera) {
    camera.position.set(0, 4.9, 10.6);
    camera.fov = BASE_FOV;
    camera.updateProjectionMatrix();
  }
  if (roadTexture) roadTexture.offset.y = 0;

  updateHud(true);
}

function startGame() {
  SFX.unlock();
  resetWorld();
  game.mode = 'playing';
  dom.menu.classList.add('hidden');
  dom.pause.classList.add('hidden');
  dom.gameover.classList.add('hidden');
  dom.hud.classList.remove('hidden');
  dom.newBest.classList.add('hidden');
  if (game.touchUI) dom.touch.classList.remove('hidden');
  SFX.blip(720);
  updateHud(true);
}

function goToMenu() {
  game.mode = 'menu';
  resetWorld();
  game.speed = 0;
  dom.menu.classList.remove('hidden');
  dom.pause.classList.add('hidden');
  dom.gameover.classList.add('hidden');
  dom.hud.classList.add('hidden');
  dom.touch.classList.add('hidden');
  updateMenuBest();
}

function pauseGame() {
  if (game.mode !== 'playing') return;
  game.mode = 'paused';
  releaseAllInputs();
  dom.pause.classList.remove('hidden');
  dom.touch.classList.add('hidden');
  SFX.engine(0, false);
  SFX.blip(420);
}

function resumeGame() {
  if (game.mode !== 'paused') return;
  game.mode = 'playing';
  dom.pause.classList.add('hidden');
  if (game.touchUI) dom.touch.classList.remove('hidden');
  clock.getDelta(); // flush accumulated time so nothing jumps
  SFX.blip(640);
}

function endGame() {
  if (game.mode !== 'playing') return;
  game.mode = 'over';

  const finalScore = Math.floor(game.score);
  const finalDistance = Math.floor(game.distance);
  let isRecord = false;

  if (finalScore > game.bestScore) {
    game.bestScore = finalScore;
    Store.set(KEY_BEST_SCORE, finalScore);
    isRecord = true;
  }
  if (finalDistance > game.bestDistance) {
    game.bestDistance = finalDistance;
    Store.set(KEY_BEST_DIST, finalDistance);
    isRecord = true;
  }

  dom.finalScore.textContent = String(finalScore);
  dom.finalDistance.textContent = finalDistance + ' m';
  dom.finalBest.textContent = String(game.bestScore);
  dom.newBest.classList.toggle('hidden', !isRecord);

  dom.hud.classList.add('hidden');
  dom.touch.classList.add('hidden');
  dom.gameover.classList.remove('hidden');

  releaseAllInputs();
  SFX.engine(0, false);
  SFX.blip(240);
  updateMenuBest();
}

/* ==========================================================================
 * 14. SIMULATION
 * ========================================================================*/

function updatePlay(dt) {
  game.elapsed += dt;
  game.collisionCooldown = Math.max(0, game.collisionCooldown - dt);

  /* ---------- Inputs ---------- */
  const throttle = input.accel ? 1 : 0;
  const braking = input.brake ? 1 : 0;
  const steerInput = (input.left ? -1 : 0) + (input.right ? 1 : 0);

  /* ---------- Longitudinal physics ---------- */
  if (braking) {
    game.speed -= BRAKE_DECEL * dt;
  } else if (throttle) {
    game.speed += ACCEL * dt;
  } else {
    game.speed -= DRAG * dt;
  }
  game.speed = clamp(game.speed, 0, MAX_SPEED);

  /* ---------- Lateral physics ---------- */
  const steerAuthority = clamp(game.speed / 18, 0, 1);
  const targetLateral = steerInput * MAX_LATERAL * steerAuthority;
  game.lateral = damp(game.lateral, targetLateral, 9, dt);

  game.playerX += game.lateral * dt;
  if (game.playerX < -DRIVE_LIMIT) {
    game.playerX = -DRIVE_LIMIT;
    game.lateral = 0;
  } else if (game.playerX > DRIVE_LIMIT) {
    game.playerX = DRIVE_LIMIT;
    game.lateral = 0;
  }

  /* ---------- Progression ---------- */
  const traveled = game.speed * dt;
  game.distance += traveled;
  game.score += traveled * 0.55;
  game.difficulty = 1 + Math.min(game.distance / 4000, 1.2);

  /* ---------- World scroll ---------- */
  scrollWorld(traveled);
  updateTraffic(dt, game.speed, true);

  /* ---------- Player car transform & animation ---------- */
  playerCar.position.x = game.playerX;
  playerCar.rotation.z = -game.lateral * 0.014;
  playerCar.rotation.y = -game.lateral * 0.018;

  game.wheelSpin += (game.speed / WHEEL_RADIUS) * dt;
  for (let i = 0; i < playerWheels.length; i++) {
    playerWheels[i].rotation.x = game.wheelSpin;
  }

  game.steerVisual = damp(game.steerVisual, steerInput * 0.5, 12, dt);
  for (let i = 0; i < playerFrontPivots.length; i++) {
    playerFrontPivots[i].rotation.y = game.steerVisual;
  }

  /* ---------- Camera & audio ---------- */
  updateChaseCamera(dt);
  SFX.engine(clamp(game.speed / MAX_SPEED, 0, 1), true);

  /* ---------- Death ---------- */
  if (game.damage <= 0) endGame();
}

function scrollWorld(distance) {
  // Road texture scroll (the cheapest possible infinite highway)
  roadTexture.offset.y += distance / ROAD_TILE;

  // Buildings
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (!b.visible) continue;
    b.position.z += distance;
    if (b.position.z > RECYCLE_Z + 20) {
      b.position.z -= BUILDING_SPAN;
      randomizeBuilding(b);
    }
  }

  // Streetlights
  for (let i = 0; i < streetlights.length; i++) {
    const l = streetlights[i];
    if (!l.visible) continue;
    l.position.z += distance;
    if (l.position.z > RECYCLE_Z + 10) l.position.z -= LIGHT_SPAN;
  }
}

function updateTraffic(dt, playerSpeed, collisionsEnabled) {
  for (let i = 0; i < aiCars.length; i++) {
    const car = aiCars[i];
    if (!car.active) continue;

    const prevZ = car.mesh.position.z;

    // Relative motion: the world moves toward the camera at playerSpeed
    car.mesh.position.z += (playerSpeed - car.speed) * dt;

    // Occasional lane changes
    car.laneTimer -= dt;
    if (car.laneTimer <= 0) {
      car.laneTimer = rand(2.5, 6.5);
      const dir = Math.random() < 0.5 ? -1 : 1;
      car.lane = clamp(car.lane + dir, 0, LANE_COUNT - 1);
      car.targetX = -ROAD_HALF + LANE_WIDTH * (car.lane + 0.5);
    }
    car.mesh.position.x = damp(car.mesh.position.x, car.targetX, 2.2, dt);

    // Recycle behind / far ahead
    if (car.mesh.position.z > RECYCLE_Z) { respawnCar(car, false); continue; }
    if (car.mesh.position.z < -470)       { respawnCar(car, false); continue; }

    // Wheel spin
    car.wheelSpin += (car.speed / WHEEL_RADIUS) * dt;
    for (let w = 0; w < car.wheels.length; w++) {
      car.wheels[w].rotation.x = car.wheelSpin;
    }

    if (!collisionsEnabled) continue;

    /* ---------- Collision ---------- */
    const dx = Math.abs(car.mesh.position.x - game.playerX);
    const dz = Math.abs(car.mesh.position.z);

    if (dx < COLLIDE_X && dz < COLLIDE_Z) {
      handleCollision(car);
    } else if (!car.passed && prevZ < 0 && car.mesh.position.z >= 0 &&
               dx < NEAR_MISS_X && dx > COLLIDE_X) {
      car.passed = true;
      game.score += 25;
      showToast('NEAR MISS +25');
      SFX.blip(880);
    }
  }
}

function handleCollision(car) {
  if (game.collisionCooldown > 0) return;

  game.collisionCooldown = 0.8;
  game.damage = Math.max(0, game.damage - 22);
  game.speed *= 0.45;
  game.shake = 1.0;

  // Knock the player sideways, away from the impact
  const dir = game.playerX < car.mesh.position.x ? -1 : 1;
  game.playerX = clamp(game.playerX + dir * 0.9, -DRIVE_LIMIT, DRIVE_LIMIT);
  game.lateral = dir * 6;

  // Push the AI car so it cannot immediately re-trigger
  car.mesh.position.z -= 4.5;
  car.speed *= 0.8;
  car.passed = true;

  triggerFlash();
  SFX.crash();
  updateHud(true);
}

function triggerFlash() {
  dom.flash.style.transition = 'none';
  dom.flash.style.opacity = '0.85';
  // Force style flush, then fade out
  void dom.flash.offsetWidth;
  requestAnimationFrame(function () {
    dom.flash.style.transition = 'opacity 0.45s ease-out';
    dom.flash.style.opacity = '0';
  });
}

let toastTimeout = 0;
function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.remove('show');
  void dom.toast.offsetWidth;
  dom.toast.classList.add('show');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(function () {
    dom.toast.classList.remove('show');
  }, 1100);
}

function updateChaseCamera(dt) {
  const speedRatio = clamp(game.speed / MAX_SPEED, 0, 1);

  camera.position.x = damp(camera.position.x, game.playerX * 0.6, 6, dt);
  camera.position.y = damp(camera.position.y, 4.9, 6, dt);
  camera.position.z = 10.6;

  if (game.shake > 0) {
    game.shake = Math.max(0, game.shake - dt * 2.4);
    const s = game.shake * 0.85;
    camera.position.x += rand(-s, s);
    camera.position.y += rand(-s, s);
  }

  lookTarget.set(game.playerX * 0.72, 1.7, -18);
  camera.lookAt(lookTarget);

  const targetFov = BASE_FOV + speedRatio * QUALITY[game.quality].fovBoost + portraitFovBoost;
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov = damp(camera.fov, targetFov, 4, dt);
    camera.updateProjectionMatrix();
  }
}

let menuOrbit = 0;
function updateMenu(dt) {
  game.elapsed += dt;
  menuOrbit += dt * 0.22;

  const menuSpeed = 32;
  const traveled = menuSpeed * dt;

  scrollWorld(traveled);
  updateTraffic(dt, menuSpeed, false);

  game.wheelSpin += (menuSpeed / WHEEL_RADIUS) * dt;
  for (let i = 0; i < playerWheels.length; i++) {
    playerWheels[i].rotation.x = game.wheelSpin;
  }
  playerCar.position.x = Math.sin(game.elapsed * 0.55) * 1.6;
  playerCar.rotation.y = -Math.sin(game.elapsed * 0.55) * 0.09;
  playerCar.rotation.z = Math.sin(game.elapsed * 0.55) * 0.02;

  const radius = 9.5;
  camera.position.x = Math.sin(menuOrbit) * radius;
  camera.position.y = 4.3 + Math.sin(game.elapsed * 0.5) * 0.45;
  camera.position.z = Math.cos(menuOrbit) * radius;
  camera.lookAt(playerCar.position.x * 0.5, 1.15, 0);

  if (Math.abs(camera.fov - BASE_FOV) > 0.05) {
    camera.fov = BASE_FOV;
    camera.updateProjectionMatrix();
  }
}  /* ==========================================================================
   * 15. HUD & OVERLAYS
   * ========================================================================*/
  let hudAccumulator = 0;
  let lastShieldClass = '';

  function updateHud(force) {
    const score = Math.floor(game.score);
    const distance = Math.floor(game.distance);
    const kmh = Math.round(game.speed * 3.6);

    if (force || dom.score.textContent !== String(score)) {
      dom.score.textContent = String(score);
    }
    if (force || dom.distance.textContent !== distance + ' m') {
      dom.distance.textContent = distance + ' m';
    }
    if (force || dom.speed.textContent !== String(kmh)) {
      dom.speed.textContent = String(kmh);
    }
    if (force || dom.best.textContent !== String(game.bestScore)) {
      dom.best.textContent = String(game.bestScore);
    }

    const pct = clamp(game.damage, 0, 100);
    dom.shieldFill.style.width = pct + '%';

    let cls = '';
    if (pct <= 25) cls = 'crit';
    else if (pct <= 55) cls = 'low';
    if (cls !== lastShieldClass) {
      dom.shieldFill.classList.remove('low', 'crit');
      if (cls) dom.shieldFill.classList.add(cls);
      lastShieldClass = cls;
    }
  }

  function updateMenuBest() {
    dom.menuBest.textContent = String(game.bestScore);
    dom.menuBestDist.textContent = game.bestDistance + ' m';
  }

  function updateSoundButton() {
    dom.btnSound.innerHTML = game.soundOn ? '&#128266;' : '&#128263;';
    dom.btnSound.classList.toggle('muted', !game.soundOn);
    dom.btnSound.setAttribute('aria-label', game.soundOn ? 'Mute sound' : 'Unmute sound');
  }

  function toggleSound() {
    game.soundOn = !game.soundOn;
    Store.set(KEY_SOUND, game.soundOn ? '1' : '0');
    SFX.unlock();
    SFX.setMuted(!game.soundOn);
    updateSoundButton();
    if (game.soundOn) SFX.blip(760);
  }

  function bindUI() {
    /* ---- Main menu ---- */
    dom.btnPlay.addEventListener('click', startGame);

    if (dom.qualityWrap) {
      dom.qualityWrap.addEventListener('click', function (e) {
        const target = e.target.closest ? e.target.closest('.qbtn') : null;
        if (!target) return;
        applyQuality(target.dataset.quality, false);
        SFX.blip(560);
      });
    }

    /* ---- HUD ---- */
    dom.btnPause.addEventListener('click', function () {
      if (game.mode === 'playing') pauseGame();
      else if (game.mode === 'paused') resumeGame();
    });
    dom.btnSound.addEventListener('click', toggleSound);

    /* ---- Pause menu ---- */
    dom.btnResume.addEventListener('click', resumeGame);
    dom.btnRestartP.addEventListener('click', startGame);
    dom.btnMenuP.addEventListener('click', goToMenu);

    /* ---- Game over ---- */
    dom.btnRestart.addEventListener('click', startGame);
    dom.btnMenu.addEventListener('click', goToMenu);

    /* ---- Context lost ---- */
    dom.btnReload.addEventListener('click', function () { window.location.reload(); });

    /* ---- WebGL context loss ---- */
    dom.canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      contextLost = true;
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      if (game.mode === 'playing') pauseGame();
      dom.contextLost.classList.remove('hidden');
    }, false);

    dom.canvas.addEventListener('webglcontextrestored', function () {
      contextLost = false;
      dom.contextLost.classList.add('hidden');
      running = true;
      clock.getDelta();
      if (!rafId) rafId = requestAnimationFrame(animate);
    }, false);

    /* ---- Auto-pause when the tab is hidden ---- */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && game.mode === 'playing') pauseGame();
    });

    updateSoundButton();
  }

  /* ==========================================================================
   * 16. RESIZE / LOOP / BOOT
   * ========================================================================*/
  let portraitFovBoost = 0;

  function onResize() {
    if (!renderer || !camera) return;

    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const aspect = w / h;

    camera.aspect = aspect;
    // Portrait screens need a wider vertical FOV so the road stays readable
    portraitFovBoost = aspect < 1 ? (1 - aspect) * 20 : 0;
    camera.updateProjectionMatrix();

    renderer.setSize(w, h, false);
  }

  function animate() {
    rafId = requestAnimationFrame(animate);

    if (!running || contextLost) return;

    const dt = Math.min(clock.getDelta(), 0.05); // clamp: no huge jumps after tab-switch

    if (game.mode === 'playing') {
      updatePlay(dt);
      hudAccumulator += dt;
      if (hudAccumulator >= 0.08) {   // ~12 HUD updates / second
        hudAccumulator = 0;
        updateHud(false);
      }
    } else if (game.mode === 'menu') {
      updateMenu(dt);
    }

    renderer.render(scene, camera);
  }

  function init() {
    loadSettings();

    // Apply touch UI visibility immediately (before the first frame)
    if (!game.touchUI) dom.touch.classList.add('hidden');

    buildScene();
    bindInput();
    bindUI();

    playerWheels = playerCar.userData.wheels;
    playerFrontPivots = playerCar.userData.frontPivots;

    onResize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', function () {
      // Some browsers report stale sizes on orientationchange
      setTimeout(onResize, 120);
    });

    goToMenu();
    updateSoundButton();

    clock.getDelta(); // discard the load-time delta
    rafId = requestAnimationFrame(animate);

    // eslint-disable-next-line no-console
    console.log('[NEON RUSH 3D] ready — quality:', game.quality,
      '| touch:', game.touchUI, '| storage:', Store.available);
  }

  init();

})();