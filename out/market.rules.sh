#!/bin/sh
set -e
iptables -N FIRENET-FWD 2>/dev/null || true
while iptables -C FORWARD -j FIRENET-FWD 2>/dev/null; do iptables -D FORWARD -j FIRENET-FWD; done
iptables -I FORWARD -j FIRENET-FWD
iptables -F FIRENET-FWD
iptables -A FIRENET-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FIRENET-FWD -m set --match-set fn_mr-1 dst -s 10.10.10.2/32 -p tcp -m multiport --dports 443 -m comment --comment "AI-55432" -j ACCEPT
iptables -A FIRENET-FWD -m set --match-set fn_mr-1 src -d 10.10.10.2/32 -p tcp -m multiport --sports 443 -m comment --comment "AI-55432" -j ACCEPT
iptables -A FIRENET-FWD -j DROP
