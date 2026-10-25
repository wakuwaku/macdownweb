# MacDown Web

A web version of [MacDown](https://github.com/MacDownApp/macdown) 0.7.3, the macOS Markdown editor. It has a live split editor and preview, the formatting toolbar and menus, 15 editor themes, code highlighting, maths, diagrams, file open/save, preferences and HTML/PDF export.

It is a static site with no back end. Your preferences and drafts stay in your browser.

## Run it with Docker

You need Docker. [OrbStack](https://orbstack.dev) and Docker Desktop both work.

1. Start OrbStack (or Docker Desktop) so the Docker engine is running.
2. In this folder, run:

   ```
   docker compose up --build -d
   ```

3. Open **http://localhost:8080**.

The first build takes a minute or two. Later starts take a few seconds.

### Everyday commands

| What | Command |
|---|---|
| Start (build first if needed) | `docker compose up --build -d` |
| Stop | `docker compose down` |
| Show status | `docker compose ps` |
| Show logs | `docker compose logs -f` |
| Rebuild after code changes | `docker compose up --build -d` |

### With `just`

If you have [just](https://github.com/casey/just) (macOS, Linux and Windows), the `justfile` wraps the same steps. It uses podman when it is installed and Docker otherwise; set `ENGINE=docker` to force Docker.

| What | Command |
|---|---|
| Build and start | `just up` |
| Stop and remove the container (keep the image) | `just down` |
| Remove the container, image and build cache | `just clean` |
| Status / logs | `just ps` / `just logs` |

### Without Compose

```
docker build -t macdown-web ./web
docker run --rm -p 8080:80 macdown-web
```

### Using a different port

Port 8080 is set in `docker-compose.yml` (`"8080:80"`). Change the first number, for example `"3000:80"`, then run `docker compose up -d` again.

### Troubleshooting

- **`docker: command not found`**: open OrbStack once so it installs the `docker` command, then open a new terminal. If it is still missing, add `~/.orbstack/bin` to your PATH.
- **`Cannot connect to the Docker daemon`**: the engine is not running. Open OrbStack or Docker Desktop and wait for it to start.
- **`port is already allocated`**: something else uses port 8080. Change the port as described above.
- **Page does not update after you changed code**: run `docker compose up --build -d` and hard-refresh the browser (Cmd+Shift+R).

### What the Docker setup does

The `web/Dockerfile` has two stages. The first builds the app with Node 24. The second copies only the built files into a small nginx image (about 87 MB), which serves them on port 80 inside the container. `web/nginx.conf` caches the hashed build files for a year and always revalidates `index.html`.

## Run it without Docker

You need Node 24.

```
cd web
npm install
npm run dev        # development server at http://localhost:5173
```

To build and serve the production version: `npm run build && npm run preview`.

## Tests

```
cd web
npm test                          # unit tests (Vitest)
npx playwright install chromium  # once, to download the test browser
npm run test:e2e                  # end-to-end tests (Playwright)
```

On a busy machine, use `npx playwright test --workers=3`.

## More documentation

- `web/README.md`: developer guide, feature-to-spec mapping and test IDs.
- `docs/spec.md`: the functional specification of MacDown 0.7.3.
- `docs/test-report.md`: the full test report.
- `docs/plan.md` and `docs/status.md`: the plan and the final status, including known gaps.
