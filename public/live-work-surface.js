/** Render saved work output in the chat and dedicated project views. */
import { element, downloadUrl } from './ui-core.js';
import { renderMarkdown } from './markdown.js';
import { artifactChip } from './artifact-preview.js';
import { liveWorkSnapshot } from './live-work-model.js';

function tableView(item) {
  const t=item.table;
  const head=t.header.length?element('thead',{},element('tr',{},t.header.map(cell=>element('th',{scope:'col',text:cell})))):null;
  const body=element('tbody',{},t.rows.map(row=>element('tr',{},row.map(cell=>element('td',{text:cell})))));
  return element('div',{class:'work-output-table md-table',role:'region',tabindex:'0',
    'aria-label':'Recorded table: '+t.name},[
    element('table',{},[
      element('caption',{class:'sr-only',text:t.name}),head,body
    ].filter(Boolean)),
    t.truncatedRows||t.truncatedColumns
      ?element('p',{class:'small muted',text:'Showing a bounded read-only sample. Open the original artifact for complete data.'}):null
  ].filter(Boolean));
}

function entryView(item){
  const title=element('div',{class:'work-output-item-head'},[
    element('strong',{text:item.type==='execution'?'Recorded runner output':item.title}),
    item.type==='execution'?element('span',{class:'small muted',text:item.label}):null
  ].filter(Boolean));
  let body=[];
  if(item.type==='execution'){
    if(item.tests){
      const t=item.tests;
      body.push(element('div',{class:'work-output-tests','aria-label':'Recorded test result counts'},[
        element('strong',{text:t.passed+' passed'}),
        element('span',{class:'muted small',text:t.failed+' failed · '+t.total+' total'}),
        element('div',{class:'work-output-test-track','aria-hidden':'true'},[
          element('i',{style:{width:(t.total?Math.min(100,Math.max(0,100*t.passed/t.total)):0)+'%'}})
        ])
      ]));
    }
    if(item.stdout)body.push(element('div',{class:'work-output-console'},[
      element('span',{class:'work-output-stream-label',text:'stdout'}),
      element('pre',{tabindex:'0',text:item.stdout})
    ]));
    if(item.stderr)body.push(element('div',{class:'work-output-console is-error'},[
      element('span',{class:'work-output-stream-label',text:'stderr'}),
      element('pre',{tabindex:'0',text:item.stderr})
    ]));
    if(item.status==='failed')body.push(element('span',{class:'small tone-warn',text:'Execution reported failure.'}));
  } else if(item.type==='table')body=[tableView(item)];
  else if(item.type==='text')body=[renderMarkdown(item.text)];
  else if(item.type==='artifact') {
    const image=/^image\/(?:png|jpeg|webp|gif)$/i.test(item.artifact.contentType);
    body=[
      image?element('img',{
        class:'work-output-image',
        src:downloadUrl('/api/objects/'+encodeURIComponent(item.artifact.id)+'/content?preview=1'),
        alt:'Saved image: '+item.artifact.name,
        loading:'lazy',decoding:'async'
      }):null,
      artifactChip(item.artifact)
    ].filter(Boolean);
    if(image)body[0].addEventListener('error',()=>{body[0].hidden=true;});
  }
  else if(item.type==='sources')body=[element('ul',{class:'work-output-source-list'},item.sources.map(s=>
    element('li',{},[
      s.url?element('a',{href:s.url,target:'_blank',rel:'noopener noreferrer',text:s.title})
        :element('span',{text:s.title}),
      s.detail?element('span',{class:'small muted',text:' · '+s.detail}):null
    ].filter(Boolean))))];
  else if(item.type==='gaps')body=[element('ul',{},item.values.map(value=>element('li',{text:value})))];
  return element('article',{class:'work-output-item','data-output-kind':item.type},[title,...body]);
}

export function renderLiveWorkSurface(run,options={}){
  const snapshot=liveWorkSnapshot(run,options);
  if(!snapshot)return null;
  const node=element('section',{class:'work-live-surface','aria-label':'Recorded work output',
    'data-work-domain':snapshot.domain},[
    element('header',{class:'work-output-head'},[
      element('div',{},[
        element('span',{class:'work-output-eyebrow',text:'WORK OUTPUT'}),
        element('strong',{text:snapshot.title})
      ]),
      element('span',{class:'small muted',text:snapshot.completedSteps+
        ' saved steps done · '+snapshot.recordedSteps+' recorded'})
    ]),
    element('ol',{class:'work-output-timeline','aria-label':'Recorded workflow step progress'},
      snapshot.steps.map((step,index)=>element('li',{
        class:'work-output-timeline-step',
        'data-step-status':step.status,'data-step-current':String(step.current)
      },[
        element('span',{class:'work-output-step-mark','aria-hidden':'true',
          text:step.status==='complete'?'✓':step.status==='failed'?'!':String(index+1)}),
        element('span',{text:step.title})
      ]))),
    snapshot.currentStep?element('p',{class:'work-output-current',role:'status'},[
      element('span',{class:'work-output-status-dot','aria-hidden':'true'}),
      element('span',{text:'Current step · '+snapshot.currentStep})
    ]):null,
    snapshot.entries.length
      ?element('div',{class:'work-output-items'},snapshot.entries.map(entryView))
      :element('p',{class:'muted small work-output-empty',text:snapshot.emptyMessage}),
    element('p',{class:'work-output-provenance small muted',text:snapshot.provenance})
  ].filter(Boolean));
  return node;
}
