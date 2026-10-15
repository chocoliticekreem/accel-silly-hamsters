# Deploying the API to Vercel

The API project (`shoreditch-sim-api`) is deployed from a staging copy, so its config never
applies to the frontend project (`shoreditch-sim`, root `apps/web`).

Day files (the 3D replay, about 5 MB a day) and footfall tables are served as static files from
the CDN, not by the Python function: on Vercel `/api/runs/{run}/days/{day}` and
`/api/runs/{run}/footfall` redirect (307) to `public/runs/...`. Keeping them out of `runs/` also keeps the
function bundle small, so cold starts are fast. Request `/api/runs/{run}/footfall` once on a local
API first so `runs/{run}/footfall.json` exists.

```sh
stage=$(mktemp -d)
rsync -a --exclude-from=deploy/api/vercelignore ./ "$stage/"
cp deploy/api/vercel.json "$stage/vercel.json"
rsync -a --exclude _archive --exclude training.lock --exclude days runs/ "$stage/runs/"
for run in runs/[0-9]*; do
  r=$(basename "$run")
  [ -d "$run/days" ] && mkdir -p "$stage/public/runs/$r" && cp -R "$run/days" "$stage/public/runs/$r/"
  [ -f "$run/footfall.json" ] && mkdir -p "$stage/public/runs/$r" && cp "$run/footfall.json" "$stage/public/runs/$r/"
done
vercel deploy --prod --cwd "$stage" --project shoreditch-sim-api
```
