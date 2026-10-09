#!/bin/sh
# Prepare persistent Docker volumes, then run the API without root privileges.
set -eu

for data_dir in /app/data /app/uploads; do
  mkdir -p "${data_dir}"
  chown -R opentutor:opentutor "${data_dir}"
done

exec gosu opentutor "$@"
