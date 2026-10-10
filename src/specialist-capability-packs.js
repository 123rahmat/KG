/**
 * Expand family-owned skills without an arbitrary "eight children" contract.
 * Common checks are useful for every family; topic packs add expertise only
 * to matching families. The runtime recruits *none* of these automatically:
 * the existing task/quality/budget scheduler selects scoped lenses later.
 */
const foundation=Object.freeze({
  'normal-chat':Object.freeze([
    'requirements-fidelity','accessible-communication','uncertainty-disclosure',
    'output-validation'
  ]),
  code:Object.freeze([
    'acceptance-traceability','dependency-impact-review','negative-case-checks',
    'revision-consistency','observable-test-receipts','rollback-risk-review'
  ]),
  research:Object.freeze([
    'research-question-traceability','source-provenance',
    'counterevidence-search','method-validity-check',
    'reproducibility-review','uncertainty-and-limits'
  ])
});
const pack=(match,skills)=>Object.freeze({match,skills:Object.freeze(skills.split('|'))});
const packs=Object.freeze({
  code:Object.freeze([
    pack(/ui|ux|frontend|visual|design-system|component|accessib|browser|form/,
      'semantic-html|focus-recovery|responsive-breakpoints|browser-state-matrix|visual-diff-evidence|screenshot-provenance|design-token-consistency|loading-error-empty-states|keyboard-interactions|cross-browser-regressions|reduced-motion|image-asset-fidelity'),
    pack(/backend|api|protocol|service|distributed|integration|real-time|websocket/,
      'request-response-invariants|schema-compatibility|authorization-boundary-tests|idempotency-contract|timeout-and-retry|rate-limit-and-backpressure|queue-failure-paths|service-telemetry|api-version-safety|partial-failure-recovery'),
    pack(/database|data|pipeline|migration|storage|cache|search-index/,
      'transaction-integrity|migration-rollback|row-level-access|data-provenance|schema-drift|concurrent-write-conflicts|data-retention|large-dataset-constraints|index-regression|backup-recovery-evidence'),
    pack(/security|identity|cryptograph|privacy|multi-tenant|payment|billing/,
      'threat-boundary-mapping|deny-by-default-authorization|cross-tenant-negative-tests|credential-lifecycle|secrets-redaction|injection-resistance|audit-evidence|abuse-case-review|supply-chain-provenance|sensitive-data-flow'),
    pack(/testing|quality|debug|observabil|reliab|incident|profiling|performance|cost/,
      'failure-reproduction|assertion-quality|regression-matrix|mutation-checks|flaky-test-triage|performance-baselines|heap-and-resource-measurement|causal-debug-hypotheses|load-test-evidence|degraded-mode-tests'),
    pack(/ai-|agent|llm|rag|model|evaluation|prompt|retrieval|inference/,
      'prompt-injection-defense|tool-result-isolation|agent-admission-policy|adaptive-agent-retirement|provider-rate-limit-recovery|model-usage-accounting|context-compression|retrieval-quality-evals|hallucination-detection|execution-receipt-integrity|agent-handoff-provenance|cost-quality-frontier'),
    pack(/cloud|devops|deploy|release|container|infrastructure|automation|desktop|mobile/,
      'least-privilege-runtime|pinned-dependencies|artifact-signature-check|sandbox-isolation|deployment-smoke|rollback-drill|offline-recovery|environment-compatibility|configuration-validation|observability-rollout'),
    pack(/file|render|media|document|simulation|interoperab/,
      'format-sniffing|malformed-input-safety|render-preview-fidelity|isolated-conversion|file-upload-validation|roundtrip-content-check|document-accessibility|unsafe-active-content-review'),
    pack(/architect|maintenance|repository|refactor|tooling|code-review/,
      'module-ownership|interface-coupling|minimal-diff-review|deprecation-plan|migration-impact|dead-code-detection|cross-package-compatibility|code-organization|build-reproducibility')
  ]),
  research:Object.freeze([
    pack(/source|academic|literature|bibliograph|evidence|systematic|review|meta-analysis/,
      'source-discovery-coverage|citation-chain-audit|primary-source-verification|duplicate-study-detection|publication-bias|inclusion-exclusion-reasons|quality-appraisal|claim-source-mapping|contradiction-table|freshness-validation|bibliography-integrity'),
    pack(/quant|statistic|econometric|causal|experiment|methods|protocol|reproducib|data|survey/,
      'measurement-validity|missing-data-sensitivity|effect-size-uncertainty|distribution-assumptions|robustness-analysis|power-and-sample-check|confounding-audit|replication-package|descriptive-figure-validation|units-and-normalization|statistical-code-review'),
    pack(/qualitat|mixed-method|ethnograph|interview|humanit|archiv|textual/,
      'sampling-reflexivity|coding-reliability|negative-case-analysis|interview-ethics|context-interpretation|theme-evidence-mapping|participant-privacy|triangulation-matrix|interpretive-alternatives'),
    pack(/thesis|dissertation|manuscript|journal|peer-review|conference|paper|publishing|writing|citation|reporting/,
      'claim-to-citation-map|methods-reporting-checklist|figure-caption-accuracy|argument-coherence|study-limitations|reviewer-objection-matrix|reference-metadata-check|authorship-integrity|submission-compliance|academic-accessibility'),
    pack(/research-gap|novelty|framing|hypothesis|proposal|grant|defense/,
      'question-scope-control|originality-boundary|falsifiable-hypotheses|contribution-evidence|feasibility-assessment|decision-relevant-unknowns|alternative-explanations|method-selection-tradeoffs|defense-question-preparation'),
    pack(/market|industry|technology|policy|social|economics|comparative|finance/,
      'base-rate-check|comparable-populations|data-period-freshness|scenario-sensitivity|primary-statistics-check|jurisdiction-context|sampling-bias|stakeholder-effects|cost-assumption-audit|source-independence'),
    pack(/research-ethics|integrity|governance|participant|human-subject|data-steward/,
      'consent-eligibility|privacy-risk-assessment|data-minimization|conflict-disclosure|fabrication-risk-audit|registered-protocol-consistency|retention-and-access|ethics-review-status|retraction-corrections'),
    pack(/figures|visual|tables|quant|data|meta|reproducib/,
      'plot-axis-integrity|uncertainty-interval-display|image-provenance|table-number-crosscheck|accessible-figure-labels|chart-caption-source-links|scale-distortion-detection')
  ])
});
export function capabilitySkillsForFamily(surface,family){
  const groups=packs[surface]??[];
  const skills=[...(foundation[surface]??[])];
  for(const group of groups)if(group.match.test(family))skills.push(...group.skills);
  return Object.freeze([...new Set(skills)]);
}
