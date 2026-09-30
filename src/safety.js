/**
 * The usage policy: Kindgleam helps with anything good and declines what
 * would hurt people. Every request, every tool used on a person's behalf,
 * and every image it is shown are held to the same rules.
 *
 *   allow   normal help
 *   care    help, with the cautions the topic needs (health, law, money,
 *           decisions about people): general information, a professional
 *           where it matters, and a person to decide
 *   refuse  a short, kind reason and a safe alternative; no answer is made
 *
 * Judging what a request is for needs meaning, not word lists, so the AI
 * model's classifier makes the decision against the categories below (the
 * providers' own safety systems apply as well). A few plain cases are also
 * recognised without the model. The model may make a decision stricter,
 * never looser. Refusals are recorded by category only (never the text),
 * and repeated refusals pause new chats for a while. An operator may also
 * choose topics not to offer at all (BLOCKED_TOPICS), such as religion.
 */

const text = value => String(value ?? '').trim();

/** What Kindgleam declines, in plain words, with what it offers instead. */
export const POLICY_CATEGORIES = Object.freeze({
  'child-safety': {
    label: 'anything that sexualises or endangers children',
    message: 'I can\'t help with anything that sexualises or endangers children.',
    alternatives: ['If a child may be at risk, contact local police or a child-protection helpline now.', 'I can help you learn how to keep children safe online.']
  },
  'intimate-images': {
    label: 'sexual or intimate images of real people without their consent, and fake images meant to deceive or humiliate someone',
    message: 'I can\'t create, alter or share intimate images of real people, or fake images meant to deceive or humiliate someone.',
    alternatives: ['I can help with creative work using clearly fictional characters.', 'If intimate images of you were shared, I can help you get them taken down and report it.']
  },
  'identify-people': {
    label: 'identifying people from their face, or guessing traits such as ethnicity, religion, sexuality or politics from how they look',
    message: 'I don\'t identify people from their face or guess things like someone\'s ethnicity, religion or sexuality from how they look.',
    alternatives: ['I can describe what is in an image, read its text, or help with the scene, objects or design.']
  },
  'serious-harm': {
    label: 'weapons or methods able to seriously hurt many people, and help carrying out violence',
    message: 'I can\'t help with anything that could be used to seriously hurt people.',
    alternatives: ['I can explain the history, the law, or how communities and emergency services keep people safe.']
  },
  'cyber-attack': {
    label: 'malicious software, or breaking into accounts, devices or systems that are not the person\'s own',
    message: 'I can\'t help break into accounts or systems, or write software meant to cause harm.',
    alternatives: ['I can help secure your own accounts and systems, explain how attacks work so you can defend against them, or set up a legal practice lab.']
  },
  'fraud': {
    label: 'scams, phishing, forged documents, fake reviews and other deception for gain',
    message: 'I can\'t help deceive people for money or advantage, such as scams, phishing, forged documents or fake reviews.',
    alternatives: ['I can help you spot and report scams, or write honest marketing and genuine requests for reviews.']
  },
  'harassment': {
    label: 'threats, harassment, hate against people for who they are, and publishing someone\'s private details',
    message: 'I can\'t help threaten, harass or target people, or expose someone\'s private details.',
    alternatives: ['If someone has hurt you, I can help you write a firm, safe message, keep a record, or report it.']
  },
  'stalking': {
    label: 'tracking, monitoring or secretly surveilling another person',
    message: 'I can\'t help track or watch another person without their knowledge.',
    alternatives: ['If you are worried about someone\'s safety, I can help you talk with them or reach the right service. For your own family, I can explain safety tools used openly.']
  },
  'illegal-drugs': {
    label: 'making or obtaining illegal drugs',
    message: 'I can\'t help make or get illegal drugs.',
    alternatives: ['I can share harm-reduction and treatment information, or talk about how medicines work in general.']
  },
  'election-manipulation': {
    label: 'misleading voters, fake accounts or mass disinformation about elections',
    message: 'I can\'t help mislead voters or interfere with elections.',
    alternatives: ['I can explain how to register and vote, compare parties\' public positions, or help check a claim.']
  },
  'impersonation': {
    label: 'pretending to be a real person or organisation to deceive others',
    message: 'I can\'t help pretend to be a real person or organisation to deceive people.',
    alternatives: ['I can help you write in your own name, or clearly label parody and fiction.']
  },
  'prohibited-ai-use': {
    label: 'using AI to score people socially, read their emotions at work or school, or exploit people\'s vulnerabilities',
    message: 'I can\'t be used to score people, read their emotions at work or school, or manipulate people.',
    alternatives: ['I can help design fair processes where people decide, with clear criteria and a way to appeal.']
  }
});

