# Usage, limits and billing

## Usage

Every AI call is recorded in `usage_events`: who made it, in which
workspace and chat, what it was for (`chat`, `classifier`; rows from before may say
`simulation-design`), the provider and model, and the tokens in and out.
Row-level security limits each person to reading their own usage.

`GET /api/usage[?conversationId=…]` reads from that table:

| Field | Meaning |
| --- | --- |
| `windows[0]` | Rolling **4-hour account window**: all chats and code workspaces for the user share one token pool |
| `windows[1]` | Rolling **weekly account window**, shared by the same user across chats and code workspaces |
| `days` | Tokens per day for the last 7 days |
| `bySource` | What the tokens were spent on |
| `context` | For a chat: the prompt size of its latest AI call compared with the model's context window |

In the app, usage appears in three places:

- a ring next to your name, showing the 4-hour window;
- a "Context n%" meter in the chat header;
- **Settings → Usage**, with both windows, the 7-day chart, the breakdown and the model's context window.

## Limits

| Setting | Default | Effect |
| --- | --- | --- |
| `USAGE_LIMIT_4H_TOKENS` | 0 (none) | Tokens per person account-wide per rolling 4 hours |
| `USAGE_LIMIT_WEEKLY_TOKENS` | 0 (none) | Tokens per person account-wide per rolling week |
| `AI_MODEL` | `gemini-3.8-flash` | The default Gemini model. Any Gemini model id works, so a successor needs no code change |
| `AI_MODELS` | only `AI_MODEL` | Other Gemini models workspace admins may choose in Settings → Workspace → AI model, comma-separated (for example `gemini-3.1-pro`). A new default is tried with Gemini before it is saved, and a plan's `modelIds` in `STRIPE_PLANS` can limit which ones it includes |
| `AI_CONTEXT_WINDOW_TOKENS` | the model catalogue's window (1M for Gemini 3.8 Flash) | Size used for the context meter |
| `AI_FALLBACK_MODELS` | unset: no backups | Backup Gemini models, comma-separated, tried in order when the chosen model is out of quota, overloaded or retired (for example `gemini-3.5-flash,gemini-3.1-flash-lite`). Each Gemini model has its own quota, so on the free tier (about 20 requests a day per model) backups multiply what the site can answer. A model that failed that way is passed over for as long as Gemini asked (a minute by default), so later requests do not wait on it. The answer records which model wrote it. A rejected key or request is reported at once, never retried on another model |
| `AI_EFFORT` | unset: each step chooses | The most Gemini may think on any step: `low`, `medium` or `high`. Unset, each step asks for what it needs (low for classifying, web searches and crisis replies; medium for answers and planning; high for code and verification). Set, it is a ceiling that caps cost; it never raises a quick step |

Both usage windows are **principal-wide**: switching chats, code workspaces, or
the active workspace does not create another quota pool. The model context
meter remains conversation-specific. A window frees up as its oldest calls get
older than the window. When a person is over a limit:

- AI steps in a chat stop and say when they can continue;
- requests are understood by the keyword rules instead of the AI.

Work that does not use the AI (files, schedules, settings) keeps working. Checking a limit costs nothing when no limit is set.

## Billing

**Settings → Billing** shows:

- the plan (`BILLING_PLAN_NAME`) and its limits;
- a **Manage payment** link to the payment provider's customer portal
  (`BILLING_PORTAL_URL`, which must be HTTPS in production), where the card
  and invoices are managed;
- the workspace's billing details (email, company, tax ID, country,
  address). Only admins can see or change them (`GET` / `PUT /api/billing`),
  and each change is recorded in Activity.

Kindgleam never collects or stores card data. A billing detail that looks
like a card number is rejected.

## Stripe

Set `PUBLIC_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
`STRIPE_PLANS` (see `.env.example`). The app refuses to start if one is
missing or invalid, or if a test key is used in production.

- **Buying a plan:** an admin chooses a plan in Settings → Billing.
  `POST /api/billing/checkout` creates the workspace's Stripe customer (once)
  and a Checkout session, and the browser goes to Stripe's page. Price IDs
  stay on the server.
- **Manage payment:** `POST /api/billing/portal` opens a Stripe customer
  portal session. There you change the card, switch or cancel the plan,
  and download invoices. Plan switching must be turned on in Stripe's portal
  settings.
- **The webhook is the source of truth.** Point a Stripe webhook at
  `<PUBLIC_URL>/api/stripe/webhook` for `checkout.session.completed` and
  `customer.subscription.*`. Each event is verified against the signing
  secret (HMAC-SHA256, 5-minute tolerance) and applied once (`stripe_events`).
  It is ignored if it names another customer than the workspace's own.
  Returning from Checkout never activates anything on its own; the app waits
  for the webhook.
- **Free, paid, and sold by your team.** Free is everyone without a
  subscription and uses the default limits (`BILLING_FREE_*`,
  `USAGE_LIMIT_*`). Plans with a `priceId` (for example Plus and Pro) are
  bought through Checkout. A plan with a `contactUrl` (for example
  Enterprise) shows **Contact sales** and can't be bought through Checkout.
  Your team creates its subscription in Stripe, at any price, with metadata
  `plan_id=<id>`. Only a sales-only plan can be picked by metadata, so a
  self-serve price never becomes Enterprise.
- **Plans set the limits.** While a subscription is `active`, `trialing` or
  `past_due`, the plan's `fourHourTokens` and `weeklyTokens` replace the
  defaults. When it is cancelled or unpaid, the defaults apply again.

To try it locally, use Stripe's test mode and `stripe listen --forward-to
localhost:3000/api/stripe/webhook`.

## Security

**Settings → Security** lists your signed-in browser sessions
(`GET /api/sessions`). **Sign out others** (`POST /api/sessions/revoke-others`)
ends every session except the current one.
