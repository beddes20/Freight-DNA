# Project Notes

## Recognized US city list (`client/src/data/usCities.json`)

The recognized US city list powers city autocomplete and the "City not
recognized" warning reps see when entering an address. It is generated from
`server/zipcodes.json` so the two stay in sync.

### Regenerate

```sh
npx tsx script/generate-us-cities.ts
```

The script:

- Reads every `"City, ST"` pair from `server/zipcodes.json`.
- Preserves curated entries already in `client/src/data/usCities.json`,
  including alias lists (e.g. `Lee's Summit` ↔ `Lees Summit`,
  `St. Louis` ↔ `Saint Louis`).
- Preserves any hand-added cities that aren't in the ZIP feed yet (so reps
  never lose a recognized city after a regeneration).
- Sorts entries by state then city and writes the file in a stable shape so
  diffs stay readable.

### Automatic refresh

`script/build.ts` runs `script/generate-us-cities.ts` before building the
client, so production builds always ship a fresh list. After updating
`server/zipcodes.json`, run the script (or just `npm run build`) and commit the
regenerated `client/src/data/usCities.json`.
