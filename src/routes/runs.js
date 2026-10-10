/** Planning and the server-owned run lifecycle. */

import { planGoal, evaluatePolicy, SMALL_TALK } from '../core.js';
import { classifyGoal } from '../classifier.js';
import { chooseExecutionTarget, executionTarget } from '../execution.js';
import { planningInput, publicClassification } from '../http/context.js';
import { RunError } from '../runs.js';
import { classifyAttachmentSet, formatOf, inspectArchive } from '../documents.js';
import { assertUsageAllowed, createUsageGate, UsageLimitError, recordUsage } from '../usage.js';
import { screenRequest, combineDecisions, recordRefusal, inCooldown, careNote, blockedTopicsFrom, ethicsOf, FIXED_REPLY_CATEGORIES } from '../safety.js';
import { assertTermsAccepted } from '../terms.js';
import { configuredExecutionTargets, planPolicyAllows, dataPolicyAllows, modelPolicyAllows } from '../http/policy.js';
import { resolveModelSelection } from '../model-routing.js';
import { FeedbackStore } from '../feedback.js';
import { EvolutionStore } from '../evolution.js';
import { SkillLearningStore, skillContextSignature } from '../skills.js';
import { admitControlEngineRequest, ControlAdmissionError, verifyControlledRun } from '../control-engine-admission.js';
import { conversationFileLinks, presentConversationFile } from '../chat-files.js';

// Files the AI reads for itself: text and code, CSV, PDF, Word, Excel and
// PowerPoint become text; images are shown to the model. Anything else stays
// a file that needs a tool (or the person) to inspect.
const READABLE_FORMATS = new Set(['text', 'csv', 'pdf', 'docx', 'xlsx', 'pptx', 'image', 'project', 'bundle']);
const MAX_READABLE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