export const POLICY_IDS = Object.freeze(Object.keys(POLICY_CATEGORIES));

/** Areas that get help with care, and the care each needs. */
/**
 * A caution the server adds to a request's constraints for a topic that needs
 * care. It is guidance for the answer, not something the person said, so it
 * never changes how risky the situation itself is judged to be.
 */
export const careNote = area => `Care: ${CARE_NOTES[area]}.`;
export const isCareNote = value => String(value ?? '').startsWith('Care: ');

export const CARE_NOTES = Object.freeze({
  health: 'general health information, not a diagnosis; see a doctor for anything serious or lasting',
  legal: 'general legal information, not legal advice; rules depend on the country',
  money: 'general information, not financial advice; projections are estimates',
  'people-decisions': 'AI can help organise information, but a person must make decisions about hiring, grades, loans or benefits'
});

/**
 * Topics an operator chose not to offer at all (BLOCKED_TOPICS), whatever
 * the request. Unlike the categories above these are not harmful: declining
 * them never pauses anyone's chats, and the reply is neutral.
 */
export const TOPICS = Object.freeze({
  religion: {
    label: 'religion: questions whose main subject is any religion or faith (beliefs, practices, rulings such as halal or haram, scripture and its meaning, religious figures, comparing religions, religious debates and religious history), for every religion equally',
    message: 'I don\'t discuss religious topics here, for any religion. For religious questions, please ask a qualified scholar or leader of your faith.',
    alternatives: ['I\'m happy to help with anything else: learning, work, business ideas, code, writing or research.'],
    // Plain questions about a religion, recognised without the model.
    pattern: new RegExp([
      String.raw`\b(?:islam|islamic|christian(?:ity)?|catholic\w*|protestant\w*|orthodox church|juda(?:ism|ic)|jewish law|hindu(?:ism)?|buddhis[mt]|sikh(?:ism)?|jain(?:ism)?|bah[aá]'?[ií]|zoroastrian\w*|shinto|tao(?:ism)?|atheis[mt]|agnosti\w*|sunni|shia|shi'?ite|ahmadi\w*|sufi\w*|wahhabi\w*|deobandi|barelvi|mormon\w*|jehovah'?s witness\w*|evangelical\w*|muslims?|christians?|hindus?|jews|sikhs?|buddhists?|jains?|catholics?|protestants?|atheists?)\b[\s\S]{0,60}\b(?:say|says|said|teach\w*|believ\w*|beliefs?|allow\w*|forbid\w*|permit\w*|view\w*|position|ruling|rules?|true|right|wrong|better|best|history|origins?|founded|founder|practices?|pray\w*|worship\w*|holy|sacred|rituals?)\b`,
      String.raw`\b(?:history|origins?|founder|beliefs?|practices?|rituals?|teachings?|holy (?:books?|sites?|days?)|pillars|sects?)\b[\s\S]{0,30}\b(?:islam|christianity|judaism|hinduism|buddhism|sikhism|jainism|zoroastrianism|taoism|shinto)\b`,
      String.raw`\b(?:what does|according to|is it|is .{1,40}) (?:in )?(?:islam|christianity|judaism|hinduism|buddhism|sikhism|the (?:quran|qur'an|bible|torah|talmud|gita|bhagavad gita|vedas|guru granth sahib|hadith|sunnah))\b`,
      String.raw`\b(?:is (?:it|this|that) (?:halal|haram|a sin|sinful|kosher|allowed in (?:islam|christianity|judaism|hinduism|my religion))|fatwa|tafsee?r|interpret (?:this |the )?(?:verse|ayah|ayat|surah|sura|scripture|hadith|psalm)|meaning of (?:this |the )?(?:verse|ayah|surah|hadith|psalm))\b`,
      String.raw`\b(?:which|what) (?:is the )?(?:true|right|best|real|correct) (?:religion|faith|god)\b|\b(?:does god exist|is there a god|prove (?:that )?god|existence of god)\b`,
      String.raw`\b(?:religion|religious|faith|theolog\w*|scripture|prophet\w*|sect|sects|denomination\w*)\b[\s\S]{0,40}\?`,
      String.raw`\breligious (?:rulings?|laws?|rules?|views?|teachings?|opinions?|obligations?|duties|duty|perspectives?|beliefs?|practices?)\b`
    ].join('|'), 'i')
  }
});
export const TOPIC_IDS = Object.freeze(Object.keys(TOPICS));

