#!/bin/bash
# usage: runarm.sh <set 23|25> <ARM A0|C2|K3..> <fixture|-> <label>
set -e
S=$1; ARMX=$2; FX=$3; L=$4; WT=${CANDIDATE_ROOT:-/tmp/kcat/wt}
cd "${HARNESS_DIR:-/tmp/kcat/h$S}"; mkdir -p logs
PRE=""; [ "$ARMX" != A0 ] && PRE="--import $WT/research/typed-v02/arm-preload.mts"
ARM=C2 ARMS=${ARMS:-service} CANDIDATE_ROOT=$WT HYBRID_FIXTURE=$FX HYBRID_LOG=logs/$L.json \
  $WT/node_modules/.bin/tsx $PRE irun$S.ts $WT $L > out-$L.txt 2>&1
tail -1 out-$L.txt
