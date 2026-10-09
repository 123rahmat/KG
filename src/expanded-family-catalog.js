/** 
 * Declarative extension to the same task-scoped main/subagent catalog.
 * Each family has eight available skill lenses, selected only if needed.
 */
const DEFINITIONS = {
  "normal-chat": [
    [
      "meeting-operations",
      "meeting|agenda|minutes|workshop",
      "agenda-design,participant-coordination,facilitation,meeting-notes,decision-records,action-tracking,accessibility-check,follow-up"
    ],
    [
      "negotiation-work",
      "negotiate|negotiation|bargaining|counteroffer",
      "stakeholder-interests,alternatives,concessions,scenario-roleplay,boundary-setting,communication,agreement-review,follow-up"
    ],
    [
      "user-automation",
      "automate|reminder workflow|recurring workflow|scheduled task",
      "trigger-design,workflow-mapping,connector-readiness,permission-review,retry-handling,idempotency,scheduled-delivery,monitoring"
    ],
    [
      "team-collaboration",
      "team alignment|stakeholder meeting|team offsite|retrospective",
      "stakeholder-analysis,status-updates,dependency-mapping,decision-records,facilitation,conflict-resolution,action-planning,progress-review"
    ],
    [
      "household-planning",
      "chores|household|grocery list|home organization",
      "inventory,shared-calendar,shopping-list,task-sharing,time-planning,budget,backup-plan,coordination"
    ],
    [
      "presentation-production",
      "powerpoint|slide deck|presentation slides|pitch deck",
      "storyline,slide-outline,design-hierarchy,chart-selection,speaker-notes,audience-fit,accessibility-check,export-review"
    ],
    [
      "spreadsheet-modeling",
      "excel formulas|spreadsheet model|workbook model|google sheets",
      "workbook-structure,formula-design,data-validation,scenario-modeling,visualization,formatting,formula-audit,source-integrity"
    ],
    [
      "multilingual-localization",
      "localization|localize|translated website|multilingual content",
      "terminology,register,cultural-context,translation-consistency,formatting,locale-standards,accessibility,quality-review"
    ],
    [
      "customer-support-work",
      "customer support|helpdesk|service ticket|support case",
      "intent-triage,knowledge-base,response-tone,escalation,service-policy,problem-solving,resolution-check,follow-up"
    ],
    [
      "visual-communication",
      "infographic|visual story|social graphics|poster layout",
      "design-brief,composition,typography,information-hierarchy,asset-selection,brand-alignment,accessibility,visual-review"
    ]
  ],
  "code": [
    [
      "distributed-systems",
      "distributed systems|microservices|event sourcing|distributed transaction",
      "service-boundaries,consistency,messaging,ordering,retries,idempotency,backpressure,fault-tolerance"
    ],
    [
      "cloud-platforms",
      "cloud architecture|cloud infrastructure|vpc|gcp|aws|azure",
      "identity,networking,compute,storage,availability,disaster-recovery,cost-control,observability"
    ],
    [
      "observability-engineering",
      "observability|tracing|telemetry|structured logging",
      "metrics,structured-logs,distributed-traces,correlation-ids,alerting,dashboards,incident-diagnosis,retention"
    ],
    [
      "cryptography-protocols",
      "cryptography|cryptographic|key rotation|encryption protocol",
      "threat-model,key-lifecycle,protocol-review,secret-storage,rotation,interface-safety,negative-tests,security-audit"
    ],
    [
      "release-engineering",
      "release pipeline|canary release|deployment rollout|rollback plan",
      "versioning,ci-gates,artifact-provenance,release-notes,canary,rollback,recovery-smoke,post-release-check"
    ],
    [
      "ai-evaluation",
      "llm eval|agent evaluation|model benchmark|prompt evaluation",
      "eval-datasets,reference-answers,adversarial-cases,acceptance-criteria,latency,token-cost,regression-tests,calibration"
    ],
    [
      "browser-automation",
      "playwright|selenium|browser automation|visual regression",
      "selectors,fixtures,navigation,network-mocking,accessibility-tests,screenshots,flakiness,regression-suite"
    ],
    [
      "data-pipelines",
      "data pipeline|etl|elt|data warehouse",
      "ingestion,schema-evolution,data-quality,lineage,backfills,orchestration,privacy-boundary,cost-check"
    ],
    [
      "protocol-interoperability",
      "mcp protocol|a2a protocol|websocket protocol|protocol integration",
      "schema,handshake,authorization,message-routing,backpressure,compatibility,conformance,retry-strategy"
    ],
    [
      "performance-profiling",
      "cpu profiling|heap profile|memory profiling|performance benchmark",
      "baseline,flamegraph,allocation-analysis,query-profile,throughput,memory-growth,bottleneck-analysis,regression"
    ]
  ],
  "research": [
    [
      "causal-inference",
      "causal inference|causal effect|confounding|instrumental variable",
      "causal-dag,identification,assumptions,selection-bias,estimation,confounding-check,robustness,limitations"
    ],
    [
      "reproducibility-studies",
      "reproducibility|replication study|replicate findings|open science",
      "methods,provenance,environment,replication-plan,code-audit,sensitivity,limitations,reproducible-report"
    ],
    [
      "questionnaire-methods",
      "survey design|questionnaire design|interview protocol|survey instrument",
      "constructs,question-wording,pilot,sampling,bias,ethics,coding-plan,analysis-plan"
    ],
    [
      "systematic-review-methods",
      "systematic review protocol|systematic review|prisma|meta-analysis method|scoping review protocol",
      "protocol,inclusion-criteria,search-strategy,screening,risk-of-bias,evidence-tables,heterogeneity,reporting"
    ],
    [
      "econometric-analysis",
      "econometrics|panel regression|difference in differences|econometric model",
      "identification,model-specification,standard-errors,panel-data,forecasting,robustness,diagnostics,interpretation"
    ],
    [
      "standards-compliance-research",
      "iso standards|iec standards|technical standards|compliance standards",
      "official-sources,scope,version,requirements,interpretation,conformance,gaps,traceability"
    ],
    [
      "patent-landscape",
      "patent landscape|prior art|patent search|patentability research",
      "search-classes,claims,prior-art-families,dates,jurisdiction,citation-chains,novelty-limits,evidence-map"
    ],
    [
      "geospatial-research",
      "gis|spatial analysis|geospatial|remote sensing",
      "coordinate-systems,geocoding,spatial-joins,sampling,mapping,uncertainty,validation,interpretation"
    ],
    [
      "risk-impact-research",
      "risk assessment|impact assessment|safety study|risk matrix",
      "hazard-identification,exposure,probability,severity,uncertainty,mitigation,stakeholder-impacts,monitoring"
    ],
    [
      "statistical-auditing",
      "statistical audit|statistical significance|p value|confidence interval",
      "data-validation,assumptions,sampling,hypothesis-tests,effect-size,uncertainty,multiple-testing,reproducibility"
    ]
  ]
};
export const EXTRA_SPECIALIST_FAMILIES = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([workspace,entries]) => [workspace,Object.freeze(
    Object.fromEntries(entries.map(([family,_keywords,skills]) =>
      [family,Object.freeze(skills.split(','))]))
  )])
));
const escapeRegex = value => value.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&')
  .replace(/[\s-]+/g,'[\\s-]+');
export const EXTRA_SPECIALIST_KEYWORDS = Object.freeze(Object.fromEntries(
  Object.values(DEFINITIONS).flat().map(([family,keywords]) =>
    [family,new RegExp('\\b(?:'+keywords.split('|').map(escapeRegex).join('|')+')\\b','i')])
));