/**
 * What a blocked topic looks like in an answer: statements of religious
 * teaching or rulings, as opposed to a passing mention such as a holiday
 * date. An answer that contains one is replaced before anyone sees it.
 */
const ANSWER_PATTERNS = Object.freeze({
  religion: new RegExp([
    String.raw`\baccording to (?:the )?(?:quran|qur'an|bible|torah|talmud|hadith|sunnah|gita|bhagavad gita|vedas|guru granth sahib|scriptures?|islam|christianity|judaism|hinduism|buddhism|sikhism|islamic law|sharia|shariah|church teaching|the church|the prophet)\b`,
    String.raw`\b(?:the )?(?:quran|qur'an|bible|torah|talmud|hadith|gita|vedas|scriptures?|new testament|old testament)\b[^.\n]{0,40}\b(?:says|states|teaches|tells|commands|forbids|permits|allows|mentions|describes)\b`,
    String.raw`\b(?:islam|christianity|judaism|hinduism|buddhism|sikhism|jainism|the church|islamic law|sharia|shariah)\b[^.\n]{0,30}\b(?:teaches|says|forbids|prohibits|permits|allows|holds|requires|considers|views)\b`,
    String.raw`\b(?:is|are|was|be|considered|deemed|becomes)\s+(?:strictly\s+)?(?:halal|haram|makruh|kosher|sinful|a (?:grave |major |minor )?sin)\b`,
    String.raw`\b(?:allah|god|jesus|christ|the prophet|prophet muhammad|krishna|buddha|guru nanak)\b[^.\n]{0,20}\b(?:says|said|commands|commanded|forbids|forbade|teaches|taught|revealed)\b`,
    String.raw`\b(?:surah|sura|ayah|ayat)\s+\d+(?:\s*[:.]\s*\d+)?`,
    String.raw`\b(?:fatwa|tafsee?r|fiqh)\b`
  ].join('|'), 'i')
});

/** Replace an answer that carries a blocked topic; null when it is fine. */
export function guardAnswer(answer, blockedTopics = []) {
  const value = String(answer ?? '');
  for (const topic of blockedTopics) {
    if (ANSWER_PATTERNS[topic]?.test(value)) {
      const entry = TOPICS[topic];
      return { topic, text: `${entry.message}\n\n${entry.alternatives.join(' ')}` };
    }
  }
  return null;
}

/** The operator's blocked topics, from config, keeping only known ones. */
export const blockedTopicsFrom = config => (config?.policy?.blockedTopics ?? []).filter(id => TOPIC_IDS.includes(id));

export function topicRefusal(topic, source = 'rules') {
  const entry = TOPICS[topic];
  return { decision: 'refuse', category: topic, topic: true, source, message: entry.message, alternatives: entry.alternatives };
}

