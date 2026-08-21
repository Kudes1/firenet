#!/bin/sh
set -e
iptables -N FIRENET-FWD 2>/dev/null || true
while iptables -C FORWARD -j FIRENET-FWD 2>/dev/null; do iptables -D FORWARD -j FIRENET-FWD; done
iptables -I FORWARD -j FIRENET-FWD
iptables -F FIRENET-FWD
iptables -A FIRENET-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FIRENET-FWD -m set --match-set fn_044ed1d3 src -m set --match-set fn_bf28cd64 dst -p tcp -m comment --comment "zavod" -j ACCEPT
iptables -A FIRENET-FWD -m set --match-set fn_bf28cd64 src -m set --match-set fn_044ed1d3 dst -p tcp -m comment --comment "zavod" -j ACCEPT
iptables -A FIRENET-FWD -j DROP
