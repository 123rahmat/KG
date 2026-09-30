import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse } from './helpers.js';
import { nextOccurrence, normalizeRule, describeRule, instantFor, clockTime } from '../src/scheduling.js';

test('rules follow the person\'s time zone, across daylight saving', () => {
  const after = new Date('2026-09-24T10:00:00Z'); // Thursday, 15:00 in Karachi
  const weekly = normalizeRule({ type: 'weekly', days: [1, 3], time: '09:00' });
  assert.equal(nextOccurrence(weekly, 'Asia/Karachi', after).toISOString(), '2026-09-28T04:00:00.000Z', 'Monday 09:00 PKT');
  assert.equal(nextOccurrence({ type: 'daily', time: '16:00' }, 'Asia/Karachi', after).toISOString(), '2026-09-24T11:00:00.000Z', 'later today');
  assert.equal(nextOccurrence({ type: 'monthly', day: 1, time: '08:30' }, 'UTC', after).toISOString(), '2026-10-01T08:30:00.000Z');
  assert.equal(nextOccurrence({ type: 'interval', minutes: 60 }, 'UTC', after).toISOString(), '2026-09-24T11:00:00.000Z');
  assert.equal(nextOccurrence({ type: 'once', at: '2026-09-25T09:00' }, 'Asia/Karachi', after).toISOString(), '2026-09-25T04:00:00.000Z');
  assert.equal(nextOccurrence({ type: 'once', at: '2026-09-20T09:00' }, 'UTC', after), null, 'a past one-time schedule never runs');
  // New York moves from EDT (UTC-4) to EST (UTC-5) on 1 November 2026: 09:00 stays 09:00 local.
  const before = new Date('2026-10-31T20:00:00Z');
  assert.equal(nextOccurrence({ type: 'daily', time: '09:00' }, 'America/New_York', before).toISOString(), '2026-11-01T14:00:00.000Z');
  assert.equal(instantFor({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(describeRule(weekly, 'Asia/Karachi'), 'Every Mon, Wed at 09:00 (Asia/Karachi)');
  assert.throws(() => normalizeRule({ type: 'interval', minutes: 1 }), /15 minutes/);
  assert.throws(() => normalizeRule({ type: 'daily', time: '25:00' }), /HH:MM/);
});

test('reminders fire once, as their owner; there are no simulation schedules', () =>
  withServer(async ({ call, seed, scheduler, pool }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    // Whole minutes, far enough ahead that rounding down never makes it due during the test.
    const soon = new Date(Date.now() + 3 * 60_000).toISOString().slice(0, 16) + 'Z';
    // A daily time twelve hours away, so it is never due while the test runs.
    const farFromNow = new Date(Date.now() + 12 * 3600_000).toISOString().slice(11, 16);
    assert.equal((await call('POST', '/api/schedules', { ...auth, body: { title: 'Past', kind: 'reminder', rule: { type: 'once', at: '2020-01-01T09:00' }, payload: { message: 'x' } } })).status, 400);

    const reminder = await call('POST', '/api/schedules', { ...auth, body: { title: 'Check the tank', kind: 'reminder', rule: { type: 'once', at: soon }, timeZone: 'Asia/Karachi', payload: { message: 'Look at the water level.' } } });
    assert.equal(reminder.status, 201, JSON.stringify(reminder.body));
    const daily = await call('POST', '/api/schedules', { ...auth, body: { title: 'Stand-up', kind: 'reminder', rule: { type: 'daily', time: farFromNow }, timeZone: 'UTC', payload: { message: 'Stand-up now.' } } });
    assert.equal(daily.status, 201);

    const refused = await call('POST', '/api/schedules', { ...auth, body: { title: 'x', kind: 'simulation', rule: { type: 'daily', time: '06:00' }, payload: { modelId: 'm1' } } });
    assert.equal(refused.status, 400);
    // The database refuses the kind too.
    await assert.rejects(pool.query("UPDATE schedules SET kind = 'simulation' WHERE id = $1", [reminder.body.schedule.id]));

    // Nothing is due yet.
    assert.equal(await scheduler.runOnce(new Date()), 0);
    const later = new Date(Date.now() + 5 * 60_000);
    // Two workers at once: each due schedule is claimed by only one.
    const [first, second] = await Promise.all([scheduler.claimDue(later), scheduler.claimDue(later)]);
    assert.equal(first.length + second.length, 1);
    for (const row of [...first, ...second]) await scheduler.fire(row, later);

    const { body } = await call('GET', '/api/notifications', auth);
    assert.equal(body.unread, 1);
    assert.ok(body.notifications.some(item => item.title === 'Check the tank' && item.body === 'Look at the water level.'));

    const schedules = (await call('GET', '/api/schedules', auth)).body.schedules;
    const byTitle = title => schedules.find(item => item.title === title);
    assert.equal(byTitle('Check the tank').active, false, 'a one-time reminder is done');
    assert.equal(byTitle('Check the tank').runCount, 1);
    assert.equal(byTitle('Stand-up').active, true);
    assert.equal(byTitle('Stand-up').description, `Every day at ${farFromNow} (UTC)`);

    assert.equal((await call('POST', '/api/notifications/read', { ...auth, body: {} })).body.marked, 1);
    assert.equal((await call('DELETE', `/api/schedules/${daily.body.schedule.id}`, auth)).body.schedule.active, false);

    // Someone else sees none of it.
    const other = await seed({ name: 'Other', role: 'editor' });
    assert.equal((await call('GET', '/api/schedules', { token: other.token, workspace })).body.schedules.length, 0);
    assert.equal((await call('GET', '/api/notifications', { token: other.token, workspace })).body.notifications.length, 0);
  }));

test('in chat, the AI proposes a schedule and it exists only after approval', () => {
  let answered = 0;
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const run = await call('POST', '/api/runs', { ...auth, body: { goal: 'Remind me every Monday at 9 to check the tank level', timeZone: 'Asia/Karachi', privacyConsent: { modelProvider: true } } });
    let current = run.body;
    for (let i = 0; i < 20 && current.next; i += 1) {
      const next = current.tasks.find(task => task.id === current.next);
      const step = next.type === 'approval'
        ? await call('POST', `/api/runs/${current.id}/advance`, { ...auth, body: { taskId: next.id, approved: true } })
        : await call('POST', `/api/runs/${current.id}/execute`, { ...auth, body: ['tool', 'investigate', 'code'].includes(next.type) ? { approved: true } : {} });
      assert.equal(step.status, 200, JSON.stringify(step.body).slice(0, 300));
      current = step.body.run ?? step.body;
      if (answered) break;
    }
    const { body: { actions } } = await call('GET', `/api/runs/${run.body.id}/actions`, auth);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].tool, 'schedule.create');
    assert.equal(actions[0].summary, 'Check the tank: Every Mon at 09:00 (Asia/Karachi)');
    assert.equal((await call('GET', '/api/schedules', auth)).body.schedules.length, 0, 'nothing before approval');
    const approved = await call('POST', `/api/runs/${run.body.id}/actions/${actions[0].id}`, { ...auth, body: { approve: true } });
    assert.equal(approved.body.action.status, 'done', JSON.stringify(approved.body));
    const [schedule] = (await call('GET', '/api/schedules', auth)).body.schedules;
    assert.equal(schedule.description, 'Every Mon at 09:00 (Asia/Karachi)');
    assert.equal(schedule.payload.message, 'Check the tank level.');
  }, {
    env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key', AI_MODEL: 'claude-opus-5-5' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const request = (() => { try { const content = body.messages?.find(message => message.role === 'user')?.content ?? '{}'; return JSON.parse(typeof content === 'string' ? content : '{}'); } catch { return {}; } })();
      const reply = text => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 3, output_tokens: 3 } });
      if (!['respond', 'deliver', 'prototype', 'tool'].includes(request.task?.type)) {
        return reply(request.task?.type === 'verify' ? JSON.stringify({ verdict: 'pass', criteria: [{ criterion: 'a weekly reminder is proposed', met: true }], problems: [] })
          : request.task?.type === 'understand' ? JSON.stringify({ successCriteria: ['a weekly reminder is proposed'] }) : 'ok');
      }
      const turn = body.messages.filter(message => message.role === 'assistant').length;
      if (turn === 0) return reply(JSON.stringify({ tool: 'schedule.create', input: { title: 'Check the tank', kind: 'reminder', message: 'Check the tank level.', rule: { type: 'weekly', days: [1], time: '09:00' } } }));
      answered += 1;
      return reply('I proposed a reminder every Monday at 09:00; approve it below.');
    }
  });
});

test('a time and days are read the way people and models write them', () => {
  for (const [written, time] of [['17:00', '17:00'], ['9:05', '09:05'], ['5 pm', '17:00'], ['5:30pm', '17:30'], ['12 am', '00:00'], ['12 pm', '12:00'], ['17:00:00', '17:00'], ['noon', '12:00'], ['5 p.m.', '17:00']]) {
    assert.equal(clockTime(written), time, written);
  }
  for (const bad of ['25:00', '13 pm', '9:75', 'soon', '']) assert.equal(clockTime(bad), '', bad);
  assert.deepEqual(normalizeRule({ type: 'weekly', days: ['Friday'], time: '5 pm' }), { type: 'weekly', days: [5], time: '17:00' });
  assert.deepEqual(normalizeRule({ type: 'weekly', days: 'fri', time: '17:00' }).days, [5]);
  assert.deepEqual(normalizeRule({ type: 'weekly', days: [1, 'wed'], time: '08:00' }).days, [1, 3]);
  assert.throws(() => normalizeRule({ type: 'daily', time: 'soon' }), /HH:MM/);
});
