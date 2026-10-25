# Container shortcuts for MacDown Web. Run `just` to list them.
# Uses podman when it is installed, otherwise docker. Override with ENGINE=docker just up.

engine := env_var_or_default("ENGINE", `command -v podman >/dev/null 2>&1 && echo podman || echo docker`)

export PODMAN_COMPOSE_WARNING_LOGS := "false"

default:
    @just --list

# Build the image and start the container on http://localhost:8080
up:
    @if [ "{{engine}}" = podman ]; then podman machine start >/dev/null 2>&1 || true; fi
    {{engine}} compose up --build -d
    @echo "MacDown Web: http://localhost:8080"

# Stop and remove the container (keeps the image for a fast next start)
down:
    {{engine}} compose down

# Remove the container, the image and its build cache
clean:
    {{engine}} compose down --rmi all --remove-orphans
    {{engine}} image prune -f

# Show container status
ps:
    {{engine}} compose ps

# Follow the container logs
logs:
    {{engine}} compose logs -f
