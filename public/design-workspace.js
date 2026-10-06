import { $, api, state } from './ui-core.js';
const DEFAULT={version:1,canvas:{width:1600,height:900,background:'#fff'},guides:{grid:8,snap:true,showGrid:true},selected:null,previewing:false,objects:[]};
let S=structuredClone(DEFAULT),runId=null,timer=null,undo=[],redo=[],drag=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy=()=>structuredClone(S), selected=()=>S.objects.find(o=>o.id===S.selected);
const status=s=>{const n=$('designSaveStatus');if(n)n.textContent=s;};
function save(){clearTimeout(timer);if(!runId)return;timer=setTimeout(async()=>{try{await api('PUT','/api/runs/'+runId+'/design-state',{state:S});status('Saved')}catch(e){status(e.message||'Save failed')}},300);status('Saving…')}
function edit(fn){undo.push(copy());redo=[];fn();render();save()}
function add(kind){edit(()=>{const id=kind+'-'+crypto.randomUUID().slice(0,8),o={id,kind,x:80,y:80,width:kind==='text'?420:320,height:kind==='text'?80:220,z:S.objects.length+1,rotation:0,opacity:1,visible:true,locked:false,fill:kind==='shape'?'#e5e7eb':'#111111'};if(kind==='text')o.text='Double-click to edit';S.objects.push(o);S.selected=id})}
function remove(){if(selected())edit(()=>{S.objects=S.objects.filter(o=>o.id!==S.selected);S.selected=S.objects.at(-1)?.id||null})}
function objectSvg(o){if(!o.visible)return '';const t='translate('+o.x+' '+o.y+') rotate('+(o.rotation||0)+' '+o.width/2+' '+o.height/2+')',c=o.id===S.selected?' selected':'';if(o.kind==='text')return '<g transform="'+t+'" data-o="'+esc(o.id)+'" class="design-object'+c+'"><rect class="object-hit" width="'+o.width+'" height="'+o.height+'"/><text x="0" y="'+Math.max(28,o.fontSize||48)+'" font-size="'+(o.fontSize||48)+'" font-family="Inter,system-ui,sans-serif" fill="'+esc(o.fill)+'">'+esc(o.text||'')+'</text></g>';return '<g transform="'+t+'" data-o="'+esc(o.id)+'" class="design-object'+c+'"><rect width="'+o.width+'" height="'+o.height+'" rx="'+(o.radius||12)+'" fill="'+esc(o.fill)+'"/><rect class="object-hit" width="'+o.width+'" height="'+o.height+'"/></g>'}
function properties(){const o=selected();if(!o)return '<p class="muted small">Select an object to edit its properties.</p>';let html='<div class="design-form">';for(const k of ['x','y','width','height','opacity'])html+='<label>'+k.toUpperCase()+'<input data-p="'+k+'" type="number" value="'+(o[k]??0)+'"></label>';html+='<label>Fill<input data-p="fill" type="color" value="'+(/^#[0-9a-f]{6}$/i.test(o.fill||'')?o.fill:'#111111')+'"></label>';if(o.kind==='text')html+='<label>Text<textarea data-p="text" rows="4">'+esc(o.text||'')+'</textarea></label><label>Font size<input data-p="fontSize" type="number" value="'+(o.fontSize||48)+'"></label>';return html+'<label><input data-p="locked" type="checkbox" '+(o.locked?'checked':'')+'> Locked</label></div>'}
function render(){
  const root = $('deepWorkspaceShell');
  if (!root) return;
  if (state.activeSurface !== 'design') {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  root.hidden = false;
  const layers = [...S.objects].sort((a, b) => b.z - a.z).map(o =>
    '<button class="design-layer ' + (o.id === S.selected ? 'active' : '') + '" data-s="' + o.id + '">' +
    (o.kind === 'text' ? 'T' : '□') + ' <span>' + esc(o.text || o.kind) + '</span></button>'
  ).join('');
  const objs = [...S.objects].sort((a, b) => a.z - b.z).map(objectSvg).join('');
  root.innerHTML = [
    '<section class="design-workspace">',
    '<header class="design-head"><div><span class="design-eyebrow">DESIGN WORKSPACE</span><h2>Visual editor</h2>',
    '<span class="muted small">Editable canvas · durable state · adaptive assistance</span></div>',
    '<div class="design-actions"><span id="designSaveStatus">Saved</span><button data-a="undo">Undo</button>',
    '<button data-a="redo">Redo</button><button data-a="preview">Preview</button><button data-a="export">Export</button></div></header>',
    '<div class="design-toolbar"><button data-a="text">Text</button><button data-a="shape">Shape</button>',
    '<button data-a="delete">Delete</button><label>Grid <input data-g="grid" type="number" min="2" max="128" value="' + S.guides.grid + '"></label>',
    '<label><input data-g="snap" type="checkbox" ' + (S.guides.snap ? 'checked' : '') + '> Snap</label>',
    '<label><input data-g="showGrid" type="checkbox" ' + (S.guides.showGrid ? 'checked' : '') + '> Grid</label></div>',
    '<div class="design-body"><aside class="design-panel layers-panel"><div class="design-panel-head"><b>Layers</b><span>' +
    S.objects.length + '</span></div>' + layers + '</aside>',
    '<main class="design-stage"><div class="design-canvas-wrap"><svg id="designCanvas" viewBox="0 0 ' +
    S.canvas.width + ' ' + S.canvas.height + '"><defs><pattern id="designGrid" width="' + S.guides.grid +
    '" height="' + S.guides.grid + '" patternUnits="userSpaceOnUse"><path d="M ' + S.guides.grid +
    ' 0 L 0 0 0 ' + S.guides.grid + '" fill="none" stroke="currentColor" opacity=".09"/></pattern></defs>',
    '<rect width="100%" height="100%" fill="' + esc(S.canvas.background) + '"/>',
    S.guides.showGrid ? '<rect width="100%" height="100%" fill="url(#designGrid)"/>' : '',
    objs,
    '</svg></div></main><aside class="design-panel properties-panel"><div class="design-panel-head"><b>Properties</b></div>',
    properties(), '</aside></div></section>'
  ].join('');
  bind();
}function bind(){const root=$('deepWorkspaceShell');root.querySelectorAll('[data-s]').forEach(n=>n.onclick=()=>{S.selected=n.dataset.s;render()});root.querySelectorAll('[data-a]').forEach(n=>n.onclick=()=>{const a=n.dataset.a;if(a==='text')add('text');else if(a==='shape')add('shape');else if(a==='delete')remove();else if(a==='undo'&&undo.length){redo.push(copy());S=undo.pop();render();save()}else if(a==='redo'&&redo.length){undo.push(copy());S=redo.pop();render();save()}else if(a==='preview'){S.previewing=!S.previewing;root.classList.toggle('design-preview',S.previewing)}else if(a==='export')exportSvg()});root.querySelectorAll('[data-g]').forEach(n=>n.onchange=()=>edit(()=>{S.guides={...S.guides,[n.dataset.g]:n.type==='checkbox'?n.checked:Math.max(2,Number(n.value)||8)}}));root.querySelectorAll('[data-p]').forEach(n=>n.onchange=()=>edit(()=>{const o=selected();if(!o)return;const k=n.dataset.p;o[k]=n.type==='checkbox'?n.checked:n.type==='number'?Number(n.value):n.value}));root.querySelectorAll('[data-o]').forEach(n=>n.addEventListener('pointerdown',e=>{const o=S.objects.find(x=>x.id===n.dataset.o);if(!o||o.locked)return;S.selected=n.dataset.o;drag={id:o.id,sx:e.clientX,sy:e.clientY,x:o.x,y:o.y,before:copy()};n.setPointerCapture?.(e.pointerId)}));root.querySelectorAll('[data-o]').forEach(n=>n.addEventListener('pointermove',e=>{if(!drag||drag.id!==n.dataset.o)return;const r=n.ownerSVGElement.getBoundingClientRect(),sx=S.canvas.width/r.width,sy=S.canvas.height/r.height;let x=drag.x+(e.clientX-drag.sx)*sx,y=drag.y+(e.clientY-drag.sy)*sy;if(S.guides.snap){const g=S.guides.grid;x=Math.round(x/g)*g;y=Math.round(y/g)*g}S.objects=S.objects.map(o=>o.id===drag.id?{...o,x,y}:o);render()}));root.querySelectorAll('[data-o]').forEach(n=>n.addEventListener('pointerup',()=>{if(drag){undo.push(drag.before);if(undo.length>40)undo.shift();drag=null;render();save()}}))}
function exportSvg(){const n=$('designCanvas');if(!n)return;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(n)],{type:'image/svg+xml'}));a.download='kindgleam-design.svg';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
export async function openDesignWorkspace(id){runId=id;state.activeSurface='design';try{const r=await api('GET','/api/runs/'+id+'/design-state');S={...structuredClone(DEFAULT),...(r.state||{})}}catch{S=structuredClone(DEFAULT)}render()}
document.addEventListener('kindgleam:select-surface',e=>{if(e.detail?.workspace==='design'&&state.run?.id)openDesignWorkspace(state.run.id)});
document.addEventListener('kindgleam:run-selected',e=>{if(state.activeSurface==='design'&&e.detail?.runId)openDesignWorkspace(e.detail.runId)});
