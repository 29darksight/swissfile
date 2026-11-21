import { state } from './state.js';

export function initBackgroundCanvas() {
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const CELL_STEP = 16;
  const CELL_SIZE = 15;
  // Strictly monochrome dark-to-mid charcoal grey tones
  const TILE_COLORS = ['#13161D', '#191D26', '#222733', '#2F3646'];

  let cols = 0;
  let rows = 0;
  let tiles = [];
  let lastFrameMs = 0;

  function initTiles() {
    cols = Math.max(12, Math.ceil(window.innerWidth / CELL_STEP));
    rows = Math.max(10, Math.ceil(window.innerHeight / CELL_STEP));
    canvas.width = cols * CELL_STEP;
    canvas.height = rows * CELL_STEP;

    // Sparse active pixels so background remains atmospheric and understated
    const targetCount = Math.min(240, Math.max(25, Math.floor(cols * rows * 0.05)));
    const used = new Set();
    tiles = [];

    for (let i = 0; i < targetCount; i++) {
      let c = Math.floor(Math.random() * cols);
      let r = Math.floor(Math.random() * rows);
      let guard = 0;
      while (used.has(`${c},${r}`) && guard < 12) {
        c = Math.floor(Math.random() * cols);
        r = Math.floor(Math.random() * rows);
        guard++;
      }
      used.add(`${c},${r}`);

      // Calm breathing cycle over ~6-10 seconds per pulse
      tiles.push({
        col: c,
        row: r,
        color: TILE_COLORS[i % TILE_COLORS.length],
        phase: Math.random() * Math.PI * 2,
        speed: (Math.PI * 2) / (6.5 + Math.random() * 3.5),
        maxAlpha: 0.06 + Math.random() * 0.10,
        moveTimer: 6.0 + Math.random() * 6.0,
      });
    }

    drawGrid(0);
  }

  function drawGrid(dt) {
    ctx.fillStyle = '#0B0D11';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#11141A';
    for (let c = 0; c < cols; c++) {
      ctx.fillRect(c * CELL_STEP + CELL_SIZE, 0, 1, canvas.height);
    }
    for (let r = 0; r < rows; r++) {
      ctx.fillRect(0, r * CELL_STEP + CELL_SIZE, canvas.width, 1);
    }

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      t.phase += t.speed * dt;
      t.moveTimer -= dt;

      // Slow smooth sine-wave breath
      const breath = 0.5 + 0.5 * Math.sin(t.phase);

      if (t.moveTimer <= 0) {
        t.moveTimer = 6.0 + Math.random() * 6.0;
        if (breath < 0.2) {
          t.col = Math.floor(Math.random() * cols);
          t.row = Math.floor(Math.random() * rows);
        }
      }

      ctx.globalAlpha = 0.01 + t.maxAlpha * breath;
      ctx.fillStyle = t.color;
      ctx.fillRect(t.col * CELL_STEP, t.row * CELL_STEP, CELL_SIZE, CELL_SIZE);
    }
    ctx.globalAlpha = 1;
  }

  function loop(now) {
    if (!lastFrameMs) lastFrameMs = now;
    const delta = now - lastFrameMs;
    // Smooth 25 fps throttle for slow breathing with minimal CPU/GPU overhead
    if (state.bgMoving && delta >= 40) {
      const dt = Math.min(0.08, delta / 1000);
      lastFrameMs = now;
      drawGrid(dt);
    } else if (!state.bgMoving) {
      lastFrameMs = now;
    }
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', initTiles);
  initTiles();
  requestAnimationFrame(loop);
}
