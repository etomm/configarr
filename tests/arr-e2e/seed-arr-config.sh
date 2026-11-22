#!/bin/sh
# Seed the *arr bootstrap config before its process starts.
#
# Host Filtering reads AllowedHosts once at startup. The e2e stack reaches each app
# both from the host (127.0.0.1) and from other containers (the compose service name),
# so both must be present. Seeding at boot keeps a reused volume correct across restarts,
# which a runtime API write cannot do, and lets the host-settings tests run without a
# one-off "make the list non-empty" write.
set -eu

service="${1:?usage: seed-arr-config.sh <compose-service-name>}"
shift
config=/config/config.xml
required="localhost,127.0.0.1,${service}"

if [ ! -f "$config" ]; then
  # First boot: the app fills every other key with its defaults.
  cat > "$config" <<EOF
<Config>
  <AllowedHosts>${required}</AllowedHosts>
</Config>
EOF
  chown "${PUID:-1000}:${PGID:-1000}" "$config"
  exec "${ARR_INIT:-/init}" "$@"
fi

flattened=$(tr '\n' ' ' < "$config")
current=$(printf '%s\n' "$flattened" | sed -n 's:.*<AllowedHosts[^>]*>\([^<]*\)</AllowedHosts>.*:\1:p' | head -n 1 | tr -d '[:space:]')
merged="$current"
for host in localhost 127.0.0.1 "$service"; do
  case ",${merged}," in
    *",${host},"*) ;;
    *) merged="${merged:+${merged},}${host}" ;;
  esac
done

if [ "$merged" != "$current" ]; then
  if grep -q '<AllowedHosts' "$config"; then
    # Replace the first element in any form: single-line, self-closing, or multiline.
    awk -v merged="$merged" '
      function canonical(indent) { return indent "<AllowedHosts>" merged "</AllowedHosts>" }
      !done && /<AllowedHosts/ {
        if ($0 ~ /<\/AllowedHosts>/) {
          sub(/<AllowedHosts[^>]*>[^<]*<\/AllowedHosts>/, canonical(""))
          print
          done = 1
          next
        }
        if ($0 ~ /<AllowedHosts[^>]*\/>/) {
          sub(/<AllowedHosts[^>]*\/>/, canonical(""))
          print
          done = 1
          next
        }
        match($0, /<AllowedHosts/)
        pendingPrefix = substr($0, 1, RSTART - 1)
        inside = 1
        done = 1
        next
      }
      inside {
        if ($0 ~ /<\/AllowedHosts>/) {
          match($0, /<\/AllowedHosts>/)
          print pendingPrefix canonical("") substr($0, RSTART + RLENGTH)
          inside = 0
        }
        next
      }
      { print }
    ' "$config" > "${config}.tmp"
    mv "${config}.tmp" "$config"
  else
    # No element: insert before the closing root tag, even when it shares a line.
    awk -v entry="  <AllowedHosts>${merged}</AllowedHosts>" '
      !done {
        i = index($0, "</Config>")
        if (i > 0) {
          print substr($0, 1, i - 1) entry
          print substr($0, i)
          done = 1
          next
        }
      }
      { print }
      END { if (!done) exit 1 }
    ' "$config" > "${config}.tmp"
    mv "${config}.tmp" "$config"
  fi
fi

chown "${PUID:-1000}:${PGID:-1000}" "$config"
exec "${ARR_INIT:-/init}" "$@"
