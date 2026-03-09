#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-apronai-live}"
REGION="${REGION:-us-central1}"
PROJECT_ID="${PROJECT_ID:-}"
LOCATION="${LOCATION:-us-central1}"
MODEL="${MODEL:-gemini-live-2.5-flash-native-audio}"
REPO_NAME="${REPO_NAME:-apronai}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
BUILD_PLATFORM="${BUILD_PLATFORM:-linux/amd64}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID is required."
  echo "Example: PROJECT_ID=my-project ./deploy_cloud_run.sh"
  exit 1
fi

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}:${IMAGE_TAG}"

echo "Deploying ${SERVICE_NAME} to Cloud Run..."
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Image: ${IMAGE_URI}"
echo "Build platform: ${BUILD_PLATFORM}"
if [[ -n "${SERVICE_ACCOUNT}" ]]; then
  echo "Runtime service account: ${SERVICE_ACCOUNT}"
fi

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com

if ! gcloud artifacts repositories describe "${REPO_NAME}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPO_NAME}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="ApronAI container images" \
    --project="${PROJECT_ID}"
fi

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

if docker buildx version >/dev/null 2>&1; then
  docker buildx build \
    --platform "${BUILD_PLATFORM}" \
    --tag "${IMAGE_URI}" \
    --push \
    .
else
  echo "docker buildx not found; using docker build with DOCKER_DEFAULT_PLATFORM=${BUILD_PLATFORM}"
  DOCKER_DEFAULT_PLATFORM="${BUILD_PLATFORM}" docker build -t "${IMAGE_URI}" .
  docker push "${IMAGE_URI}"
fi

deploy_args=(
  "--project=${PROJECT_ID}"
  "--region=${REGION}"
  "--platform=managed"
  "--allow-unauthenticated"
  "--timeout=3600"
  "--image=${IMAGE_URI}"
  "--set-env-vars=PROJECT_ID=${PROJECT_ID},LOCATION=${LOCATION},MODEL=${MODEL},LIVE_API_VERSION=v1,LIVE_ENABLE_CONTEXT_WINDOW_COMPRESSION=1"
)

if [[ -n "${SERVICE_ACCOUNT}" ]]; then
  deploy_args+=("--service-account=${SERVICE_ACCOUNT}")
fi

gcloud run deploy "${SERVICE_NAME}" "${deploy_args[@]}"

echo "Deployment completed."
