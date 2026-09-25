// A terminal screen for the browser terminal (PLAN.md §7.6): the common VT100 / xterm subset a shell,
// `top`, `less` or `vim` emits, parsed as a stream (sequences may split across writes) into a grid of
// styled cells, with scrollback and the alternate screen. No DOM: a view renders `snapshot()` rows as
// runs of equally styled text. Unknown sequences are consumed and ignored, never printed. Every code
// point takes one cell (wide CJK / emoji characters are not doubled).

export interface CellStyle {
  /** 0-255 palette index, or `#rrggbb`; undefined is the default color. */
  fg?: number | string;
  bg?: number | string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface ScreenRun {
  text: string;
  style: CellStyle;
}

export interface ScreenSnapshot {
  rows: number;
  cols: number;
  /** One entry per row, top to bottom: runs of equally styled text (trailing blanks trimmed). */
  lines: ScreenRun[][];
  cursor: { row: number; col: number; visible: boolean };
  /** Lines scrolled off the main screen, oldest first. */
  scrollback: ScreenRun[][];
  /** The window title the program set (OSC 0 / 2). */
  title?: string;
  alternate: boolean;
}

export interface Screen {
  write(data: string): void;
  resize(rows: number, cols: number): void;
  reset(): void;
  snapshot(): ScreenSnapshot;
  /** Bumps on every change, for views that re-render on demand. */
  readonly version: number;
}

interface Cell {
  ch: string;
  style: CellStyle;
}

const blankStyle: CellStyle = Object.freeze({});
const blank = (style: CellStyle = blankStyle): Cell => ({ ch: ' ', style });
const row = (cols: number, style?: CellStyle): Cell[] =>
  Array.from({ length: cols }, () => blank(style));

const sameStyle = (a: CellStyle, b: CellStyle) =>
  a.fg === b.fg &&
  a.bg === b.bg &&
  !a.bold === !b.bold &&
  !a.dim === !b.dim &&
  !a.italic === !b.italic &&
  !a.underline === !b.underline &&
  !a.inverse === !b.inverse;

function runsOf(cells: readonly Cell[]): ScreenRun[] {
  let end = cells.length;
  while (
    end > 0 &&
    cells[end - 1]!.ch === ' ' &&
    cells[end - 1]!.style.bg === undefined &&
    !cells[end - 1]!.style.inverse
  )
    end--;
  const runs: ScreenRun[] = [];
  for (let index = 0; index < end; index++) {
    const cell = cells[index]!;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last.style, cell.style)) last.text += cell.ch;
    else runs.push({ text: cell.ch, style: cell.style });
  }
  return runs;
}

type State =
  | 'ground'
  | 'escape'
  | 'charset'
  | 'csi'
  | 'osc'
  | 'osc-escape'
  | 'string'
  | 'string-escape';

