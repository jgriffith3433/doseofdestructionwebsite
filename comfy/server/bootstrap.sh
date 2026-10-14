#!/bin/bash
# First boot of the Dose of Destruction GPU server (EC2 g6e, AWS Deep
# Learning Base GPU AMI, Ubuntu 24.04). tools/gpu/aws.mjs fills in the
# double-underscore placeholders and passes this as EC2 user data.
#
#   ComfyUI      127.0.0.1:8188, never exposed directly
#   nginx        :8189 with HTTP basic auth (user dod, the launch token),
#                the only port the security group opens, to your IP only
#   status       /dod/status.json: install progress, read by devtools
#   idle stop    a timer powers the machine off after __IDLE_MINUTES__ idle
#                minutes; EC2 treats that as a stop, so billing stops too
#
# Logs: /var/log/dod-bootstrap.log, journalctl -u comfyui
set -uo pipefail
exec > >(tee -a /var/log/dod-bootstrap.log) 2>&1

STATE=/var/lib/dod
COMFY=/opt/comfy
mkdir -p "$STATE"
status() {
  printf '{"stage":"%s","detail":"%s","time":%s}\n' "$1" "$2" "$(date +%s)" > "$STATE/status.json.tmp"
  mv "$STATE/status.json.tmp" "$STATE/status.json"
  echo "== $1: $2"
}
fail() {
  status failed "$1"
  exit 1
}

status installing "system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y || fail "apt update"
apt-get install -y nginx apache2-utils ffmpeg git python3-venv python3-dev aria2 jq curl || fail "apt install"

# ------------------------------------------------------------------ proxy
htpasswd -bc /etc/nginx/dod.htpasswd dod '__TOKEN__' || fail "htpasswd"
chmod 640 /etc/nginx/dod.htpasswd
chown root:www-data /etc/nginx/dod.htpasswd
cat > /etc/nginx/sites-available/dod <<'NGINX'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
  listen 8189;
  client_max_body_size 2g;
  auth_basic "Dose of Destruction GPU";
  auth_basic_user_file /etc/nginx/dod.htpasswd;
  # Status polling doesn't count as activity for the idle timer.
  location = /dod/status.json {
    access_log off;
    default_type application/json;
    alias /var/lib/dod/status.json;
  }
  location / {
    proxy_pass http://127.0.0.1:8188;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    access_log /var/log/nginx/dod-access.log;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/dod /etc/nginx/sites-enabled/dod
rm -f /etc/nginx/sites-enabled/default
systemctl enable nginx
systemctl restart nginx || fail "nginx"

# ----------------------------------------------------------- idle shutdown
cat > /usr/local/bin/dod-idle.sh <<'IDLE'
#!/bin/bash
# Powers off after IDLE_MINUTES with an empty ComfyUI queue and no API calls.
IDLE_MINUTES=__IDLE_MINUTES__
STATE=/var/lib/dod
grep -q '"stage":"ready"' "$STATE/status.json" 2>/dev/null || exit 0
q=$(curl -s --max-time 5 http://127.0.0.1:8188/queue)
busy=$(echo "$q" | jq '(.queue_running | length) + (.queue_pending | length)' 2>/dev/null || echo 0)
if [ "${busy:-0}" -gt 0 ]; then touch "$STATE/last_busy"; exit 0; fi
last=$(stat -c %Y "$STATE/last_busy" 2>/dev/null || echo 0)
log=$(stat -c %Y /var/log/nginx/dod-access.log 2>/dev/null || echo 0)
[ "$log" -gt "$last" ] && last=$log
[ "$last" -eq 0 ] && { touch "$STATE/last_busy"; exit 0; }
if [ $(( $(date +%s) - last )) -gt $(( IDLE_MINUTES * 60 )) ]; then
  echo "idle for over $IDLE_MINUTES minutes, powering off" | systemd-cat -t dod-idle
  shutdown -h now
fi
IDLE
chmod +x /usr/local/bin/dod-idle.sh
cat > /etc/systemd/system/dod-idle.service <<'UNIT'
[Unit]
Description=Stop the GPU server when idle
[Service]
Type=oneshot
ExecStart=/usr/local/bin/dod-idle.sh
UNIT
cat > /etc/systemd/system/dod-idle.timer <<'UNIT'
[Unit]
Description=Check for idle every 5 minutes
[Timer]
OnBootSec=10min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now dod-idle.timer
# A fresh boot starts the idle clock, so a restart is never stopped straight away.
cat > /etc/systemd/system/dod-boot-busy.service <<'UNIT'
[Unit]
Description=Reset the idle clock on boot
[Service]
Type=oneshot
ExecStart=/usr/bin/touch /var/lib/dod/last_busy
[Install]
WantedBy=multi-user.target
UNIT
systemctl enable dod-boot-busy.service
touch "$STATE/last_busy"

# ---------------------------------------------------------------- ComfyUI
status installing "ComfyUI __COMFY_TAG__"
git clone --depth 1 --branch '__COMFY_TAG__' '__COMFY_REPO__' "$COMFY" || fail "clone ComfyUI"
python3 -m venv "$COMFY/venv" || fail "venv"
. "$COMFY/venv/bin/activate"
pip install --upgrade pip wheel
status installing "PyTorch (CUDA 12.8)"
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128 || fail "torch"
status installing "ComfyUI requirements"
pip install -r "$COMFY/requirements.txt" || fail "ComfyUI requirements"

status installing "custom nodes"
cd "$COMFY/custom_nodes"
while read -r repo commit; do
  [ -z "$repo" ] && continue
  name=$(basename "$repo" .git)
  git clone "$repo" "$name" && git -C "$name" checkout "$commit" || fail "clone $name"
  [ -f "$name/requirements.txt" ] && { pip install -r "$name/requirements.txt" || fail "requirements for $name"; }
done <<'NODES'
__NODES__
NODES
# DWPose runs its detector through onnxruntime; the GPU build is much faster.
pip install onnxruntime-gpu || true

# ----------------------------------------------------------------- models
cat > "$STATE/models.txt" <<'MODELS'
__MODELS__
MODELS
total=$(grep -c . "$STATE/models.txt")
n=0
while read -r dir file url; do
  [ -z "$dir" ] && continue
  n=$((n + 1))
  status downloading "model $n of $total: $file"
  mkdir -p "$COMFY/models/$dir"
  for attempt in 1 2 3; do
    aria2c -q -x 16 -s 16 -c --file-allocation=none -d "$COMFY/models/$dir" -o "$file" "$url" && break
    sleep 10
    [ "$attempt" = 3 ] && fail "download $file"
  done
done < "$STATE/models.txt"

# ---------------------------------------------------------------- service
cat > /etc/systemd/system/comfyui.service <<UNIT
[Unit]
Description=ComfyUI
After=network-online.target
[Service]
WorkingDirectory=$COMFY
ExecStart=$COMFY/venv/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now comfyui || fail "start ComfyUI"

status installing "waiting for ComfyUI to start"
for i in $(seq 1 120); do
  curl -sf http://127.0.0.1:8188/system_stats > /dev/null && break
  sleep 5
done
curl -sf http://127.0.0.1:8188/system_stats > /dev/null || fail "ComfyUI did not start (journalctl -u comfyui)"

touch "$STATE/last_busy"
status ready "ComfyUI __COMFY_TAG__ with $total models"
