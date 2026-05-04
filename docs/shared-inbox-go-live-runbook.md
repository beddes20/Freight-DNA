# Shared Inbox Go-Live Runbook (Task #549)

> **Reply-routing model (current default):** The product routes carrier
> replies through **each rep's own monitored M365 mailbox** via the
> per-rep Graph change-notification subscriptions. **No shared reply
> mailbox is required** for the pipeline to work end-to-end. Steps in
> this runbook that mention `OUTLOOK_REPLY_EMAIL` are **optional** and
> only apply if you want a *secondary* shared inbox in addition to the
> per-rep model. Per Task #959 the shared mailbox is now intentionally
> disabled in production.

This runbook covers everything IT needs to do to enable Microsoft
Graph–backed mailbox sync in production. The pipeline reads carrier
replies from each rep's own M365 mailbox via Microsoft Graph change
notification webhooks, matches them to the lane outreach that was sent,
and surfaces them inside the Available Freight workspace.

The same pipeline powers per-rep mailbox enrollment, which feeds the
Email Intelligence and Customer Quoting features.

---

## Audience

- IT / Microsoft 365 admin who can edit Azure AD app registrations and
  grant tenant-wide consent.
- Site admin who manages the application's environment variables and
  monitored mailboxes.

---

## Pre-flight checklist

Before you start, confirm:

- [ ] You have an Azure AD tenant admin account (granting application
      permissions requires admin consent).
- [ ] *(Optional — only if adopting the shared-inbox model on top of
      per-rep)* You have, or can create, a shared M365 mailbox to
      receive carrier replies (e.g. `replies@yourcompany.com`).
- [ ] The application is reachable from the public internet over HTTPS at
      a stable hostname. Microsoft Graph will not deliver notifications to
      `localhost`, raw IP addresses, or HTTP-only URLs.

---

## Step 1 — Register an Azure AD application

1. Sign in to the [Azure portal](https://portal.azure.com) as a tenant
   admin and open **Azure Active Directory → App registrations →
   New registration**.
2. Give the app a clear name (for example `Freight DNA Mailbox Reader`).
3. Set **Supported account types** to *Accounts in this organizational
   directory only*.
4. Leave the **Redirect URI** blank — this app uses app-only (client
   credentials) flow, no user sign-in is required.
5. Click **Register** and note the **Application (client) ID** and the
   **Directory (tenant) ID** shown on the overview page.

### 1a — Create a client secret

1. In the new app, open **Certificates & secrets → Client secrets → New
   client secret**.
2. Choose an expiry that matches your secret rotation policy (24 months
   maximum is recommended).
3. **Copy the secret value immediately** — Azure only displays it once.

### 1b — Grant the Mail.Read application permission

1. Open **API permissions → Add a permission → Microsoft Graph →
   Application permissions** and check `Mail.Read`. Click **Add
   permissions**.
2. Back on the API permissions page, click **Grant admin consent for
   <tenant>** and confirm.
3. The status next to `Mail.Read` should switch to *Granted for
   <tenant>* with a green check.

> Without admin consent the app can authenticate but every Graph call
> for mail content will return `403`. Reply tracking will refuse to
> activate and the readiness checklist will surface the error.

---

## Step 2 — *(Optional)* Create a shared reply mailbox

> **Skip this step** if you are using the per-rep monitored-mailbox
> model (the current default). Per-rep mailboxes are enrolled later
> from the **Admin → Monitored Mailboxes** page and don't need any
> shared inbox.

If you want a *secondary* shared inbox in addition to the per-rep
model:

1. In the M365 admin centre, create (or pick) a shared mailbox dedicated
   to carrier replies. Suggested name: `Carrier Replies`,
   address: `replies@yourcompany.com`.
2. The mailbox does **not** need a paid licence — shared mailboxes are
   free up to 50 GB.
3. Confirm the mailbox can receive external email. Send a test message
   from a personal account and verify it arrives in the inbox.

The Azure app from Step 1 has tenant-wide `Mail.Read`, so no further
mailbox-level permission is required.

---

## Step 3 — Generate the webhook secret

The webhook secret (`OUTLOOK_WEBHOOK_SECRET`) is the `clientState` value
Microsoft Graph echoes back on every notification. We use it to reject
forged payloads — without a secret, anyone who can reach the webhook URL
could inject fake carrier replies.

Generate a strong, unguessable value. On any Mac/Linux shell:

```bash
openssl rand -hex 32
```

Save the output — you will paste it into the application's environment
in the next step. Treat this value like a password.

---

## Step 4 — Configure application environment variables

Set the following in the application's environment (Replit secrets,
deployment env, etc.). The required values cover the per-rep mailbox
model — `OUTLOOK_REPLY_EMAIL` is **optional** and only needed if you
opted into Step 2:

