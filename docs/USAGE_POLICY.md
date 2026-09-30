# Usage policy and safeguards

Kindgleam helps with anything good and declines what would hurt people.
The public page people read is `public/policy.html` (served at `/policy.html`);
this page explains how the safeguards work, for operators.

## Allow, care, or refuse

Every new chat gets one of three
decisions (`src/safety.js`):

| Decision | What happens |
| --- | --- |
| **allow** | Normal help. Most requests. |
| **care** | Help, with cautions every step sees: health (not a diagnosis), law (not legal advice), money (estimates, not financial advice), decisions about people (a person must decide). |
| **refuse** | The declined part is never given. When the AI read the request, the reply is written for the person's situation and real need, without tools; otherwise (and always for children's safety) it is a fixed kind message with a safe alternative. |

What is refused is described in plain words, by category: children's
safety; intimate or deceptive images of real people; identifying people
from faces or guessing sensitive traits; serious harm to people; attacks on
others' systems; fraud and phishing; harassment and hate; stalking; illegal
drugs; election interference; impersonation; and AI uses the EU AI Act
prohibits (social scoring, emotion recognition at work or school,
manipulating vulnerable people).

**How it decides.** Telling a request apart from a question about the same
topic needs meaning, not word lists. So:
1. the AI model's classifier reads each request against the categories and
   returns allow, care or refuse (when the person allowed the AI to read it);
2. a few plain cases are recognised without the model, such as "who is this
   person in the photo";
3. the stricter of the two wins. The model can make a decision stricter,
   never looser.

Asking to understand, prevent, defend against, report or recover from any
of these is allowed. Every reasoning step also
follows the policy, including the image rules, and the AI providers apply
their own safety systems on top.

**Tools.** New workspace tools and scheduled messages are screened too, so
nothing made on someone's behalf can carry what a chat could not.

**Situation-aware governance.** Every workflow gets a server-owned governance contract that adapts
to the current situation: risk, domain, data sensitivity, jurisdiction, people-impact, side effects,
policy, capabilities and verification. It can mark a workflow ready, require extra care, require
review, or block it. This governance is checked again at execution and evidence boundaries.

Privacy is part of the same contract. Private data remains scoped to the authenticated user and
workspace, the minimum necessary data should leave the current trust boundary, and external model
or connector processing requires the required consent and authorization.

For high-impact or regulated work, the system can require a known jurisdiction and a configured
jurisdiction policy source before execution. A jurisdiction flag is not legal advice and does not
certify compliance with every applicable law.


## Topics not offered

Separately from harm, an operator can choose topics the service doesn't
discuss at all, for everyone: `BLOCKED_TOPICS` (default `religion`; `none`
offers every topic).

**Religion** covers any request whose main subject is a religion or faith:
beliefs, practices, rulings (halal or haram, fatwas), scripture and its
meaning, religious figures, comparing religions, religious debates and
religious history. Every religion is treated the same. The reply is neutral:
"I don't discuss religious topics here, for any religion. For religious
questions, please ask a qualified scholar or leader of your faith."

- A request that only mentions religion in passing (planning a week around
  Eid, a sales email for Christmas, a job at a Catholic school) is helped
  with, and the answer stays neutral.
- The model decides by the main subject; plain questions are also caught
  without it. Follow-ups in a chat follow the same rule.
- Answers are checked too. An answer that states religious teaching or
  rulings (for example "according to the Quran…", "Christianity teaches…",
  "…is haram", a surah reference) is replaced with the neutral message
  before anyone sees it, even when the question did not ask for it.
- Declining a topic is not abuse: it is recorded as `off-topic` and never
  pauses chats.
- Memory never keeps religion or belief (nor sexuality, health conditions
  or politics).

Update `public/policy.html` if you change the blocked topics.

## Ethics as understanding

Ethics is part of how Kindgleam understands each situation, not a list of
limits. With each request the model also reads:

| Reading | Meaning |
| --- | --- |
| `intent` | understand, protect, do, or unclear |
| `need` | the real need behind the request, in a few words |
| `affected` | self, others, the public, or no one |
| `vulnerable` | whether the person seems distressed, at risk or very young |

This reading is kept on the chat (`situation.ethics`) and every step adapts
to it: gentler words and support when someone seems vulnerable, respect for
others who could be affected, and the person's real need kept in view.

A declined request is answered the same way. "Track my wife's phone" is not
helped with tracking, but the worry behind it is: how to talk about it, or
where to find support. A religious question from a student gets how to
approach the assignment instead of religious content. The reply never
contains the declined content, uses no tools, and still passes the answer
check. When the model did not read the request (the person did not allow
it), and always for children's safety, the fixed kind message is used.

## What is recorded

- The safety record of a refused request keeps only its **category** and
  whether the rules, the model or a tool declined it (`safety_events`). When
  the reply was adapted, the chat itself is kept like any other chat, and
  the person can delete it.
- Five refusals in an hour pause new chats for that person for an hour.
- Admins see a 30-day count by category in Settings → Workspace.

## Age and terms

Before their first chat, each person confirms their age and accepts the
terms and usage policy. They're asked again when the version changes.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MINIMUM_AGE` | 16 | Minimum age people confirm (13–21) |
| `TERMS_VERSION` | 2026-09 | Change it when the terms change; everyone accepts again |
| `TERMS_REQUIRED` | true | `false` only for private test deployments |

Update the age on `public/policy.html` if you change `MINIMUM_AGE`.

## Reports

A flag under every answer reports it as harmful, wrong, unfair or a privacy
problem. The report keeps the reason, an optional note and the answer's
first 2,000 characters, so it can be reviewed even if the chat is later
deleted. Admins resolve or dismiss reports in Settings → Workspace; people
see their own reports there.

## Legal notes (not legal advice)

- Say it is AI: the app does, in the first-use dialog, the footer and the
  policy page.
- Children: the default age of 16 avoids the extra consent rules for younger
  children in most countries. Serving younger students needs parental or
  school consent and a review of COPPA, GDPR and local law.
- High-risk uses: Kindgleam is not a decision system for hiring, credit,
  benefits or official grading. It helps organise information and says a
  person must decide. Don't market or configure it as one.
- Check the result with a lawyer in the countries you serve, and adapt
  `public/policy.html` and `docs/PRIVACY_NOTES.md`.

## Checking it

`npm run eval:live` includes policy scenarios: a fraud request and a face
identification are declined kindly with alternatives, a phishing-defence
question is answered, a health question gets care, and a hiring ranking
leaves the decision to a person. See `LIVE_EVALUATION.md`.
