#!/usr/bin/env bash
# Run only on a fresh Raspberry Pi OS host, before installing Docker.
set -euo pipefail
[[ $EUID == 0 ]] || { echo "Run with sudo" >&2; exit 1; }
ssd=/srv/verbatim
mountpoint -q "$ssd" || { echo "Mount the SSD at $ssd first" >&2; exit 1; }
[[ $(findmnt -n -o FSTYPE --mountpoint "$ssd") = ext4 &&
   $(stat -c %d "$ssd") != "$(stat -c %d /)" ]] ||
  { echo "Expected a separate ext4 SSD at $ssd" >&2; exit 1; }
for service in docker.service docker.socket containerd.service; do
  if systemctl is-active --quiet "$service"; then
    echo "$service is already active; this script is for a fresh host" >&2
    exit 1
  fi
done

targets=(/var/lib/docker /var/lib/containerd /etc/dokploy)
sources=("$ssd/docker-runtime/docker" "$ssd/docker-runtime/containerd" "$ssd/dokploy")
units=(var-lib-docker.mount var-lib-containerd.mount etc-dokploy.mount)
docker_dropin=/etc/systemd/system/docker.service.d/30-barktown-ssd.conf
containerd_dropin=/etc/systemd/system/containerd.service.d/30-barktown-ssd.conf

for i in "${!targets[@]}"; do
  for directory in "${targets[i]}" "${sources[i]}"; do
    if [[ -L "$directory" ]] || mountpoint -q "$directory" ||
       [[ -e "$directory" && ! -d "$directory" ]] ||
       [[ -d "$directory" && -n $(find "$directory" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
      echo "Not a fresh directory: $directory; no changes made" >&2
      exit 1
    fi
  done
done
for file in "$docker_dropin" "$containerd_dropin" "/etc/systemd/system/"{var-lib-docker,var-lib-containerd,etc-dokploy}.mount; do
  [[ ! -e "$file" && ! -L "$file" ]] || { echo "Already configured: $file" >&2; exit 1; }
done

install -d -m 0700 "$ssd/docker-runtime"
for i in "${!targets[@]}"; do
  install -d -m 0755 "${targets[i]}" "${sources[i]}"
  cat > "/etc/systemd/system/${units[i]}" <<MOUNT
[Unit]
RequiresMountsFor=$ssd
AssertPathIsMountPoint=$ssd

[Mount]
What=${sources[i]}
Where=${targets[i]}
Options=bind,nofail
MOUNT
done

install -d -m 0755 "$(dirname "$docker_dropin")" "$(dirname "$containerd_dropin")"
cat > "$docker_dropin" <<'UNIT'
[Unit]
RequiresMountsFor=/var/lib/docker /var/lib/containerd /etc/dokploy
AssertPathIsMountPoint=/var/lib/docker
AssertPathIsMountPoint=/var/lib/containerd
AssertPathIsMountPoint=/etc/dokploy
UNIT
cat > "$containerd_dropin" <<'UNIT'
[Unit]
RequiresMountsFor=/var/lib/containerd
AssertPathIsMountPoint=/var/lib/containerd
UNIT
systemctl daemon-reload
systemctl start "${units[@]}"
for target in "${targets[@]}"; do
  findmnt --mountpoint "$target" -o TARGET,SOURCE,FSTYPE
done