| Variable                  | Example                                       | Required?  | Notes                                                     |
|---------------------------|-----------------------------------------------|------------|-----------------------------------------------------------|
| `OUTLOOK_TENANT_ID`       | `00000000-0000-0000-0000-000000000000`        | Required   | Directory (tenant) ID from Step 1.                        |
| `OUTLOOK_CLIENT_ID`       | `11111111-1111-1111-1111-111111111111`        | Required   | Application (client) ID from Step 1.                      |
| `OUTLOOK_CLIENT_SECRET`   | `(generated by Azure)`                        | Required   | Client secret value from Step 1a — copy once on creation. |
| `APP_BASE_URL`            | `https://app.yourcompany.com`                 | Required   | Public HTTPS URL of this application — no trailing slash. |
| `OUTLOOK_WEBHOOK_SECRET`  | `(output of `openssl rand -hex 32`)`          | Required   | The Step 3 secret. No insecure default.                   |
| `OUTLOOK_REPLY_EMAIL`     | `replies@yourcompany.com`                     | **Optional** | Only set if you completed Step 2 and want a shared inbox in addition to the per-rep model. **Leave unset** to use the per-rep default — that is what production runs today. |

Restart the application after setting these. On boot, the Graph
subscription service will:

1. Iterate the enabled monitored-mailboxes table and register per-rep
   inbox + sentitems subscriptions against
   `${APP_BASE_URL}/api/webhooks/graph/email`. **This is the primary
   reply-routing path.**
2. *(Only if `OUTLOOK_REPLY_EMAIL` is set)* probe `Mail.Read` against
   the shared mailbox and, if granted, register an inbox subscription
   against `${APP_BASE_URL}/api/webhooks/outlook-reply`. If the env
   var is unset, you will see the boot log line
   `[graph-sub] OUTLOOK_REPLY_EMAIL or APP_BASE_URL not set — shared
   mailbox reply tracking disabled` — that is the intended state.
3. Schedule auto-renewal every 2 days (subscriptions live ~70 hours).

> **What happens if the secret is missing?** The service refuses to
> register any subscriptions and the webhook handlers refuse to process
> any payloads. The readiness checklist will show
> `OUTLOOK_WEBHOOK_SECRET` as a missing requirement.

---

## Step 5 — Verify with the in-app readiness panel

Sign in as an admin / director / sales director and open
**Admin → Monitored Mailboxes**. The "Go-live readiness" card at the top
of the page lists eight checks:

1. **Azure app-only credentials** — tenant/client/secret env vars set.
2. **Carrier reply mailbox (optional)** — reports "ok" both when
   `OUTLOOK_REPLY_EMAIL` is unset (per-rep default) and when it is set
   to a mailbox that passes the Graph probe. Only flips to error if
   the env var is set but the mailbox doesn't exist or Mail.Read is
   denied.
3. **Public APP_BASE_URL** — set, ideally `https://`.
4. **Webhook clientState secret** — `OUTLOOK_WEBHOOK_SECRET` set.
5. **Mail.Read admin consent** — Azure tenant has granted Mail.Read.
6. **At least one mailbox enrolled** — at least one row enabled in the
   monitored mailboxes table.
