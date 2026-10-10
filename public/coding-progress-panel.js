/**
 * Project coding progress panel: pure server evidence rendered with existing
 * DOM primitives. It neither starts agents nor grants tool permissions.
 */
import { element, button } from './ui-core.js';
import { codingProgressSnapshot } from './coding-progress-model.js';
import { agentActivitySnapshot } from './agent-activity.js';

const get = id => document.getElementById(id);
const statusDot = tone => element('span',{class:'code-progress-dot '+tone,'aria-hidden':'true'});
let lastSignature = '';
let lastHost = null;

export function renderCodingProgress(host, run, { surface = 'normal-chat', pending = false } = {}) {
  if (!host) return;
  const coding = run?.surface === 'code' || (!run && surface === 'code');
  const snapshot = coding ? codingProgressSnapshot(run) : null;
  const agentState = coding && run ? agentActivitySnapshot(run) : null;
  const specialists = Array.isArray(agentState?.roles) ? agentState.roles.slice(-5) : [];
  const activeSpecialists = Array.isArray(agentState?.active) ? agentState.active.length : 0;
  // The run's evidence can include large tool output and file contents.
  // Serialize only the small visible projection, not the full run/task graph
  // on every streaming UI update.
  const signature = JSON.stringify({coding,snapshot,pending,surface,
    specialists,activeSpecialists});
  if (host === lastHost && signature === lastSignature) return;
  lastHost = host;
  lastSignature = signature;
  host.hidden = !coding;
  if (!coding) { host.replaceChildren(); return; }

  const intro = element('div',{class:'code-progress-top'},[
    element('div',{class:'code-progress-intro'},[
      element('span',{class:'code-progress-eyebrow',text:'KG CODE  /  EXECUTION STATUS'}),
      element('h2',{class:'code-progress-title',text:snapshot?.headline ||
        (pending ? 'Preparing your coding request' : 'Start a coding task')}),
      element('p',{class:'code-progress-subtitle',text:snapshot
        ? 'Live status from saved run steps. No estimated completion or fabricated test passes.'
        : 'Choose a repository or attach source files, then describe the change you want.'})
    ]),
    element('span',{class:'code-progress-status '+(snapshot?.tone || 'neutral')},[
      statusDot(snapshot?.tone || 'neutral'),
      element('span',{text:snapshot?.status || (pending ? 'Preparing' : 'Ready')})
    ])
  ]);
  const quickActions = element('div',{class:'code-progress-actions',role:'group',
    'aria-label':'Open related coding tools'},[
    button('Chat files',()=>get('chatViewFiles')?.click(),'code-progress-action'),
    button('Terminal',()=>get('openTerminal')?.click(),'code-progress-action')
  ]);
  if (!snapshot || !snapshot.recorded) {
    host.replaceChildren(element('div',{class:'code-progress-card'},[
      intro,element('div',{class:'code-progress-empty'},[
        element('span',{class:'code-progress-step-number',text:'01'}),
        element('p',{text:'Inspect context → implement focused changes → run real checks → review the diff.'})
      ]),quickActions
    ]));
    return;
  }
  const meter = element('progress',{
    class:'code-progress-meter',value:snapshot.completed,max:snapshot.recorded,
    'aria-label':'Recorded workflow steps completed'
  });
  const facts = element('div',{class:'code-progress-facts'},[
    element('span',{text:snapshot.progressLabel}),
    element('span',{text:snapshot.failures ? `${snapshot.failures} blocked or failed` : snapshot.testState}),
    element('span',{class:snapshot.verified?'code-progress-evidence good':'code-progress-evidence',
      text:snapshot.verified ? 'Verification recorded' : 'Not verified'})
  ]);
  const steps = element('ol',{class:'code-progress-checkpoints',
    'aria-label':'Latest recorded workflow steps'},snapshot.checkpoints.map((step,index)=>
    element('li',{class:'code-progress-step '+step.status+(step.current?' current':'')},[
      element('span',{class:'code-progress-step-number',
        text:String(snapshot.hiddenCount+index+1).padStart(2,'0')}),
      element('span',{class:'code-progress-step-copy'},[
        element('span',{class:'code-progress-step-label',text:step.label}),
        element('span',{class:'code-progress-step-state',text:step.statusLabel})
      ])
    ])
  ));
  const wasOpen = host.querySelector('.code-progress-detail')?.open === true;
  const detail = element('details',{class:'code-progress-detail'},[
      element('summary',{text:`Recorded activity · latest ${snapshot.checkpoints.length} steps`}),
      steps,
      snapshot.hiddenCount ? element('p',{class:'code-progress-subtitle',
        text:`${snapshot.hiddenCount} earlier recorded steps are shown in the conversation history.`}) : null,
      element('p',{class:'code-progress-evidence-text',text:snapshot.evidence}),
      specialists.length ? element('section',{class:'code-progress-specialists',
        'aria-label':'Recorded specialist activity'},[
        element('div',{class:'code-progress-specialist-head'},[
          element('strong',{text:`Specialist activity · ${specialists.length} recorded`}),
          element('span',{text:activeSpecialists
            ? `${activeSpecialists} active in the current task`
            : 'No active specialists confirmed'})
        ]),
        element('ul',{class:'code-progress-agent-list'}, specialists.map(item =>
          element('li',{},[
            element('span',{text:item.displayRole || item.role || 'Specialist'}),
            element('span',{text:item.status || 'Recorded'})
          ]))),
        element('p',{class:'code-progress-evidence-text',
          text:'These are recorded agent states; selection is not proof of execution.'})
      ]) : null
    ].filter(Boolean));
  detail.open = wasOpen;
  host.replaceChildren(element('div',{class:'code-progress-card'},[
    intro,element('div',{class:'code-progress-meter-wrap'},[meter,facts]),
    detail,quickActions
  ]));
}
