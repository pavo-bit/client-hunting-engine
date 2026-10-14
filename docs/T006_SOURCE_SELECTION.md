# T006_SOURCE_SELECTION — First Real Discovery Source

> Date: 2026-10-13. Rule: no API assumed; every claim below cites fetched evidence or is labeled UNVERIFIED. No credentials were created; no accounts registered.

## Candidates evaluated

### 1. GLEIF API (Global Legal Entity Identifier Foundation) — SELECTED

- **What:** production JSON:API over the Global LEI Index (~3.46M legal-entity records at probe time), incl. full-text and single-field search, filters, pagination links.
- **Access evidence (verified live, no key):** `GET https://api.gleif.org/api/v1/lei-records?page[size]=1` returned HTTP 200 with a complete LEI record (KOTZILLA, FR) — fetched 2026-10-13 with no authentication of any kind. Official GLEIF page confirms the API is a production service (since fall 2020) over the Golden Copy with search/filter/fuzzy capability; docs at `https://api.gleif.org/docs`.
- **Terms:** GLEIF positions LEI data as open data ("Business Identity as a Global Public Good", Open Data program). No key, no registration, no stated commercial prohibition found on the pages reviewed.
- **Rate limits/cost:** none published on the pages reviewed — recorded as UNVERIFIED. Mitigation: small pages (≤25), bounded runs (≤3 pages), single-flight runs, backoff on HTTP 429, fixture-backed tests (no live dependency).
- **Worldwide:** yes — Global LEI Index across jurisdictions; records carry `jurisdiction` + legal-address country.
- **Provenance/identifiers:** stable LEI per record (`id` + `links.self`), `registeredAs` local number, registration authority, corroboration level, timestamps. Ideal for jurisdiction-scoped identity rules (LEI as `registry_id`, type `lei`, country from legal address).
- **Fit caveat (honest):** LEI holders skew toward regulated/larger entities; small web agencies rarely hold LEIs, so agency-discovery yield will be low. This adapter proves ONE reliable end-to-end path with authoritative records — it does not promise high agency yield.

### 2. OpenCorporates API — REJECTED (credential gate)

- Evidence (official API reference, fetched 2026-10-13): *"An API key is required in order to use the OpenCorporates API, and usage limits depend on your account type and plan."* Search/pagination/jurisdiction facets otherwise excellent — but obtaining a key means registering an external account, which is forbidden in this environment. Revisit only with a human-provisioned key (recorded as future setup requirement, not done here).

### 3. Companies House API (UK) — REJECTED (account + scope)

- Evidence (official Developer Hub, fetched 2026-10-13): requires "Sign in / Register", application creation, and API authentication (external account). Scope is UK Companies Act companies only — a geographic mismatch with the worldwide mandate. Revisit only for a UK slice with provisioned credentials.

### 4. Agency directories (Clutch, DesignRush, GoodFirms et al.) — REJECTED for live use

- No public, documented API offering found for programmatic discovery; these remain **manual** S-05 sources per the integration plan (operator-curated entries + snapshots). Automated extraction would risk violating platform terms — not attempted, not assumed.

### 5. Social platforms (LinkedIn, X, Instagram, Facebook) — REJECTED for live use

- Permitted-means-only per locked boundaries; no credentials provisioned; LinkedIn scraping explicitly forbidden. Manual-note fallback stands.

### 6. Paid search APIs — REJECTED

- Require paid subscriptions (external accounts + cost + secret management) with nothing provisioned. Not evaluated further.

## Selection gate: PASS (one source)

GLEIF is the only candidate with a verified, credential-free, permitted access method. No credentials or approvals are outstanding for it.

## Uncertainties (explicit)

- Exact rate limits / fair-use thresholds: UNVERIFIED (mitigated by small bounded runs + backoff).
- Full filter dialect beyond what the smoke test exercises: verified per-call at runtime; unknown filters surface as typed failures, never silent.
- Agency yield: expected low; measured per-run and reported honestly.
