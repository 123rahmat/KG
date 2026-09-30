/**
 * Scheduling, built into Kindgleam: reminders and questions asked in a chat
 * at a set time.
 *
 * Times follow the person's own time zone (daylight saving included). The
 * scheduler claims due schedules in a short transaction, then does each one
 * under its owner's own access, re-checked every time, like the job worker.
 */

import crypto from 'node:crypto';
import { runDbScope, transaction } from './db.js';
import { registerTools } from './toolbox.js';

const text = value => String(value ?? '').trim();
export const KINDS = Object.freeze(['reminder', 'ask']);
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A clock time as "HH:MM", from the ways a person or a model writes one:
 * "17:00", "9:05", "5 pm", "5:30pm", "17:00:00", "noon", "midnight".
 * '' when it is not a time.
 */
export function clockTime(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\./g, '');
  if (raw === 'noon' || raw === 'midday') return '12:00';
  if (raw === 'midnight') return '00:00';
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/);
  if (!match) return '';
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const half = match[3];
  if (half) {
    if (hour < 1 || hour > 12) return '';
    hour = (hour % 12) + (half === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
/** A weekday as 0-6 (0 = Sunday), from a number or a name such as "Friday" or "fri". */
const weekday = value => (typeof value === 'number' || /^\d+$/.test(String(value).trim())
  ? Number(value)
  : WEEKDAY[String(value ?? '').trim().toLowerCase().slice(0, 3)] ?? NaN);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MIN_INTERVAL_MINUTES = 15;
const MAX_SCHEDULES = 200;

export class ScheduleError extends Error {
  constructor(message, code = 'schedule-invalid') {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

/* ------------------------------------------------------------------ time */

export function validTimeZone(zone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

/** The wall-clock parts of an instant in a time zone. */
function zoned(date, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), weekday: DAY_NAMES.indexOf(parts.weekday) };
}

/** The instant a wall-clock time happens in a zone (nearest, across DST changes). */
export function instantFor({ year, month, day, hour, minute }, zone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const seen = zoned(new Date(guess), zone);
    const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - guess;
    guess = wall - offset;
  }
  return new Date(guess);
}

/**
 * A rule, checked: { type: 'once', at } | { type: 'daily', time }
 * | { type: 'weekly', days: [0-6], time } | { type: 'monthly', day: 1-28, time }
 * | { type: 'interval', minutes }. `at` is local ("2026-10-01T09:00") or an ISO instant.
 */
export function normalizeRule(input = {}) {
  const type = text(input.type);
  if (type === 'once') {
    const at = text(input.at);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) throw new ScheduleError('A one-time schedule needs "at", e.g. "2026-10-01T09:00".');
    return { type, at };
  }
  if (type === 'interval') {
    const minutes = Math.floor(Number(input.minutes));
    if (!(minutes >= MIN_INTERVAL_MINUTES) || minutes > 60 * 24 * 31) throw new ScheduleError(`A repeating interval is from ${MIN_INTERVAL_MINUTES} minutes to 31 days.`);
    return { type, minutes };
  }
  const time = clockTime(input.time);
  if (!TIME.test(time)) throw new ScheduleError('The time must be HH:MM, e.g. "09:00".');
  if (type === 'daily') return { type, time };
  if (type === 'weekly') {
    const days = [...new Set((Array.isArray(input.days) ? input.days : [input.days].filter(day => day !== undefined && day !== null)).map(weekday))].filter(day => Number.isInteger(day) && day >= 0 && day <= 6).sort();
    if (!days.length) throw new ScheduleError('A weekly schedule needs days (0 = Sunday … 6 = Saturday).');
    return { type, days, time };
  }
  if (type === 'monthly') {
    const day = Math.floor(Number(input.day));
    if (!(day >= 1 && day <= 28)) throw new ScheduleError('A monthly schedule runs on day 1 to 28.');
    return { type, day, time };
  }
  throw new ScheduleError('The rule type must be once, daily, weekly, monthly or interval.');
}

/** The next time a rule fires after `after`, or null when it never will again. */
export function nextOccurrence(rule, zone, after = new Date()) {
  if (rule.type === 'once') {
    const at = /[zZ]|[+-]\d{2}:\d{2}$/.test(rule.at)
      ? new Date(rule.at)
      : instantFor({ year: +rule.at.slice(0, 4), month: +rule.at.slice(5, 7), day: +rule.at.slice(8, 10), hour: +rule.at.slice(11, 13), minute: +rule.at.slice(14, 16) }, zone);
    return at > after ? at : null;
  }
  if (rule.type === 'interval') return new Date(after.getTime() + rule.minutes * 60_000);
  const [hour, minute] = rule.time.split(':').map(Number);
  const start = zoned(after, zone);
  for (let offset = 0; offset < 400; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const local = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute };
    if (rule.type === 'weekly' && !rule.days.includes(date.getUTCDay())) continue;
    if (rule.type === 'monthly' && local.day !== rule.day) continue;
    const at = instantFor(local, zone);
    if (at > after) return at;
  }
  return null;
}

