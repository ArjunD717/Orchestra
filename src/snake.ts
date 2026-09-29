import blessed from "neo-blessed";

type Direction = "up" | "down" | "left" | "right";

interface Point {
  x: number;
  y: number;
}

interface SnakeState {
  snake: Point[];
  direction: Direction;
  pendingDirection: Direction;
  food: Point;
  score: number;
  bestScore: number;
  started: boolean;
  paused: boolean;
  gameOver: boolean;
  status: string;
}

const GRID_WIDTH = 22;
const GRID_HEIGHT = 14;
const TICK_MS = 110;

const DELTAS: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

const OPPOSITE: Record<Direction, Direction> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left"
};

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function randomFood(snake: Point[]): Point {
  const occupied = new Set(snake.map((part) => `${part.x},${part.y}`));
  const open: Point[] = [];
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      if (!occupied.has(`${x},${y}`)) {
        open.push({ x, y });
      }
    }
  }
  return open[Math.floor(Math.random() * open.length)] ?? { x: 0, y: 0 };
}

function createInitialState(bestScore = 0): SnakeState {
  const snake = [
    { x: Math.floor(GRID_WIDTH / 2), y: Math.floor(GRID_HEIGHT / 2) },
    { x: Math.floor(GRID_WIDTH / 2) - 1, y: Math.floor(GRID_HEIGHT / 2) },
    { x: Math.floor(GRID_WIDTH / 2) - 2, y: Math.floor(GRID_HEIGHT / 2) }
  ];
  return {
    snake,
    direction: "right",
    pendingDirection: "right",
    food: randomFood(snake),
    score: 0,
    bestScore,
    started: false,
    paused: true,
    gameOver: false,
    status: "Press Enter or move to start."
  };
}

function renderBoard(state: SnakeState): string {
  const snakeCells = new Map<string, number>(state.snake.map((part, index) => [`${part.x},${part.y}`, index]));
  const rows: string[] = [];
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const key = `${x},${y}`;
      if (state.food.x === x && state.food.y === y) {
        row.push("*");
        continue;
      }
      const index = snakeCells.get(key);
      if (index === 0) {
        row.push("@");
      } else if (index !== undefined) {
        row.push("o");
      } else {
        row.push(".");
      }
    }
    rows.push(row.join(" "));
  }
  return rows.join("\n");
}

function moveSnake(state: SnakeState): void {
  if (state.paused || state.gameOver || !state.started) {
    return;
  }

  state.direction = state.pendingDirection;
  const delta = DELTAS[state.direction];
  const nextHead = {
    x: state.snake[0].x + delta.x,
    y: state.snake[0].y + delta.y
  };

  if (nextHead.x < 0 || nextHead.y < 0 || nextHead.x >= GRID_WIDTH || nextHead.y >= GRID_HEIGHT) {
    state.gameOver = true;
    state.paused = true;
    state.bestScore = Math.max(state.bestScore, state.score);
    state.status = "You hit a wall. Press R to restart.";
    return;
  }

  const grow = samePoint(nextHead, state.food);
  const hitSelf = state.snake.some((part, index) => {
    if (!grow && index === state.snake.length - 1) {
      return false;
    }
    return samePoint(part, nextHead);
  });
  if (hitSelf) {
    state.gameOver = true;
    state.paused = true;
    state.bestScore = Math.max(state.bestScore, state.score);
    state.status = "You hit your tail. Press R to restart.";
    return;
  }

  state.snake.unshift(nextHead);
  if (grow) {
    state.score += 1;
    state.bestScore = Math.max(state.bestScore, state.score);
    state.food = randomFood(state.snake);
    state.status = "Food collected.";
    return;
  }

  state.snake.pop();
}

function setDirection(state: SnakeState, next: Direction): void {
  if (OPPOSITE[state.direction] === next && state.started) {
    return;
  }
  if (!state.started) {
    state.started = true;
    state.paused = false;
    state.status = "Run started.";
  }
  state.pendingDirection = next;
}

export async function runSnakeGame(): Promise<void> {
  await new Promise<void>((resolve) => {
    const screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: "Orchestra Snake"
    });

    const board = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: GRID_WIDTH * 2 + 4,
      height: GRID_HEIGHT + 2,
      border: "line",
      label: " Snake ",
      tags: false,
      style: { border: { fg: "green" } }
    });

    const hud = blessed.box({
      parent: screen,
      top: 0,
      left: GRID_WIDTH * 2 + 5,
      width: 34,
      height: 10,
      border: "line",
      label: " HUD ",
      tags: false,
      style: { border: { fg: "cyan" } }
    });

    const footer = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: false,
      style: { fg: "black", bg: "white" }
    });

    let state = createInitialState();
    let timer: NodeJS.Timeout | null = null;
    let closed = false;

    const render = (): void => {
      board.setContent(renderBoard(state));
      hud.setContent(
        [
          `Score: ${state.score}`,
          `Best: ${state.bestScore}`,
          `State: ${state.gameOver ? "game over" : state.paused ? "paused" : state.started ? "running" : "ready"}`,
          "",
          state.status,
          "",
          "Arrows/WASD move",
          "P or Space pause",
          "R restart",
          "Q quit"
        ].join("\n")
      );
      footer.setContent(" Orchestra Snake | Q quit ");
      screen.render();
    };

    const stop = (): void => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (closed) {
        return;
      }
      closed = true;
      screen.destroy();
      resolve();
    };

    timer = setInterval(() => {
      moveSnake(state);
      render();
    }, TICK_MS);

    screen.key(["up", "w"], () => setDirection(state, "up"));
    screen.key(["down", "s"], () => setDirection(state, "down"));
    screen.key(["left", "a"], () => setDirection(state, "left"));
    screen.key(["right", "d"], () => setDirection(state, "right"));
    screen.key(["enter"], () => {
      if (!state.started) {
        state.started = true;
        state.paused = false;
        state.status = "Run started.";
      } else if (state.gameOver) {
        state = createInitialState(state.bestScore);
      }
      render();
    });
    screen.key(["space", "p"], () => {
      if (!state.started || state.gameOver) {
        return;
      }
      state.paused = !state.paused;
      state.status = state.paused ? "Paused." : "Resumed.";
      render();
    });
    screen.key(["r"], () => {
      state = createInitialState(state.bestScore);
      render();
    });
    screen.key(["q", "C-c", "escape"], () => stop());

    render();
  });
}
