# Monetisation — notes & considerations

Strategic notes on if/how to monetise Prem Picks. Nothing here is committed
work — it's a decision aid. **None of this is legal advice**; before charging
anyone, spend an hour with a solicitor who knows UK gambling + consumer law.

## The most important reframe

The three starting ideas (ads, subs for large leagues, subs for chips) are all
**"sell the software/service"** models. That's the *safe* side of a critical
line. The dangerous side is **"take money on the outcome of matches"** (paid
entry → cash prize pool), which can fall under the **UK Gambling Act 2005**
(betting / lottery / prize-competition rules, possibly needing a licence).

> Rule of thumb: monetise the **tool**, never the **wager**. Never add
> "£X to enter, winner takes the pot" without proper legal advice.

## The two blockers that matter more than the pricing model

1. **The data & brand aren't ours to sell.** The app is built on the
   **FPL API** (unofficial, *not* licensed for commercial use), Premier League
   fixtures/results, club names, and the name "Prem Picks". Free hobby use is
   tolerated; **charging money** for a product built on that is a real
   IP/trademark risk (the Premier League defends its marks aggressively).
   Likely required before any paid version:
   - Rebrand away from "Prem" / "Premier League".
   - Either license a proper data feed (Opta / Stats Perform etc. — costly) or
     knowingly accept the risk.
   - **This is the single most likely thing to kill a paid version — resolve
     it first.**

2. **A static site can't securely gate paid features.** Today it's GitHub
   Pages + client-side ES modules; anyone can open dev tools and flip a
   `hasSubscription` flag. Payments require a trusted backend:
   **Firebase Cloud Functions + Stripe**, where a Stripe webhook writes an
   entitlement document that only the server can write, enforced by Firestore
   security rules. That means leaving the pure-static model and moving to
   Firebase's paid **Blaze** plan.

## The three ideas, ranked

### #2 — organiser pays for larger / premium leagues → **best**
Classic "commissioner pays" freemium (how many office-league tools work).
- **Pros:** one payer per league (tiny billing surface, far less support);
  price aligns with value; no fairness problem; no gambling flavour; free
  small leagues naturally seed paid larger ones (growth loop).
- **Prerequisite:** the app is currently *single-league* (one shared pool).
  Needs a **multi-league refactor** — leagues, memberships, per-league
  config/picks/results/allowlist. Biggest build item, but it's also what makes
  the product grow. See "Multi-league refactor" below.

### #1 — ads → lowest effort, near-zero return at this scale
- AdSense pays ~single-digit £ per *thousand* views; a friends' league earns
  pennies. Only worth it at thousands of weekly active users.
- *Adds* compliance (GDPR cookie-consent banner, privacy policy) and hurts UX.
- **Verdict:** skip until there's real traffic.

### #3 — subs for chips → **weakest (pay-to-win)**
- Chips give scoring advantages; if one player pays and others don't, the
  competition is unfair and sours the group dynamic. "Pay for an edge in a
  contest" feels bad even where it's legal.
- **Better folded into #2:** *premium leagues* have chips enabled by the
  organiser, so everyone in that league plays on equal terms.

## Full checklist of things to think about

- **Legal structure & tax:** register as sole trader / Ltd; UK VAT threshold
  (~£90k); you're now a business.
- **Gambling law:** stay on "selling software"; never entry-fee-for-prize-pool.
- **IP / data:** rebrand; resolve FPL-data / PL-trademark commercial risk
  (blocker #1).
- **UK GDPR:** privacy policy, lawful basis, data-processor terms with
  Firebase/Stripe, right-to-erasure; cookie consent if running ads.
- **Consumer / subscription law:** clear pricing, easy cancellation,
  auto-renewal disclosure (UK rules are strict).
- **Payments:** Stripe (Checkout / Billing); they handle PCI; budget
  ~1.5% + 20p per transaction, plus refunds/chargebacks.
- **Architecture:** backend/serverless for entitlement enforcement, Firebase
  Blaze, multi-tenancy (blocker #2).
- **Ops expectations:** paying users expect a custom domain, a support email,
  uptime, and timely responses.
- **Unit economics:** will revenue clear Stripe fees + hosting + *your time*?
  For most friends'-app-sized products, honestly no — which is why validation
  comes first.

## Suggested sequence (don't build payments yet)

1. **Validate demand free.** Ship multi-league support, get several real
   leagues running, measure week-over-week retention. Retention is the only
   signal worth monetising against.
2. **Clear the IP/data blocker.** Rebrand + decide on data licensing. No point
   building billing on foundations you can't legally charge for.
3. **Then** add the backend + Stripe + organiser-pays premium tier (#2), with
   chips / custom scoring / deeper stats as the premium unlocks.

> Short version: **#2 is the model, but the real work is (a) is-this-even-
> licensable, (b) multi-league architecture, and (c) a backend — not the
> payment button itself.**

## Multi-league refactor (the gating piece)

Needed for both product growth *and* model #2. Rough shape (to be planned
properly on its own):

- `leagues/{leagueId}` — name, owner, tier (free/premium), settings (chips
  on/off, unlock gameweek, scoring tweaks), member cap.
- `leagues/{leagueId}/members/{uid}` — replaces the single global allowlist;
  per-league membership + role (owner/player).
- Picks / results / config become **per-league** (namespaced under the league
  or carrying a `leagueId`), instead of the current single shared pool.
- Security rules gate reads/writes by league membership, and gate premium
  features by the league's `tier` (which only a Stripe webhook can raise).
- Entitlement: `leagues/{id}.tier` is server-written only; the client never
  sets it.
