# Vendored: `@sketchcast/ere`

This directory is a **copy of the ERE engine's `src/`** from the canonical repo
`../sketchcast-ere` (framework-agnostic TypeScript, zero runtime deps). It is
vendored here so the app builds on Vercel (which only checks out the app repo).

- **Canonical source + tests live in `sketchcast-ere/`** — develop and test there.
- Import in the app as `@/ere` (e.g. `import { BoardSession, renderSvg } from "@/ere"`).
- Pure engine only — it has **no** Supabase/auth/Next knowledge; the app injects
  grounding, the model (`complete`), and persistence.

## Syncing after an engine change

```bash
# from the Edtech/ root, after committing changes in sketchcast-ere:
rm -rf sketchcast-app/src/ere && mkdir -p sketchcast-app/src/ere \
  && cp -r sketchcast-ere/src/. sketchcast-app/src/ere/

# REQUIRED: strip the ".js" extension from relative import specifiers.
# The standalone engine uses NodeNext ESM (which mandates ".js" on relative
# imports), but the Next.js bundler (webpack/turbopack) does NOT resolve a
# ".js" specifier to a ".ts" file, so the app build fails without this. tsc
# (moduleResolution: bundler) and vitest are fine either way; the bundler isn't.
node -e '
const fs=require("fs"),path=require("path");
const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
  if(e.isDirectory())walk(p);
  else if(e.name.endsWith(".ts")){const s=fs.readFileSync(p,"utf8");
    const o=s.replace(/(["'\''])(\.\.?\/[^"'\'']*?)\.js\1/g,"$1$2$1");
    if(o!==s)fs.writeFileSync(p,o);}}};
walk("sketchcast-app/src/ere");'
```

After syncing, verify with `npx tsc --noEmit`, `npx vitest run`, **and**
`npx next build` (the bundler is the one that catches a missed `.js` strip).

Vendored at ERE **v0.2.0**. Do not edit files here directly — edit in
`sketchcast-ere/`, run its tests, then re-sync (and re-run the `.js` strip).
