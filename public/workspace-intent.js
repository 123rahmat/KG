/**
 * Shared, bounded request hints for the browser and server. These describe
 * work, not permissions or execution. Consumers retain their own routing and
 * recommendation contracts; a small code bundle can stay in Normal Chat.
 */
const prefix = '(?:(?:please|could you|can you|help me)\\s+)*';
const learning = new RegExp('^' + prefix + '(?:explain|teach|show|learn|study|solve|prove|derive|outline|describe|compare|what|why|how|give an? (?:explanation|overview|lesson))\\b', 'i');
const business = new RegExp('^' + prefix + '(?:(?:build|develop|create|draft|prepare|write|make|improve|analy[sz]e|design)\\s+(?:(?:a|an|the|my|our|new|detailed|five[- ]year|complete|better|simple|education)\\s+){0,5})?(?:business plan|business strategy|marketing plan|financial forecast|business model|lesson plan|curriculum|course plan|study plan|learning roadmap|business case|case study|educational plan)\\b', 'i');
const codeTopic = /\b(?:code|coding|program|programming|debug|debugging|refactor|repository|repo|pull request|branch|commit|function|class|bug|stack trace|compile|test suite|unit test|typescript|javascript|python|rust|golang|java|sql|api|backend|frontend|software|app|application|website|web app|github|simulation|simulate|simulating|computational model|numerical model)\b|\b[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sql|sh|html|css|json)\b/i;
const codeProject = /\b(?:repository|repo|codebase|project|github|pull request|branch|commit|multi[- ]file|multiple files|whole app|whole application|full[- ]?stack|service|backend|frontend|api|deployment|deploy)\b/i;
const singleCode = /\b(?:function|method|class|variable|snippet|script|single file|this file|one file|small fix|small change|edit this file|fix this file|explain this code|review this code|run this script|test this file|small program|utility script)\b/i;
const execution = /\b(?:run|execute|debug|fix|repair|test|refactor|implement|compile|build|develop|create|update|edit|modify)\b/i;
const softwareBuild = /\b(?:build|develop|create|implement)\b.{0,100}\b(?:website|web app|application|app|api|backend|frontend|(?:web|api|backend|micro|http|rest)[- ]?service)\b/i;
const compoundEngineering = /(?:\b(?:and then|then|and also|and|also)\s+|[.;]\s*)(?:please\s+)?(?:update|modify|edit|refactor|test|fix|implement|build)\b.{0,100}(?:\b(?:repository|repo|codebase|code|software|application|app|api|backend|frontend|tests?)\b|\b[\w./-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sql|sh|html|css|json)\b)/i;
const referencedEngineering = /(?:\b(?:and then|then|and also|and|also)\s+|[.;]\s*)(?:please\s+)?(?:update|modify|edit|refactor|test|fix|implement|build)\s+(?:(?:it|them|this|that|those)\b|(?:a|the)\s+(?:fix|patch|change)\b)/i;
const researchRequest = new RegExp('^' + prefix + '(?:research|investigate|find sources|compare sources)\\b', 'i');
const researchProject = /\b(?:deep research|systematic review|literature review|thesis|dissertation|academic paper|research paper|meta-analysis|research project|comprehensive research|peer-reviewed studies|multi[- ]source study|source[- ]by[- ]source|compare (?:credible|multiple|primary) sources|verify (?:the )?citations)\b/i;
const sourceHeavy = /\b(?:research|investigate)\b.{0,160}\b(?:sources|citations|papers|studies|evidence|literature)\b/i;
const ongoing = /\b(?:findings?|previous results?|next steps?|our work|work so far|current (?:project|task|investigation)|(?:the|this|these|those) (?:results?|evidence|sources?|implementation|changes?))\b/i;
const lightweight = new RegExp('^' + prefix + '(?:translate|rewrite|summarize|explain|calculate|brainstorm|draft|hello|hi|thanks)\\b', 'i');

export function workspaceIntent(goal = '') {
  const request = String(goal ?? '').trim().slice(0, 3000);
  // "Use code examples" is not a workspace selection. Bare destinations
  // need a transition verb; open/use need the explicit workspace noun.
  const selection = request.match(/\b(?:switch(?:\s+to)?|move(?:\s+to)?|take me to|continue in|work in)\s+(?:the\s+)?(code|coding|research|normal chat)(?:\s+workspace)?\b/i)
    ?? request.match(/\b(?:open|use)\s+(?:the\s+)?(code|coding|research|normal chat)\s+workspace\b/i);
  const explicitWorkspace = selection
    ? /^(?:code|coding)$/i.test(selection[1]) ? 'code'
      : /^research$/i.test(selection[1]) ? 'research' : 'normal-chat'
    : null;
  const compound = compoundEngineering.test(request)
    || (codeTopic.test(request) && codeProject.test(request) && referencedEngineering.test(request));
  const research = researchRequest.test(request) && !compound;
  const everyday = (learning.test(request) || business.test(request)) && !compound && !research;
  const engineering = !everyday && !research;
  const construction = /\b(?:simulate|simulating|simulation|computational model|numerical model)\b/i.test(request)
    && /\b(?:simulate|simulating|develop|build|create|implement|test|refine)\b/i.test(request);
  const compoundBuild = /\b(?:build|develop|implement|refactor|create)\b.{0,110}\b(?:code|software|application|model)\b/i.test(request)
    && /\b(?:and|then|plus)\b.{0,80}\b(?:modify|edit|refactor|test|fix)\b/i.test(request);
  return Object.freeze({
    explicitWorkspace, everyday, researchRequest: research,
    codeTopic: engineering && codeTopic.test(request),
    codeProject: engineering && codeProject.test(request),
    softwareBuild: engineering && softwareBuild.test(request),
    projectLifecycle: engineering && (construction || compound || compoundBuild),
    singleCode: singleCode.test(request), execution: engineering && execution.test(request),
    researchProject: !everyday && researchProject.test(request),
    sourceHeavyResearch: !everyday && sourceHeavy.test(request),
    researchEvidence: !everyday && /\b(?:citations?|papers?|literature|source verification|peer-reviewed|systematic review)\b/i.test(request),
    researchIntent: !everyday && /\b(?:research|investigate|find sources|literature|citations|evidence)\b/i.test(request),
    lightweight: everyday || lightweight.test(request), ongoing: ongoing.test(request)
  });
}
