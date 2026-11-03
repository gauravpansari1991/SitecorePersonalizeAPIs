# Sitecore Personalize: copy flows and decision models between tenants

This script copies experiences and experiments (flow definitions) and decision models (with their variants) from one Personalize tenant, such as dev, to another, such as prod. It uses the public Personalize REST APIs. It needs Node 18 or later and has no dependencies.

## Setup
1. Create an API key in **each** tenant (Cloud Portal → Personalize → Developer settings → API keys).
2. Copy `.env.example` to `.env` and fill in the base URL, client ID and secret for each tenant.
3. In the UI, use **Copy to tenant** to copy the dependencies: offers, offer templates, connections, decision templates, web templates, conditions and points of sale.
4. Rename `id-map.example.json` to `id-map.json`. Add one entry per copied item: `"<dev ref>": "<prod ref>"`. You only need entries for items that experiences or decision models reference by ref, such as offers and connections. The dry run lists any refs that are still unmapped.

## Run
```bash
node sync.mjs                                  # dry run: exports to ./export and prints the plan
node sync.mjs --only home_banner,cart_upsell   # selected flow friendlyIds + the decision models they use
node sync.mjs --apply                          # create missing items in target
node sync.mjs --apply --overwrite              # also update items that already exist in target
node sync.mjs --skip-decision-models           # flows only
```

## Behaviour
- **Matching:** flows match on `friendlyId`. Decision models match on name, and their variants match on name within the model.
- **Ref remapping:** every dev ref in the payload is swapped for its prod ref. This includes refs inside the DMN XML of decision model variants. After `--apply`, the script saves the full map back to `id-map.json`, so later runs reuse it.
- **Status:** new flows are created as **DRAFT**. Updated flows keep the status they already have in the target. Decision model deployment status and splits are copied as they are in the source.
- **Export:** each run saves the source JSON to `export/<timestamp>/`. Commit it to git if you want history.
- **Not copied:** analytics, connection secrets, and archived items.
