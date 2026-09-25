import { describe, expect, it } from 'vitest';
import { createScreen, keyInput, paletteColor, type Screen } from '@better-compute/console-kit';

// console-kit terminal screen: the VT100 / xterm subset shells and full-screen programs emit.

const text = (screen: Screen) =>
  screen.snapshot().lines.map((line) => line.map((run) => run.text).join(''));

describe('screen', () => {
  it('prints, returns and feeds lines, and trims trailing blanks', () => {
    const screen = createScreen({ rows: 3, cols: 10 });
    screen.write('hello\r\nworld  ');
    expect(text(screen)).toEqual(['hello', 'world', '']);
    expect(screen.snapshot().cursor).toEqual({ row: 1, col: 7, visible: true });
  });

  it('wraps at the last column only when the next character arrives', () => {
    const screen = createScreen({ rows: 3, cols: 4 });
    screen.write('abcd');
    expect(screen.snapshot().cursor).toMatchObject({ row: 0, col: 3 });
    screen.write('e');
    expect(text(screen)).toEqual(['abcd', 'e', '']);
    // A CR at the margin cancels the pending wrap.
    screen.write('\x1b[2;1Hwxyz\rQ');
    expect(text(screen)[1]).toBe('Qxyz');
  });

  it('scrolls into scrollback, bounded', () => {
    const screen = createScreen({ rows: 2, cols: 5, scrollback: 2 });
    screen.write('1\r\n2\r\n3\r\n4\r\n5');
    expect(text(screen)).toEqual(['4', '5']);
    expect(screen.snapshot().scrollback.map((line) => line[0]?.text)).toEqual(['2', '3']);
  });

  it('parses sequences split across writes', () => {
    const screen = createScreen({ rows: 2, cols: 10 });
    screen.write('a\x1b');
    screen.write('[3');
    screen.write('1mred\x1b[');
    screen.write('0m!');
    const [line] = screen.snapshot().lines;
    expect(line).toEqual([
      { text: 'a', style: {} },
      { text: 'red', style: { fg: 1 } },
      { text: '!', style: {} },
    ]);
  });

  it('applies SGR: bold, bright, 256-color and truecolor, and resets', () => {
    const screen = createScreen({ rows: 1, cols: 20 });
    screen.write('\x1b[1;92mA\x1b[22;38;5;208mB\x1b[48;2;1;2;3mC\x1b[7mD\x1b[mE');
    expect(screen.snapshot().lines[0]).toEqual([
      { text: 'A', style: { bold: true, fg: 10 } },
      { text: 'B', style: { fg: 208 } },
      { text: 'C', style: { fg: 208, bg: '#010203' } },
      { text: 'D', style: { fg: 208, bg: '#010203', inverse: true } },
      { text: 'E', style: {} },
    ]);
  });

  it('moves the cursor and erases (the prompt redraws shells do)', () => {
    const screen = createScreen({ rows: 3, cols: 10 });
    screen.write('abcdefgh\x1b[4D\x1b[K');
    expect(text(screen)[0]).toBe('abcd');
    screen.write('\x1b[3;5HX\x1b[1;1H\x1b[2J');
    expect(text(screen)).toEqual(['', '', '']);
    screen.write('12345\x1b[1;2H\x1b[2P');
    expect(text(screen)[0]).toBe('145');
    screen.write('\x1b[1;2H\x1b[2@');
    expect(text(screen)[0]).toBe('1  45');
    screen.write('\x1b[1;1H\x1b[3X');
    expect(text(screen)[0]).toBe('   45');
  });

  it('keeps the main screen under the alternate screen (vim, less, top)', () => {
    const screen = createScreen({ rows: 2, cols: 10 });
    screen.write('$ vim');
    screen.write('\x1b[?1049h\x1b[?25lEDITOR');
    expect(screen.snapshot()).toMatchObject({ alternate: true, cursor: { visible: false } });
    expect(text(screen)).toEqual(['EDITOR', '']);
    screen.write('\x1b[?1049l\x1b[?25h');
    expect(text(screen)).toEqual(['$ vim', '']);
    expect(screen.snapshot().cursor).toEqual({ row: 0, col: 5, visible: true });
  });

  it('scrolls only inside the scroll region, and inserts / deletes lines there', () => {
    const screen = createScreen({ rows: 4, cols: 5 });
    screen.write('top\r\na\r\nb\r\nbot');
    screen.write('\x1b[2;3r\x1b[3;1H\n');
    expect(text(screen)).toEqual(['top', 'b', '', 'bot']);
    expect(screen.snapshot().scrollback).toEqual([]);
    screen.write('\x1b[2;1H\x1b[L');
    expect(text(screen)).toEqual(['top', '', 'b', 'bot']);
    screen.write('\x1b[M');
    expect(text(screen)).toEqual(['top', 'b', '', 'bot']);
  });

  it('reads the window title and swallows other strings', () => {
    const screen = createScreen({ rows: 1, cols: 20 });
    screen.write('\x1b]0;user@node: ~\x07\x1bPq#0;2\x1b\\\x1b]8;;http://x\x1b\\ok');
    expect(screen.snapshot().title).toBe('user@node: ~');
    expect(text(screen)).toEqual(['ok']);
  });

  it('handles tabs, backspace and saved cursors', () => {
    const screen = createScreen({ rows: 2, cols: 20 });
    screen.write('a\tb\x08c\x1b7\r\nnext\x1b8!');
    expect(text(screen)).toEqual(['a       c!', 'next']);
  });

  it('resizes, moving rows above the cursor into scrollback', () => {
    const screen = createScreen({ rows: 3, cols: 6 });
    screen.write('one\r\ntwo\r\nthree');
    screen.resize(2, 4);
    expect(text(screen)).toEqual(['two', 'thre']);
    expect(screen.snapshot().scrollback.map((line) => line[0]?.text)).toEqual(['one']);
    expect(screen.snapshot().cursor).toMatchObject({ row: 1, col: 3 });
    screen.resize(3, 8);
    expect(text(screen)).toEqual(['two', 'thre', '']);
  });

  it('bumps its version on every change and resets', () => {
    const screen = createScreen({ rows: 1, cols: 5 });
    const before = screen.version;
    screen.write('x');
    expect(screen.version).toBeGreaterThan(before);
    screen.reset();
    expect(text(screen)).toEqual(['']);
  });
});

describe('keyInput', () => {
  it('maps keys to xterm input', () => {
    expect(keyInput({ key: 'a' })).toBe('a');
    expect(keyInput({ key: 'Enter' })).toBe('\r');
    expect(keyInput({ key: 'Backspace' })).toBe('\x7f');
    expect(keyInput({ key: 'ArrowUp' })).toBe('\x1b[A');
    expect(keyInput({ key: 'Tab', shiftKey: true })).toBe('\x1b[Z');
    expect(keyInput({ key: 'c', ctrlKey: true })).toBe('\x03');
    expect(keyInput({ key: '[', ctrlKey: true })).toBe('\x1b');
    expect(keyInput({ key: ' ', ctrlKey: true })).toBe('\x00');
    expect(keyInput({ key: 'b', altKey: true })).toBe('\x1bb');
    expect(keyInput({ key: 'Shift' })).toBeUndefined();
    expect(keyInput({ key: 'v', metaKey: true })).toBeUndefined();
  });
});

describe('paletteColor', () => {
  it('covers the base colors, the cube and the gray ramp', () => {
    expect(paletteColor(1)).toBe('#cd3131');
    expect(paletteColor(16)).toBe('#000000');
    expect(paletteColor(196)).toBe('#ff0000');
    expect(paletteColor(232)).toBe('#080808');
  });
});