/** "Every Mon, Wed at 09:00 (Asia/Karachi)". */
export function describeRule(rule, zone) {
  const where = ` (${zone})`;
  if (rule.type === 'once') return `Once, ${rule.at.replace('T', ' ').slice(0, 16)}${where}`;
  if (rule.type === 'interval') return rule.minutes % 60 === 0 ? `Every ${rule.minutes / 60} hour${rule.minutes === 60 ? '' : 's'}` : `Every ${rule.minutes} minutes`;
  if (rule.type === 'daily') return `Every day at ${rule.time}${where}`;
  if (rule.type === 'weekly') return `Every ${rule.days.map(day => DAY_NAMES[day]).join(', ')} at ${rule.time}${where}`;
  return `Every month on day ${rule.day} at ${rule.time}${where}`;
}

/* ------------------------------------------------------------------ store */

const view = row => ({
  id: row.id, title: row.title, kind: row.kind, payload: row.payload, rule: row.rule, timeZone: row.time_zone,
  description: describeRule(row.rule, row.time_zone), nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
  runCount: row.run_count, lastOutcome: row.last_outcome, active: row.active, conversationId: row.conversation_id, createdAt: row.created_at
});

function normalizePayload(kind, payload = {}) {
  if (kind === 'reminder') {
    const message = text(payload.message).slice(0, 1000);
    if (!message) throw new ScheduleError('A reminder needs a message.');
    return { message };
  }
  const goal = text(payload.goal).slice(0, 4000);
  if (!goal) throw new ScheduleError('A scheduled question needs the question.');
  return { goal, consent: payload.consent === true };
}

export class Scheduler {
  constructor({ pool, runs, identity, logger, metrics, intervalMs = 30_000 } = {}) {
    Object.assign(this, { pool, runs, identity, logger, metrics, intervalMs });
    this.timer = null;
    this.active = null;
  }

  async create(scope, { title, kind, payload, rule, timeZone = 'UTC', conversationId = null }) {
    if (!KINDS.includes(kind)) throw new ScheduleError('The kind must be reminder or ask.');
    const zone = validTimeZone(text(timeZone)) ? text(timeZone) : 'UTC';
    const checked = normalizeRule(rule);
    const next = nextOccurrence(checked, zone);
    if (!next) throw new ScheduleError('That time has already passed.');
    const { rows: [{ count }] } = await this.pool.query('SELECT count(*)::int AS count FROM schedules WHERE workspace_id = $1 AND principal_id = $2 AND active', [scope.workspaceId, scope.principalId]);
    if (count >= MAX_SCHEDULES) throw new ScheduleError(`You have ${MAX_SCHEDULES} active schedules; cancel some first.`, 'schedule-limit');
    const { rows: [row] } = await this.pool.query(
      `INSERT INTO schedules (id, workspace_id, principal_id, conversation_id, title, kind, payload, rule, time_zone, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10) RETURNING *`,
      [`sch_${crypto.randomUUID()}`, scope.workspaceId, scope.principalId, conversationId, text(title).slice(0, 120) || 'Scheduled', kind,
        JSON.stringify(normalizePayload(kind, payload)), JSON.stringify(checked), zone, next]
    );
    return view(row);
  }

