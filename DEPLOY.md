# Deploying Whyzr to Railway

The image is verified: it builds, boots, clones a kid repo inside the
container, and holds a real conversation. What follows is the exact sequence
to put it on a URL you can send to someone.

Nothing here puts a secret in git. Every value goes into Railway's own
environment settings.

## Before you start

Have these three ready:

1. Your Anthropic API key.
2. An access code you invent now: the word your tester types once. Six
   characters minimum. Send it to them in a SEPARATE message from the link.
3. An admin key you invent now: any long random string. It gates the review
   endpoints that `npm run review` reads.

## 1. Create the project

From the repo root:

```bash
railway init
```

Pick "Empty project" and name it `whyzr`. Then link the service:

```bash
railway up --detach
```

The first `railway up` uploads the repo and builds the Dockerfile. It will
boot and then exit: the app refuses to start without `WHYZR_CODE`, by
design. That is the fail-fast guard working, not a broken deploy.

## 2. Add the persistent volume (do this BEFORE the first real boot)

Journals are real children's thinking and must survive restarts. In the
Railway dashboard: your service, Settings, Volumes, New Volume, mount path
`/data`.

Everything Whyzr keeps lives there: kid repos, the registry and (during
testing) transcripts. All of it sits outside every git repo.

## 3. Set the environment

```bash
railway variables --set ANTHROPIC_API_KEY=sk-ant-...       \
                  --set WHYZR_CODE=your-code-here          \
                  --set ADMIN_KEY=your-admin-key-here      \
                  --set DAILY_BUDGET_USD=1                 \
                  --set TRUST_PROXY_HOPS=1                 \
                  --set SAVE_TRANSCRIPTS=true              \
                  --set WHYZR_DATA_DIR=/data
```

Notes on two of these:

- `TRUST_PROXY_HOPS=1` because Railway puts exactly one proxy in front. The
  rate limiter ignores `X-Forwarded-For` unless this is set, since that
  header is client-controlled and was otherwise trivially spoofable.
- `SAVE_TRANSCRIPTS=true` is for the sibling test only. Turn it off and
  delete `/data/transcripts` before any public launch, so the README's
  "raw conversations are not kept" claim stays true.

## 4. Deploy and get the URL

```bash
railway up --detach
railway domain          # generates a public https URL
```

Watch it come up:

```bash
railway logs
```

A healthy boot prints the data dir, `access code : set`, the admin state and
the daily budget.

## 5. Smoke test the live URL, from a phone, on cellular data

Not wifi: cellular proves the thing works from outside your house, which is
where your tester is.

1. Open the URL. You should see the secret-word screen.
2. Type a wrong code. It must refuse.
3. Type the real code, set a nickname, an age and a parent PIN.
4. Hold a short conversation, out loud if the browser allows it.
5. Press "new adventure", wait a minute, then open "grown-ups: see the
   journal", enter the PIN and confirm today's session appears as a card
   with a commit hash.
6. Edit a rule, save it, watch the commit appear, then press "Restore
   original rules".
7. From your laptop:
   ```bash
   WHYZR_URL=https://your-app.up.railway.app ADMIN_KEY=your-admin-key npm run review
   ```
   You should see the session, the journal entry and any parent edits.

## 6. Send it

Send the link and the code in two separate messages. Tell the tester's
parent, in plain words, that conversations are being read during testing so
the robot can be improved, and that you will delete them afterwards.

## After the test

```bash
railway variables --set SAVE_TRANSCRIPTS=false
```

and delete `/data/transcripts` from a Railway shell. The journals stay: they
are the product.

## Operating notes

- Cost: a full 30-turn session runs about $0.25. The `DAILY_BUDGET_USD=1`
  ceiling flips a kid-safe nap mode rather than erroring, and per-kid caps
  (3 sessions and 30 turns a day) bite first.
- Restarts: Railway sends SIGTERM. The app retires live sessions and writes
  their journals before exiting, with a grace period longer than the wrap-up
  deadline, so a deploy mid-conversation does not lose the entry.
- Logs never contain message content. They record auth failures, cap hits,
  budget state and session retirements only.
- Custom domain: Railway, Settings, Networking, Custom Domain, then a CNAME
  from your DNS. The generated URL works fine meanwhile.
