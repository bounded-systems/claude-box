#!/bin/sh
# Foreground bastion: printf 'y\n' | podman run -i (the proven-registering shape).
# StandardInput=data didn't survive ExecStartPre draining the pipe; an explicit
# printf into the pipe does. Paths from XDG_RUNTIME_DIR (the systemd user runtime dir).
RT="${XDG_RUNTIME_DIR:-/run/user/501}"
exec sh -c "printf 'y\n' | podman run -i --rm --name claude-box-remote-serve \
  --userns keep-id:uid=1000,gid=1000 \
  --security-opt no-new-privileges --cap-drop all --pids-limit 2048 --memory 1g \
  --unsetenv CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC \
  --network sni-egress \
  --add-host api.anthropic.com:10.90.0.2 --add-host statsig.anthropic.com:10.90.0.2 \
  --add-host claude.ai:10.90.0.2 --add-host platform.claude.com:10.90.0.2 \
  -e AUTHD_SOCK=/run/doors/authd.sock \
  --env-file $RT/claude-box-rc-grant.env \
  -v /var/home/core/.claude-box/run/authd.sock:/run/doors/authd.sock:z \
  -v /var/home/core/.claude-box/run/dispatch.sock:/run/doors/dispatch.sock:z -e DISPATCH_SOCK=/run/doors/dispatch.sock \
  --tmpfs /home/claude/.config/claude:rw,mode=1777 \
  -v $RT/claude-box-rc-boot.sh:/rc-boot.sh:ro,z \
  --entrypoint sh localhost/claude-personal:dev \
  /rc-boot.sh remote-control --name dispatch --remote-control-session-name-prefix claude-box --spawn session"