  async list(scope) {
    const { rows } = await this.pool.query('SELECT * FROM schedules WHERE workspace_id = $1 AND principal_id = $2 ORDER BY active DESC, next_run_at NULLS LAST, created_at DESC LIMIT 200', [scope.workspaceId, scope.principalId]);
    return rows.map(view);
  }

  async cancel(scope, id) {
    const { rows: [row] } = await this.pool.query('UPDATE schedules SET active = false, next_run_at = NULL WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 AND active RETURNING *', [text(id), scope.workspaceId, scope.principalId]);
    return row ? view(row) : null;
  }

  async notifications(scope, { limit = 30 } = {}) {
    const { rows } = await this.pool.query('SELECT * FROM notifications WHERE workspace_id = $1 AND principal_id = $2 ORDER BY created_at DESC LIMIT $3', [scope.workspaceId, scope.principalId, Math.min(100, limit)]);
    return rows.map(row => ({ id: row.id, title: row.title, body: row.body, tone: row.tone, link: row.link, read: Boolean(row.read_at), createdAt: row.created_at, scheduleId: row.schedule_id }));
  }

  async markRead(scope, ids = null) {
    const { rowCount } = Array.isArray(ids) && ids.length
      ? await this.pool.query('UPDATE notifications SET read_at = now() WHERE workspace_id = $1 AND principal_id = $2 AND read_at IS NULL AND id = ANY($3::text[])', [scope.workspaceId, scope.principalId, ids.map(text).slice(0, 100)])
      : await this.pool.query('UPDATE notifications SET read_at = now() WHERE workspace_id = $1 AND principal_id = $2 AND read_at IS NULL', [scope.workspaceId, scope.principalId]);
    return rowCount;
  }

  /** Due schedules, leased for two minutes so no two workers do the same one. */
  async claimDue(now = new Date()) {
    return runDbScope({ principalId: '', workspaceId: '', organizationId: '', jurisdiction: '', role: 'scheduler' }, () =>
      transaction(this.pool, async client => {
        const { rows } = await client.query(
          `UPDATE schedules SET lease_until = $1::timestamptz + interval '2 minutes'
            WHERE id IN (
              SELECT id FROM schedules
               WHERE active AND next_run_at <= $1 AND (lease_until IS NULL OR lease_until < $1)
               ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 20)
            RETURNING *`,
          [now]
        );
        return rows;
      }));
  }

  async notify(scope, schedule, { title, body = '', tone = 'info', link = null }) {
    await this.pool.query(
      'INSERT INTO notifications (id, workspace_id, principal_id, schedule_id, title, body, tone, link) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)',
      [`ntf_${crypto.randomUUID()}`, scope.workspaceId, scope.principalId, schedule?.id ?? null, text(title).slice(0, 160), text(body).slice(0, 2000), tone, link ? JSON.stringify(link) : null]
    );
  }

  /** Do one schedule, as its owner. */
  async fire(row, now = new Date()) {
    const scope = { principalId: row.principal_id, workspaceId: row.workspace_id, organizationId: '', jurisdiction: '', role: '' };
    return runDbScope(scope, async () => {
      let outcome;
      let stillAllowed = true;
      try {
        const access = await this.identity.requireAccess({ id: row.principal_id }, row.workspace_id, row.kind === 'reminder' ? 'viewer' : 'editor');
        access.principalId = row.principal_id;
        outcome = await this.#perform(access, row);
      } catch (error) {
        if (error?.status === 403 || error?.status === 401 || /access|member/i.test(error?.message ?? '')) stillAllowed = false;
        outcome = { ok: false, error: text(error?.message) || 'The schedule could not run.' };
        this.logger?.warn('schedule failed', { scheduleId: row.id, error: outcome.error });
      }
      const next = stillAllowed ? nextOccurrence(row.rule, row.time_zone, now) : null;
      await this.pool.query(
        `UPDATE schedules SET last_run_at = $2, run_count = run_count + 1, last_outcome = $3::jsonb,
                next_run_at = $4, active = $5, lease_until = NULL WHERE id = $1`,
        [row.id, now, JSON.stringify(outcome), next, Boolean(next)]
      );
      this.metrics?.increment('schedules_fired_total', { kind: row.kind, outcome: outcome.ok ? 'ok' : 'failed' });
      return outcome;
    });
  }