export function createScreen(
  options: { rows?: number; cols?: number; scrollback?: number } = {},
): Screen {
  let rows = Math.max(1, options.rows ?? 24);
  let cols = Math.max(1, options.cols ?? 80);
  const maxScrollback = options.scrollback ?? 1000;

  let main: Cell[][] = [];
  let alt: Cell[][] = [];
  let grid: Cell[][] = [];
  let scrollback: Cell[][] = [];
  let alternate = false;
  let cursorRow = 0;
  let cursorCol = 0;
  let pendingWrap = false;
  let cursorVisible = true;
  let style: CellStyle = blankStyle;
  let top = 0;
  let bottom = rows - 1;
  let saved = { row: 0, col: 0, style: blankStyle as CellStyle };
  let savedMain = { row: 0, col: 0, style: blankStyle as CellStyle };
  let title: string | undefined;
  let version = 0;

  let state: State = 'ground';
  let params = '';
  let osc = '';

  const init = () => {
    main = Array.from({ length: rows }, () => row(cols));
    alt = Array.from({ length: rows }, () => row(cols));
    grid = main;
    scrollback = [];
    alternate = false;
    cursorRow = cursorCol = 0;
    pendingWrap = false;
    cursorVisible = true;
    style = blankStyle;
    top = 0;
    bottom = rows - 1;
    saved = { row: 0, col: 0, style: blankStyle };
    title = undefined;
    state = 'ground';
  };
  init();

  const clampCursor = () => {
    cursorRow = Math.min(Math.max(cursorRow, 0), rows - 1);
    cursorCol = Math.min(Math.max(cursorCol, 0), cols - 1);
    pendingWrap = false;
  };

  // Blank cells take the current background (xterm's "background color erase").
  const eraseStyle = (): CellStyle => (style.bg !== undefined ? { bg: style.bg } : blankStyle);

  const scrollUp = (count = 1) => {
    for (let n = 0; n < count; n++) {
      const [gone] = grid.splice(top, 1);
      if (!alternate && top === 0 && gone) {
        scrollback.push(gone);
        if (scrollback.length > maxScrollback) scrollback.shift();
      }
      grid.splice(bottom, 0, row(cols, eraseStyle()));
    }
  };
  const scrollDown = (count = 1) => {
    for (let n = 0; n < count; n++) {
      grid.splice(bottom, 1);
      grid.splice(top, 0, row(cols, eraseStyle()));
    }
  };

  const lineFeed = () => {
    pendingWrap = false;
    if (cursorRow === bottom) scrollUp();
    else if (cursorRow < rows - 1) cursorRow++;
  };

  const print = (ch: string) => {
    if (pendingWrap) {
      cursorCol = 0;
      lineFeed();
    }
    grid[cursorRow]![cursorCol] = { ch, style };
    if (cursorCol === cols - 1) pendingWrap = true;
    else cursorCol++;
  };

  const eraseCells = (line: Cell[], from: number, to: number) => {
    for (let col = Math.max(0, from); col < Math.min(cols, to); col++)
      line[col] = blank(eraseStyle());
  };

  const numbers = () =>
    params
      .replace(/^[?>=!]/, '')
      .split(';')
      .map((part) => {
        // `38:2::r:g:b` colon forms: take the first number of each parameter group.
        const value = Number.parseInt(part.split(':')[0] ?? '', 10);
        return Number.isFinite(value) ? value : undefined;
      });

  const sgr = (list: (number | undefined)[]) => {
    if (list.length === 0) list = [0];
    let next: CellStyle = { ...style };
    for (let index = 0; index < list.length; index++) {
      const code = list[index] ?? 0;
      if (code === 0) next = {};
      else if (code === 1) next.bold = true;
      else if (code === 2) next.dim = true;
      else if (code === 3) next.italic = true;
      else if (code === 4) next.underline = true;
      else if (code === 7) next.inverse = true;
      else if (code === 22) {
        delete next.bold;
        delete next.dim;
      } else if (code === 23) delete next.italic;
      else if (code === 24) delete next.underline;
      else if (code === 27) delete next.inverse;
      else if (code >= 30 && code <= 37) next.fg = code - 30;
      else if (code === 39) delete next.fg;
      else if (code >= 40 && code <= 47) next.bg = code - 40;
      else if (code === 49) delete next.bg;
      else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
      else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
      else if (code === 38 || code === 48) {
        const key = code === 38 ? 'fg' : 'bg';
        if (list[index + 1] === 5 && list[index + 2] !== undefined) {
          next[key] = Math.min(255, list[index + 2]!);
          index += 2;
        } else if (list[index + 1] === 2) {
          const hex = [list[index + 2], list[index + 3], list[index + 4]]
            .map((value) =>
              Math.min(255, value ?? 0)
                .toString(16)
                .padStart(2, '0'),
            )
            .join('');
          next[key] = `#${hex}`;
          index += 4;
        }
      }
    }
    style = Object.keys(next).length ? next : blankStyle;
  };

  const setMode = (on: boolean) => {
    if (!params.startsWith('?')) return;
    for (const mode of numbers()) {
      if (mode === 25) cursorVisible = on;
      else if (mode === 1049 || mode === 1047 || mode === 47) {
        if (on && !alternate) {
          savedMain = { row: cursorRow, col: cursorCol, style };
          alt = Array.from({ length: rows }, () => row(cols));
          grid = alt;
          alternate = true;
          cursorRow = cursorCol = 0;
        } else if (!on && alternate) {
          grid = main;
          alternate = false;
          ({ row: cursorRow, col: cursorCol, style } = savedMain);
        }
        clampCursor();
      }
    }
  };

  const csi = (final: string) => {
    const list = numbers();
    const first = list[0] ?? 0;
    const count = Math.max(1, first);
    const line = grid[cursorRow]!;
    switch (final) {
      case 'A':
        cursorRow = Math.max(cursorRow < top ? 0 : top, cursorRow - count);
        pendingWrap = false;
        break;
      case 'B':
      case 'e':
        cursorRow = Math.min(cursorRow > bottom ? rows - 1 : bottom, cursorRow + count);
        pendingWrap = false;
        break;
      case 'C':
      case 'a':
        cursorCol = Math.min(cols - 1, cursorCol + count);
        pendingWrap = false;
        break;
      case 'D':
        cursorCol = Math.max(0, cursorCol - count);
        pendingWrap = false;
        break;
      case 'E':
        cursorRow = Math.min(bottom, cursorRow + count);
        cursorCol = 0;
        pendingWrap = false;
        break;
      case 'F':
        cursorRow = Math.max(top, cursorRow - count);
        cursorCol = 0;
        pendingWrap = false;
        break;
      case 'G':
      case '`':
        cursorCol = count - 1;
        clampCursor();
        break;
      case 'd':
        cursorRow = count - 1;
        clampCursor();
        break;
      case 'H':
      case 'f':
        cursorRow = Math.max(1, list[0] ?? 1) - 1;
        cursorCol = Math.max(1, list[1] ?? 1) - 1;
        clampCursor();
        break;
      case 'J':
        if (first === 0) {
          eraseCells(line, cursorCol, cols);
          for (let r = cursorRow + 1; r < rows; r++) grid[r] = row(cols, eraseStyle());
        } else if (first === 1) {
          eraseCells(line, 0, cursorCol + 1);
          for (let r = 0; r < cursorRow; r++) grid[r] = row(cols, eraseStyle());
        } else if (first === 2 || first === 3) {
          for (let r = 0; r < rows; r++) grid[r] = row(cols, eraseStyle());
          if (first === 3) scrollback = [];
        }
        break;
      case 'K':
        if (first === 0) eraseCells(line, cursorCol, cols);
        else if (first === 1) eraseCells(line, 0, cursorCol + 1);
        else if (first === 2) eraseCells(line, 0, cols);
        break;
      case 'X':
        eraseCells(line, cursorCol, cursorCol + count);
        break;
      case 'P':
        line.splice(cursorCol, Math.min(count, cols - cursorCol));
        while (line.length < cols) line.push(blank(eraseStyle()));
        break;
      case '@':
        line.splice(cursorCol, 0, ...row(Math.min(count, cols - cursorCol), eraseStyle()));
        line.length = cols;
        break;
      case 'L':
      case 'M':
        if (cursorRow >= top && cursorRow <= bottom) {
          const savedTop = top;
          top = cursorRow;
          if (final === 'L') scrollDown(Math.min(count, bottom - cursorRow + 1));
          else {
            // Deleted lines are not scrollback.
            const wasAlternate = alternate;
            alternate = true;
            scrollUp(Math.min(count, bottom - cursorRow + 1));
            alternate = wasAlternate;
          }
          top = savedTop;
          cursorCol = 0;
          pendingWrap = false;
        }
        break;
      case 'S':
        scrollUp(count);
        break;
      case 'T':
        scrollDown(count);
        break;
      case 'm':
        sgr(list);
        break;
      case 'r': {
        const from = Math.max(1, list[0] ?? 1) - 1;
        const to = Math.min(rows, list[1] ?? rows) - 1;
        if (from < to) {
          top = from;
          bottom = to;
          cursorRow = cursorCol = 0;
          pendingWrap = false;
        }
        break;
      }
      case 's':
        saved = { row: cursorRow, col: cursorCol, style };
        break;
      case 'u':
        ({ row: cursorRow, col: cursorCol } = saved);
        clampCursor();
        break;
      case 'h':
        setMode(true);
        break;
      case 'l':
        setMode(false);
        break;
      default:
      // Device reports, keyboard modes, …: ignored.
    }
  };

  const escape = (ch: string) => {
    state = 'ground';
    switch (ch) {
      case '[':
        state = 'csi';
        params = '';
        break;
      case ']':
        state = 'osc';
        osc = '';
        break;
      case 'P':
      case '_':
      case '^':
      case 'X':
        state = 'string';
        break;
      case '(':
      case ')':
      case '*':
      case '+':
      case '#':
      case '%':
        state = 'charset';
        break;
      case '7':
        saved = { row: cursorRow, col: cursorCol, style };
        break;
      case '8':
        ({ row: cursorRow, col: cursorCol, style } = saved);
        clampCursor();
        break;
      case 'D':
        lineFeed();
        break;
      case 'E':
        cursorCol = 0;
        lineFeed();
        break;
      case 'M':
        pendingWrap = false;
        if (cursorRow === top) scrollDown();
        else if (cursorRow > 0) cursorRow--;
        break;
      case 'c':
        init();
        break;
      default:
      // ESC =, ESC >, …: keypad modes, ignored.
    }
  };

  const endOsc = () => {
    const [kind, ...rest] = osc.split(';');
    if (kind === '0' || kind === '2') title = rest.join(';').slice(0, 200);
    state = 'ground';
  };

  const write = (data: string) => {
    for (const ch of data) {
      const code = ch.codePointAt(0)!;
      switch (state) {
        case 'ground':
          if (code === 0x1b) state = 'escape';
          else if (code === 0x0d) {
            cursorCol = 0;
            pendingWrap = false;
          } else if (code === 0x0a || code === 0x0b || code === 0x0c) lineFeed();
          else if (code === 0x08) {
            if (cursorCol > 0) cursorCol--;
            pendingWrap = false;
          } else if (code === 0x09) {
            cursorCol = Math.min(cols - 1, (Math.floor(cursorCol / 8) + 1) * 8);
            pendingWrap = false;
          } else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) print(ch);
          break;
        case 'escape':
          escape(ch);
          break;
        case 'charset':
          state = 'ground';
          break;
        case 'csi':
          if (code >= 0x40 && code <= 0x7e) {
            state = 'ground';
            csi(ch);
          } else if (code === 0x1b) state = 'escape';
          else if (code >= 0x20 && code < 0x40 && params.length < 64) params += ch;
          else if (code === 0x18 || code === 0x1a) state = 'ground';
          break;
        case 'osc':
          if (code === 0x07) endOsc();
          else if (code === 0x1b) state = 'osc-escape';
          else if (osc.length < 512) osc += ch;
          break;
        case 'osc-escape':
          if (ch === '\\') endOsc();
          else {
            state = 'escape';
            escape(ch);
          }
          break;
        case 'string':
          if (code === 0x07) state = 'ground';
          else if (code === 0x1b) state = 'string-escape';
          break;
        case 'string-escape':
          state = ch === '\\' ? 'ground' : 'string';
          break;
      }
    }
    version++;
  };

  return {
    write,
    resize(nextRows, nextCols) {
      nextRows = Math.max(1, Math.floor(nextRows));
      nextCols = Math.max(1, Math.floor(nextCols));
      if (nextRows === rows && nextCols === cols) return;
      const fit = (buffer: Cell[][], keepBottom: boolean) => {
        for (const line of buffer) {
          if (line.length > nextCols) line.length = nextCols;
          while (line.length < nextCols) line.push(blank());
        }
        while (buffer.length > nextRows) {
          // Shrinking: rows above the cursor go to scrollback; otherwise drop from the bottom.
          if (keepBottom && cursorRow > 0) {
            const [gone] = buffer.splice(0, 1);
            if (buffer === main && gone) scrollback.push(gone);
            cursorRow--;
          } else buffer.pop();
        }
        while (buffer.length < nextRows) buffer.push(row(nextCols));
      };
      fit(main, !alternate);
      fit(alt, alternate);
      if (scrollback.length > maxScrollback)
        scrollback.splice(0, scrollback.length - maxScrollback);
      rows = nextRows;
      cols = nextCols;
      grid = alternate ? alt : main;
      top = 0;
      bottom = rows - 1;
      clampCursor();
      version++;
    },
    reset() {
      init();
      version++;
    },
    snapshot() {
      return {
        rows,
        cols,
        lines: grid.map(runsOf),
        cursor: { row: cursorRow, col: cursorCol, visible: cursorVisible },
        scrollback: scrollback.map(runsOf),
        ...(title !== undefined ? { title } : {}),
        alternate,
      };
    },
    get version() {
      return version;
    },
  };
}

