/** 
 * Declarative extension to the same task-scoped main/subagent catalog.
 * Families start with focused seed skills and expand through contextual capability packs.
 * These are available vocabularies, not fixed team sizes or active agents.
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
      "data-management-engineering",
      "data management|data governance|data lifecycle|data stewardship|data catalog|data retention|data access policy",
      "data-contracts,data-validation,data-quality,data-lineage,retention-policy,access-controls,import-export,recovery-checks"
    ],
    [
      "identity-access-engineering",
      "identity management|identity provider|authentication flow|single sign-on|sso|multi-tenant access|rbac|oauth|session management",
      "authentication-flows,authorization-model,session-lifecycle,tenant-isolation,credential-handling,identity-federation,negative-tests,audit-events"
    ],
    [
      "file-rendering-engineering",
      "file preview|document rendering|pdf rendering|office conversion|thumbnail generation|media processing|file upload|document viewer",
      "file-type-detection,safe-extraction,render-isolation,office-fidelity,preview-fallbacks,upload-validation,accessibility-review,format-regression-tests"
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
    ,
    [
      "design-system-components",
      "design tokens|component library|storybook|component documentation",
      "component-apis,design-tokens,theme-architecture,variant-modeling,storybook-examples,responsive-behavior,accessibility-tests,visual-regression"
    ],
    [
      "frontend-state-engineering",
      "react state|redux|zustand|state management|client state|frontend state",
      "state-model,derived-state,cache-synchronization,async-updates,persistence,render-profiling,state-tests,regression-review"
    ],
    [
      "forms-validation-engineering",
      "form validation|complex form|form builder|form schema|wizard form",
      "field-models,validation-schema,accessible-errors,server-validation,dynamic-fields,form-security,submission-retries,form-tests"
    ],
    [
      "real-time-web-engineering",
      "real time app|real-time app|websocket|server sent events|realtime synchronization",
      "event-contracts,connection-lifecycle,reconnection,presence,ordering,backpressure,synchronization-tests,observability"
    ],
    [
      "cache-engineering",
      "redis cache|distributed cache|cache invalidation|caching strategy|cdn caching",
      "cache-keys,consistency,invalidation,ttl-design,cache-stampede,privacy-segmentation,benchmarks,failover"
    ],
    [
      "background-job-engineering",
      "background jobs|task queue|bullmq|celery|message queue|job scheduler",
      "queue-design,retry-policy,idempotency,poison-messages,job-tracing,concurrency,transactional-outbox,recovery-tests"
    ],
    [
      "search-index-engineering",
      "search indexing|full text search|elasticsearch|opensearch|meilisearch|search relevance",
      "query-analysis,index-schema,ranking,filters,incremental-indexing,privacy-filters,search-benchmarks,relevance-evals"
    ],
    [
      "billing-payments-engineering",
      "payment integration|stripe billing|subscription billing|invoice system|checkout payment",
      "payment-contracts,pricing-entitlements,webhook-verification,idempotency,reconciliation,refund-flow,abuse-controls,payment-tests"
    ],
    [
      "privacy-consent-engineering",
      "consent management|data subject request|data deletion workflow|privacy engineering|gdpr implementation",
      "data-inventory,consent-flow,minimization,retention,deletion-propagation,audit-log,regional-rules,privacy-tests"
    ],
    [
      "multi-tenant-isolation-engineering",
      "tenant isolation|multi tenant database|row level security|per-tenant encryption|tenant scoped access",
      "tenant-identity,rls-policy,credential-isolation,cross-tenant-tests,storage-scope,backup-boundary,auditability,privilege-review"
    ],
    [
      "database-migrations-engineering",
      "database migration plan|zero downtime migration|schema evolution|expand contract migration|database rollback",
      "schema-diff,expand-contract,data-backfill,transaction-safety,locking-impacts,rollback,rehearsal,integrity-verification"
    ],
    [
      "orm-persistence-engineering",
      "orm layer|prisma|drizzle orm|typeorm|sequelize models|object relational mapping",
      "model-constraints,query-shapes,transaction-boundaries,n-plus-one-detection,migration-contracts,type-safety,performance-tests,persistence-tests"
    ],
    [
      "application-security-testing",
      "security test|penetration test|sast|dast|authorization regression|owasp top ten",
      "threat-scenarios,abuse-cases,authz-negative-tests,input-validation,secure-headers,dependency-scans,logging-hygiene,remediation-checks"
    ],
    [
      "api-sdk-client-engineering",
      "client sdk|api client|typed client|generated sdk|openapi generator",
      "contract-schemas,typed-bindings,retries,version-compatibility,error-types,pagination,auth-handling,integration-tests"
    ],
    [
      "package-build-engineering",
      "build tooling|monorepo build|pnpm workspace|turborepo|vite config|bundler",
      "dependency-graph,build-cache,toolchain-versions,artifact-layout,workspace-boundaries,deterministic-builds,lint-typecheck,release-tests"
    ],
    [
      "browser-extension-engineering",
      "browser extension|chrome extension|firefox add-on|manifest v3",
      "manifest-privileges,content-scripts,background-service-worker,storage-limits,csp-review,ui-panel,extension-tests,store-packaging"
    ],
    [
      "native-mobile-platforms",
      "swiftui|jetpack compose|native ios|native android|kotlin multiplatform",
      "platform-navigation,platform-storage,lifecycle,push-notifications,accessibility,offline-sync,platform-tests,store-compliance"
    ],
    [
      "offline-first-app-engineering",
      "offline first|offline-first|local-first|sync conflict|offline data sync",
      "local-data-model,change-tracking,conflict-resolution,sync-protocol,offline-auth,queue-replay,recovery-evals,device-tests"
    ],
    [
      "graphics-visualization-engineering",
      "three.js|webgl|webgpu|canvas graphics|3d rendering|d3 visualization",
      "scene-data,rendering-pipeline,interaction,performance,browser-compatibility,visual-accuracy,accessibility-fallbacks,render-tests"
    ],
    [
      "media-streaming-engineering",
      "video streaming|audio streaming|media transcoding|webrtc|hls streaming",
      "media-ingestion,codec-compatibility,stream-control,buffering,latency,privacy,adaptive-bitrate,playback-tests"
    ],
    [
      "document-generation-engineering",
      "pdf generation|docx generation|pptx generation|report generator|document export",
      "template-model,format-fidelity,fonts-and-layout,tables-and-charts,export-accessibility,rendered-preview,safe-conversion,regression-snapshots"
    ],
    [
      "rag-knowledge-systems",
      "retrieval augmented generation|vector retrieval|semantic search pipeline|rag pipeline|embedding store",
      "document-ingestion,chunking,strategy,embedding-index,access-filters,retrieval-evaluation,citation-grounding,refresh-policy"
    ],
    [
      "agent-runtime-engineering",
      "agent runtime|multi agent orchestration|agentic workflow|agent harness|tool calling agent",
      "agent-boundaries,task-graph,a2a-handoff,tool-approval,loop-control,resource-budget,evidence-gates,failure-recovery"
    ],
    [
      "inference-model-serving",
      "model serving|inference server|vertex ai endpoint|batch inference|model gateway",
      "routing,request-limits,streaming,token-budget,provider-retries,observability,security-scope,latency-evals"
    ],
    [
      "plugin-connector-engineering",
      "plugin integration|connector framework|mcp server|tool registry|third party connector",
      "capability-discovery,tool-schema,auth-scopes,tenant-binding,input-validation,versioning,rate-limits,connector-tests"
    ],
    [
      "file-storage-lifecycle",
      "object storage|s3 upload|gcs storage|upload pipeline|file retention|signed url",
      "upload-validation,object-lifecycle,access-control,content-scanning,versioning,retention,restore-path,download-audits"
    ],
    [
      "internationalization-engineering",
      "i18n|l10n|rtl layout|locale formatting|internationalization|localization engineering",
      "message-catalog,pluralization,rtl-design,date-numbers,translation-loading,locale-routing,accessibility,locale-tests"
    ],
    [
      "testing-fuzz-contract-engineering",
      "fuzz testing|property based test|contract testing|mutation testing|consumer driven contract",
      "invariants,generators,contract-compatibility,test-isolation,coverage-gaps,reproducible-seeds,failure-triage,regression-cases"
    ],
    [
      "repository-change-management",
      "git merge conflict|codebase migration|mass refactor|repository restructuring|git worktree",
      "change-impact,ownership,migration-plan,branch-compatibility,conflict-resolution,patch-review,test-selection,rollback"
    ],
    [
      "backup-disaster-recovery-engineering",
      "disaster recovery|backup restore|point in time recovery|failover test|rpo rto",
      "backup-policy,key-separation,restore-validation,recovery-objectives,failover,incident-drills,data-integrity,retention-audit"
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
    ,
    [
      "thesis-proposal-design",
      "thesis proposal|dissertation proposal|research proposal chapter|doctoral proposal",
      "problem-statement,aims-objectives,research-questions,feasibility,method-plan,scope,risk-ethics,proposal-review"
    ],
    [
      "dissertation-architecture",
      "dissertation structure|thesis outline|thesis structure|dissertation chapters|thesis chapter plan",
      "chapter-contracts,argument-flow,scope-coverage,method-alignment,evidence-links,signposting,section-boundaries,coherence-review"
    ],
    [
      "research-gap-novelty",
      "research gap|literature gap|novel contribution|original contribution to knowledge",
      "prior-art-map,gap-classification,novelty-threshold,significance,competing-work,claim-bounds,feasibility,contribution-review"
    ],
    [
      "theoretical-frameworks",
      "theoretical framework|theoretical lens|theory development|theory chapter",
      "theory-selection,definitions,assumptions,construct-relations,predictions,competing-theories,fit-to-method,limitations"
    ],
    [
      "conceptual-modeling",
      "conceptual framework|conceptual model|construct operationalization|research variables framework",
      "concept-definition,causal-assumptions,variable-mapping,measurement-model,diagram-logic,alternatives,testability,framework-review"
    ],
    [
      "academic-manuscript-planning",
      "research paper outline|journal article outline|scientific manuscript structure|imrad",
      "audience-journal,contribution,section-structure,methods-results-fit,claims-ledger,figure-plan,citation-plan,completeness"
    ],
    [
      "scientific-abstract-writing",
      "structured abstract|conference abstract|research abstract|journal abstract",
      "study-purpose,methods-summary,actual-results,uncertainty,word-limit,key-terms,claims-consistency,format-check"
    ],
    [
      "research-introduction-writing",
      "research introduction|paper introduction|thesis introduction|background and rationale",
      "context,evidence-gap,motivation,objective-alignment,contribution,scope,source-check,argument-flow"
    ],
    [
      "research-methodology-writing",
      "methodology chapter|methods section|method justification|research methods chapter",
      "design-rationale,sampling,materials,procedures,measurement,ethics,reproducibility,limitations"
    ],
    [
      "research-results-reporting",
      "results chapter|results section|findings chapter|quantitative results writeup",
      "evidence-order,descriptive-statistics,figures-tables,effect-sizes,uncertainty,no-interpretive-overreach,raw-data-link,report-check"
    ],
    [
      "research-discussion-synthesis",
      "discussion chapter|paper discussion|interpretation of findings|thesis discussion",
      "finding-interpretation,prior-study-comparison,alternative-explanations,limitations,implications,contribution-bounds,future-work,coherence"
    ],
    [
      "research-conclusion-writing",
      "conclusion chapter|thesis conclusion|paper conclusion|recommendations chapter",
      "objectives-revisit,evidence-limits,contributions,practical-implications,limitations,next-questions,scope-fidelity,final-check"
    ],
    [
      "scholarly-argumentation",
      "academic argument|argumentative synthesis|critical academic writing|claim evidence reasoning",
      "claims,reasoning-warrants,counterarguments,evidence-weight,logical-coherence,hedging,scope,review"
    ],
    [
      "academic-language-editing",
      "academic proofreading|academic editing|scholarly tone|thesis language editing",
      "clarity,terminology,flow,discipline-style,conciseness,grammar,citation-preservation,meaning-check"
    ],
    [
      "research-integrity-auditing",
      "research integrity|plagiarism check|fabricated citations|data fabrication|academic misconduct",
      "source-verification,authorship,quotation-fidelity,data-provenance,similarity-review,conflict-disclosure,corrections,integrity-report"
    ],
    [
      "bibliographic-reference-management",
      "reference manager|zotero library|mendeley references|bibtex|bibliography cleanup",
      "doi-validation,metadata,duplicate-removal,citation-links,reference-style,missing-sources,reference-export,bibliography-audit"
    ],
    [
      "citation-style-compliance",
      "apa 7|ieee citation|chicago citations|harvard referencing|vancouver style",
      "in-text-citations,reference-entries,author-date,footnotes,format-consistency,missing-links,style-guide,citation-audit"
    ],
    [
      "academic-peer-review-response",
      "reviewer response|response to reviewers|respond to reviewers|point by point response|peer review comments|revise and resubmit",
      "reviewer-matrix,point-by-point-response,evidence-plan,manuscript-changes,disagreement-handling,professional-tone,tracked-revision,verification"
    ],
    [
      "journal-submission-preparation",
      "journal submission|journal guidelines|cover letter to editor|publication checklist",
      "journal-fit,author-guidelines,reporting-checklist,cover-letter,submission-files,ethics-disclosure,figures-tables,final-audit"
    ],
    [
      "conference-paper-presentation",
      "conference paper|research poster|academic presentation|scientific talk",
      "research-story,slide-structure,figure-selection,timing,audience,methods-summary,uncertainty,question-prep"
    ],
    [
      "dissertation-defense-preparation",
      "thesis defense|viva voce|viva examination|dissertation defense",
      "contribution-summary,method-defense,evidence-crosscheck,challenging-questions,limitations,slides,practice,committee-followups"
    ],
    [
      "research-ethics-governance",
      "ethics approval|institutional review board|irb protocol|human subjects research|informed consent research",
      "risk-benefit,participant-consent,recruitment,privacy,review-requirements,sensitive-data,withdrawal,ethics-record"
    ],
    [
      "research-data-stewardship",
      "research data management|data management plan|research dataset metadata|data availability statement",
      "data-inventory,collection-provenance,identifiers,documentation,privacy-access,sharing-plan,retention,reproducible-export"
    ],
    [
      "scholarly-figures-and-tables",
      "scientific figures|research tables|publication quality figures|figure caption",
      "figure-design,data-fidelity,uncertainty-bars,table-structure,labels-accessibility,source-footnotes,captions,figure-audit"
    ],
    [
      "mixed-methods-integration",
      "mixed methods research|triangulation design|explanatory sequential design|convergent mixed methods",
      "integration-rationale,qual-quant-link,sampling,sequence,triangulation,discordant-results,joint-display,limits"
    ],
    [
      "research-meta-analysis-statistics",
      "random effects meta-analysis|fixed effect meta-analysis|meta analytic effect size|heterogeneity i2",
      "effect-extraction,study-dependence,weighting,heterogeneity,subgroups,publication-bias,sensitivity,pooled-uncertainty"
    ],
    [
      "archival-primary-source-research",
      "primary historical sources|archive research|manuscript analysis|historical archives",
      "source-provenance,dating,authenticity,context,translation-bias,cross-archive-check,uncertainty,archival-citation"
    ],
    [
      "qualitative-coding-validation",
      "qualitative coding framework|intercoder reliability|thematic coding|grounded theory analysis",
      "codebook,coder-calibration,reflexivity,disagreement,reliability,theme-evidence,negative-cases,audit-trail"
    ],
    [
      "research-protocol-registration",
      "preregistration|registered report|osf registration|clinical trial protocol",
      "hypotheses,outcomes,analysis-plan,exclusions,registration-date,deviations,reporting,protocol-audit"
    ],
    [
      "research-funding-grant-writing",
      "research grant|funding proposal|grant application|research funding",
      "significance,objectives,work-packages,milestones,budget,impact,ethics,grant-compliance"
    ],
    [
      "research-reproducible-computation",
      "reproducible notebook|research code reproducibility|computational appendix|reproducible research workflow",
      "environment-capture,input-data,notebook-steps,random-seeds,results-check,dependency-lock,artifact-provenance,reproduction-guide"
    ],
    [
      "humanities-scholarly-interpretation",
      "textual criticism|close reading analysis|hermeneutic research|humanities thesis",
      "primary-text-context,interpretive-method,alternative-readings,historical-positioning,translation-choices,source-fidelity,argument-structure,limitations"
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
