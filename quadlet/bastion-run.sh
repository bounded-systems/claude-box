#!/bin/sh
# Foreground bastion: printf 'y\n' | podman run -i (the proven-registering shape).
#
# SELinux: label-disabled (like the whole door fleet — SecurityLabelDisable). The
# bastion holds the dispatch door and must connect to launcherd-rs's dispatch.sock;
# launcherd-rs runs VM-native (unconfined_t), so a *confined* container_t bastion is
# denied `connectto` to it regardless of the socket file's label. The bastion is the
# singleton, most-trusted control point, so it takes the fleet-standard label-disable;
# dispatched WORKER boxes stay fully confined (they never touch dispatch.sock).
RT="${XDG_RUNTIME_DIR:-/run/user/501}"
exec sh -c "printf 'y\n' | podman run -i --rm --name claude-box-remote-serve \
  --userns keep-id:uid=1000,gid=1000 \
  --security-opt no-new-privileges --security-opt label=disable --cap-drop all --pids-limit 2048 --memory 1g \
  --unsetenv CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC \
  --network sni-egress \
  --add-host api.anthropic.com:10.90.0.2 --add-host statsig.anthropic.com:10.90.0.2 \
  --add-host claude.ai:10.90.0.2 --add-host platform.claude.com:10.90.0.2 \
  -e AUTHD_SOCK=/run/doors/authd.sock -e DISPATCH_SOCK=/run/doors/dispatch.sock \
  --env-file $RT/claude-box-rc-grant.env \
  -v /var/home/core/.claude-box/run:/run/doors \
  --tmpfs /home/claude/.config/claude:rw,mode=1777 \
  -v $RT/claude-box-rc-boot.sh:/rc-boot.sh:ro \
  --entrypoint sh localhost/claude-personal:dev \
  /rc-boot.sh remote-control --name dispatch --remote-control-session-name-prefix claude-box --spawn session"