7. **Recent successful sync (last 24h)** — at least one mailbox synced
   within the last 24 hours, proving the Graph delta loop is alive.
8. **No draining sync failures** — no mailbox has unresolved
   per-message failures piling up.

Every row should be green (`ok`) before declaring the pipeline live.
Yellow rows are non-blocking but worth investigating. Red rows mean the
pipeline will not work.

To trigger an initial sync, click the refresh icon on any mailbox row.

---

## Day-2 operations

### Subscription renewal

The application renews each Graph subscription automatically every two
days. If renewal fails for three consecutive cycles, the affected
mailbox row will show `syncStatus = "error"` with a `syncError` message.

### Re-checking Mail.Read consent

If consent was just granted (or revoked) in Azure, click
**Re-check Mail.Read** on the Email coverage card to force a fresh
probe rather than waiting for the next sync.

### Rotating the webhook secret

1. Generate a new value with `openssl rand -hex 32`.
2. Update `OUTLOOK_WEBHOOK_SECRET` in the app environment and restart
   the server. On boot, existing subscriptions will be deleted and
   re-registered with the new clientState — there is a short window
   (seconds, not minutes) during which an in-flight notification could
   be dropped.

### Rotating the Azure client secret

1. Add a new client secret in Azure (do not delete the old one yet).
2. Update `OUTLOOK_CLIENT_SECRET` in the app and restart.
3. Confirm the readiness panel turns fully green.
4. Delete the old Azure secret.

---

## Troubleshooting

| Symptom                                                                     | Likely cause                                                                                                                     |
|-----------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| Readiness shows "OUTLOOK_WEBHOOK_SECRET" as missing                         | Env var is unset or empty — set it and restart.                                                                                  |
| Mail.Read shows "denied" after consent                                      | The `Mail.Read` permission you granted was *delegated*, not *application*. Re-add it under **Application permissions** and re-consent. |
| Subscription registration fails with HTTP 400 on `notificationUrl`         | `APP_BASE_URL` is not reachable from Microsoft. Check DNS, TLS cert, firewall, and that the URL is HTTPS.                        |
| Subscription registration fails with HTTP 404 on `users/<email>`           | The mailbox at that address doesn't exist in your tenant or the address is wrong. For shared mailboxes set via `OUTLOOK_REPLY_EMAIL`, either provision the mailbox, replace the env var with one that exists, or unset it to fall back to the per-rep default. For per-rep mailboxes, fix or remove the row from **Admin → Monitored Mailboxes**. |
| Webhook receives 200 but no `email_messages` rows appear                    | Likely a `clientState` mismatch — server logs will show `Invalid clientState ... — ignoring notification`. Re-rotate the secret. |
| Recent-sync row stays red even though enrolment succeeded                  | Click the per-mailbox refresh button to trigger a manual delta sync, then check the mailbox's `syncError` field for details.    |
| Per-mailbox row shows `OUTLOOK_WEBHOOK_SECRET is not configured` error    | The secret was unset when the subscription was attempted — set it and click the refresh icon to re-register.                    |

---

## Related code

- `server/graphSubscriptionService.ts` — registers and renews Graph
  subscriptions (refuses to register without the webhook secret).
- `server/routes/graphWebhook.ts` — handles per-rep mailbox notifications
  (refuses to process without the webhook secret).
- `server/routes/laneCarrierOutreach.ts` (`/api/webhooks/outlook-reply`)
  — handles shared-mailbox carrier reply notifications (refuses to
  process without the webhook secret).
- `server/routes/monitoredMailboxes.ts`
  (`GET /api/internal/admin/monitored-mailboxes/readiness`) — powers the
  readiness panel.
- `tests/shared-inbox-webhook-e2e.test.ts` — end-to-end test of the
  shared-mailbox reply path (In-Reply-To match, idempotent re-delivery,
  wrong clientState rejection).
