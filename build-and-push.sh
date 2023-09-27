#!/bin/bash

IMAGE=registry.jan.systems/hommabot2:latest

set -euxo pipefail
docker build --platform linux/amd64 -t $IMAGE .
docker push $IMAGE
