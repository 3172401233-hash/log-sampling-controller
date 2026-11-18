'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LogSampler } = require('../src/sampler');

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

// Letters-only encoding so normalizeMessage() does not collapse distinct
// messages into one "duplicate" fingerprint.
function uniqueWord(i) {
  let word = '';
  let n = i;
  do {
    word = String.fromCharCode(97 + (n % 26)) + word;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return word;
}

test('burst noise is capped by the per-service budget', () => {
  const clock = makeClock();
  const sampler = new LogSampler({
    windowMs: 2000,
    serviceBudget: 50,
    globalBudget: 100000,
    now: clock.now,
  });

  let kept = 0;
  for (let i = 0; i < 1000; i++) {
    clock.advance(1);
    const d = sampler.decide({ serviceId: 'noisy', level: 'INFO', traceId: `t${i}`, message: `event-${uniqueWord(i)}` });
    if (d.keep) kept++;
  }

  assert.ok(kept <= 50, `kept ${kept} exceeds service budget`);
  assert.ok(kept > 0, 'expected some logs to be kept');
  const stats = sampler.stats();
  assert.equal(stats.services.noisy.kept, kept);
  assert.ok(stats.services.noisy.sampleRate <= 0.05);
});

test('error chain: an ERROR pins the whole trace to keep, even past budget', () => {
  const clock = makeClock();
  const sampler = new LogSampler({
    windowMs: 1000,
    serviceBudget: 5,
    globalBudget: 1000,
    now: clock.now,
  });

  clock.advance(900);
  for (let i = 0; i < 200; i++) {
    sampler.decide({ serviceId: 'svc', level: 'INFO', traceId: `noise${i}`, message: `noise-${uniqueWord(i)}` });
  }
  assert.equal(sampler.stats().services.svc.kept, 5);

  const err = sampler.decide({ serviceId: 'svc', level: 'ERROR', traceId: 'trace-err', message: 'boom' });
  assert.equal(err.keep, true);
  assert.equal(err.reason, 'first-error');

  const after1 = sampler.decide({ serviceId: 'svc', level: 'INFO', traceId: 'trace-err', message: 'cleanup step 1' });
  const after2 = sampler.decide({ serviceId: 'svc', level: 'WARN', traceId: 'trace-err', message: 'cleanup step 2' });
  assert.equal(after1.keep, true);
  assert.equal(after2.keep, true);
  assert.equal(after1.reason, 'trace-consistent');
  assert.equal(after2.reason, 'trace-consistent');
});

test('duplicate logs are downsampled to 1 in N', () => {
  const clock = makeClock();
  const sampler = new LogSampler({
    windowMs: 1000,
    serviceBudget: 1000,
    globalBudget: 10000,
    duplicateKeepEvery: 10,
    now: clock.now,
  });

  let kept = 0;
  for (let i = 0; i < 100; i++) {
    clock.advance(1);
    const d = sampler.decide({ serviceId: 'svc', level: 'WARN', traceId: `t${i}`, message: 'disk full on host 42' });
    if (d.keep) kept++;
  }

  assert.equal(kept, 11);
  const reasons = sampler.stats().services.svc.reasons;
  assert.equal(reasons.duplicate, 99);
});

test('service fairness: a noisy service cannot starve a quiet one', () => {
  const clock = makeClock();
  const sampler = new LogSampler({
    windowMs: 1000,
    serviceBudget: 100,
    globalBudget: 100000,
    now: clock.now,
  });

  let keptNoisy = 0;
  let keptQuiet = 0;
  for (let i = 0; i < 2000; i++) {
    clock.advance(0.4);
    if (sampler.decide({ serviceId: 'noisy', level: 'INFO', traceId: `a${i}`, message: `nx-${uniqueWord(i)}` }).keep) keptNoisy++;
    if (i % 40 === 0) {
      if (sampler.decide({ serviceId: 'quiet', level: 'INFO', traceId: `b${i}`, message: `qy-${uniqueWord(i)}` }).keep) keptQuiet++;
    }
  }

  assert.ok(keptNoisy <= 100, `noisy kept ${keptNoisy}`);
  assert.equal(keptQuiet, 50);
});

test('global budget caps total keeps across services', () => {
  const clock = makeClock();
  const sampler = new LogSampler({
    windowMs: 1000,
    serviceBudget: 1000,
    globalBudget: 60,
    now: clock.now,
  });

  let kept = 0;
  for (let i = 0; i < 500; i++) {
    clock.advance(1);
    const svc = `svc-${i % 5}`;
    if (sampler.decide({ serviceId: svc, level: 'INFO', traceId: `t${i}`, message: `gm-${uniqueWord(i)}` }).keep) kept++;
  }

  assert.equal(kept, 60);
  assert.ok(sampler.stats().global.reasons['global-budget-exhausted'] > 0);
});

test('budget changes take effect within the current window', () => {
  const clock = makeClock();
  const sampler = new LogSampler({
    windowMs: 10000,
    serviceBudget: 20,
    globalBudget: 100000,
    now: clock.now,
  });

  for (let i = 0; i < 300; i++) {
    clock.advance(10);
    sampler.decide({ serviceId: 'svc', level: 'INFO', traceId: `t${i}`, message: `bc-${uniqueWord(i)}` });
  }
  const keptBefore = sampler.stats().services.svc.kept;
  assert.ok(keptBefore <= 20, `kept ${keptBefore} exceeds initial budget`);

  sampler.setBudgets({ serviceBudget: 80 });
  for (let i = 300; i < 600; i++) {
    clock.advance(10);
    sampler.decide({ serviceId: 'svc', level: 'INFO', traceId: `t${i}`, message: `bd-${uniqueWord(i)}` });
  }

  const keptAfter = sampler.stats().services.svc.kept;
  assert.ok(keptAfter > keptBefore, 'raising the budget should admit more logs');
  assert.ok(keptAfter <= 80, `kept ${keptAfter} exceeds updated budget`);
});

test('clock window rollover resets budgets and duplicate counters', () => {
  const clock = makeClock();
  const sampler = new LogSampler({
    windowMs: 1000,
    serviceBudget: 10,
    globalBudget: 1000,
    duplicateKeepEvery: 5,
    now: clock.now,
  });

  let firstWindowKept = 0;
  for (let i = 0; i < 200; i++) {
    clock.advance(1);
    if (sampler.decide({ serviceId: 'svc', level: 'INFO', traceId: `t${i}`, message: `wa-${uniqueWord(i)}` }).keep) firstWindowKept++;
  }
  assert.ok(firstWindowKept <= 10);

  clock.advance(1000);
  assert.equal(sampler.stats().global.arrivals, 0);

  let secondWindowKept = 0;
  for (let i = 200; i < 400; i++) {
    clock.advance(1);
    if (sampler.decide({ serviceId: 'svc', level: 'INFO', traceId: `t${i}`, message: `wb-${uniqueWord(i)}` }).keep) secondWindowKept++;
  }
  assert.ok(secondWindowKept > 0, 'budget should replenish after rollover');
  assert.ok(secondWindowKept <= 10);

  clock.advance(1000);
  const dup = sampler.decide({ serviceId: 'svc', level: 'WARN', traceId: 'd1', message: 'repeated' });
  assert.equal(dup.keep, true);
  assert.notEqual(dup.reason, 'duplicate');
});

test('same trace always gets the same decision', () => {
  const clock = makeClock();
  const sampler = new LogSampler({
    windowMs: 1000,
    serviceBudget: 50,
    globalBudget: 100000,
    now: clock.now,
  });

  for (let t = 0; t < 200; t++) {
    clock.advance(1);
    const decisions = [];
    for (let k = 0; k < 3; k++) {
      decisions.push(sampler.decide({
        serviceId: 'svc',
        level: 'INFO',
        traceId: `trace-${t}`,
        message: `tc-${uniqueWord(t * 10 + k)}`,
      }).keep);
    }
    assert.ok(
      decisions.every((d) => d === decisions[0]),
      `trace-${t} has inconsistent decisions: ${decisions}`,
    );
  }
});

test('first-seen errors are boosted, repeats use the error probability', () => {
  const clock = makeClock();
  const sampler = new LogSampler({
    windowMs: 1000,
    serviceBudget: 100,
    globalBudget: 1000,
    now: clock.now,
  });

  const first = sampler.decide({ serviceId: 'svc', level: 'ERROR', traceId: 't1', message: 'NullPointer at line 12' });
  assert.equal(first.keep, true);
  assert.equal(first.reason, 'first-error');

  const repeat = sampler.decide({ serviceId: 'svc', level: 'ERROR', traceId: 't2', message: 'NullPointer at line 99' });
  assert.equal(repeat.reason, 'error');
  assert.equal(repeat.keep, true);
});

test('decisions expose a sample rate and stats aggregate reasons', () => {
  const clock = makeClock();
  const sampler = new LogSampler({
    windowMs: 1000,
    serviceBudget: 20,
    globalBudget: 1000,
    now: clock.now,
  });

  for (let i = 0; i < 200; i++) {
    clock.advance(1);
    const d = sampler.decide({ serviceId: 'svc', level: 'INFO', traceId: `t${i}`, message: `sr-${uniqueWord(i)}` });
    assert.ok(typeof d.sampleRate === 'number');
    assert.ok(d.sampleRate >= 0 && d.sampleRate <= 1);
    assert.ok(typeof d.reason === 'string');
  }

  const stats = sampler.stats();
  assert.equal(stats.global.arrivals, 200);
  assert.equal(stats.global.kept + stats.global.dropped, 200);
  assert.ok(stats.global.sampleRate <= 0.1);
  assert.ok(Object.keys(stats.global.reasons).length > 0);
});

test('decide requires a serviceId', () => {
  const sampler = new LogSampler({});
  assert.throws(() => sampler.decide({ level: 'INFO' }), /serviceId/);
});
