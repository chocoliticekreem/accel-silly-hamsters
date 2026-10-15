# Deploying the API to Vercel

The API project (`shoreditch-sim-api`) is deployed from a staging copy, so its config never
applies to the frontend project (`shoreditch-sim`, root `apps/web`):

```sh
stage=$(mktemp -d)
rsync -a --exclude-from=deploy/api/vercelignore ./ "$stage/"
cp deploy/api/vercel.json "$stage/vercel.json"
rsync -a --exclude _archive --exclude training.lock runs/ "$stage/runs/"   # the demo runs
vercel deploy --prod --cwd "$stage" --project shoreditch-sim-api
```
