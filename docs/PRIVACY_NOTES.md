# Privacy notes for operators

Plain-language facts about what Kindgleam does with people's data, for the
operator's privacy policy. They describe the code as it is. Retention periods,
the operator's name and contact, and legal bases are the operator's to add.

## What leaves the service

- **Google Gemini API** (Gemini 3.8 Flash). A chat's messages, the parts of attached files it needs, the person's
  settings (language, country, "About me") and their remembered facts are
  sent so the model can answer. Nothing is sent until the person allows it
  (or has turned on "AI conversation consent"). Web searches also run through
  this provider's search.
- **Stripe**, for paid plans. Kindgleam never sees or stores card numbers;
  it keeps the Stripe customer and subscription ids and the plan.
- **Public websites**, when the AI reads a page or downloads a public file.
  The request comes from the server, not the person's browser, and carries
  no personal data beyond the address being read.

By default, nothing else is shared by the application. Kindgleam connects to no email, cloud-drive or
bank account.

## What is kept

| Data | Who can see it | How it is removed |
| --- | --- | --- |
| Chats and their steps | the person; the workspace if they share the chat | the delete button next to the chat removes the person's messages, steps and proposed actions |
| Uploaded and generated files | the owner; the workspace if shared | Files → Delete |
| **Memories** (lasting facts from chats) | only that person, in that workspace | Settings → Personalization → Memory: delete one, Forget everything, or turn memory off |
| Schedules and notifications | only that person | Settings → Schedules → Cancel |
| Tools the workspace built | the workspace | an admin retires them |
| Usage (token counts per request) | the person; admins for the workspace | kept for usage limits and billing, without the chat's content |
| Settings | the person | Settings → Reset all settings to defaults |
| Declined requests | the person; admins as counts by kind | the safety record keeps only the kind of request; an adapted reply is a normal chat the person can delete |
| Reported answers | the reporter; the workspace's admins | the reason, an optional note and the answer's first 2,000 characters |
| Age confirmation and terms acceptance | the person | the version and time accepted |

All of it is in the operator's PostgreSQL database, separated by workspace
with row-level security. In production, `OBJECT_ENCRYPTION_KEY` is required,
so encrypted object storage is enabled for stored sensitive file/object content.

## Memory

Memory is **on by default**, and the policy should say so. Suggested text:

> Kindgleam remembers lasting things you tell it, such as your work, where
> you are, your projects and how you like answers, so later chats don't start
> from zero. It never keeps passwords, keys or card numbers. Only you can see
> your memories. You can see, delete or turn off memory at any time in
> Settings → Personalization → Memory; when it is off, nothing is saved or
> used.

People are told this in the app: in the "Allow the AI to read this chat?"
prompt, with "Saved to memory" on the answer when something is kept, "Used
what you told me before" when a memory shaped an answer, and a "Manage
memory" link in Settings → Data controls.

## Code and sandboxes

Code runs in throwaway containers with no network. Attached files are copied
in for that run only, and the containers are removed afterwards; only result
files the person chose to save are kept, in their Files.


## Gemini API contract note

This application uses the Gemini API, not the Gemini consumer app. Use of the API
remains subject to Google's Gemini API terms and its Generative AI Prohibited Use Policy.
Run it from a billing-enabled (paid) Gemini API project: on unpaid tiers Google may use
prompts and responses to improve its products, which the promises above do not allow.
The operator remains responsible for evaluating outputs, applying appropriate human review,
and complying with the laws that apply to the operator and its users. Availability and regional
restrictions can change, so deployment should check Google's list of regions where the
Gemini API is available before launch.


## Situation-aware governance and privacy

Every workflow receives a server-generated governance contract derived from the current
situation. It considers risk, domain signals, data sensitivity, jurisdiction, human decision
requirements, side effects, candidate tools/capabilities, the server policy layers and the
verification contract. The contract can require care, review, or a hard block.

Private data is classified before external egress. The platform requires explicit consent for
private model/connector processing, keeps workspace and principal scope separate, and treats
credentials, payments and workspace secrets as restricted data. The browser cannot override
these decisions.

Jurisdiction awareness means the system can require the applicable country/region before a
regulated or high-impact workflow proceeds. It does not mean the software automatically
knows every law in every jurisdiction or provides legal certification. A jurisdiction-specific
policy source or qualified legal review is still required.

Governance is continuously checked through the workflow rather than only at the first prompt:
planning, capability selection, execution, receipt acceptance, verification and delivery each
retain the situation's governance constraints.