/** The xterm 16-color palette plus the 6×6×6 cube and grayscale ramp, for views. */
export function paletteColor(index: number): string {
  const base = [
    '#000000',
    '#cd3131',
    '#0dbc79',
    '#e5e510',
    '#2472c8',
    '#bc3fbc',
    '#11a8cd',
    '#e5e5e5',
    '#666666',
    '#f14c4c',
    '#23d18b',
    '#f5f543',
    '#3b8eea',
    '#d670d6',
    '#29b8db',
    '#ffffff',
  ];
  if (index < 16) return base[index] ?? '#e5e5e5';
  if (index < 232) {
    const value = index - 16;
    const level = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, '0');
    return `#${level(Math.floor(value / 36))}${level(Math.floor(value / 6) % 6)}${level(value % 6)}`;
  }
  const gray = (8 + (index - 232) * 10).toString(16).padStart(2, '0');
  return `#${gray}${gray}${gray}`;
}

/**
 * The bytes a key press sends (xterm conventions, normal cursor mode), or undefined for keys the
 * terminal ignores. `key` is a DOM `KeyboardEvent.key`.
 */
export function keyInput(event: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): string | undefined {
  if (event.metaKey) return undefined;
  const named: Record<string, string> = {
    Enter: '\r',
    Backspace: '\x7f',
    Tab: event.shiftKey ? '\x1b[Z' : '\t',
    Escape: '\x1b',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    Insert: '\x1b[2~',
    Delete: '\x1b[3~',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
    F1: '\x1bOP',
    F2: '\x1bOQ',
    F3: '\x1bOR',
    F4: '\x1bOS',
    F5: '\x1b[15~',
    F6: '\x1b[17~',
    F7: '\x1b[18~',
    F8: '\x1b[19~',
    F9: '\x1b[20~',
    F10: '\x1b[21~',
    F11: '\x1b[23~',
    F12: '\x1b[24~',
  };
  let out = named[event.key];
  if (out === undefined) {
    if ([...event.key].length !== 1) return undefined;
    out = event.key;
    if (event.ctrlKey) {
      const upper = out.toUpperCase();
      const code = upper.charCodeAt(0);
      if (code >= 64 && code <= 95) out = String.fromCharCode(code - 64);
      else if (out === ' ' || out === '2') out = '\x00';
      else if (out === '/') out = '\x1f';
      else return undefined;
    }
  }
  return event.altKey ? `\x1b${out}` : out;
}