  async #perform(scope, row) {
    const payload = row.payload ?? {};
    if (row.kind === 'reminder') {
      await this.notify(scope, row, { title: row.title, body: payload.message, link: row.conversation_id ? { conversationId: row.conversation_id } : null });
      return { ok: true };
    }
    if (row.kind === 'ask') {
      const run = await this.runs.create(scope, { id: row.principal_id }, {
        goal: payload.goal, conversationId: row.conversation_id || undefined, timeZone: row.time_zone,
        privacyConsent: { modelProvider: payload.consent === true }
      });
      await this.notify(scope, row, { title: row.title, body: `Your scheduled question is ready: ${payload.goal.slice(0, 200)}`, link: { conversationId: row.conversation_id || run.conversationId || null, runId: run.id } });
      return { ok: true, runId: run.id };
    }
    throw new Error(`Unknown schedule kind "${row.kind}".`);
  }

  async runOnce(now = new Date()) {
    const due = await this.claimDue(now);
    for (const row of due) await this.fire(row, now);
    return due.length;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = this.runOnce().catch(error => this.logger?.error('scheduler cycle failed', { error })).finally(() => { this.active = null; });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }
}

/* ------------------------------------------------------------------ tools */

registerTools([
  {
    name: 'schedule.create',
    title: 'Schedule something',
    description: 'Set a reminder, or ask a question in this chat at a set time. Times are in the person\'s time zone.',
    input: {
      title: 'short title', kind: 'reminder | ask',
      rule: '{"type":"once","at":"2026-10-01T09:00"} | {"type":"daily","time":"07:30"} | {"type":"weekly","days":[1,3],"time":"09:00"} | {"type":"monthly","day":1,"time":"09:00"} | {"type":"interval","minutes":60}',
      message: 'reminder text (reminder)', goal: 'the question (ask)'
    },
    sideEffect: true,
    ready: ctx => (ctx.scheduler ? { ready: true } : { ready: false, needs: 'admin', reason: 'Scheduling is not running on this site.' }),
    validate(input, ctx) {
      try {
        const rule = normalizeRule(input.rule ?? {});
        const zone = ctx.run?.adaptation?.timeZone || 'UTC';
        const next = nextOccurrence(rule, zone);
        if (!next) return { error: 'That time has already passed.' };
        normalizePayload(text(input.kind), { message: input.message, goal: input.goal });
        input.firstRun = next.toISOString();
        input.timeZone = zone;
        return null;
      } catch (error) {
        return { error: error.message };
      }
    },
    summarize: (input, ctx) => {
      try {
        const zone = ctx.run?.adaptation?.timeZone || 'UTC';
        return `${text(input.title) || 'Schedule'}: ${describeRule(normalizeRule(input.rule ?? {}), zone)}`;
      } catch {
        return text(input.title) || 'Schedule something';
      }
    },
    async run(input, ctx) {
      const schedule = await ctx.scheduler.create(ctx.scope, {
        title: input.title, kind: text(input.kind), rule: input.rule, timeZone: input.timeZone || ctx.run?.adaptation?.timeZone || 'UTC',
        conversationId: ctx.run?.conversationId ?? null,
        payload: { message: input.message, goal: input.goal, consent: ctx.run?.adaptation?.privacy?.consent?.modelProvider === true }
      });
      return { scheduled: schedule.id, description: schedule.description, nextRunAt: schedule.nextRunAt, note: `Scheduled: ${schedule.description}.` };
    }
  },
  {
    name: 'schedule.list',
    title: 'List schedules',
    description: 'The person\'s active reminders and scheduled questions, with when each runs next.',
    input: {},
    ready: ctx => (ctx.scheduler ? { ready: true } : { ready: false, needs: 'admin', reason: 'Scheduling is not running on this site.' }),
    async run(_input, ctx) {
      const schedules = await ctx.scheduler.list(ctx.scope);
      return { schedules: schedules.filter(item => item.active).map(item => ({ id: item.id, title: item.title, kind: item.kind, when: item.description, nextRunAt: item.nextRunAt })) };
    }
  }
]);
