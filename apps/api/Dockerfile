# ---- Build stage ----
FROM python:3.11-slim AS builder

WORKDIR /build

ARG PYTHON_REQUIREMENTS=requirements-full.txt

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-core.txt requirements-full.txt requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r "${PYTHON_REQUIREMENTS}"

# ---- Runtime stage ----
FROM python:3.11-slim

WORKDIR /app

# Runtime-only system deps (curl for healthcheck, docker CLI for sandbox,
# gosu to drop privileges after preparing mounted data volumes)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl docker.io gosu \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Create non-root user
RUN groupadd -r opentutor && useradd -r -g opentutor -d /app -s /sbin/nologin opentutor \
    && mkdir -p /app/uploads && chown -R opentutor:opentutor /app

COPY --chown=opentutor:opentutor . .

# Docker named volumes start as root-owned directories.  The entrypoint fixes
# the two writable mounts, then drops to the unprivileged app account.
COPY docker-entrypoint.sh /usr/local/bin/lumate-api-entrypoint
RUN chmod 755 /usr/local/bin/lumate-api-entrypoint

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/lumate-api-entrypoint"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
