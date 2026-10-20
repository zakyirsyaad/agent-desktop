import { afterAll, describe, expect, it } from 'vitest';
import { toContent } from '../lib/elicitation-form';
import type { ElicitationField } from '../types';

// A zone with daylight saving, so a winter and a summer date have different
// offsets. Node applies a change to TZ at once; no date is made before this.
const zoneBefore = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (zoneBefore === undefined) delete process.env.TZ;
  else process.env.TZ = zoneBefore;
});

const when: ElicitationField = {
  name: 'd',
  required: false,
  kind: { type: 'text', format: 'date-time' },
};

describe('toContent in a zone with daylight saving', () => {
  it('uses the offset at the entered date, not the offset today', () => {
    expect(toContent([when], { d: '2026-01-15T12:00' })).toEqual({
      d: '2026-01-15T12:00:00-05:00',
    });
    expect(toContent([when], { d: '2026-07-15T12:00' })).toEqual({
      d: '2026-07-15T12:00:00-04:00',
    });
  });
});
