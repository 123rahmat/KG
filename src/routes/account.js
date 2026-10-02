/**
 * Account routes: AI usage, Stripe-hosted billing and sign-in sessions.
 *
 * Billing is intentionally provider-owned. Kindgleam exposes plan/entitlement
 * state but does not collect, store or edit billing-profile/payment details.
 */

import { text, parseCookies, sessionCookieName } from '../http/context.js';
import { usageSummary, limitsFor } from '../usage.js';
import { ScheduleError } from '../scheduling.js';
import { MemoryError } from '../memory.js';
import { termsStatus, acceptTerms } from '../terms.js';
import crypto from 'node:crypto';
import { encryptJson, decryptJson } from '../data-protection.js';

const CONVERSATION_ID = /^[A-Za-z0-9-]{8,64}$/;
export function registerAccountRoutes(app, { config, pool, identity, audit, route, scoped, scheduler = null, memories = null }) {
  app.get('/api/usage', scoped('viewer'), route(async (req, res) => {
    const conversationId = text(req.query?.conversationId);
    res.json(await usageSummary(pool, {
      principalId: req.principal.id,
      workspaceId: req.scope.workspaceId,
      config,
      conversationId: CONVERSATION_ID.test(conversationId) ? conversationId : null,
      // AI quota is account-wide; the active workspace only selects chat context.
      limits: await limitsFor(pool, config, req.scope.workspaceId, req.principal.id)
    }));
  }));

  app.get('/api/billing', scoped('viewer'), route(async (req, res) => {
    const admin = req.scope.role === 'admin';
    const { rows: [row] } = await pool.query(
      'SELECT subscription_status, plan_id, current_period_end, cancel_at_period_end FROM workspace_billing WHERE workspace_id = $1',
      [req.scope.workspaceId]
    );
    const limits = await limitsFor(pool, config, req.scope.workspaceId, req.principal.id);
    res.json({
      plan: limits.planName,
      planId: limits.planId,
      supportEmail: config.billing.supportEmail,
      // Stripe is the system of record for payment methods, invoices and
      // customer billing details. Kindgleam keeps only entitlement state and
      // opaque provider references required to open the hosted portal.
      portalUrl: admin && !config.stripe ? config.billing.portalUrl : null,
      portalConfigured: Boolean(config.stripe || config.billing.portalUrl),
      canManage: admin && Boolean(config.stripe || config.billing.portalUrl),
      limits: { fourHourTokens: limits.fourHourTokens || null, weeklyTokens: limits.weeklyTokens || null },
      stripe: config.stripe ? {
        plans: [
          { id: 'free', free: true, name: config.billing.free.name, price: '$0', description: config.billing.free.description, features: config.billing.free.features, fourHourTokens: config.usage.fourHourTokens, weeklyTokens: config.usage.weeklyTokens },
          ...config.stripe.plans.map(({ priceId: _price, priceIds: _prices, ...plan }) => plan)
        ],
        subscription: row?.subscription_status ? {
          status: row.subscription_status,
          planId: row.plan_id || null,
          currentPeriodEnd: row.current_period_end,
          cancelAtPeriodEnd: row.cancel_at_period_end
        } : null
      } : null,
      billingAuthority: 'stripe',
      billingDetailsStoredLocally: false
    });
  }));

  app.get('/api/sessions', route(async (req, res) => {
    res.json({ sessions: await identity.listSessions(req.principal.id, parseCookies(req.get('cookie'))[sessionCookieName(config)]) });
  }));

  app.post('/api/sessions/revoke-others', route(async (req, res) => {
    const revoked = await identity.revokeOtherSessions(req.principal.id, parseCookies(req.get('cookie'))[sessionCookieName(config)]);
    res.json({ revoked });
  }));

  /* ------------------------------------------------ schedules and notifications */

  const needScheduler = res => {
    if (scheduler) return true;
    res.status(503).json({ error: 'Scheduling is not running on this site.', code: 'scheduler-unavailable' });
    return false;
  };

  app.get('/api/schedules', scoped('viewer'), route(async (req, res) => {
    if (!needScheduler(res)) return;
    res.json({ schedules: await scheduler.list(req.scope) });
  }));

  // A person can also set a schedule directly (the AI proposes them in chat).
  app.post('/api/schedules', scoped('viewer'), route(async (req, res) => {
    if (!needScheduler(res)) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.kind !== 'reminder' && !['editor', 'admin'].includes(req.scope.role)) {
      return res.status(403).json({ error: 'Only editors can schedule reminders and questions.', code: 'forbidden' });
    }
    try {
      const schedule = await scheduler.create(req.scope, { title: body.title, kind: body.kind, rule: body.rule, timeZone: body.timeZone, payload: body.payload ?? {}, conversationId: typeof body.conversationId === 'string' ? body.conversationId.slice(0, 64) : null });
      await audit?.record({ principalId: req.principal.id, workspaceId: req.scope.workspaceId, action: 'schedule.create', target: schedule.id, outcome: 'allowed', detail: { kind: schedule.kind }, requestId: req.requestId });
      res.status(201).json({ schedule });
    } catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      res.status(error.status).json({ error: error.message, code: error.code });
    }
  }));

  app.delete('/api/schedules/:id', scoped('viewer'), route(async (req, res) => {
    if (!needScheduler(res)) return;
    const schedule = await scheduler.cancel(req.scope, req.params.id);
    if (!schedule) return res.status(404).json({ error: 'No active schedule has that id.', code: 'schedule-not-found' });
    res.json({ schedule });
  }));

  app.get('/api/notifications', scoped('viewer'), route(async (req, res) => {
    if (!needScheduler(res)) return;
    const notifications = await scheduler.notifications(req.scope);
    res.json({ notifications, unread: notifications.filter(item => !item.read).length });
  }));

  app.post('/api/notifications/read', scoped('viewer'), route(async (req, res) => {
    if (!needScheduler(res)) return;
    res.json({ marked: await scheduler.markRead(req.scope, Array.isArray(req.body?.ids) ? req.body.ids : null) });
  }));

  /* ------------------------------------------------------------- memory */

  // Each person sees and manages only their own explicit cross-chat memories.
  app.get('/api/memories', scoped('viewer'), route(async (req, res) => {
    const crossChatMemory = await memories.crossChatEnabled(req.scope.principalId);
    res.json({ crossChatMemory, enabled: crossChatMemory, memories: await memories.list(req.scope) });
  }));

  app.post('/api/memories', scoped('viewer'), route(async (req, res) => {
    try {
      const { memory, created } = await memories.add(req.scope, { content: req.body?.content, kind: req.body?.kind });
      res.status(created ? 201 : 200).json({ memory });
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      res.status(error.status).json({ error: error.message, code: error.code });
    }
  }));

  app.delete('/api/memories/:id', scoped('viewer'), route(async (req, res) => {
    const removed = await memories.forget(req.scope, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Memory not found', code: 'memory-not-found' });
    res.json({ removed });
  }));

  app.delete('/api/memories', scoped('viewer'), route(async (req, res) => {
    res.json({ removed: await memories.clear(req.scope) });
  }));

  /* --------------------------------------------------- terms and reports */

  app.get('/api/terms', route(async (req, res) => {
    res.json(await termsStatus(pool, config, req.principal.id));
  }));

  app.post('/api/terms', route(async (req, res) => {
    const result = await acceptTerms(pool, config, req.principal.id, {
      version: req.body?.version, ageConfirmed: req.body?.ageConfirmed, accept: req.body?.accept
    });
    if (result.error) return res.status(400).json(result);
    await audit?.record({ principalId: req.principal.id, workspaceId: '', action: 'terms.accept', target: config.terms.version, outcome: 'allowed', requestId: req.requestId });
    res.json(await termsStatus(pool, config, req.principal.id));
  }));

  const REPORT_REASONS = ['harmful', 'wrong', 'unfair', 'privacy', 'other'];
  const reportRow = row => ({
    id: row.id, runId: row.run_id, reason: row.reason,
    note: row.note_enc ? decryptJson(config.security.personalDataEncryptionKey, 'safety-report-note-v1', row.note_enc) : row.note,
    excerpt: row.excerpt_enc ? decryptJson(config.security.personalDataEncryptionKey, 'safety-report-excerpt-v1', row.excerpt_enc) : row.excerpt,
    status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at
  });

  // Anyone who can read an answer can report it; the workspace's admins review.
  app.post('/api/runs/:id/report', scoped('viewer'), route(async (req, res) => {
    const reason = String(req.body?.reason ?? '');
    if (!REPORT_REASONS.includes(reason)) return res.status(400).json({ error: `Choose a reason: ${REPORT_REASONS.join(', ')}.`, code: 'report-reason' });
    const { rows: [run] } = await pool.query(
      'SELECT id FROM runs WHERE id = $1 AND workspace_id = $2 AND (visibility = \'workspace\' OR principal_id = $3)',
      [req.params.id, req.scope.workspaceId, req.principal.id]
    );
    if (!run) return res.status(404).json({ error: 'Chat not found', code: 'no-run' });
    const { rows: tasks } = await pool.query(
      "SELECT evidence->>'text' AS text FROM run_tasks WHERE run_id = $1 AND type IN ('respond', 'deliver', 'prototype', 'investigate', 'tool') AND evidence ? 'text' ORDER BY position DESC LIMIT 1",
      [run.id]
    ).catch(() => ({ rows: [] }));
    const note = String(req.body?.note ?? '').trim().slice(0, 1000);
    const excerpt = String(tasks[0]?.text ?? '').slice(0, 2000);
    const { rows: [row] } = await pool.query(
      `INSERT INTO safety_reports
        (id, workspace_id, principal_id, run_id, reason, note, excerpt, note_enc, excerpt_enc, encryption_version)
       VALUES ($1, $2, $3, $4, $5, '', '', $6, $7, 1) RETURNING *`,
      [crypto.randomUUID(), req.scope.workspaceId, req.principal.id, run.id, reason,
        encryptJson(config.security.personalDataEncryptionKey, 'safety-report-note-v1', note),
        encryptJson(config.security.personalDataEncryptionKey, 'safety-report-excerpt-v1', excerpt)]
    );
    await audit?.record({ principalId: req.principal.id, workspaceId: req.scope.workspaceId, action: 'answer.report', target: run.id, outcome: 'allowed', detail: { reason }, requestId: req.requestId });
    res.status(201).json({ report: reportRow(row) });
  }));

  // Admins see every report in the workspace; others see their own.
  app.get('/api/reports', scoped('viewer'), route(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM safety_reports
         WHERE workspace_id = $1 AND (principal_id = $2 OR $3 = true)
         ORDER BY status = 'open' DESC, created_at DESC LIMIT 200`,
      [req.scope.workspaceId, req.principal.id, req.scope.role === 'admin']
    );
    let declined = null;
    if (req.scope.role === 'admin') {
      const { rows: counts } = await pool.query(
        `SELECT category, count(*)::int AS count FROM safety_events
          WHERE workspace_id = $1 AND created_at > now() - interval '30 days' GROUP BY category ORDER BY count DESC`,
        [req.scope.workspaceId]
      );
      declined = counts;
    }
    res.json({ reports: rows.map(reportRow), declined, canReview: req.scope.role === 'admin' });
  }));

  app.post('/api/reports/:id', scoped('admin'), route(async (req, res) => {
    const status = String(req.body?.status ?? '');
    if (!['resolved', 'dismissed', 'open'].includes(status)) return res.status(400).json({ error: 'Status is resolved, dismissed or open.', code: 'report-status' });
    const { rows: [row] } = await pool.query(
      `UPDATE safety_reports SET status = $2, resolved_by = CASE WHEN $2 = 'open' THEN NULL ELSE $3 END,
              resolved_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END
        WHERE id = $1 AND workspace_id = $4 RETURNING *`,
      [req.params.id, status, req.principal.id, req.scope.workspaceId]
    );
    if (!row) return res.status(404).json({ error: 'Report not found', code: 'no-report' });
    await audit?.record({ principalId: req.principal.id, workspaceId: req.scope.workspaceId, action: 'report.review', target: row.id, outcome: 'allowed', detail: { status }, requestId: req.requestId });
    res.json({ report: reportRow(row) });
  }));
}
