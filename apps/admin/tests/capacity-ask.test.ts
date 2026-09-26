import { describe, expect, it } from 'vitest';
import { capacityAt, DAY, HOUR, sharedCapacitySource } from '@/lib/data/capacity';
import { parseAsk, rankAsk } from '@/components/capacity/ask';

describe('parseAsk', () => {
  it('reads a size, a model and a duration', () => {
    expect(parseAsk('16 h200 3d')).toEqual({ gpus: 16, models: ['h200'], durationMs: 3 * DAY, spot: false });
    expect(parseAsk('8 gpus a100 for 12 hours spot')).toEqual({ gpus: 8, models: ['a100'], durationMs: 12 * HOUR, spot: true });
    expect(parseAsk('2x8 b200 1w')).toEqual({ gpus: 16, shape: { nodes: 2, perNode: 8 }, models: ['b200'], durationMs: 7 * DAY, spot: false });
  });

  it('defaults the duration to a day when a model is named', () => {
    expect(parseAsk('4 l40s')?.durationMs).toBe(DAY);
  });

  it('ignores ordinary searches', () => {
    expect(parseAsk('h100')).toBeUndefined();
    expect(parseAsk('rsv_12ab')).toBeUndefined();
    expect(parseAsk('aurora')).toBeUndefined();
    expect(parseAsk('0 h100 1d')).toBeUndefined();
  });
});

describe('rankAsk', () => {
  const NOW = Date.UTC(2026, 8, 23, 14, 7);
  const snapshot = capacityAt(NOW);
  const source = sharedCapacitySource();
  const hour = Math.floor(NOW / HOUR) * HOUR;
  const timelineOf = (poolId: string) => source.timelineSync(poolId, { from: hour, to: hour + 7 * DAY });

  it('answers only pools of the named model, whole nodes when larger than a node', () => {
    const answers = rankAsk(parseAsk('16 h100 1d')!, snapshot, timelineOf);
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) {
      expect(answer.short.toLowerCase()).toBe('h100');
      expect(answer.nodes * answer.perNode).toBe(16);
      expect(answer.perNode).toBe(8);
    }
  });

  it('sorts soonest first and prices at list (spot at 40%)', () => {
    const regular = rankAsk(parseAsk('8 a100 10h')!, snapshot, timelineOf)[0]!;
    const spot = rankAsk(parseAsk('8 a100 10h spot')!, snapshot, timelineOf)[0]!;
    expect(spot.cost).toBeCloseTo(regular.cost * 0.4, 5);
    const any = rankAsk({ gpus: 4, models: [], durationMs: 6 * HOUR, spot: false }, snapshot, timelineOf);
    const starts = any.map((answer) => answer.start ?? Infinity);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});
