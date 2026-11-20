import { state } from './state.js';

export function initBackgroundCanvas() {
  const canvas = document.getElementById('bgCanvas');
        const ctx = canvas.getContext('2d');
        const CELL_STEP = 14;
        const CELL_SIZE = 13;
        const TILE_COLORS = ['#0D182E', '#132342', '#1A315C', '#224078'];

        let cols = 0;
        let rows = 0;
        let tiles = [];
        let lastFrameMs = 0;

        function initTiles() {
          cols = Math.max(12, Math.ceil(window.innerWidth / CELL_STEP));
          rows = Math.max(10, Math.ceil(window.innerHeight / CELL_STEP));
          canvas.width = cols * CELL_STEP;
          canvas.height = rows * CELL_STEP;

          const targetCount = Math.min(900, Math.max(45, Math.floor(cols * rows * 0.18)));
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

            tiles.push({
              col: c,
              row: r,
              color: TILE_COLORS[i % TILE_COLORS.length],
              phase: Math.random() * Math.PI * 2,
              speed: (Math.PI * 2) / (8 + Math.random() * 8),
              maxAlpha: 0.16 + Math.random() * 0.22,
              moveTimer: 1.4 + Math.random() * 3.0,
            });
          }

          drawGrid(0);
        }

        function drawGrid(dt) {
          ctx.fillStyle = '#070B14';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          ctx.fillStyle = '#0A101E';
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

            const breath = 0.5 + 0.5 * Math.sin(t.phase);

            if (t.moveTimer <= 0) {
              t.moveTimer = 1.8 + Math.random() * 3.4;
              if (breath < 0.25 && Math.random() < 0.55) {
                t.col = Math.floor(Math.random() * cols);
                t.row = Math.floor(Math.random() * rows);
              } else {
                const dir = Math.floor(Math.random() * 4);
                if (dir === 0) t.col = (t.col + 1) % cols;
                else if (dir === 1) t.col = (t.col - 1 + cols) % cols;
                else if (dir === 2) t.row = (t.row + 1) % rows;
                else t.row = (t.row - 1 + rows) % rows;
              }
            }

            ctx.globalAlpha = 0.02 + t.maxAlpha * breath;
            ctx.fillStyle = t.color;
            ctx.fillRect(t.col * CELL_STEP, t.row * CELL_STEP, CELL_SIZE, CELL_SIZE);
          }
          ctx.globalAlpha = 1;
        }

        function loop(now) {
          if (!lastFrameMs) lastFrameMs = now;
          const delta = now - lastFrameMs;
          if (state.bgMoving && delta >= 42) {
            const dt = Math.min(0.12, delta / 1000);
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

