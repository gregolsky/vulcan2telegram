# vulcan-telegram

Cron job: logs in to Vulcan once per run and posts new items to Telegram supergroup topics:

| module | what | topic env var |
|---|---|---|
| `inbox` | Wiadomości Plus messages with bodies and attachment links | `TELEGRAM_THREAD_ID` |
| `grades` | new grades (and proposed/final term grades) per student, with class | `TELEGRAM_THREAD_GRADES` |
| `exams` | upcoming tests and quizzes (next `EXAMS_WEEKS` weeks) per student, with class | `TELEGRAM_THREAD_EXAMS` |
| `plan` | schedule changes (substitutions, cancelled lessons) this and next week, one message per student and day | `TELEGRAM_THREAD_PLAN` |

Grades, exams and plan stay off until their topic id is set. Free: Telegram Bot API + local Playwright.

## Setup
1. `npm install && npx playwright install chromium` (on Pi: 64-bit OS; if the bundled Chromium
   won't run, `sudo apt install chromium` and set `CHROMIUM_PATH=/usr/bin/chromium` in `.env`). Node >= 20.6.
2. @BotFather → `/newbot` → token. Add bot to a supergroup with Topics enabled, make it admin
   (or allow it to post).
3. Get chat id + topic id: post in the topic, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → `chat.id` and `message_thread_id`.
4. `cp .env.example .env && chmod 600 .env`, fill in.
5. `npm run test-telegram`
6. `npm start` — each module's first run only records what already exists (sends nothing).
   Use `npm start -- --send-existing` to post the current items instead.
   `--only=grades,exams` runs selected modules; `npm run dry-run` prints without sending or saving.

## Weekly summary
On Wednesday and Saturday (from `DIGEST_HOUR`, default 18:00 Warsaw time) one extra step runs `claude -p` over the last
7 days of messages and the next 7 days of tests, and posts "what is needed next week" per child to the General topic.
It needs the Claude Code CLI (bundled in the Docker image; on a plain host `npm i -g @anthropic-ai/claude-code`) and is off
unless `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) is set. Create the token with `claude setup-token` on a machine
where you are logged in and put it in `.env`. Claude runs with no tools and the message text is passed as data only.
Try it with `npm start -- --only=none --digest --dry-run` (prints instead of sending); `--digest` also forces a real send.

## Cron
```
*/20 * * * * cd ~/vulcan-telegram && flock -n /tmp/vulcan-tg.lock npm start >> run.log 2>&1
```

## Docker
Runs the job every `RUN_INTERVAL` seconds (default 1200) inside the container; no host cron needed.
GitHub Actions tests and builds a multi-arch (amd64/arm64) image to `ghcr.io/gregolsky/vulcan2telegram` on every push to `master`.
```
cp .env.example .env              # fill in
mkdir data && chown 1001 data     # state lives here; container user is uid 1001
cp state.json data/               # optional: keep existing dedupe state (else first run seeds without sending)
docker compose pull && docker compose up -d   # or: docker compose up -d --build  (build locally)
docker compose logs -f
```
On a server only `docker-compose.yml`, `.env` and `data/` are needed.
One-off commands: `docker compose run --rm --entrypoint node vulcan src/run.mjs --test-telegram`
(or `--dry-run`, `--send-existing`, `--only=grades`).

## Notes
- Everything uses the portal's JSON APIs after one Playwright login: `Wiadomości Plus /api/*` and
  `Uczeń *.mvc/Get` (the per-student "current student" is two cookies, set before each call).
  Fetching does not mark messages as read.
- Dedupe keys: inbox = message `apiGlobalKey` (one message is delivered once per child mailbox; copies with
  the same sender+subject within 2 minutes are merged into "Dla: Adam, Beata"); grades = student+column+value
  (a changed grade is announced again); exams = student+exam id; plan = student+date+lesson+change note (a new substitute teacher is announced again; past days are never sent).
- `state.json`: per-module seen keys + `initialized`, plus a consecutive-failure count; a Telegram alert fires
  after 3 failed runs in a row (and then roughly daily while it keeps failing). An item Telegram permanently rejects
  is skipped with an alert so it cannot block its topic; HTML that Telegram cannot parse is resent as plain text. One module failing does not stop the others.
- Max 20 items per module per run (`MAX_PER_RUN`); the rest go out on the next run. The inbox is read page by page
  (50 rows) until it reaches messages that were already seen, so a burst or a long downtime loses nothing.
- Attachments are posted as SharePoint links; anyone in the group can open them.
- `npm test` runs the unit tests (Node's built-in runner, no extra dependencies).
