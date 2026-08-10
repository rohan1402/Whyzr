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

## Deploy from the Railway website

### 1. Create the project from GitHub

Go to railway.app and sign in, then **New Project** and
**Deploy from GitHub repo**. Authorise Railway to see your repositories if
it asks, and pick **rohan1402/Whyzr**.

Railway detects the Dockerfile on its own. There is nothing to configure:
no build command, no start command.

It starts building straight away. **Expect this first deploy to build fine
and then stop.** The app refuses to start until `WHYZR_CODE` exists, and it
says so in the logs. That is the fail-fast guard working, not a broken
deploy: an app for children should never boot with an open gate. The next
two steps fix it.

### 2. Add the volume (before you let it boot properly)

Journals are real children's thinking, and a container without a volume
loses everything on every restart.

Open the service, go to **Settings**, find **Volumes**, and add one with the
mount path:

```
/data
```

Everything Whyzr keeps lives there: kid repos, the registry, and, during
testing, transcripts. All of it outside every git repo.

### 3. Set the variables

Go to the **Variables** tab. Click **RAW Editor** so you can paste the whole
block at once, and paste this, replacing the three placeholder values:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
WHYZR_CODE=your-secret-word
ADMIN_KEY=your-long-random-admin-key
DAILY_BUDGET_USD=1
TRUST_PROXY_HOPS=1
SAVE_TRANSCRIPTS=true
WHYZR_DATA_DIR=/data
```

Two of these are easy to skip and both matter:

- `TRUST_PROXY_HOPS=1` because Railway puts exactly one proxy in front of
  the app. The rate limiter ignores `X-Forwarded-For` unless this is set,
  because that header is written by the caller and was otherwise trivially
  spoofable.
- `SAVE_TRANSCRIPTS=true` is for this test only. Turn it off and delete
  `/data/transcripts` before any public launch, so the README's "raw
  conversations are not kept" claim stays true.

Saving variables triggers a redeploy. This one should stay up.

### 4. Get the URL

**Settings**, then **Networking**, then **Generate Domain**. Railway gives
you a `something.up.railway.app` address with HTTPS already handled.

### 5. Check it actually booted

Open the **Deploy Logs**. A healthy start prints:

```
Whyzr hosted app on :3456
  data dir      : /data
  access code   : set
  admin         : enabled
  transcripts   : SAVING (testing mode)
  daily budget  : $1
```

If it says `WHYZR_CODE is not set` the variable did not save. If it says
`too short`, the code needs at least six characters.

### Note on automatic deploys

Because the service is linked to GitHub, every push to `main` redeploys.
That is convenient, but it means a push during your sibling's session
restarts the app. The shutdown path writes in-flight journals first, so
nothing is lost, but avoid pushing while someone is mid-conversation.

### The same thing from the terminal

If you prefer the CLI: `railway init`, then `railway up --detach`, then
`railway variables --set KEY=value` for each of the seven above, then
`railway domain`. The volume still has to be added from the website.

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
