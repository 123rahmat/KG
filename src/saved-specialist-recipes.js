/**
 * Durable, user/workspace-scoped reusable expertise hints.
 *
 * The only stored content is a normalized short ID and a generic label
 * compiled from an already-recorded capability candidate. No prompts, chat
 * transcripts, code, evidence bodies, credentials, source pages or tools.
 *
 * Two distinct VERIFIED runs promote an observed hint to reusable.
 * Neither status creates agents, authorizes tools or certifies a new result.
 */
const SURFACES = new Set(['normal-chat', 'code', 'research']);
const BLOCKED = /(?:password|passwd|secret|token|credential|private|api[-_]?key|email|phone|address|contact|session|account|auth[-_]?cookie|bearer|passport|credit[-_]?card|ssn)/i;
const COMMON = new Set(['new','unknown','unfamiliar','task','specialist','capability','dynamic','generic','create','user','the','and','for','with','from']);
const bounded = (v,n) => String(v ?? '').slice(0,n);
const workspace = run => SURFACES.has(run?.surface) ? run.surface
  : SURFACES.has(run?.adaptation?.primarySurface) ? run.adaptation.primarySurface : 'normal-chat';
const words = value => [...new Set(String(value ?? '').toLowerCase().split(/[^a-z0-9]+/)
  .filter(v => v.length >= 3 && v.length <= 25 && !COMMON.has(v)))];
const cap = (v,max=3)=>Math.max(0,Math.min(max,Number.isFinite(Number(v)) ? Math.floor(Number(v)) : max));

export function compileRecipeCandidates(run = {}) {
  const records = Array.isArray(run?.capabilities?.discovered) ? run.capabilities.discovered : [];
  const out=[],seen=new Set();
  for(const entry of records.slice(0,16)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    // Never use model-proposed instructions/status/tools/URLs in a saved recipe.
    const id = bounded(entry.id,81).toLowerCase();
    if(!/^[a-z][a-z0-9_-]{3,79}$/.test(id) || BLOCKED.test(id) || seen.has(id)) continue;
    const terms = words(id).slice(0,8);
    if (terms.length < 1) continue;
    seen.add(id);
    out.push(Object.freeze({
      id, surface:workspace(run),
      terms:Object.freeze(terms),
      description:'Specialized expertise: ' + terms.join(' ').slice(0,130),
      advisoryOnly:true
    }));
    if(out.length>=3)break;
  }
  return Object.freeze(out);
}

export function matchReusableSpecialists(records=[], {goal='',surface='normal-chat',limit=3}={}) {
  if(!SURFACES.has(surface)) return [];
  const wanted = new Set(words(goal).slice(0,75));
  if(!wanted.size)return [];
  return (Array.isArray(records)?records:[])
    .filter(item=>item?.surface===surface
      && ['observed','reusable'].includes(item?.status)
      && (!item?.expiresAt || Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt)>Date.now()))
    .map(item=>{
      const terms = Array.isArray(item.terms) ? item.terms.slice(0,8) : [];
      const overlap=terms.filter(t=>wanted.has(t)).length;
      return {item,overlap,score:overlap*5+(item.status==='reusable'?2:0)};
    })
    .filter(x=>x.overlap>0)
    .sort((a,b)=>b.score-a.score||a.item.id.localeCompare(b.item.id))
    .slice(0,cap(limit))
    .map(({item})=>Object.freeze({
      id:bounded(item.id,80),surface,
      description:bounded(item.description,160),
      status:item.status,verifiedExamples:cap(item.verifiedExamples,8),
      authority:'advisory-only',
      requiresFreshVerification:true,
      mayExecuteTools:false,
      maySpawnAgents:false
    }));
}

export class SavedSpecialistRecipeStore {
  constructor(pool){ this.pool=pool; }
  // The person's existing opt-in for cross-chat memory controls
  // this cross-chat reuse as well. False by default.
  async optedIn(scope){
    if(!scope?.workspaceId || !scope?.principalId)return false;
    const {rows}=await this.pool.query(
      "SELECT COALESCE(settings->>'crossChatMemory', 'false') = 'true' AS enabled FROM user_preferences WHERE principal_id = $1",
      [scope.principalId]
    );
    return rows[0]?.enabled === true;
  }
  async list(scope,{limit=30}={}){
    if(!scope?.workspaceId || !scope?.principalId || !(await this.optedIn(scope)))return [];
    const {rows}=await this.pool.query(
      `SELECT recipe_id AS id, surface, description, terms, status,
              cardinality(observed_run_ids) AS "verifiedExamples",
              expires_at AS "expiresAt", updated_at AS "updatedAt"
         FROM saved_specialist_recipes
        WHERE workspace_id=$1 AND principal_id=$2 AND status <> 'retired'
          AND expires_at > now()
        ORDER BY (status='reusable') DESC, updated_at DESC
        LIMIT $3`,[scope.workspaceId,scope.principalId,Math.max(1,cap(limit,50))]
    );
    return rows;
  }
  async suggest(scope,{goal='',surface='normal-chat',limit=3}={}){
    if(!goal || !SURFACES.has(surface))return [];
    const all=await this.list(scope,{limit:50});
    return matchReusableSpecialists(all,{goal,surface,limit});
  }
  async observeVerified(scope,run,{verified=false}={}){
    if(!verified || !run?.id || !scope?.workspaceId || !scope?.principalId
       || !(await this.optedIn(scope)))return [];
    const candidates=compileRecipeCandidates(run);
    const rows=[];
    for(const recipe of candidates){
      const {rows:result}=await this.pool.query(
        `INSERT INTO saved_specialist_recipes
          (workspace_id,principal_id,surface,recipe_id,description,terms,observed_run_ids)
          VALUES ($1,$2,$3,$4,$5,$6::text[],ARRAY[$7]::text[])
          ON CONFLICT (workspace_id,principal_id,surface,recipe_id) DO UPDATE
          SET observed_run_ids = CASE
                WHEN $7=ANY(saved_specialist_recipes.observed_run_ids)
                  THEN saved_specialist_recipes.observed_run_ids
                WHEN cardinality(saved_specialist_recipes.observed_run_ids)>=8
                  THEN saved_specialist_recipes.observed_run_ids[2:8] || ARRAY[$7]::text[]
                ELSE array_append(saved_specialist_recipes.observed_run_ids,$7)
              END,
              status = CASE
                WHEN saved_specialist_recipes.status='reusable'
                  OR ($7<>ALL(saved_specialist_recipes.observed_run_ids)
                      AND cardinality(saved_specialist_recipes.observed_run_ids)>=1)
                THEN 'reusable' ELSE 'observed' END,
              last_verified_at=now(),expires_at=now()+interval '120 days',
              updated_at=now()
          WHERE saved_specialist_recipes.status<>'retired'
          RETURNING recipe_id AS id, status`,
        [scope.workspaceId,scope.principalId,recipe.surface,recipe.id,
          recipe.description,recipe.terms,run.id]
      );
      if(result[0])rows.push(result[0]);
    }
    return rows;
  }
  async forget(scope,{id='',surface='normal-chat'}={}){
    if(!scope?.workspaceId || !scope?.principalId || !SURFACES.has(surface)
       || !/^[a-z][a-z0-9_-]{3,79}$/.test(id))return false;
    const result=await this.pool.query(
      'DELETE FROM saved_specialist_recipes WHERE workspace_id=$1 AND principal_id=$2 AND surface=$3 AND recipe_id=$4',
      [scope.workspaceId,scope.principalId,surface,id]
    );
    return (result.rowCount ?? 0)>0;
  }
}
