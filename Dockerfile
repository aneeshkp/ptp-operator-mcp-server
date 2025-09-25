# Dockerfile for PTP MCP Server with Real-time Event Consumer
FROM python:3.11-slim

# Set build arguments
ARG APP_VERSION=latest
ARG BUILD_DATE
ARG GIT_COMMIT

# Labels
LABEL maintainer="aneeshkp" \
      version="${APP_VERSION}" \
      description="PTP MCP Server with Real-time Event Consumer" \
      build-date="${BUILD_DATE}" \
      git-commit="${GIT_COMMIT}"

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Set working directory
WORKDIR /app

# Copy requirements first for better layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -u 1001 appuser

# Copy application code
COPY src/ ./src/
COPY *.py ./

# Create necessary directories with proper permissions
RUN mkdir -p /tmp /app/logs \
    && chown -R appuser:appuser /app /tmp

# Switch to non-root user
USER appuser

# Expose MCP server port
EXPOSE 3000

# Health check for the MCP server
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Environment variables
ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    MCP_SERVER_PORT=3000 \
    MCP_SERVER_HOST=0.0.0.0

# Start the MCP server
CMD ["python", "src/server.py"]