// A few requests are plain enough to recognise without the model: asking
// who a pictured person is, or what their protected traits are.
const PLAIN = [
  { category: 'identify-people', pattern: /\b(?:who is|identify|name|find out who is|recogni[sz]e) (?:this|the|that) (?:person|man|woman|girl|boy|guy|face)\b[\s\S]{0,25}\b(?:in|on|from) (?:this|the|my|that) (?:photo|image|picture|pic|video|selfie|screenshot)\b/i },
  { category: 'identify-people', pattern: /\b(?:guess|tell|detect|determine|predict)\b[\s\S]{0,30}\b(?:his|her|their|this person'?s)\b[\s\S]{0,15}\b(?:ethnicity|race|religion|sexual(?:ity| orientation)|political (?:views|leaning))\b/i },
  { category: 'intimate-images', pattern: /\b(?:undress (?:her|him|them|this|the)|nudify|deep ?fake (?:of|with) (?:my|her|his|a real|this))\b/i },
  // Phishing and fake logins are fraud first, even when they take passwords.
  { category: 'fraud', pattern: /\b(?:help|show|write|create|build|make|generate|develop|set up)\b[\s\S]{0,70}\b(?:phishing (?:page|site|email)|fake login|credential harvesting|steal passwords|forged document|fake review|scam)\b/i },
  { category: 'cyber-attack', pattern: /\b(?:help|show|write|create|build|make|give|develop|set up)\b[\s\S]{0,70}\b(?:malware|ransomware|keylogger|steal (?:passwords|credentials)|break into|hack (?:an?|the|my|someone'?s)|exploit (?:an?|the) (?:account|device|system))\b/i },
  { category: 'serious-harm', pattern: /\b(?:help|show|write|create|build|make|design|generate)\b[\s\S]{0,55}\b(?:bomb|explosive|weapon|poison|toxic agent|thermite|napalm|molotov|nerve agent|incendiary device)\b/i },
  { category: 'illegal-drugs', pattern: /\b(?:help|show|write|create|build|make|synthesize|manufacture|obtain|get)\b[\s\S]{0,55}\b(?:meth(?:amphetamine)?|cocaine|heroin|fentanyl|illegal drug)\b/i },
  { category: 'stalking', pattern: /\b(?:track|monitor|spy on|secretly watch)\b[\s\S]{0,55}\b(?:someone|a person|my (?:ex|partner|spouse)|another person)\b[\s\S]{0,35}\b(?:without (?:their )?(?:knowledge|consent)|secretly)\b/i },
  { category: 'impersonation', pattern: /\b(?:pretend to be|impersonate|pose as)\b[\s\S]{0,55}\b(?:a real person|someone else|a company|an organization|the bank|the police)\b[\s\S]{0,45}\b(?:to deceive|to trick|so they believe|to fool)\b/i },
  { category: 'election-manipulation', pattern: /\b(?:mislead|deceive|manipulate|target)\b[\s\S]{0,55}\b(?:voters?|election|ballot)\b[\s\S]{0,35}\b(?:with fake|false|disinformation|propaganda|fake accounts?)\b/i },
  { category: 'prohibited-ai-use', pattern: /\b(?:score|rank|classify|predict)\b[\s\S]{0,55}\b(?:people|employees?|students?|applicants?)\b[\s\S]{0,45}\b(?:emotion|social credit|vulnerability|personality|trustworthiness)\b/i }
];
const PEOPLE_DECISIONS = /\b(?:decide|choose|pick|rank|score|reject|approve)\b[\s\S]{0,40}\b(?:candidates?|applicants?|employees?|students?|tenants?|borrowers?)\b/i;

/** The recognisable part of the policy, without the model. */
export function screenRequest(goal, { blockedTopics = [] } = {}) {
  const value = text(goal);
  for (const rule of PLAIN) {
    if (rule.pattern.test(value)) return refusal(rule.category, 'rules');
  }
  for (const topic of blockedTopics) {
    if (TOPICS[topic]?.pattern.test(value)) return topicRefusal(topic, 'rules');
  }
  if (PEOPLE_DECISIONS.test(value)) return { decision: 'care', care: ['people-decisions'], source: 'rules' };
  return { decision: 'allow', source: 'rules' };
}

export function refusal(category, source = 'rules') {
  const entry = POLICY_CATEGORIES[category];
  return { decision: 'refuse', category, source, message: entry.message, alternatives: entry.alternatives };
}

/** Validate the classifier's policy reading; anything malformed is ignored. */
export function normalizePolicyHint(value, { blockedTopics = [] } = {}) {
  if (!value || typeof value !== 'object') return null;
  const decision = text(value.decision);
  if (!['allow', 'care', 'refuse'].includes(decision)) return null;
  const category = text(value.category);
  if (decision === 'refuse' && !POLICY_IDS.includes(category) && !blockedTopics.includes(category)) return null;
  const care = Array.isArray(value.care) ? value.care.map(text).filter(item => item in CARE_NOTES) : [];
  return { decision, ...(decision === 'refuse' ? { category } : {}), ...(care.length ? { care } : {}), ...readingOf(value) };
}

const INTENTS = ['understand', 'protect', 'do', 'unclear'];
const AFFECTED = ['self', 'others', 'public', 'none'];

/** The model's reading of the person: intent, underlying need, who is affected, vulnerability. */
function readingOf(value) {
  const reading = {};
  if (INTENTS.includes(text(value.intent))) reading.intent = text(value.intent);
  const need = text(value.need).replace(/\s+/g, ' ').slice(0, 160);
  if (need) reading.need = need;
  if (AFFECTED.includes(text(value.affected))) reading.affected = text(value.affected);
  if (typeof value.vulnerable === 'boolean') reading.vulnerable = value.vulnerable;
  return reading;
}

/** The stricter of the rules and the model: refuse > care > allow. */
export function combineDecisions(rules, hint) {
  // The model's reading of the person travels with the decision, whoever made it.
  const reading = hint ? readingOf(hint) : {};
  if (rules.decision === 'refuse') return { ...rules, ...reading };
  if (hint?.decision === 'refuse') return { ...(TOPIC_IDS.includes(hint.category) ? topicRefusal(hint.category, 'model') : refusal(hint.category, 'model')), ...reading };
  const care = [...new Set([...(rules.care ?? []), ...(hint?.care ?? [])])];
  if (rules.decision === 'care' || hint?.decision === 'care' || care.length) return { decision: 'care', care, source: hint?.decision === 'care' ? 'model' : 'rules', ...reading };
  return { decision: 'allow', source: hint ? 'model' : 'rules', ...reading };
}

/**
 * The ethical side of the situation, kept on the run so every step adapts
 * to it: what was decided, and what the person needs.
 */
export function ethicsOf(verdict) {
  return {
    decision: verdict.decision,
    ...(verdict.category ? { category: verdict.category, topic: verdict.topic === true } : {}),
    ...(verdict.care?.length ? { care: verdict.care } : {}),
    ...(verdict.intent ? { intent: verdict.intent } : {}),
    ...(verdict.need ? { need: verdict.need } : {}),
    ...(verdict.affected ? { affected: verdict.affected } : {}),
    ...(verdict.vulnerable !== undefined ? { vulnerable: verdict.vulnerable } : {})
  };
}

/** Children's safety is never answered by generated text: its reply is fixed. */
export const FIXED_REPLY_CATEGORIES = Object.freeze(['child-safety']);

/**
 * How to answer a declined request for this person's situation: without the
 * declined content, but with their real need in view.
 */
export function declinedPurpose(ethics) {
  const entry = POLICY_CATEGORIES[ethics.category] ?? TOPICS[ethics.category];
  const what = ethics.topic
    ? `${entry.label}. Do not state or explain any religious teaching, ruling, scripture or view, for any religion`
    : `${entry.label}. Do not give any part of it, not even in outline or as an example`;
  return [
    `This request is declined under the usage policy: ${what}.`,
    'Understand the person\'s situation and answer their real need instead:',
    ethics.need ? `their need seems to be "${ethics.need}";` : 'work out what they are really trying to solve;',
    ethics.vulnerable ? 'they may be distressed or at risk, so be warm and point to people who can help right away;' : '',
    ethics.topic
      ? 'say kindly that religious topics are not discussed here, for any religion, and that a qualified scholar or leader of their faith can help; then help with the rest of their situation (for example how to approach an assignment, or support in a hard time).'
      : 'without judging or lecturing, say in one sentence what you cannot help with and why, then offer concrete, safe help that fits their situation: a better way to reach their goal, protection, support, or the right people or services.',
    `Suitable alternatives include: ${entry.alternatives.join(' ')}`,
    'Use their language and level, and keep it short.'
  ].filter(Boolean).join(' ');
}

/** For the classifier prompt: the categories it may refuse, in plain words. */
export function policyPromptLines(blockedTopics = []) {
  return [
    '- "policy": {"decision":"allow"|"care"|"refuse","category":"","care":[],"intent":"understand"|"protect"|"do"|"unclear","need":"","affected":"self"|"others"|"public"|"none","vulnerable":false}.',
    '  Read the ethical side of the situation, not just the words: "intent" is what the person wants (to understand something, to protect themselves or others, or to do it); "need" is the real need behind the request in a few words (for example "worried their partner is lying", "school assignment", "grieving a parent", "short of money"); "affected" is who could be hurt; "vulnerable" is true when they seem distressed, at risk or very young.',
    '  Refuse only when the person asks for help doing one of these, not when they ask to understand, prevent, report or recover from it:',
    ...POLICY_IDS.map(id => `    ${id}: ${POLICY_CATEGORIES[id].label}`),
    ...(blockedTopics.length ? [
      '  Also refuse, with that topic as the category, when the main subject of the request is a topic this service does not offer (a passing mention is fine when the subject is something else):',
      ...blockedTopics.map(id => `    ${id}: ${TOPICS[id].label}`)
    ] : []),
    `  "care" lists which of ${JSON.stringify(Object.keys(CARE_NOTES))} apply when the topic needs caution. Most requests are "allow".`
  ];
}

/** Every reasoning step follows the same policy. */
export const USAGE_POLICY_PROMPT = [
  'Usage policy: help with anything good. Decline, briefly and kindly, and offer a safe alternative, when a request or tool use would help with any of:',
  POLICY_IDS.map(id => POLICY_CATEGORIES[id].label).join('; ') + '.',
  'Explaining, preventing, defending against, reporting or recovering from these is allowed.',
  'Images: describe what is shown and read its text; never identify a real person from their face, never guess ethnicity, religion, sexuality, politics or health from appearance, and never sexualise real people. Charts and pictures you make with code follow the same rules.',
  'Care: for health, law and money give general information and say when to see a professional; label projections as estimates; for hiring, grading, loans or benefits, help organise information but say that a person must decide.',
  'Always be honest that you are an AI, cite sources for facts you looked up, and say when you are unsure.'
].join(' ');

/** The usage policy plus the operator's blocked topics, for every reasoning step. */
export function usagePolicyPrompt(blockedTopics = []) {
  if (!blockedTopics.length) return USAGE_POLICY_PROMPT;
  return `${USAGE_POLICY_PROMPT} Topics this service does not discuss: ${blockedTopics.map(id => TOPICS[id].label).join('; ')}. If a request or follow-up is about one, reply only: "${blockedTopics.map(id => TOPICS[id].message).join(' ')}" When one comes up in passing, stay neutral and do not comment on it.`;
}

/** Tool inputs made on someone's behalf (new tools, scheduled messages) follow the rules too. */
export function screenToolInput(tool, input, { blockedTopics = [] } = {}) {
  if (!['tool.create', 'schedule.create'].includes(tool)) return null;
  const words = [input?.title, input?.name, input?.description, input?.message, input?.question].map(text).join(' ');
  const verdict = screenRequest(words, { blockedTopics });
  return verdict.decision === 'refuse' ? verdict : null;
}

/** How many refusals this person had in the last hour; many pause new chats. */
export const COOLDOWN = Object.freeze({ refusals: 5, windowMinutes: 60 });

export async function recordRefusal(pool, scope, { category, source, topic = false }) {
  // A topic this service doesn't offer is recorded apart: it never pauses chats.
  await pool.query(
    `INSERT INTO safety_events (workspace_id, principal_id, kind, category, source)
     VALUES ($1, $2, $3, $4, $5)`,
    [scope.workspaceId, scope.principalId, topic ? 'off-topic' : 'refused', category, source]
  ).catch(() => {});
}

export async function inCooldown(pool, scope) {
  const { rows: [row] } = await pool.query(
    `SELECT count(*)::int AS n, max(created_at) AS latest FROM safety_events
      WHERE workspace_id = $1 AND principal_id = $2 AND kind = 'refused'
        AND created_at > now() - make_interval(mins => $3)`,
    [scope.workspaceId, scope.principalId, COOLDOWN.windowMinutes]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  if ((row?.n ?? 0) < COOLDOWN.refusals) return null;
  const until = new Date(new Date(row.latest).getTime() + COOLDOWN.windowMinutes * 60_000);
  return { until: until.toISOString() };
}