export function registerRunsRoutes(app, { config, governance, runs, objects, fetchImpl, scoped, idempotent, route, pool, audit, memories = null }) {
  /** What this deployment can really run, so plans never wait on a missing runner. */
  const feedback = config.security?.personalDataEncryptionKey
    ? new FeedbackStore(pool, { encryptionKey: config.security.personalDataEncryptionKey })
    : null;
  const evolution = config.security?.personalDataEncryptionKey
    ? new EvolutionStore(pool, { encryptionKey: config.security.personalDataEncryptionKey })
    : null;

  const skillLearning = new SkillLearningStore(pool);

  function executionAvailable() {
    return {
      code: configuredExecutionTargets(config, 'code').length > 0
    };
  }

  /**
   * Resolve attachment ids to files this person may read. An id that is not
   * theirs to see is refused rather than silently dropped.
   */
  async function resolveAttachments(req) {
    const ids = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const sourceId = typeof req.body?.workspaceSourceId === 'string' ? req.body.workspaceSourceId : '';
    if (ids.length > MAX_ATTACHMENTS) {
      throw new RunError(`At most ${MAX_ATTACHMENTS} files can be attached to one message`, { status: 400, code: 'too-many-attachments' });
    }
    const attachments = [];
    for (const id of ids) {
      const object = typeof id === 'string' ? await objects.get(req.scope, id) : null;
      if (!object) {
        throw new RunError('An attached file was not found', { status: 400, code: 'attachment-not-found' });
      }
      const detectedFormat = formatOf({ name: object.name, contentType: object.contentType });
      const readable = READABLE_FORMATS.has(detectedFormat)
        && object.size <= (detectedFormat === 'image' ? MAX_IMAGE_BYTES : MAX_READABLE_BYTES);
      let attachmentFormat = detectedFormat;
      let archiveKind = null;
      let archiveItemCount = null;
      if (detectedFormat === 'project' && /\\.zip$/i.test(String(object.name ?? '')) && readable) {
        try {
          const stored = await objects.read(req.scope, object.id);
          const inspected = inspectArchive(Buffer.from(stored.content));
          attachmentFormat = inspected.archiveKind === 'code-project' ? 'project' : 'bundle';
          archiveKind = inspected.archiveKind ?? null;
          archiveItemCount = Number(inspected.itemCount) || 0;
        } catch {
          // The normal attachment reader reports the exact parse failure later.
          // Do not let profile inspection turn a readable upload into a planning failure.
        }
      }
      attachments.push({
        id: object.id,
        name: object.name ?? object.id,
        contentType: object.contentType,
        size: object.size,
        format: attachmentFormat,
        readable: readable,
        ...(archiveKind ? { archiveKind, ...(archiveItemCount != null ? { archiveItemCount } : {}) } : {})
      });
    }
    if (sourceId) {
      const { rows: [source] } = await pool.query(
        `SELECT id, kind, name, snapshot_object_id, repo_owner, repo_name, repo_ref, permissions
           FROM workspace_sources
          WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 AND revoked_at IS NULL
          LIMIT 1`,
        [sourceId, req.scope.workspaceId, req.principal.id]
      );
      if (!source || !source.snapshot_object_id) {
        throw new RunError('The selected workspace source is unavailable.', { status: 404, code: 'workspace-source-not-found' });
      }
      const object = await objects.get(req.scope, source.snapshot_object_id);
      if (!object) throw new RunError('The selected workspace source snapshot is unavailable.', { status: 409, code: 'workspace-source-snapshot-missing' });
      attachments.push({
        id: object.id,
        name: object.name ?? source.name,
        contentType: object.contentType,
        size: object.size,
        format: 'project',
        readable: true,
        sourceId: source.id,
        sourceKind: source.kind,
        sourceName: source.name,
        sourcePermissions: source.permissions ?? {},
        sourceRepo: source.kind === 'github' ? { owner: source.repo_owner, repo: source.repo_name, ref: source.repo_ref } : null
      });
    }
    return attachments;
  }

  /** A non-safety scope decline: no model/tool spend or abuse strike. */
  async function strictProductAdmission(req, res) {
    if (config.product?.codingResearchOnly !== true && config.product?.codingOnly !== true) return null;
    try {
      return await admitControlEngineRequest({
        pool,
        scope: req.scope,
        principalId: req.principal.id,
        goal: req.body?.goal,
        projectId: req.body?.projectId,
        activeSurface: req.body?.activeSurface,
        conversationId: req.body?.conversationId,
        codingOnly: config.product?.codingOnly === true
      });
    } catch (error) {
      if (!(error instanceof ControlAdmissionError)) throw error;
      await audit?.record({
        principalId: req.principal.id, workspaceId: req.scope.workspaceId,
        action: 'product.scope.declined', target: 'new-work',
        outcome: 'denied', detail: { code: error.code },
        requestId: req.requestId
      });
      res.status(error.status).json({
        error: error.message, code: error.code,
        ...(error.detail ? { detail: error.detail } : {})
      });
      return false;
    }
  }

  async function strictExistingRun(req, res) {
    if (config.product?.codingResearchOnly !== true && config.product?.codingOnly !== true) return true;
    const run = await runs.get(req.scope, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Run not found', code: 'no-run' });
      return false;
    }
    const blocked = await verifyControlledRun({
      pool, run, scope: req.scope, principalId: req.principal.id,
      codingResearchOnly: true,
      codingOnly: config.product?.codingOnly === true
    });
    if (blocked) {
      res.status(blocked.status).json(blocked);
      return false;
    }
    return true;
  }

  /* ---------------------------------------------------------- workflow */

  // Plan without persisting or executing. Useful for previewing what a goal
  // would require before committing to a run.
  /**
   * Classify with the model only when the person consented to model
   * processing and governance permits the goal to go to that model.
   */
  async function classifyFor(req, policies) {
    // A greeting or thanks is read by the rules alone: nothing to classify.
    if (SMALL_TALK.test(String(req.body?.goal ?? ''))) return { hints: null, source: 'keywords', reason: 'small-talk' };
    const governanceDecision = evaluatePolicy(policies);
    const candidate = { governance: governanceDecision };
    const selection = await resolveModelSelection(pool, config, {
      workspaceId: req.scope?.workspaceId,
      principalId: req.principal.id
    });
    const model = selection.selectedModelId || String(config.ai?.provider || '') + ':' + String(config.ai?.model || '');
    const usageGate = createUsageGate(pool, {
      principalId: req.principal.id,
      workspaceId: req.scope?.workspaceId,
      conversationId: typeof req.body?.conversationId === 'string' ? req.body.conversationId : null,
      config
    });
    // Past a usage limit the goal is read by the keyword rules instead.
    const withinUsage = await assertUsageAllowed(pool, { principalId: req.principal.id, config, workspaceId: req.scope?.workspaceId }).then(() => true, error => {
      if (error instanceof UsageLimitError) return false;
      throw error;
    });
    const allowed = withinUsage && req.body?.privacyConsent?.modelProvider === true
      && governanceDecision.status !== 'incomplete'
      && modelPolicyAllows(candidate, model, 'low')
      && dataPolicyAllows(candidate, ['user-content'], 'model-provider', { explicitConsent: true });
    // A follow-up is read with the chat it continues, which it may see.
    const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
    const conversation = allowed && conversationId
      ? await runs.conversationHistory(req.scope, conversationId, { turns: 3, chars: 400 }).catch(() => [])
      : [];
    return classifyGoal(req.body?.goal, {
      config,
      fetchImpl,
      allowed,
      conversation,
      modelId: selection.selectedModelId,
      usageGate
    });
  }

  app.post('/api/plan', scoped('viewer'), route(async (req, res) => {
    const admitted = await strictProductAdmission(req, res);
    if (admitted === false) return;
    const policies = await governance.forScope({
      workspaceId: req.scope.workspaceId,
      principalId: req.principal.id,
      taskPolicy: req.body?.taskPolicy
    });
    const attachments = await resolveAttachments(req);
    const classification = await classifyFor(req, policies);
    const attachmentProfile = classifyAttachmentSet(attachments);
    const modelSelection = await resolveModelSelection(pool, config, {
      workspaceId: req.scope.workspaceId,
      principalId: req.principal.id
    });
    const planSkillContext = skillContextSignature({
      goal: req.body?.goal,
      taskType: classification.source === 'model' ? (classification.hints?.actions ?? []).includes('investigate') ? 'investigate' : classification.hints?.actions?.includes('answer') ? 'respond' : 'plan' : 'plan',
      intent: classification.hints?.intent?.kind ?? '',
      coding: req.body?.activeSurface === 'code' || /\b(?:code|coding|debug|repository|repo|software|program)\b/i.test(String(req.body?.goal ?? '')),
      projectWork: Boolean(
        req.body?.project
        || (req.body?.files ?? req.body?.artifacts ?? []).length
        || attachments.some(item => item.format === 'project' || item.sourceKind === 'github')
        || attachmentProfile.kind === 'code'
      ),
      language: req.body?.language ?? ''
    });
    const learnedSkills = await skillLearning.profiles(req.scope, { limit: 48, contextSignature: planSkillContext });
    const plan = planGoal(req.body?.goal, {
      ...planningInput(req, policies, config),
      ...(admitted ? {
        activeSurface: admitted.surface,
        enforcedControlSurface: admitted.surface,
        project: { id: admitted.projectId, currentRevision: admitted.projectRevision }
      } : {}),
      executionAvailable: executionAvailable(),
      blockedTopics: blockedTopicsFrom(config),
      classifierHints: classification.hints,
      modelSelection: modelSelection.selectedModelId || null,
      learnedSkills,
      attachments
    });
    if (plan.adaptation) plan.adaptation.classification = { ...plan.adaptation.classification, ...publicClassification(classification) };
    res.json(plan);
  }));

  app.post('/api/runs', scoped('editor'), idempotent, route(async (req, res) => {
    const admitted = await strictProductAdmission(req, res);
    if (admitted === false) return;
    const policies = await governance.forScope({
      workspaceId: req.scope.workspaceId,
      principalId: req.principal.id,
      taskPolicy: req.body?.taskPolicy
    });
    await assertTermsAccepted(pool, config, req.principal.id);
    // Someone who kept asking for what the usage policy declines waits a while.
    const cooldown = await inCooldown(pool, req.scope);
    if (cooldown) {
      return res.status(429).json({
        error: 'New chats are paused for a while after several requests the usage policy declines.',
        code: 'usage-policy-cooldown', until: cooldown.until
      });
    }
    // The AI quota belongs to the signed-in person in this workspace, not to
    // one conversation. Stop new AI work here so every chat sees the same lock
    // instead of creating a run that can only fail later at execution time.
    await assertUsageAllowed(pool, {
      principalId: req.principal.id,
      config,
      workspaceId: req.scope.workspaceId
    });
    const attachments = await resolveAttachments(req);
    const classification = await classifyFor(req, policies);
    const attachmentProfile = classifyAttachmentSet(attachments);
    const modelSelection = await resolveModelSelection(pool, config, {
      workspaceId: req.scope.workspaceId,
      principalId: req.principal.id
    });
    const runSkillContext = skillContextSignature({
      goal: req.body?.goal,
      taskType: 'plan',
      intent: classification.hints?.intent?.kind ?? '',
      coding: req.body?.activeSurface === 'code' || /\b(?:code|coding|debug|repository|repo|software|program)\b/i.test(String(req.body?.goal ?? '')),
      projectWork: Boolean(req.body?.project || (req.body?.files ?? req.body?.artifacts ?? []).length || attachmentProfile.kind === 'code'),
      language: req.body?.language ?? ''
    });
    const learnedSkills = await skillLearning.profiles(req.scope, { limit: 48, contextSignature: runSkillContext });
    const verdict = combineDecisions(screenRequest(req.body?.goal, { blockedTopics: blockedTopicsFrom(config) }), classification.hints?.policy);
    // When the model read the request, a declined one becomes a chat answered
    // for the person's situation and real need. Without that reading, and for
    // children's safety always, the reply is the fixed kind message.
    // A topic this site does not discuss at all (BLOCKED_TOPICS) always gets
    // the fixed reply: a model-written answer about it would itself be
    // stopped at the execution boundary, leaving the chat without a reply.
    const adaptive = verdict.decision === 'refuse' && classification.source === 'model' && !FIXED_REPLY_CATEGORIES.includes(verdict.category) && !verdict.topic;
    if (verdict.decision === 'refuse') {
      await recordRefusal(pool, req.scope, verdict);
      await audit?.record({
        principalId: req.principal.id, workspaceId: req.scope.workspaceId, action: verdict.topic ? 'usage-policy.off-topic' : 'usage-policy.refused',
        target: verdict.category, outcome: 'denied', detail: { source: verdict.source, adaptive }, requestId: req.requestId
      });
    }
    if (verdict.decision === 'refuse' && !adaptive) {
      // Tokens the classifier spent still count; the request itself is not kept.
      if (classification.usage) {
        await recordUsage(pool, { source: 'classifier', provider: classification.provider, model: classification.model, inputTokens: classification.usage.inputTokens, outputTokens: classification.usage.outputTokens });
      }
      return res.status(422).json({ error: verdict.message, code: 'usage-policy', category: verdict.category, alternatives: verdict.alternatives });
    }
    const input = {
      ...planningInput(req, policies, config),
      ...(admitted ? {
        activeSurface: admitted.surface,
        enforcedControlSurface: admitted.surface,
        controlEngineId: admitted.controlEngineId,
        project: { id: admitted.projectId, currentRevision: admitted.projectRevision },
        projectId: admitted.projectId
      } : {}),
      executionAvailable: executionAvailable()
    };
    // Topics that need care carry their cautions into every step.
    if (verdict.decision === 'care') input.constraints = [...(input.constraints ?? []), ...verdict.care.map(careNote)];
    const created = await runs.create(req.scope, req.principal, {
      ...input,
      // Readable files go to the model as text; only the rest need a file tool.
      files: [...(input.files ?? []), ...attachments.filter(file => !file.readable).map(file => file.name)],
      attachments,
      goal: req.body?.goal,
      conversationId: req.body?.conversationId,
      ...(req.body?.workspaceSourceId ? { workspaceSourceId: req.body.workspaceSourceId } : {}),
      ethics: ethicsOf(verdict),
      classifierHints: classification.hints,
      classification: publicClassification(classification),
      modelSelection: modelSelection.selectedModelId || null,
      learnedSkills
    }, { requestId: req.requestId });
    // Classification spent real tokens; they count against the run's budget.
    const usage = classification.usage;
    if (usage) await runs.addTokens(created.id, { ...usage, provider: classification.provider, model: classification.model }, { source: 'classifier' });
    res.status(201).json(usage ? await runs.get(req.scope, created.id) : created);
  }));

  app.get('/api/runs', scoped('viewer'), route(async (req, res) =>
    res.json(await runs.list(req.scope, {
      limit: req.query.limit, cursor: req.query.cursor, state: req.query.state
    }))));

  // A chat is a sequence of runs sharing a conversation id.
  app.get('/api/conversations', scoped('viewer'), route(async (req, res) =>
    res.json({
      conversations: await runs.conversations(req.scope, {
        limit: req.query.limit,
        projectId: req.query.projectId,
        surface: req.query.surface,
        status: req.query.status,
        query: req.query.search
      })
    })));

  app.get('/api/conversations/:id', scoped('viewer'), route(async (req, res) => {
    const list = await runs.conversationRuns(req.scope, req.params.id);
    if (!list.length) return res.status(404).json({ error: 'Conversation not found', code: 'no-conversation' });
    res.json({ id: req.params.id, runs: list });
  }));

  // The Chat / Files segmented view has a strictly conversation-scoped
  // attachment/artifact list, not a global workspace file browser.
  // Referenced IDs never bypass normal object visibility/tenant RLS.
  app.get('/api/conversations/:id/files', scoped('viewer'), route(async (req, res) => {
    const conversation = await runs.conversationRuns(req.scope, req.params.id);
    if (!conversation.length) {
      return res.status(404).json({ error: 'Conversation not found', code: 'no-conversation' });
    }
    const refs = conversationFileLinks(conversation);
    const candidateIds = [...new Set([...refs.attachmentIds, ...refs.artifactIds])];
    const { rows } = await pool.query(
      `SELECT id, name, type, content_type, size, created_at
         FROM objects
        WHERE workspace_id = $1
          AND (visibility = 'workspace' OR owner_id = $2)
          AND (id = ANY($3::text[])
            OR ((provenance->>'runId') = ANY($4::text[])
              AND EXISTS (
                SELECT 1 FROM runs linked
                 WHERE linked.id::text = objects.provenance->>'runId'
                   AND linked.workspace_id = objects.workspace_id
                   AND linked.principal_id = objects.owner_id
              )))
        ORDER BY created_at DESC, id DESC
        LIMIT 501`,
      [req.scope.workspaceId, req.scope.principalId, candidateIds, refs.runIds]
    );
    const linked = new Set(refs.attachmentIds);
    return res.json({
      conversationId: req.params.id,
      files: rows.slice(0, 500).map(row => presentConversationFile(row, linked)),
      truncated: rows.length > 500
    });
  }));

  // Deleting a chat removes the person's own messages in it, with their
  // steps, jobs and proposed actions. Memories and files they chose to keep stay.
  app.delete('/api/conversations/:id', scoped('viewer'), route(async (req, res) => {
    const id = String(req.params.id ?? '');
    const { rows } = await pool.query(
      `DELETE FROM runs
        WHERE workspace_id = $1 AND principal_id = $2 AND COALESCE(conversation_id, id::text) = $3
        RETURNING id`,
      [req.scope.workspaceId, req.scope.principalId, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Chat not found', code: 'no-conversation' });
    // Chat-local memories belong to the chat and disappear with it. Explicit
    // cross-chat memories are conversation_id NULL and remain.
    await memories?.clearConversation(req.scope, id).catch(() => {});
    await audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId, action: 'conversation.delete',
      target: id, outcome: 'allowed', detail: { runs: rows.length }, requestId: req.requestId
    });
    res.json({ deleted: rows.length });
  }));

  app.get('/api/runs/:id', scoped('viewer'), route(async (req, res) => {
    const run = await runs.get(req.scope, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found', code: 'no-run' });
    res.json(run);
  }));


  app.get('/api/runs/:id/feedback', scoped('viewer'), route(async (req, res) => {
    const run = await runs.get(req.scope, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found', code: 'no-run' });
    if (run.principalId !== req.principal.id) return res.status(404).json({ error: 'Run not found', code: 'no-run' });
    res.json({ feedback: feedback ? await feedback.list(req.scope, req.params.id) : [] });
  }));

  app.post('/api/runs/:id/feedback', scoped('editor'), route(async (req, res) => {
    const run = await runs.get(req.scope, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found', code: 'no-run' });
    if (run.principalId !== req.principal.id) return res.status(403).json({ error: 'Only the run owner can rate this result.', code: 'feedback-owner-only' });
    if (!feedback) return res.status(503).json({ error: 'Feedback storage is not configured.', code: 'feedback-unavailable' });
    const saved = await feedback.add(req.scope, req.principal, run.id, req.body ?? {});
    await evolution?.captureFeedback(req.scope, {
      feedbackId: saved.id, runId: run.id, reason: saved.reason, note: req.body?.note
    }).catch(error => audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId,
      action: 'evolution.capture.failed', target: run.id, outcome: 'warning',
      detail: { code: error.code ?? 'capture-failed' }, requestId: req.requestId
    }));
    await audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId,
      action: 'run.feedback', target: run.id, outcome: 'allowed',
      detail: { rating: saved.rating, reason: saved.reason }, requestId: req.requestId
    });
    const feedbackOutcome = saved.rating === 'positive'
      ? 'success'
      : ['too-slow', 'too-expensive', 'other'].includes(saved.reason) ? 'uncertain'
        : 'failure';
    const feedbackUtility = saved.rating === 'positive'
      ? 1
      : saved.reason === 'too-slow' || saved.reason === 'too-expensive' ? -0.5
        : saved.reason === 'other' ? 0
          : -1;
    const runSkills = [...new Set([
      ...(Array.isArray(run.tasks) ? run.tasks : [])
        .flatMap(task => Array.isArray(task?.evidence?.skillsUsed) ? task.evidence.skillsUsed : []),
      ...((run.tasks ?? []).some(task => Array.isArray(task?.evidence?.skillsUsed) && task.evidence.skillsUsed.length)
        ? []
        : (Array.isArray(run.adaptation?.skills) ? run.adaptation.skills.map(item => item?.name) : []))
    ].map(item => String(item ?? '').trim()).filter(Boolean))];
    const feedbackTaskType = (Array.isArray(run.tasks) ? run.tasks : [])
      .find(task => Array.isArray(task?.evidence?.skillsUsed) && task.evidence.skillsUsed.length)?.id
      || run.intent?.kind
      || 'run';
    await skillLearning.observe(req.scope, {
      runId: run.id,
      taskId: 'run-feedback',
      taskType: feedbackTaskType,
      skillNames: runSkills,
      outcome: feedbackOutcome,
      source: 'feedback',
      reason: saved.reason,
      eventKey: saved.id,
      contextSignature: run.adaptation?.learning?.patternContext ?? '',
      utilitySignal: feedbackUtility
    }).catch(error => audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId,
      action: 'skill.learning.failed', target: run.id, outcome: 'warning',
      detail: { source: 'feedback', code: error.code ?? 'learning-failed' }, requestId: req.requestId
    }));
    res.status(201).json({ feedback: saved });
  }));

  app.get('/api/skills/profiles', scoped('viewer'), route(async (req, res) =>
    res.json({ version: '2', profiles: await skillLearning.profiles(req.scope, { limit: req.query.limit }) })));

  app.delete('/api/skills/profiles', scoped('editor'), route(async (req, res) => {
    const cleared = await skillLearning.clear(req.scope);
    await audit?.record({
      principalId: req.principal.id,
      workspaceId: req.scope.workspaceId,
      action: 'skill.learning.cleared',
      target: 'self',
      outcome: 'allowed',
      detail: cleared,
      requestId: req.requestId
    });
    res.json({ cleared });
  }));

  app.get('/api/audit/integrity', scoped('admin'), route(async (req, res) => {
    const result = audit ? await audit.verify({ workspaceId: req.scope.workspaceId, limit: req.query.limit }) : { ok: false, checked: 0, reason: 'audit-unavailable' };
    res.status(result.ok ? 200 : 503).json({ audit: result });
  }));

  app.get('/api/evolution/proposals', scoped('admin'), route(async (req, res) => {
    res.json({ proposals: evolution ? await evolution.list(req.scope, { status: req.query.status, limit: req.query.limit }) : [] });
  }));

  app.post('/api/evolution/proposals/:id/status', scoped('admin'), route(async (req, res) => {
    if (!evolution) return res.status(503).json({ error: 'Evolution storage is not configured.', code: 'evolution-unavailable' });
    const saved = await evolution.setStatus(req.scope, req.principal, req.params.id, req.body?.status);
    await audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId,
      action: 'evolution.proposal.status', target: saved.id, outcome: 'allowed',
      detail: { status: saved.status, target: saved.target }, requestId: req.requestId
    });
    res.json({ proposal: saved });
  }));

  // Record a real outcome for one task. The client names the task and supplies
  // evidence; the server decides whether that task may complete.
  app.post('/api/runs/:id/advance', scoped('editor'), route(async (req, res) => {
    if (!(await strictExistingRun(req, res))) return;
    res.json(await runs.advance(
      req.scope, req.principal, req.params.id, req.body?.taskId, req.body ?? {},
      { requestId: req.requestId }
    ));
  }));

  app.post('/api/runs/:id/fail', scoped('editor'), route(async (req, res) => {
    if (!(await strictExistingRun(req, res))) return;
    const run = await runs.fail(req.scope, req.principal, req.params.id, req.body?.reason, {
      requestId: req.requestId
    });
    if (!run) return res.status(404).json({ error: 'Run not found', code: 'no-run' });
    res.json(run);
  }));

  /**
   * Execute the run's next task for real, and record what came back as that
   * task's evidence.
   *
   * Approval and iterate are deliberately excluded: both are human decisions,
   * and a system that auto-approves its own gate has no gate.
   */
  app.post('/api/runs/:id/execution-plan', scoped('editor'), route(async (req, res) => {
    if (!(await strictExistingRun(req, res))) return;
    const run = await runs.get(req.scope, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found', code: 'no-run' });
    const task = run.tasks.find(item => item.id === run.next);
    if (!task || task.type !== 'code') {
      return res.json({
        status: 'not-applicable',
        task: task ? { id: task.id, type: task.type } : null,
        run
      });
    }

    const availableTargets = configuredExecutionTargets(config, task.type);
    const decision = chooseExecutionTarget(task.type, {
      preference: req.body?.executionTarget,
      preflight: req.body?.preflight,
      requirements: task.metadata?.requirements,
      cloudFallbackAllowed: req.body?.cloudFallbackAllowed !== false,
      availableTargets
    });
    const selected = decision.target ? executionTarget(decision.target) : null;
    const targetRisk = 'high';
    const policyAllowed = decision.target
      ? planPolicyAllows(run, decision.target, targetRisk)
      : true;

    res.json({
      ...decision,
      target: policyAllowed ? decision.target : null,
      policyAllowed,
      policyReason: policyAllowed ? null : 'The active governance policy does not allow this execution target.',
      targetDefinition: selected,
      availableTargets,
      localAgentUrl: config.execution.localAgentUrl
    });
  }));
}
